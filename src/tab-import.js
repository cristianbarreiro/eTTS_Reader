export const MAX_IMPORT_CHARACTERS = 200_000;
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv", "xml", "html", "htm"]);
const RESTRICTED_SCHEMES = new Set(["edge:", "chrome:", "about:", "devtools:", "chrome-extension:", "edge-extension:", "view-source:"]);

export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function extensionFromUrl(value) {
  try {
    const pathname = new URL(value).pathname;
    return pathname.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function isOfficeOnlineDocument(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = url.pathname;
    const wordEditor = /(^|\.)word\.(?:office\.com|cloud\.microsoft)$/i.test(host)
      || /(^|\.)officeapps\.live\.com$/i.test(host)
      || /(^|\.)office\.live\.com$/i.test(host) && /word/i.test(path)
      || /(^|\.)office\.com$/i.test(host) && /\/(?:launch\/)?word(?:\/|$)/i.test(path);
    const sharePointWord = /(^|\.)sharepoint\.com$/i.test(host)
      && /(?:\/:w:\/|\/_layouts\/\d+\/doc\.aspx|\/word\/)/i.test(path);
    const oneDriveWord = host === "onedrive.live.com" && /\/(?:edit\.aspx|word|document)(?:\/|$)/i.test(path);
    return wordEditor || sharePointWord || oneDriveWord;
  } catch {
    return false;
  }
}

export function classifyTab(tab) {
  const value = tab?.url;
  if (!value) {
    return {
      kind: "permission-required",
      message: "Edge no expuso la dirección de esta pestaña. Pulsa el icono de la extensión desde la pestaña que quieres importar y vuelve a intentarlo."
    };
  }

  let url;
  try { url = new URL(value); } catch {
    return { kind: "restricted", message: "Esta pestaña no tiene una dirección que la extensión pueda leer." };
  }

  if (RESTRICTED_SCHEMES.has(url.protocol)) {
    return { kind: "restricted", message: "Edge protege las páginas internas del navegador y de las extensiones. Usa el selector de archivos o pega el texto." };
  }
  if (["chromewebstore.google.com", "microsoftedge.microsoft.com"].includes(url.hostname) && /\/(webstore|addons)(\/|$)/i.test(url.pathname)) {
    return { kind: "restricted", message: "La tienda de extensiones no permite extraer su contenido. Puedes pegar el texto manualmente." };
  }
  if (url.hostname === "docs.google.com" && /^\/document\//i.test(url.pathname)) {
    return { kind: "google-docs", message: "Google Docs expone parte del contenido mediante una capa de edición propia." };
  }
  if (isOfficeOnlineDocument(value)) {
    return { kind: "office-online", message: "Documento de Word en línea. Se leerá solo el texto que esta vista exponga localmente." };
  }
  if (url.protocol === "file:") {
    const extension = extensionFromUrl(value);
    if (extension === "pdf") {
      return { kind: "local-pdf", extension, message: "PDF local detectado. Se comprobará el permiso de acceso a archivos antes de intentar leer sus bytes." };
    }
    if (TEXT_EXTENSIONS.has(extension)) return { kind: "local-text-document", extension };
    return { kind: "local-document", extension, message: "No se puede recuperar este archivo local desde la pestaña. Selecciónalo con el importador existente." };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { kind: "restricted", message: "Este tipo de pestaña no permite extracción. Usa el selector de archivos o pega el texto." };
  }

  if (url.username || url.password) {
    return { kind: "permission-required", message: "La dirección contiene credenciales. No se guardarán ni se usarán; selecciona el archivo original o pega el texto." };
  }
  const extension = extensionFromUrl(value);
  if (extension === "pdf" || /\.pdf$/i.test(tab.title || "")) return { kind: "pdf", extension: "pdf" };
  if (TEXT_EXTENSIONS.has(extension)) return { kind: "text-document", extension };
  return { kind: "web-page", extension: "html" };
}

export function combineImportedText(currentText, importedText, mode, { maxCharacters = MAX_IMPORT_CHARACTERS, allowDuplicate = false } = {}) {
  const current = String(currentText || "");
  const incoming = String(importedText || "");
  if (!incoming.trim()) return { ok: false, message: "No hay texto que importar." };
  if (mode !== "replace" && mode !== "append") return { ok: false, message: "Elige si quieres reemplazar o añadir el texto." };
  if (mode === "append" && current.trimEnd().endsWith(incoming.trim()) && !allowDuplicate) {
    return { ok: false, confirmationRequired: true, message: "Este texto parece estar ya al final del editor." };
  }
  const text = mode === "append" && current.trim()
    ? `${current.replace(/\s*$/, "")}\n\n${incoming}`
    : incoming;
  if (text.length > maxCharacters) {
    return { ok: false, message: `El texto supera el límite del editor (${maxCharacters.toLocaleString()} caracteres).` };
  }
  return { ok: true, text };
}

// This function is serialized by chrome.scripting.executeScript. Keep it self-contained.
export function extractReadablePage({ selectionOnly = false, maxCharacters = MAX_IMPORT_CHARACTERS } = {}) {
  const doc = globalThis.document;
  const win = globalThis.window;
  const limit = Math.max(1, Number(maxCharacters) || 1);
  const title = String(doc?.title || "").slice(0, 500);
  const contentType = doc?.contentType || "";
  const hostname = String(win?.location?.hostname || "").toLowerCase();
  const pathname = String(win?.location?.pathname || "");
  const isGoogleDocs = /(^|\.)docs\.google\.com$/i.test(hostname);
  if (!doc?.body) return { title, contentType, type: "web-page", text: "", truncated: false };

  const readSelection = () => {
    const windows = [win];
    for (const frame of Array.from(doc.querySelectorAll?.("iframe") || [])) {
      try {
        const frameWindow = frame.contentWindow;
        if (frameWindow?.location?.origin === win?.location?.origin) windows.push(frameWindow);
      } catch { /* Cross-origin frames are outside the page's readable scope. */ }
    }
    for (const targetWindow of windows) {
      try {
        const selected = String(targetWindow?.getSelection?.()?.toString?.() || "").replace(/\r\n?/g, "\n");
        if (selected.trim()) return selected;
      } catch { /* A frame selection may disappear while the application changes focus. */ }
    }
    return "";
  };

  if (selectionOnly) {
    const selected = readSelection();
    return {
      title,
      contentType,
      type: "selection",
      ...(isGoogleDocs ? { sourceApp: "google-docs" } : {}),
      text: selected.slice(0, limit),
      truncated: selected.length > limit
    };
  }

  const isOfficeOnline = /(^|\.)word\.(?:office\.com|cloud\.microsoft)$/i.test(hostname)
    || /(^|\.)officeapps\.live\.com$/i.test(hostname)
    || /(^|\.)office\.live\.com$/i.test(hostname) && /word/i.test(pathname)
    || /(^|\.)office\.com$/i.test(hostname) && /\/(?:launch\/)?word(?:\/|$)/i.test(pathname)
    || /(^|\.)sharepoint\.com$/i.test(hostname) && /(?:\/:w:\/|\/_layouts\/\d+\/doc\.aspx|\/word\/)/i.test(pathname)
    || hostname === "onedrive.live.com" && /\/(?:edit\.aspx|word|document)(?:\/|$)/i.test(pathname);
  const isDocumentApp = isGoogleDocs || isOfficeOnline;
  const visible = (node) => {
    if (!node || node.hasAttribute?.("aria-hidden") || node.closest?.("[aria-hidden='true']")) return false;
    try {
      const ownerWindow = node.ownerDocument?.defaultView || win;
      const style = ownerWindow?.getComputedStyle?.(node);
      const rect = node.getBoundingClientRect?.();
      if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
      if (rect && (rect.width === 0 || rect.height === 0 || rect.bottom <= 0 || rect.top >= (ownerWindow?.innerHeight || 0))) return false;
    } catch { return false; }
    return true;
  };
  const appRoots = isDocumentApp ? [doc] : null;
  let inaccessibleFrameCount = 0;
  if (isDocumentApp) {
    for (const frame of Array.from(doc.querySelectorAll("iframe") || [])) {
      if (!visible(frame)) continue;
      try {
        const frameDocument = frame.contentDocument;
        const sameOrigin = frameDocument?.defaultView?.location?.origin === win.location.origin;
        if (sameOrigin && frameDocument.documentElement) appRoots.push(frameDocument);
        else inaccessibleFrameCount++;
      } catch { inaccessibleFrameCount++; }
    }
  }

  if (isGoogleDocs) {
    const roots = appRoots;
    const collectVisible = (selector) => roots.flatMap((root) => Array.from(root.querySelectorAll(selector) || []).filter(visible));
    const pageNodes = collectVisible(".kix-page");
    const lineNodes = collectVisible(".kix-lineview-text-block");
    const wordNodes = lineNodes.length ? [] : collectVisible(".kix-wordhtmlgenerator-word-node");
    const contentNodes = lineNodes.length ? lineNodes : wordNodes;
    const accessibleNodes = contentNodes.length ? [] : collectVisible("[role='document'], [role='textbox'], [contenteditable='true']");
    let raw = [...contentNodes, ...accessibleNodes].map((node) => String(node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n");
    if (!raw && pageNodes.length) raw = pageNodes.map((node) => String(node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n\n");
    const normalized = raw.replace(/\r\n?/g, "\n").replace(/[\u00a0\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const text = normalized.slice(0, limit);
    if (!text) {
      const selected = readSelection();
      if (selected.trim()) return {
        title, contentType, type: "selection", coverage: "selection", selectionFallback: true,
        sourceApp: "google-docs", text: selected.slice(0, limit), truncated: selected.length > limit,
        inaccessibleFrameCount
      };
    }
    return {
      title,
      contentType,
      type: text ? "google-docs-visible" : "google-docs",
      coverage: text ? "visible-pages" : "not-exposed",
      visiblePageCount: pageNodes.length,
      inaccessibleFrameCount,
      text,
      truncated: normalized.length > limit
    };
  }

  const xmlDocument = /^(text\/xml|application\/xml)(?:\s*;|$)/i.test(contentType)
    && doc.documentElement?.namespaceURI !== "http://www.w3.org/1999/xhtml";
  if (xmlDocument && win?.XMLSerializer && doc.documentElement) {
    const xmlText = new win.XMLSerializer().serializeToString(doc.documentElement).replace(/\r\n?/g, "\n");
    return { title, contentType, type: "text-document", text: xmlText.slice(0, limit), truncated: xmlText.length > limit };
  }
  const plainDocument = /^(text\/(plain|csv|markdown|x-markdown|xml)|application\/(json|xml))(?:\s*;|$)/i.test(contentType)
    || (doc.body.children?.length === 1 && doc.body.firstElementChild?.tagName?.toLowerCase() === "pre");
  const excludedTags = new Set(["script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed", "nav", "footer", "form", "button", "input", "select", "textarea", "option"]);
  const excludedRoles = new Set(["navigation", "banner", "contentinfo", "complementary", "toolbar", "search", "dialog"]);
  const noisyName = /(?:advert|cookie|consent|newsletter|subscribe|social-share|share-tools|breadcrumb|related-posts|comment-form|popup|modal|toolbar|sidebar|pagination)/i;

  function collect(node, budget, root = false) {
    if (!node) return "";
    if (node.nodeType === 3) {
      const value = String(node.nodeValue || node.textContent || "");
      const part = value.slice(0, Math.max(0, budget.left));
      budget.left -= part.length;
      return part;
    }
    if (node.nodeType !== 1) return "";

    const tag = String(node.tagName || "").toLowerCase();
    const role = String(node.getAttribute?.("role") || "").toLowerCase();
    if (excludedTags.has(tag) || excludedRoles.has(role)) return "";
    if (node.hasAttribute?.("hidden") || node.hasAttribute?.("inert") || node.getAttribute?.("aria-hidden") === "true") return "";
    if (tag === "header" && !root && !node.closest?.("article")) return "";
    const name = `${node.getAttribute?.("id") || ""} ${node.getAttribute?.("class") || ""}`;
    if (noisyName.test(name)) return "";
    try {
      const style = win?.getComputedStyle?.(node);
      if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0")) return "";
    } catch { /* A page-specific style failure must not block readable text. */ }

    const childText = Array.from(node.childNodes || []).map((child) => collect(child, budget)).join("");
    if (!childText) return "";
    const block = new Set(["address", "article", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "li", "main", "p", "pre", "section", "table", "tr"]);
    return block.has(tag) ? `\n${childText}\n` : childText;
  }

  function pageText(root) {
    const budget = { left: limit + 1 };
    const raw = collect(root, budget, true).replace(/\r\n?/g, "\n");
    if (plainDocument) return raw.slice(0, limit);
    return raw
      .replace(/[\u00a0\t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, limit);
  }

  if (isOfficeOnline) {
    const selectorGroups = [
      ["[role='document']"],
      ["[contenteditable='true']"],
      ["[role='textbox']"],
      [".WACViewPanel_Editing", "#WACViewPanel_Editing"],
      ["main", "[role='main']"]
    ];
    let best = "";
    let pageCount = 0;
    for (const selectors of selectorGroups) {
      const candidates = appRoots.flatMap((root) => selectors.flatMap((selector) => Array.from(root.querySelectorAll(selector) || [])))
        .filter(visible);
      let groupBest = "";
      for (const candidate of candidates) {
        const candidateText = pageText(candidate);
        if (candidateText.length > groupBest.length) groupBest = candidateText;
      }
      if (groupBest) {
        best = groupBest;
        pageCount = candidates.length;
        break;
      }
    }
    const text = best.slice(0, limit);
    if (!text) {
      const selected = readSelection();
      if (selected.trim()) return {
        title, contentType, type: "selection", coverage: "selection", selectionFallback: true,
        sourceApp: "office-online", text: selected.slice(0, limit), truncated: selected.length > limit,
        inaccessibleFrameCount
      };
    }
    return {
      title, contentType,
      type: text ? "office-online-visible" : "office-online",
      coverage: text ? "visible-pages" : "not-exposed",
      visiblePageCount: pageCount,
      inaccessibleFrameCount,
      text,
      truncated: best.length > limit
    };
  }

  let text = "";
  let type = plainDocument ? "text-document" : "web-page";
  if (plainDocument) {
    const pre = doc.body.querySelector?.("pre");
    text = pre ? String(pre.textContent || "").replace(/\r\n?/g, "\n").slice(0, limit) : pageText(doc.body);
  } else {
    const candidates = Array.from(doc.querySelectorAll("article, main, [role='main']") || []).slice(0, 20);
    let best = null;
    for (const candidate of candidates) {
      const candidateText = pageText(candidate);
      if (candidateText.length < 80) continue;
      const tag = String(candidate.tagName || "").toLowerCase();
      const role = String(candidate.getAttribute?.("role") || "").toLowerCase();
      const factor = tag === "article" ? 1.25 : role === "main" ? 1.15 : 1.05;
      const score = candidateText.length * factor;
      if (!best || score > best.score) best = { text: candidateText, score, type: tag === "article" ? "article" : "main-content" };
    }
    if (best) {
      text = best.text;
      type = best.type;
    } else {
      text = pageText(doc.body);
    }
  }

  return { title, contentType, type, text, truncated: text.length >= limit };
}

function extensionMessage(error) {
  const message = String(error?.message || error || "");
  if (/cannot access|not allowed|permission|restricted|cannot be scripted|extensions gallery/i.test(message)) return "Edge no permitió acceder al contenido de esta pestaña. Pulsa el icono de la extensión desde la pestaña deseada para conceder acceso temporal. Si es un visor protegido, selecciona el archivo original o pega el texto.";
  return "No se pudo extraer el contenido de esta pestaña. Puedes seleccionar el archivo original o pegar el texto manualmente.";
}

function pdfName(tab, url) {
  let name = "documento.pdf";
  try {
    const lastPart = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    if (lastPart) name = decodeURIComponent(lastPart);
  } catch { /* Use the tab title below. */ }
  if (!/\.pdf$/i.test(name) && /\.pdf$/i.test(tab.title || "")) name = tab.title;
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180);
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function pdfDisplayTitle(tab) {
  const title = String(tab?.title || "").trim();
  try {
    const parsed = new URL(title);
    if (["http:", "https:"].includes(parsed.protocol)) return "PDF";
    if (parsed.protocol === "file:") return "PDF local";
  } catch { /* A normal browser title is safe to keep after removing query-like suffixes below. */ }
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(title)) return /^file:/i.test(tab?.url || "") ? "PDF local" : "PDF";
  const clean = title.split(/[?#]/, 1)[0];
  const basename = clean.split(/[\\/]/).filter(Boolean).at(-1);
  return String(basename || clean || pdfName(tab, tab?.url || "")).slice(0, 180);
}

function safePdfSourceOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : "";
  } catch { return ""; }
}

async function readBoundedBlob(response, maxBytes) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("El PDF supera el límite de 25 MB. Descárgalo y usa el selector de archivos.");
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error("El PDF supera el límite de 25 MB. Descárgalo y usa el selector de archivos.");
    return new Blob([buffer], { type: response.headers?.get?.("content-type") || "application/pdf" });
  }

  const parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("El PDF supera el límite de 25 MB. Descárgalo y usa el selector de archivos.");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new Blob(parts, { type: response.headers?.get?.("content-type") || "application/pdf" });
}

function errorResult(kind, message, tab = null, type = "", metadata = {}) {
  const pdf = type === "pdf" || type === "local-pdf";
  return {
    ok: false, state: kind, type, message,
    title: pdf ? pdfDisplayTitle(tab) : tab?.title || "",
    sourceUrl: pdf ? safePdfSourceOrigin(tab?.url || "") : safeSourceUrl(tab?.url || ""),
    ...(metadata.authenticatedAttempted ? { authenticatedAttempted: true } : {})
  };
}

function responseContentType(response) {
  return String(response?.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
}

function isHtmlContentType(contentType) {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

function isHtmlDocumentPrefix(value) {
  return /^\s*(?:\uFEFF\s*)?(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(value);
}

function remotePdfResponseError(response, tab, authenticatedAttempted) {
  const metadata = { authenticatedAttempted };
  if (!response) return errorResult("network-error", "No se recibió una respuesta del servidor. Comprueba la conexión o selecciona el archivo PDF manualmente.", tab, "pdf", metadata);
  if (response.type === "opaqueredirect" || (authenticatedAttempted && response.redirected)
    || (response.status >= 300 && response.status < 400)) {
    return errorResult("redirect-not-allowed", "El servidor redirigió la solicitud. Por seguridad, eTTS no seguirá esa redirección con la sesión del sitio. Descarga el PDF desde el sitio y selecciónalo manualmente.", tab, "pdf", metadata);
  }

  const requestedUrl = new URL(tab.url);
  const finalUrl = response.url ? new URL(response.url) : requestedUrl;
  if (requestedUrl.origin !== finalUrl.origin) {
    return errorResult("redirect-not-allowed", "El PDF redirigió a otro origen. Por seguridad, eTTS no enviará credenciales ni seguirá esa redirección. Descarga el archivo desde el sitio y selecciónalo manualmente.", tab, "pdf", metadata);
  }

  const contentType = responseContentType(response);
  if (isHtmlContentType(contentType)) {
    const status = response.status && response.status !== 200 ? ` (HTTP ${response.status})` : "";
    return errorResult("html-response", `El servidor respondió${status} con HTML, no con el PDF. No se procesó el contenido de esa página. El recurso podría requerir tu sesión del sitio; puedes reintentar con la sesión o seleccionar el archivo manualmente.`, tab, "pdf", metadata);
  }
  if (response.status === 413) {
    return errorResult("too-large", "El servidor rechazó el PDF por su tamaño. Descárgalo y usa el selector de archivos si está dentro del límite de 25 MB.", tab, "pdf", metadata);
  }
  if (!response.ok) {
    const status = Number.isInteger(response.status) && response.status ? ` HTTP ${response.status}` : "";
    return errorResult("http-error", `El servidor no permitió recuperar el PDF${status}. Puedes reintentar con la sesión del sitio o seleccionar el archivo manualmente.`, tab, "pdf", metadata);
  }
  return null;
}

function normalizedFileUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "file:") throw new Error("La respuesta no es un archivo local.");
  url.hash = "";
  return url.href;
}

export function localPdfRecoveryActions(result) {
  const state = result?.state || "";
  const localPdf = result?.type === "local-pdf" || ["local-pdf-target", "local-pdf-unavailable", "file-access-disabled", "file-access-unknown"].includes(state);
  const pdf = localPdf || result?.type === "pdf" || state === "file-unavailable" || /\.pdf(?:$|\s)/i.test(result?.title || "");
  const manualSelectionUseful = !["selection-unavailable", "no-text", "too-large"].includes(state);
  return {
    selectPdf: Boolean(pdf && manualSelectionUseful),
    previewSelectedPdf: Boolean(localPdf && manualSelectionUseful),
    retryFileAccess: state === "file-access-disabled"
  };
}

export function remotePdfRecoveryActions(result) {
  const canRetryWithSiteSession = ["html-response", "http-error", "network-error", "unsupported-content-type", "invalid-pdf-signature", "file-unavailable", "site-permission-required"].includes(result?.state);
  return {
    retryWithSiteSession: result?.type === "pdf" && canRetryWithSiteSession && result.authenticatedAttempted !== true
  };
}

export function createLocalPdfPreview(file, text, maxCharacters = MAX_IMPORT_CHARACTERS) {
  const content = String(text || "");
  const limit = Math.max(1, Number(maxCharacters) || MAX_IMPORT_CHARACTERS);
  const limited = content.slice(0, limit);
  return {
    ok: true,
    state: "complete",
    title: String(file?.name || "PDF local"),
    sourceUrl: "",
    type: "local-pdf",
    text: limited,
    characters: limited.length,
    truncated: content.length > limit,
    message: "PDF leído localmente desde el archivo seleccionado. Revisa el texto y elige Reemplazar o Añadir para aplicarlo."
  };
}

export async function importCurrentTab({
  tabsApi = globalThis.chrome?.tabs,
  scriptingApi = globalThis.chrome?.scripting,
  permissionsApi = globalThis.chrome?.permissions,
  fetchImpl = globalThis.fetch,
  targetTab = null,
  fileAccessAllowed = false,
  selectionOnly = false,
  authenticatedPdf = false,
  validateTarget = null,
  maxCharacters = MAX_IMPORT_CHARACTERS,
  maxBytes = MAX_IMPORT_BYTES,
  onStatus = () => {},
  extractPdf = null
} = {}) {
  onStatus({ state: "detecting", message: "Detectando contenido de la pestaña activa…" });
  if (!targetTab && !tabsApi?.query) {
    return errorResult("permission-required", "La API de pestañas no está disponible. Abre esta extensión en Edge y vuelve a intentarlo.");
  }

  let tab = targetTab;
  if (!tab) try {
    const tabs = await tabsApi.query({ active: true, lastFocusedWindow: true });
    tab = tabs?.[0];
  } catch (error) {
    return errorResult("permission-required", extensionMessage(error));
  }
  if (!tab?.id) return errorResult("restricted", "No hay una pestaña activa que se pueda importar.", tab);

  const classification = classifyTab(tab);
  if (["restricted", "permission-required", "local-document"].includes(classification.kind)) {
    return errorResult(classification.kind, classification.message, tab, classification.kind);
  }
  const localPdf = classification.kind === "local-pdf";
  if (selectionOnly && (classification.kind === "pdf" || localPdf)) {
    return errorResult("selection-unavailable", "Edge no permite leer directamente la selección de este visor. Selecciona el texto en el PDF, pulsa Ctrl+C y pégalo en el editor con Ctrl+V.", tab, localPdf ? "local-pdf" : "pdf");
  }
  if (localPdf && fileAccessAllowed !== true) {
    const state = fileAccessAllowed === false ? "file-access-disabled" : "file-access-unknown";
    return errorResult(state, fileAccessAllowed === false
      ? "El permiso para leer archivos locales no está activo. En edge://extensions abre Detalles de la extensión y activa ‘Permitir el acceso a direcciones URL de archivo’; luego vuelve a comprobarlo o selecciona el PDF manualmente."
      : "No se pudo confirmar el permiso para leer archivos locales. Vuelve a comprobarlo o selecciona el PDF manualmente.", tab, "local-pdf");
  }
  if (classification.kind === "pdf" || localPdf) {
    onStatus({
      state: localPdf ? "retrieving-local-pdf" : "retrieving-pdf",
      message: localPdf ? "Intentando recuperar el PDF local…" : authenticatedPdf ? "Reintentando el PDF con la sesión del sitio y sin seguir redirecciones…" : "Documento compatible · recuperando el PDF sin cookies para extraerlo localmente…",
      title: pdfDisplayTitle(tab)
    });
    const authMetadata = authenticatedPdf && !localPdf ? { authenticatedAttempted: true } : {};
    if (authenticatedPdf && !localPdf) {
      let requestedUrl;
      try { requestedUrl = new URL(tab.url); }
      catch { return errorResult("permission-required", "No se pudo validar la dirección actual del PDF.", tab, "pdf"); }
      if (!["http:", "https:"].includes(requestedUrl.protocol) || !requestedUrl.hostname) {
        return errorResult("permission-required", "El reintento con sesión solo está disponible para PDF HTTP o HTTPS.", tab, "pdf");
      }
      if (typeof validateTarget !== "function") {
        return errorResult("stale-context", "No se pudo confirmar que la pestaña siga en el mismo PDF. Vuelve a intentarlo desde esa pestaña.", tab, "pdf");
      }
      let validation;
      try { validation = await validateTarget(); } catch { validation = null; }
      const validatedContext = validation?.context;
      if (!validation?.ok || validatedContext?.tabId !== tab.id || validatedContext?.url !== tab.url || !validatedContext?.documentToken) {
        return errorResult(validation?.state || "stale-context", validation?.message || "La pestaña cambió antes del reintento. No se envió ninguna solicitud con la sesión del sitio.", tab, "pdf");
      }
      const hostPattern = `${requestedUrl.protocol}//${requestedUrl.hostname}/*`;
      let sitePermission = false;
      try { sitePermission = await permissionsApi?.contains?.({ origins: [hostPattern] }) === true; } catch { sitePermission = false; }
      if (!sitePermission) {
        return errorResult("site-permission-required", "Edge no tiene permiso para este sitio. Autoriza el acceso desde el aviso de Edge y vuelve a pulsar «Reintentar con la sesión del sitio». No se realizó la solicitud autenticada.", tab, "pdf");
      }
    }

    let response;
    try {
      response = await fetchImpl(tab.url, {
        credentials: authenticatedPdf && !localPdf ? "include" : "omit",
        ...(authenticatedPdf && !localPdf ? { redirect: "manual" } : {}),
        referrerPolicy: "no-referrer", cache: "no-store"
      });
    } catch {
      if (!localPdf) {
        const message = authenticatedPdf
          ? "No se pudo descargar el PDF usando la sesión del sitio. Comprueba la conexión o selecciona el archivo manualmente."
          : "No se pudo descargar el PDF. Puedes reintentar con la sesión del sitio o seleccionar el archivo manualmente.";
        return errorResult("network-error", message, tab, "pdf", authMetadata);
      }
      return errorResult("local-pdf-unavailable", "Edge no entregó los bytes originales del PDF desde el visor. Selecciona el archivo PDF original manualmente.", tab, "local-pdf");
    }

    if (!localPdf) {
      const responseError = remotePdfResponseError(response, tab, authenticatedPdf);
      if (responseError) return responseError;
    } else if (!response?.ok) {
      return errorResult("local-pdf-unavailable", "Edge no entregó los bytes originales del PDF desde el visor. Selecciona el archivo PDF original manualmente.", tab, "local-pdf");
    }

    try {
      const requestedUrl = new URL(tab.url);
      const finalUrl = response.url ? new URL(response.url) : requestedUrl;
      if (localPdf) {
        if (normalizedFileUrl(finalUrl.href) !== normalizedFileUrl(requestedUrl.href)) {
          return errorResult("local-pdf-unavailable", "El visor devolvió otra dirección en lugar del PDF original. Selecciona el archivo PDF manualmente.", tab, "local-pdf");
        }
      } else if (requestedUrl.origin !== finalUrl.origin) {
        return errorResult("file-unavailable", "El PDF redirige a otro origen que no tiene permiso temporal. Descárgalo y selecciónalo manualmente.", tab, "pdf");
      }
      const blob = await readBoundedBlob(response, maxBytes);
      const prefix = await blob.slice(0, 1024).text();
      const hasPdfSignature = prefix.slice(0, 5).startsWith("%PDF-");
      if (!localPdf && !hasPdfSignature && isHtmlDocumentPrefix(prefix)) {
        return errorResult("html-response", `El servidor respondió con contenido HTML, no con el PDF. No se procesó como documento.${authenticatedPdf ? " Comprueba el acceso al sitio o descarga el PDF manualmente." : " El recurso podría requerir tu sesión del sitio; puedes reintentar con la sesión o seleccionar el archivo manualmente."}`, tab, "pdf", authMetadata);
      }
      const contentType = responseContentType(response);
      if (!localPdf && contentType && !/^application\/(?:pdf|octet-stream|x-pdf)$/.test(contentType)) {
        return errorResult("unsupported-content-type", "El servidor indicó un tipo de contenido que no corresponde a un PDF. No se envió a PDF.js; puedes reintentar con la sesión o seleccionar el archivo manualmente.", tab, "pdf", authMetadata);
      }
      if (!hasPdfSignature) {
        return errorResult(localPdf ? "local-pdf-unavailable" : "invalid-pdf-signature", localPdf
          ? "La dirección parecía un PDF, pero Edge no entregó sus bytes originales. Selecciona el archivo PDF manualmente."
          : authenticatedPdf
            ? "La respuesta autenticada no contiene una firma PDF válida. Descarga el PDF desde el sitio y selecciónalo manualmente."
            : "La pestaña parece un PDF, pero el servidor no entregó los bytes del archivo. Puedes reintentar con la sesión del sitio o seleccionar el archivo manualmente.", tab, localPdf ? "local-pdf" : "pdf", authMetadata);
      }
      onStatus({ state: "extracting-pdf", message: localPdf ? "PDF recuperado · extrayendo texto en este dispositivo…" : "Extrayendo texto del PDF en este dispositivo…", title: pdfDisplayTitle(tab) });
      const file = new File([blob], pdfName(tab, tab.url), { type: "application/pdf" });
      let extract = extractPdf;
      if (!extract) extract = (await import("./documents.js")).extractDocument;
      let text;
      try { text = String(await extract(file) || ""); }
      catch (error) {
        const message = error?.message || "No se pudo interpretar el archivo PDF.";
        const state = /no contiene texto extraíble|escaneo/i.test(message) ? "no-text" : "pdf-extraction-error";
        return errorResult(state, state === "no-text"
          ? "El PDF no contiene texto extraíble. Si es un escaneo, usa OCR fuera de la extensión y vuelve a importarlo."
        : "Se descargó el PDF, pero no se pudo interpretar localmente. Descárgalo y selecciónalo manualmente.", tab, localPdf ? "local-pdf" : "pdf", authMetadata);
      }
      if (!text.trim()) return errorResult("no-text", "El PDF no contiene texto extraíble. Si es un escaneo, usa OCR fuera de la extensión y vuelve a importarlo.", tab, localPdf ? "local-pdf" : "pdf", authMetadata);
      const limited = text.slice(0, maxCharacters);
      return {
        ok: true, state: "complete", title: pdfDisplayTitle(tab) || "PDF", sourceUrl: localPdf ? "" : safePdfSourceOrigin(tab.url),
        type: localPdf ? "local-pdf" : "pdf", text: limited, characters: limited.length, truncated: text.length > maxCharacters,
        message: text.length > maxCharacters ? `Extracción completada; se limitaron los primeros ${maxCharacters.toLocaleString()} caracteres.` : localPdf ? "PDF local recuperado y extraído en este dispositivo. Revisa el resultado antes de importarlo." : "Extracción completada desde el PDF localmente."
      };
    } catch (error) {
      const message = error?.message || "No se pudo extraer el PDF.";
      const state = /no contiene texto extraíble|escaneo/i.test(message) ? "no-text" : /25 MB/i.test(message) ? "too-large" : "file-unavailable";
      const safeMessage = state === "no-text"
        ? "El PDF no contiene texto extraíble. Si es un escaneo, usa OCR fuera de la extensión y vuelve a importarlo."
        : state === "too-large"
          ? "El PDF supera el límite de 25 MB. Descárgalo y usa el selector de archivos con un documento dentro del límite."
          : localPdf
            ? "Edge no pudo leer los bytes de este PDF desde el visor. Selecciona el PDF original manualmente."
            : authenticatedPdf
              ? "No se pudo leer la respuesta autenticada del PDF. Descarga el archivo desde el sitio y selecciónalo manualmente."
              : "No se pudo leer la respuesta del PDF. Puedes reintentar con la sesión del sitio o seleccionar el archivo manualmente.";
      return errorResult(localPdf && state === "file-unavailable" ? "local-pdf-unavailable" : state,
        safeMessage,
        tab, localPdf ? "local-pdf" : "pdf", authMetadata);
    }
  }

  if (!scriptingApi?.executeScript) {
    return errorResult("permission-required", "La API de lectura de pestañas no está disponible. Abre esta extensión en Edge y vuelve a intentarlo.", tab);
  }

  const plain = classification.kind === "text-document" || classification.kind === "local-text-document";
  onStatus({
    state: "extracting",
    message: selectionOnly ? "Buscando el texto seleccionado…" : `${plain ? "Documento" : "Página"} compatible · extrayendo texto disponible…`,
    title: tab.title || ""
  });
  try {
    const results = await scriptingApi.executeScript({
      target: { tabId: tab.id },
      func: extractReadablePage,
      args: [{ selectionOnly, maxCharacters }]
    });
    const page = results?.[0]?.result;
    if (!page || typeof page.text !== "string") return errorResult("extraction-error", "La pestaña no devolvió texto legible. Usa el selector de archivos o pega el texto.", tab, selectionOnly ? "selection" : classification.kind);
    const text = page.text.replace(/\u0000/g, "");
    if (!text.trim()) {
      const state = selectionOnly ? "no-selection" : "no-text";
      const message = selectionOnly
        ? "No hay texto seleccionado en esta pestaña. Selecciona texto visible y vuelve a intentarlo."
        : page.type === "google-docs"
          ? "Google Docs no expuso el texto del documento en esta vista. Prueba Importar selección o descarga el documento como DOCX/PDF."
          : page.type === "office-online"
            ? "Office en línea no expuso texto del documento en esta vista. Prueba Importar selección o descarga el documento como DOCX/PDF."
            : "No se encontró texto accesible. Puede ser un visor protegido o una aplicación que dibuja el documento en un canvas; usa el archivo original o pega el texto.";
      return errorResult(state, message, tab, selectionOnly ? "selection" : classification.kind);
    }
    const safeText = text.slice(0, maxCharacters);
    const kind = selectionOnly ? "selection" : page.type || (plain ? "text-document" : "web-page");
    const selectionFallback = Boolean(page.selectionFallback);
    return {
      ok: true, state: "complete", title: page.title || tab.title || "Pestaña actual",
      sourceUrl: safeSourceUrl(tab.url), type: kind, contentType: page.contentType || "",
      coverage: page.coverage || "page-text", selectionFallback,
      text: safeText, characters: safeText.length, truncated: Boolean(page.truncated || text.length > maxCharacters),
      message: selectionFallback
        ? `La aplicación no expuso el documento completo; se encontró solo el texto seleccionado${page.sourceApp === "google-docs" ? " en Google Docs" : " en Office en línea"}. Revisa la vista previa.`
        : page.type === "google-docs-visible"
          ? "Google Docs: se obtuvo solo el texto visible y accesible en esta vista. Para una copia completa, descarga DOCX/PDF."
          : page.type === "office-online-visible"
            ? "Office en línea: se obtuvo el texto accesible de la vista actual. Revisa la vista previa; puede que no incluya páginas aún no expuestas."
        : selectionOnly
        ? "Texto seleccionado disponible. Revisa el resultado antes de importarlo."
        : page.truncated || text.length > maxCharacters
        ? `Extracción completada; se limitaron los primeros ${maxCharacters.toLocaleString()} caracteres.`
        : "Extracción completada. Revisa el texto antes de importarlo."
    };
  } catch (error) {
    return errorResult("restricted", extensionMessage(error), tab, selectionOnly ? "selection" : classification.kind);
  }
}
