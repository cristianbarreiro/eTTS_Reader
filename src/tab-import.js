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
  if (url.protocol === "file:") {
    const extension = extensionFromUrl(value);
    if (extension === "pdf") {
      return { kind: "local-pdf", extension, message: "Edge no permite recuperar de forma fiable los bytes de este PDF local desde su visor. Selecciona el archivo PDF con el importador existente." };
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
  if (!doc?.body) return { title, contentType, type: "web-page", text: "", truncated: false };

  if (selectionOnly) {
    const selected = String(win?.getSelection?.()?.toString?.() || "").replace(/\r\n?/g, "\n");
    return {
      title,
      contentType,
      type: "selection",
      text: selected.slice(0, limit),
      truncated: selected.length > limit
    };
  }

  const isGoogleDocs = /(^|\.)docs\.google\.com$/i.test(String(win?.location?.hostname || ""));
  if (isGoogleDocs) {
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
    const roots = [doc];
    let inaccessibleFrameCount = 0;
    for (const frame of Array.from(doc.querySelectorAll("iframe") || [])) {
      if (!visible(frame)) continue;
      try {
        const frameDocument = frame.contentDocument;
        const sameOrigin = frameDocument?.defaultView?.location?.origin === win.location.origin;
        if (sameOrigin && frameDocument.documentElement) roots.push(frameDocument);
        else inaccessibleFrameCount++;
      } catch { inaccessibleFrameCount++; }
    }
    const collectVisible = (selector) => roots.flatMap((root) => Array.from(root.querySelectorAll(selector) || []).filter(visible));
    const pageNodes = collectVisible(".kix-page");
    const lineNodes = collectVisible(".kix-lineview-text-block");
    const wordNodes = lineNodes.length ? [] : collectVisible(".kix-wordhtmlgenerator-word-node");
    const contentNodes = lineNodes.length ? lineNodes : wordNodes;
    let raw = contentNodes.map((node) => String(node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n");
    if (!raw && pageNodes.length) raw = pageNodes.map((node) => String(node.innerText || node.textContent || "").trim()).filter(Boolean).join("\n\n");
    const normalized = raw.replace(/\r\n?/g, "\n").replace(/[\u00a0\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    const text = normalized.slice(0, limit);
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

function errorResult(kind, message, tab = null, type = "") {
  return { ok: false, state: kind, type, message, title: tab?.title || "", sourceUrl: safeSourceUrl(tab?.url || "") };
}

export async function importCurrentTab({
  tabsApi = globalThis.chrome?.tabs,
  scriptingApi = globalThis.chrome?.scripting,
  fetchImpl = globalThis.fetch,
  targetTab = null,
  selectionOnly = false,
  maxCharacters = MAX_IMPORT_CHARACTERS,
  maxBytes = MAX_IMPORT_BYTES,
  onStatus = () => {},
  extractPdf = null
} = {}) {
  onStatus({ state: "detecting", message: "Detectando contenido de la pestaña activa…" });
  if (!tabsApi?.query || !scriptingApi?.executeScript) {
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
  if (["restricted", "permission-required", "local-pdf", "local-document"].includes(classification.kind)) {
    return errorResult(classification.kind, classification.message, tab, classification.kind);
  }
  if (selectionOnly && classification.kind === "pdf") {
    return errorResult("selection-unavailable", "El visor PDF de Edge no expone su selección mediante scripting. Selecciona texto en una página web o abre el archivo con el selector.", tab, "pdf");
  }
  if (classification.kind === "pdf") {
    onStatus({ state: "extracting", message: "Documento compatible · recuperando el PDF sin cookies para extraerlo localmente…", title: tab.title || "" });
    try {
      const response = await fetchImpl(tab.url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
      if (!response?.ok) return errorResult("file-unavailable", "No se pudo recuperar el PDF (puede requerir acceso o redirigir a otro origen). Descárgalo y selecciónalo manualmente.", tab, "pdf");
      const requestedUrl = new URL(tab.url);
      const finalUrl = response.url ? new URL(response.url) : requestedUrl;
      if (requestedUrl.origin !== finalUrl.origin) return errorResult("file-unavailable", "El PDF redirige a otro origen que no tiene permiso temporal. Descárgalo y selecciónalo manualmente.", tab, "pdf");
      const blob = await readBoundedBlob(response, maxBytes);
      const signature = await blob.slice(0, 5).text();
      if (!signature.startsWith("%PDF-")) return errorResult("file-unavailable", "La pestaña parece un PDF, pero el servidor no entregó los bytes del archivo. Descárgalo y selecciónalo manualmente.", tab, "pdf");
      onStatus({ state: "extracting", message: "Extrayendo texto del PDF en este dispositivo…", title: tab.title || "" });
      const file = new File([blob], pdfName(tab, tab.url), { type: "application/pdf" });
      let extract = extractPdf;
      if (!extract) extract = (await import("./documents.js")).extractDocument;
      const text = String(await extract(file) || "");
      if (!text.trim()) return errorResult("no-text", "El PDF no contiene texto extraíble. Si es un escaneo, usa OCR fuera de la extensión y vuelve a importarlo.", tab, "pdf");
      const limited = text.slice(0, maxCharacters);
      return {
        ok: true, state: "complete", title: tab.title || file.name, sourceUrl: safeSourceUrl(tab.url),
        type: "pdf", text: limited, characters: limited.length, truncated: text.length > maxCharacters,
        message: text.length > maxCharacters ? `Extracción completada; se limitaron los primeros ${maxCharacters.toLocaleString()} caracteres.` : "Extracción completada desde el PDF localmente."
      };
    } catch (error) {
      const message = error?.message || "No se pudo extraer el PDF.";
      const state = /no contiene texto extraíble|escaneo/i.test(message) ? "no-text" : /25 MB/i.test(message) ? "too-large" : "file-unavailable";
      return errorResult(state, `${message} Puedes descargarlo y seleccionar el archivo original.`, tab, "pdf");
    }
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
        : "No se encontró texto accesible. Puede ser un visor protegido o una aplicación que dibuja el documento en un canvas; usa el archivo original o pega el texto.";
      return errorResult(state, message, tab, selectionOnly ? "selection" : classification.kind);
    }
    const safeText = text.slice(0, maxCharacters);
    const kind = selectionOnly ? "selection" : page.type || (plain ? "text-document" : "web-page");
    return {
      ok: true, state: "complete", title: page.title || tab.title || "Pestaña actual",
      sourceUrl: safeSourceUrl(tab.url), type: kind, contentType: page.contentType || "",
      text: safeText, characters: safeText.length, truncated: Boolean(page.truncated || text.length > maxCharacters),
      message: selectionOnly
        ? "Texto seleccionado disponible. Revisa el resultado antes de importarlo."
        : page.truncated || text.length > maxCharacters
        ? `Extracción completada; se limitaron los primeros ${maxCharacters.toLocaleString()} caracteres.`
        : "Extracción completada. Revisa el texto antes de importarlo."
    };
  } catch (error) {
    return errorResult("restricted", extensionMessage(error), tab, selectionOnly ? "selection" : classification.kind);
  }
}
