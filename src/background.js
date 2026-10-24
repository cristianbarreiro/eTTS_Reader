import { classifyTab, extractReadablePage, safeSourceUrl } from "./tab-import.js";
import { localTabFileName, safeTabTitle } from "./tab-card-presentation.js";

const PANEL_PATH = chrome.runtime.getManifest().side_panel?.default_path || "sidepanel.html";
const OFFSCREEN_PATH = `${PANEL_PATH.slice(0, PANEL_PATH.lastIndexOf("/") + 1)}offscreen.html`;
const IMPORT_TARGET_KEY = "tabImportTarget";
const ACTIVE_TAB_CONTEXT_KEY = "activeTabContext";
const FOLLOW_ACTIVE_TAB_KEY = "followActiveTab";
const PENDING_SELECTION_KEY = "pendingTabSelection";
const SELECTION_MENU_ID = "send-selection-to-local-reader";
let creatingOffscreen = null;
let creatingContextMenu = null;
let inMemoryImportTarget = null;
let activeTabContext = null;
let followActiveTab = false;
let followWindowId = null;
let contextRevision = 0;
let contextRequestSequence = 0;
const documentTokens = new Map();

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
    });
    return contexts.length > 0;
  }
  return Boolean(await chrome.offscreen.hasDocument?.());
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Mantener la reproducción local y su cola mientras el usuario oculta el panel lateral."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function sendOffscreen(command, payload = {}, { create = true } = {}) {
  if (create) await ensureOffscreenDocument();
  else if (!(await hasOffscreenDocument())) return { ok: true, sessionId: null, snapshot: null };
  let response;
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      response = await chrome.runtime.sendMessage({ target: "offscreen", command, ...payload });
      if (response) return response;
      lastError = new Error("El motor de lectura todavía no respondió.");
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
  }
  throw lastError || new Error("No se pudo contactar al motor de lectura local.");
}

function captureTab(tab) {
  if (!Number.isInteger(tab?.id)) return null;
  return {
    tabId: tab.id,
    windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
    url: typeof tab.url === "string" ? tab.url : "",
    title: typeof tab.title === "string" ? tab.title.slice(0, 500) : "",
    capturedAt: Date.now(),
    token: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
  };
}

async function saveImportTarget(target) {
  inMemoryImportTarget = target;
  try { await chrome.storage.session.set({ [IMPORT_TARGET_KEY]: target }); } catch { /* In-memory fallback lasts for this worker lifetime. */ }
}

async function readImportTarget() {
  if (inMemoryImportTarget) {
    try {
      const stored = await chrome.storage.session.get(IMPORT_TARGET_KEY);
      if (!stored[IMPORT_TARGET_KEY] || inMemoryImportTarget.capturedAt >= stored[IMPORT_TARGET_KEY].capturedAt) return inMemoryImportTarget;
      return stored[IMPORT_TARGET_KEY];
    } catch { return inMemoryImportTarget; }
  }
  try {
    const stored = await chrome.storage.session.get(IMPORT_TARGET_KEY);
    if (stored[IMPORT_TARGET_KEY]) return stored[IMPORT_TARGET_KEY];
  } catch { /* Use the in-memory target if session storage is unavailable. */ }
  return inMemoryImportTarget;
}

async function clearImportTarget(tabId = null) {
  const target = await readImportTarget();
  if (!target || (tabId !== null && target.tabId !== tabId)) return;
  if (inMemoryImportTarget?.tabId === target.tabId) inMemoryImportTarget = null;
  try { await chrome.storage.session.remove(IMPORT_TARGET_KEY); } catch { /* The target is still cleared in memory. */ }
}

async function isFileSchemeAccessAllowed() {
  if (typeof chrome.extension?.isAllowedFileSchemeAccess !== "function") return null;
  try { return await chrome.extension.isAllowedFileSchemeAccess(); } catch { return null; }
}

function makeToken() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function hostPermissionPattern(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return "";
    return `${url.protocol}//${url.hostname}/*`;
  } catch { return ""; }
}

async function hasPermission(details) {
  if (typeof chrome.permissions?.contains !== "function") return false;
  try { return await chrome.permissions.contains(details); } catch { return false; }
}

async function savedTabForId(tabId) {
  const target = await readImportTarget();
  return target?.tabId === tabId ? target : null;
}

async function describeActiveTab(tab, { forceNewDocument = false, faviconChanged = false, faviconSettled = false } = {}) {
  if (!tab?.id) {
    return { state: "waiting", title: "", location: "", contentType: "", accessState: "Esperando selección", availability: "No hay una pestaña activa disponible.", importable: false, tabsPermissionGranted: await hasTabsPermission() };
  }
  const tabsPermissionGranted = await hasTabsPermission();
  const savedTarget = await savedTabForId(tab.id);
  const url = typeof tab.url === "string" && tab.url ? tab.url : savedTarget?.url || "";
  const title = safeTabTitle(typeof tab.title === "string" && tab.title ? tab.title : savedTarget?.title || "", url);
  if (!url) {
    return {
      tabId: tab.id, windowId: tab.windowId ?? savedTarget?.windowId ?? null,
      url: "", title, favIconUrl: "", faviconPending: false, faviconRevision: 0, documentToken: "", state: "tabs-permission-required",
      location: "Dirección oculta por Edge", contentType: "Pestaña actual",
      accessState: "Permiso de seguimiento requerido",
      availability: "Activa «Seguir pestaña activa» o abre el lector desde esta pestaña.", importable: false,
      sitePermissionGranted: false, tabsPermissionGranted
    };
  }

  const previousToken = documentTokens.get(tab.id);
  const previousContext = activeTabContext?.tabId === tab.id ? activeTabContext : null;
  const sameDocument = !forceNewDocument && ((previousToken?.url === url && previousToken?.token) || (previousContext?.url === url && previousContext?.documentToken));
  const documentToken = sameDocument ? (previousToken?.token || previousContext.documentToken) : makeToken();
  documentTokens.set(tab.id, { url, token: documentToken });

  const parsed = (() => { try { return new URL(url); } catch { return null; } })();
  const classification = classifyTab({ ...tab, url, title });
  const faviconPending = forceNewDocument
    ? true
    : faviconChanged || faviconSettled ? false : Boolean(previousContext?.faviconPending);
  const location = parsed?.protocol === "http:" || parsed?.protocol === "https:"
    ? parsed.host
    : parsed?.protocol === "file:" ? localTabFileName(url) : parsed?.protocol?.replace(":", "") || "";
  const base = {
    tabId: tab.id, windowId: tab.windowId ?? savedTarget?.windowId ?? null,
    url, title: title || "Pestaña sin título", location,
    favIconUrl: faviconPending ? "" : typeof tab.favIconUrl === "string" ? tab.favIconUrl : "",
    faviconPending,
    faviconRevision: (previousContext?.faviconRevision || 0) + (forceNewDocument || faviconChanged || faviconSettled ? 1 : 0),
    documentToken,
    tabsPermissionGranted,
    hostPattern: hostPermissionPattern(url),
    contentType: "Página web", accessState: "", availability: "", importable: false
  };

  if (classification.kind === "restricted") {
    return { ...base, state: "restricted", contentType: "Página interna", accessState: "Pestaña restringida", availability: "Usa el selector de archivos o pega el texto.", importable: false, sitePermissionGranted: false };
  }
  if (classification.kind === "local-pdf") {
    const allowed = await isFileSchemeAccessAllowed();
    return { ...base, state: "local-pdf", contentType: "PDF detectado", accessState: allowed ? "Acceso a archivos locales concedido" : allowed === false ? "Permiso de archivo requerido" : "No se pudo comprobar el permiso", availability: allowed ? "Se comprobará el acceso al importar." : "Selecciona el PDF o habilita el acceso a archivos.", importable: allowed === true, sitePermissionGranted: false };
  }
  if (classification.kind === "pdf") base.contentType = "PDF detectado";
  else if (classification.kind === "google-docs") base.contentType = "Google Docs";
  else if (classification.kind === "text-document") base.contentType = "Documento de texto";
  else if (classification.kind === "local-text-document") {
    return { ...base, state: "local-document", contentType: "Archivo local", accessState: "Acceso del visor no confirmado", availability: "Usa el selector de archivos.", importable: false, sitePermissionGranted: false };
  }

  const pattern = hostPermissionPattern(url);
  const granted = pattern ? await hasPermission({ origins: [pattern] }) : false;
  return {
    ...base, state: classification.kind === "pdf" ? "pdf" : classification.kind,
    accessState: granted ? "Permiso de sitio concedido" : "Permiso de sitio requerido",
    availability: granted ? "Listo para importar" : "Se solicitará autorización al pulsar Importar pestaña actual.",
    importable: granted, sitePermissionGranted: granted
  };
}

async function commitActiveTabContext(tab, options, requestSequence) {
  const description = await describeActiveTab(tab, options);
  if (requestSequence !== contextRequestSequence) return activeTabContext;
  const context = { ...description, following: followActiveTab, revision: ++contextRevision, updatedAt: Date.now() };
  activeTabContext = context;
  try { await chrome.storage.session.set({ [ACTIVE_TAB_CONTEXT_KEY]: context }); } catch { /* The live worker keeps the current context. */ }
  void chrome.runtime.sendMessage({ target: "panel", type: "active-tab-context", context }).catch(() => {});
  return context;
}

async function publishActiveTabContext(tab, options = {}) {
  const requestSequence = ++contextRequestSequence;
  return commitActiveTabContext(tab, options, requestSequence);
}

async function currentActiveTab(windowId = null) {
  let active;
  try {
    const query = windowId === null ? { active: true, lastFocusedWindow: true } : { active: true, windowId };
    [active] = await chrome.tabs.query(query);
    if (!active?.id) return null;
    const full = await chrome.tabs.get(active.id).catch(() => null);
    const visible = full || active;
    if (!visible.url || !visible.title) {
      const savedTarget = await savedTabForId(active.id);
      return { ...visible, url: visible.url || savedTarget?.url || "", title: visible.title || savedTarget?.title || "", windowId: visible.windowId ?? savedTarget?.windowId };
    }
    return visible;
  } catch { return null; }
}

async function refreshActiveTabContext({ windowId = null, forceNewDocument = false } = {}) {
  const requestSequence = ++contextRequestSequence;
  const tab = await currentActiveTab(windowId);
  return commitActiveTabContext(tab, { forceNewDocument }, requestSequence);
}

async function refreshContextForTab(tabId, windowId, { forceNewDocument = false, faviconChanged = false, faviconSettled = false } = {}) {
  const requestSequence = ++contextRequestSequence;
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch { /* The tab may have closed before the event was handled. */ }
  if (tab?.windowId !== undefined && windowId !== undefined && tab.windowId !== windowId) return activeTabContext;
  return commitActiveTabContext(tab, { forceNewDocument, faviconChanged, faviconSettled }, requestSequence);
}

async function hasTabsPermission() {
  return hasPermission({ permissions: ["tabs"] });
}

async function setFollowActiveTab(enabled, preferredWindowId = null) {
  if (!enabled) {
    followActiveTab = false;
    followWindowId = null;
    try { await chrome.storage.local.set({ [FOLLOW_ACTIVE_TAB_KEY]: false }); } catch { /* Session storage state is enough until the worker stops. */ }
    const context = await refreshActiveTabContext();
    return { ok: true, following: false, context };
  }
  if (!(await hasTabsPermission())) return { ok: false, state: "tabs-permission-required", following: false };
  followActiveTab = true;
  const context = await refreshActiveTabContext({ windowId: Number.isInteger(preferredWindowId) ? preferredWindowId : null });
  if (!context?.tabId) {
    followActiveTab = false;
    followWindowId = null;
    return { ok: false, state: "no-active-tab", following: false };
  }
  followWindowId = Number.isInteger(context.windowId) ? context.windowId : null;
  try { await chrome.storage.local.set({ [FOLLOW_ACTIVE_TAB_KEY]: true }); } catch { /* The live worker keeps the setting. */ }
  return { ok: true, following: true, context };
}

async function restoreFollowState() {
  try {
    const stored = await chrome.storage.local.get(FOLLOW_ACTIVE_TAB_KEY);
    if (!stored[FOLLOW_ACTIVE_TAB_KEY] || !(await hasTabsPermission())) return;
    followActiveTab = true;
    const context = await refreshActiveTabContext();
    followWindowId = Number.isInteger(context?.windowId) ? context.windowId : null;
  } catch { /* Following can be enabled again from the Side Panel. */ }
}

function openPanelForTab(tab, selectionText = "", captureSelection = false) {
  const target = captureTab(tab);
  if (!target) return;

  // Call openPanel synchronously from the user gesture so Edge retains that gesture.
  if (followActiveTab && Number.isInteger(target.windowId)) followWindowId = target.windowId;
  void chrome.sidePanel.open({ tabId: target.tabId }).catch(() => {});
  void publishActiveTabContext(tab);
  void saveImportTarget(target);
  if (captureSelection) {
    const selection = {
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      text: selectionText.slice(0, 200_000),
      truncated: selectionText.length > 200_000,
      title: target.title,
      sourceUrl: safeSourceUrl(target.url),
      capturedAt: Date.now()
    };
    const saved = chrome.storage.session?.set?.({ [PENDING_SELECTION_KEY]: selection });
    void Promise.resolve(saved).then(() => chrome.runtime.sendMessage({ target: "panel", type: "tab-selection", selection })).catch(() => {});
  }
}

async function validateImportTarget() {
  const target = await readImportTarget();
  if (!target) return { ok: false, state: "permission-required", message: "Para autorizar el acceso temporal, vuelve a la pestaña que quieres leer y pulsa el icono de esta extensión." };

  let active;
  let tab;
  try {
    [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active?.id !== target.tabId) {
      return { ok: false, state: "target-mismatch", title: target.title, message: "La pestaña autorizada ya no es la pestaña actual. Pulsa el icono de la extensión desde la pestaña que quieres importar." };
    }
    tab = await chrome.tabs.get(target.tabId);
  } catch {
    await clearImportTarget(target.tabId);
    return { ok: false, state: "stale-target", title: target.title, message: "La pestaña de origen se cerró o ya no está disponible. Abre la extensión desde la pestaña deseada y vuelve a intentarlo." };
  }

  if (!tab) {
    await clearImportTarget(target.tabId);
    return { ok: false, state: "stale-target", title: target.title, message: "La pestaña de origen se cerró. Abre el lector desde la pestaña deseada y vuelve a intentarlo." };
  }
  if (!tab.url) {
    const title = tab?.title || target.title;
    const looksLikePdf = /\.pdf(?:$|\s)/i.test(title || "");
    const fileAccess = looksLikePdf ? await isFileSchemeAccessAllowed() : null;
    return {
      ok: false,
      state: !looksLikePdf ? "permission-required" : fileAccess === false ? "file-access-disabled" : "local-pdf-unavailable",
      type: looksLikePdf ? "local-pdf" : "permission-required",
      title,
      message: !looksLikePdf
        ? "Edge no expuso la dirección de la pestaña autorizada. Vuelve a esa pestaña y pulsa el icono de la extensión para conceder acceso temporal."
        : fileAccess === false
          ? "El acceso a archivos locales está desactivado. En edge://extensions abre Detalles de esta extensión y activa ‘Permitir el acceso a direcciones URL de archivo’; después vuelve a comprobarlo o selecciona el PDF manualmente."
          : "El visor PDF de Edge no expuso la dirección o los bytes originales que la extensión necesita. Selecciona el PDF original manualmente."
    };
  }
  if (target.url && tab.url !== target.url) {
    await clearImportTarget(target.tabId);
    return { ok: false, state: "stale-target", title: tab.title || target.title, message: "La pestaña navegó a otra página después de abrir el lector. Vuelve a invocar la extensión desde la página actual." };
  }
  if (!target.url) {
    target.url = tab.url;
    target.title = tab.title || target.title;
    await saveImportTarget(target);
  }
  return { ok: true, target, tab };
}

function contextIdentity(context) {
  return {
    tabId: context?.tabId,
    windowId: context?.windowId ?? null,
    url: context?.url || "",
    documentToken: context?.documentToken || ""
  };
}

async function validateCurrentTabContext(expectedContext) {
  if (!expectedContext?.documentToken || !Number.isInteger(expectedContext.tabId) || !expectedContext.url) {
    return { ok: false, state: "context-unavailable", message: "No se conoce una pestaña actual segura. Activa «Seguir pestaña activa» o abre el lector desde la pestaña que quieres importar." };
  }
  const windowId = Number.isInteger(expectedContext.windowId) ? expectedContext.windowId : null;
  const active = await currentActiveTab(windowId);
  if (!active?.id) return { ok: false, state: "no-active-tab", message: "No hay una pestaña activa disponible. Vuelve a intentarlo desde la página deseada." };
  if (active.id !== expectedContext.tabId) {
    return { ok: false, state: "stale-context", message: "La pestaña activa cambió durante la operación. No se aplicó el resultado; vuelve a intentarlo." };
  }

  const latest = await refreshActiveTabContext({ windowId });
  if (!latest?.tabId || latest.tabId !== expectedContext.tabId) {
    return { ok: false, state: "stale-context", message: "La pestaña activa cambió durante la operación. No se aplicó el resultado; vuelve a intentarlo." };
  }
  if (!latest.url) {
    return { ok: false, state: "tabs-permission-required", context: latest, message: "Edge no expuso la dirección de la pestaña. Activa «Seguir pestaña activa» o vuelve a abrir el lector desde esa pestaña." };
  }
  if (latest.url !== expectedContext.url || latest.documentToken !== expectedContext.documentToken) {
    return { ok: false, state: "stale-context", context: latest, message: "La pestaña navegó a otro documento durante la operación. No se aplicó el resultado; vuelve a intentarlo." };
  }
  const tab = await chrome.tabs.get(latest.tabId).catch(() => null);
  if (!tab) return { ok: false, state: "stale-context", message: "La pestaña se cerró durante la operación. No se aplicó el resultado." };
  const url = typeof tab.url === "string" && tab.url ? tab.url : latest.url;
  if (url !== latest.url) return { ok: false, state: "stale-context", context: latest, message: "La dirección de la pestaña cambió durante la operación. No se aplicó el resultado." };
  return { ok: true, context: latest, tab: { ...tab, url, title: tab.title || latest.title } };
}

async function extractCurrentTab(selectionOnly, expectedContext, operationId) {
  const validated = await validateCurrentTabContext(expectedContext);
  if (!validated.ok) return { ...validated, operationId };
  const { tab, context } = validated;
  const classification = classifyTab({ ...tab, url: context.url, title: context.title || tab.title });
  if (classification.kind === "restricted") {
    return { ok: false, state: "restricted", type: "restricted", title: context.title, operationId, message: "Edge restringe esta página. Usa el selector de archivos o pega el texto en el editor." };
  }
  if (selectionOnly && ["pdf", "local-pdf"].includes(classification.kind)) {
    return {
      ok: false, state: "selection-unavailable", type: classification.kind,
      title: classification.kind === "local-pdf" ? "PDF local" : "PDF", operationId,
      message: "Edge no permite leer directamente la selección de este visor. Selecciona el texto en el PDF, pulsa Ctrl+C y pégalo en el editor con Ctrl+V."
    };
  }
  if (classification.kind === "local-text-document") {
    return { ok: false, state: "local-document", type: "local-document", title: context.title, operationId, message: "Edge no permite extraer este archivo local desde el visor. Usa el selector de archivos." };
  }
  if (classification.kind === "permission-required") {
    return { ok: false, state: "tabs-permission-required", type: "permission-required", title: context.title, operationId, message: "Edge no expuso la dirección de esta pestaña. Activa «Seguir pestaña activa» o vuelve a abrir el lector desde ella." };
  }
  if (classification.kind === "local-pdf") {
    const fileAccessAllowed = await isFileSchemeAccessAllowed();
    if (fileAccessAllowed !== true) {
      return {
        ok: false, state: fileAccessAllowed === false ? "file-access-disabled" : "file-access-unknown",
        type: "local-pdf", title: context.title, operationId,
        message: fileAccessAllowed === false
          ? "Activa «Permitir el acceso a direcciones URL de archivo» en los detalles de la extensión o selecciona el PDF original manualmente."
          : "Edge no pudo confirmar el acceso al PDF local. Selecciona el PDF original manualmente."
      };
    }
    return {
      ok: true, state: "local-pdf-target", targetTab: { id: tab.id, url: context.url, title: context.title || "PDF local" },
      targetToken: context.documentToken, documentContext: contextIdentity(context), fileAccessAllowed: true,
      type: "local-pdf", operationId
    };
  }

  const hostPattern = hostPermissionPattern(context.url);
  if (hostPattern && !(await hasPermission({ origins: [hostPattern] }))) {
    return {
      ok: false, state: "site-permission-required", type: classification.kind,
      title: context.title, hostPattern, operationId,
      message: "Se necesita permiso para leer esta página. Autorízalo desde el aviso de Edge y vuelve a intentarlo."
    };
  }
  if (classification.kind === "pdf") {
    return {
      ok: true, state: "pdf-target", targetTab: { id: tab.id, url: context.url, title: context.title || "PDF" },
      targetToken: context.documentToken, documentContext: contextIdentity(context), type: "pdf", operationId
    };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: context.tabId, frameIds: [0] },
      func: extractReadablePage,
      args: [{ selectionOnly, maxCharacters: 200_000 }]
    });
    const stillCurrent = await validateCurrentTabContext(expectedContext);
    if (!stillCurrent.ok) return { ...stillCurrent, operationId };
    const page = results?.[0]?.result;
    if (!page || typeof page.text !== "string") {
      return { ok: false, state: "no-text", type: classification.kind, title: context.title, operationId, message: "La pestaña no devolvió texto accesible. Puedes pegarlo o cargar el documento con el selector." };
    }
    const text = page.text.replace(/\u0000/g, "");
    if (!text.trim()) {
      const state = selectionOnly ? "no-selection" : "no-text";
      const message = selectionOnly
        ? "No hay texto seleccionado disponible. Selecciona texto en la página o usa el menú contextual «Enviar selección al lector local»."
        : page.type === "google-docs"
          ? "Google Docs no expuso texto accesible en esta vista. Prueba Importar selección, copia y pega el texto o descarga DOCX/PDF."
          : "No se encontró texto accesible. Usa el archivo original o pega el texto en el editor.";
      return { ok: false, state, type: page.type || classification.kind, title: page.title || context.title, operationId, message };
    }
    const limited = text.slice(0, 200_000);
    return {
      ok: true, state: "complete", title: page.title || context.title || "Pestaña actual",
      sourceUrl: safeSourceUrl(context.url), type: page.type || classification.kind,
      coverage: page.coverage || "page-text", visiblePageCount: Number(page.visiblePageCount) || 0,
      inaccessibleFrameCount: Number(page.inaccessibleFrameCount) || 0,
      characters: limited.length, truncated: Boolean(page.truncated || text.length > 200_000),
      text: limited, operationId,
      message: page.type === "google-docs-visible"
        ? "Google Docs: se obtuvo solo el texto visible y accesible en esta vista. Para una copia completa, descarga DOCX/PDF."
        : selectionOnly
          ? "Selección recibida desde la pestaña activa. Revisa el texto antes de importarlo."
          : "Extracción completada. Revisa el texto antes de importarlo."
    };
  } catch (error) {
    const message = String(error?.message || "");
    const isPermissionError = /cannot access|not allowed|permission|restricted|cannot be scripted|extensions gallery/i.test(message);
    return {
      ok: false, state: isPermissionError ? "site-permission-required" : "extraction-error",
      type: classification.kind, title: context.title, operationId,
      message: isPermissionError
        ? "Edge no permitió acceder a esta página. Comprueba el permiso de sitio y vuelve a intentarlo."
        : "Falló la extracción local. Puedes pegar el texto o descargar el documento y cargarlo manualmente."
    };
  }
}

async function extractAuthorizedTab(selectionOnly) {
  const validated = await validateImportTarget();
  if (!validated.ok) return validated;
  const { target, tab } = validated;
  const classification = classifyTab(tab);
  if (selectionOnly && ["pdf", "local-pdf"].includes(classification.kind)) {
    return {
      ok: false, state: "selection-unavailable", type: classification.kind, title: classification.kind === "local-pdf" ? "PDF local" : "PDF",
      message: "Edge no permite leer directamente la selección de este visor. Selecciona el texto en el PDF, pulsa Ctrl+C y pégalo en el editor con Ctrl+V."
    };
  }
  if (classification.kind === "pdf") return { ok: true, state: "pdf-target", targetTab: { id: tab.id, url: tab.url, title: tab.title || "PDF" }, targetToken: target.token, type: "pdf" };
  if (classification.kind === "local-pdf") {
    if (selectionOnly) {
      return { ok: false, state: "selection-unavailable", type: "local-pdf", title: tab.title || target.title, message: "El visor PDF de Edge no expone selecciones mediante scripting. Usa Importar pestaña actual o selecciona el archivo original." };
    }
    const fileAccess = await isFileSchemeAccessAllowed();
    if (fileAccess === false) {
      return {
        ok: false, state: "file-access-disabled", type: "local-pdf", title: tab.title || target.title,
        message: "El acceso a archivos locales está desactivado. En edge://extensions abre Detalles de esta extensión y activa ‘Permitir el acceso a direcciones URL de archivo’; luego pulsa ‘Volver a comprobar el permiso’. También puedes seleccionar el PDF manualmente."
      };
    }
    if (fileAccess !== true) {
      return {
        ok: false, state: "file-access-unknown", type: "local-pdf", title: tab.title || target.title,
        message: "Edge no pudo confirmar el permiso para leer archivos locales. Puedes volver a comprobar el permiso o seleccionar el PDF manualmente."
      };
    }
    return {
      ok: true, state: "local-pdf-target",
      targetTab: { id: tab.id, url: tab.url, title: tab.title || "PDF local" },
      targetToken: target.token, type: "local-pdf", fileAccessAllowed: true
    };
  }
  if (["restricted", "permission-required", "local-document"].includes(classification.kind)) {
    return { ok: false, state: classification.kind, type: classification.kind, title: tab.title || target.title, sourceUrl: safeSourceUrl(tab.url), message: classification.message };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: target.tabId, frameIds: [0] },
      func: extractReadablePage,
      args: [{ selectionOnly, maxCharacters: 200_000 }]
    });
    const stillCurrent = await readImportTarget();
    const currentTab = await chrome.tabs.get(target.tabId).catch(() => null);
    if (!stillCurrent || stillCurrent.token !== target.token || currentTab?.url !== target.url) {
      await clearImportTarget(target.tabId);
      return { ok: false, state: "stale-target", title: target.title, message: "La pestaña cambió durante la extracción. No se usó el resultado; vuelve a invocar la extensión desde la página deseada." };
    }
    const page = results?.[0]?.result;
    if (!page || typeof page.text !== "string") return { ok: false, state: "no-text", title: tab.title || target.title, message: "La pestaña no devolvió texto accesible. Puedes pegarlo o descargar el documento y cargarlo con el selector." };
    const text = page.text.replace(/\u0000/g, "");
    if (!text.trim()) {
      const state = selectionOnly ? "no-selection" : "no-text";
      const message = page.type === "google-docs"
        ? "Google Docs no expuso texto accesible del documento en esta vista. Prueba Importar selección, copia y pega el texto o descarga el archivo como DOCX/PDF."
        : selectionOnly
          ? "No hay texto seleccionado disponible en la pestaña autorizada. Selecciona texto en la página o usa el menú contextual ‘Enviar selección al lector local’."
          : "No se encontró texto accesible. Puede ser un visor protegido o una aplicación que dibuja el documento en un canvas; usa el archivo original o pega el texto.";
      return { ok: false, state, type: page.type || classification.kind, title: page.title || tab.title || target.title, sourceUrl: safeSourceUrl(tab.url), message };
    }
    const limited = text.slice(0, 200_000);
    const googleDocsPartial = page.type === "google-docs-visible";
    return {
      ok: true,
      state: "complete",
      title: page.title || tab.title || "Pestaña actual",
      sourceUrl: safeSourceUrl(tab.url),
      type: page.type || classification.kind,
      coverage: page.coverage || "page-text",
      visiblePageCount: Number(page.visiblePageCount) || 0,
      inaccessibleFrameCount: Number(page.inaccessibleFrameCount) || 0,
      characters: limited.length,
      truncated: Boolean(page.truncated || text.length > 200_000),
      text: limited,
      message: googleDocsPartial
        ? "Google Docs: se obtuvo solo el texto visible y accesible en esta vista; no se garantiza el documento completo. Para una copia completa, descárgalo como DOCX/PDF."
        : selectionOnly
          ? "Selección recibida desde la pestaña autorizada. Revisa el texto antes de importarlo."
          : "Extracción completada. Revisa el texto antes de importarlo."
    };
  } catch (error) {
    const message = String(error?.message || "");
    const isPermissionError = /cannot access|not allowed|permission|restricted|cannot be scripted|extensions gallery/i.test(message);
    const localFile = classification.kind === "local-text-document";
    return {
      ok: false,
      state: isPermissionError ? "permission-required" : "extraction-error",
      type: classification.kind,
      title: tab.title || target.title,
      sourceUrl: safeSourceUrl(tab.url),
      message: localFile
        ? "Edge bloqueó el acceso desde la pestaña file://. Para TXT o Markdown, usa el selector de archivos; habilitar ‘Permitir acceso a URL de archivo’ puede autorizar páginas locales, pero no concede acceso al visor PDF integrado."
        : isPermissionError
        ? "Edge no permitió acceder a esta página. Vuelve a la pestaña y pulsa el icono de la extensión para autorizar el acceso temporal."
        : "Falló la extracción local. Puedes pegar el texto o descargar el documento y cargarlo manualmente."
    };
  }
}

async function setupContextMenu() {
  if (!chrome.contextMenus) return;
  if (!creatingContextMenu) {
    creatingContextMenu = (async () => {
      await chrome.contextMenus.removeAll().catch(() => {});
      chrome.contextMenus.create({
        id: SELECTION_MENU_ID,
        title: "Enviar selección al lector local",
        contexts: ["selection"]
      });
    })().finally(() => { creatingContextMenu = null; });
  }
  await creatingContextMenu;
}

chrome.runtime.onInstalled.addListener(() => { void setupContextMenu(); });
void setupContextMenu();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
void restoreFollowState();

chrome.action.onClicked.addListener((tab) => openPanelForTab(tab));

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (followActiveTab && Number.isInteger(followWindowId) && windowId !== followWindowId) return;
  if (!followActiveTab && Number.isInteger(activeTabContext?.windowId) && windowId !== activeTabContext.windowId) return;
  void refreshContextForTab(tabId, windowId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const navigated = Boolean(changeInfo.url || changeInfo.status === "loading");
  if (navigated) {
    if (inMemoryImportTarget?.tabId === tabId) inMemoryImportTarget = null;
    documentTokens.delete(tabId);
    void clearImportTarget(tabId).then(() => {
      const sameWindow = followActiveTab
        ? tab?.windowId === followWindowId
        : tab?.windowId === activeTabContext?.windowId;
      if (sameWindow && (tab?.active || activeTabContext?.tabId === tabId)) {
        void refreshContextForTab(tabId, tab?.windowId, { forceNewDocument: true });
      }
    });
    return;
  }
  const sameWindow = followActiveTab
    ? tab?.windowId === followWindowId
    : tab?.windowId === activeTabContext?.windowId;
  const hasFaviconUpdate = Object.prototype.hasOwnProperty.call(changeInfo, "favIconUrl");
  if (sameWindow && tab?.active && (changeInfo.title || hasFaviconUpdate || changeInfo.status === "complete")) {
    void refreshContextForTab(tabId, tab.windowId, {
      faviconChanged: hasFaviconUpdate,
      faviconSettled: changeInfo.status === "complete"
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo = {}) => {
  void clearImportTarget(tabId);
  documentTokens.delete(tabId);
  if (activeTabContext?.tabId !== tabId && !followActiveTab) return;
  const windowId = Number.isInteger(removeInfo.windowId) ? removeInfo.windowId : followWindowId;
  if (followActiveTab && Number.isInteger(followWindowId) && windowId !== followWindowId) return;
  void refreshActiveTabContext({ windowId: Number.isInteger(windowId) ? windowId : null });
});

chrome.permissions?.onAdded?.addListener(() => {
  if (followActiveTab && !followWindowId) void restoreFollowState();
  else void refreshActiveTabContext({ windowId: followWindowId });
});

chrome.permissions?.onRemoved?.addListener((removed) => {
  if (removed.permissions?.includes("tabs")) {
    followActiveTab = false;
    followWindowId = null;
    void chrome.storage.local.set({ [FOLLOW_ACTIVE_TAB_KEY]: false }).catch(() => {});
  }
  void refreshActiveTabContext({ windowId: followWindowId });
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== SELECTION_MENU_ID || !tab?.id) return;
  const selection = String(info.selectionText || "");
  openPanelForTab(tab, selection, true);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "background") return undefined;
  const run = async () => {
    if (message.command === "get-active-tab-context") {
      const windowId = followActiveTab && Number.isInteger(followWindowId)
        ? followWindowId
        : Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null;
      const context = await refreshActiveTabContext({ windowId });
      return { ok: true, following: followActiveTab, context };
    }
    if (message.command === "set-follow-active-tab") {
      const windowId = Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null;
      return setFollowActiveTab(Boolean(message.enabled), windowId);
    }
    if (message.command === "extract-current-tab") {
      return extractCurrentTab(Boolean(message.selectionOnly), message.context, message.operationId);
    }
    if (message.command === "validate-current-import") {
      const result = await validateCurrentTabContext(message.context);
      return { ...result, operationId: message.operationId };
    }
    if (message.command === "extract-tab") return extractAuthorizedTab(Boolean(message.selectionOnly));
    if (message.command === "get-import-target") {
      const validated = await validateImportTarget();
      return validated.ok
        ? { ok: true, target: { title: validated.tab.title || validated.target.title, url: safeSourceUrl(validated.tab.url), tabId: validated.tab.id } }
        : validated;
    }
    if (message.command === "validate-import-target") {
      const validated = await validateImportTarget();
      if (!validated.ok) return validated;
      if (message.expectedToken && validated.target.token !== message.expectedToken) {
        return { ok: false, state: "stale-target", message: "La pestaña objetivo cambió durante la lectura del PDF. Vuelve a invocar la extensión desde la pestaña deseada." };
      }
      return { ok: true, targetToken: validated.target.token };
    }
    if (message.command === "take-pending-selection") {
      let pending = null;
      try {
        const stored = await chrome.storage.session.get(PENDING_SELECTION_KEY);
        pending = stored[PENDING_SELECTION_KEY] || null;
        if (pending) await chrome.storage.session.remove(PENDING_SELECTION_KEY);
      } catch { /* No pending selection on browsers without session storage. */ }
      return pending ? { ok: true, selection: pending } : { ok: true, selection: null };
    }
    if (message.command === "status") return sendOffscreen("status", {}, { create: false });
    if (message.command === "stop") {
      const result = await sendOffscreen("stop", {}, { create: false });
      await chrome.offscreen.closeDocument().catch(() => {});
      return result;
    }
    if (message.command === "replace") return sendOffscreen("replace", message.payload || {}, { create: true });
    if (message.command === "delete-model") {
      const result = await sendOffscreen("delete-model", {}, { create: true });
      return result;
    }
    const needsContext = [
      "start", "preview", "initialize", "restore", "piper-catalog", "piper-model-status",
      "list-installed-piper-models", "install-piper-model", "delete-piper-model", "clear-audio-cache", "voice-preparation-status"
    ].includes(message.command);
    return sendOffscreen(message.command, message.payload || {}, { create: needsContext });
  };
  void run().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || "Falló la coordinación del lector." }));
  return true;
});
