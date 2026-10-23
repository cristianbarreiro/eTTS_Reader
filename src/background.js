import { classifyTab, extractReadablePage, safeSourceUrl } from "./tab-import.js";

const PANEL_PATH = chrome.runtime.getManifest().side_panel?.default_path || "sidepanel.html";
const OFFSCREEN_PATH = `${PANEL_PATH.slice(0, PANEL_PATH.lastIndexOf("/") + 1)}offscreen.html`;
const IMPORT_TARGET_KEY = "tabImportTarget";
const PENDING_SELECTION_KEY = "pendingTabSelection";
const SELECTION_MENU_ID = "send-selection-to-local-reader";
let creatingOffscreen = null;
let creatingContextMenu = null;
let inMemoryImportTarget = null;

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

function openPanelForTab(tab, selectionText = "", captureSelection = false) {
  const target = captureTab(tab);
  if (!target) return;

  // Call openPanel synchronously from the user gesture so Edge retains that gesture.
  void chrome.sidePanel.open({ tabId: target.tabId }).catch(() => {});
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
    return {
      ok: false,
      state: looksLikePdf ? "local-pdf" : "permission-required",
      type: looksLikePdf ? "local-pdf" : "permission-required",
      title,
      message: looksLikePdf
        ? "El visor PDF de Edge no expuso una dirección o bytes que la extensión pueda leer. Usa ‘Elegir archivo para importar’ y selecciona el PDF original."
        : "Edge no expuso la dirección de la pestaña autorizada. Vuelve a esa pestaña y pulsa el icono de la extensión para conceder acceso temporal."
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

async function extractAuthorizedTab(selectionOnly) {
  const validated = await validateImportTarget();
  if (!validated.ok) return validated;
  const { target, tab } = validated;
  const classification = classifyTab(tab);
  if (classification.kind === "pdf") return { ok: true, state: "pdf-target", targetTab: { id: tab.id, url: tab.url, title: tab.title || "PDF" }, targetToken: target.token, type: "pdf" };
  if (["restricted", "permission-required", "local-pdf", "local-document"].includes(classification.kind)) {
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

chrome.action.onClicked.addListener((tab) => openPanelForTab(tab));

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "loading") void clearImportTarget(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { void clearImportTarget(tabId); });

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== SELECTION_MENU_ID || !tab?.id) return;
  const selection = String(info.selectionText || "");
  openPanelForTab(tab, selection, true);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") return undefined;
  const run = async () => {
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
    if (message.command === "replace") return sendOffscreen("replace", message.payload || {}, { create: false });
    if (message.command === "delete-model") {
      const result = await sendOffscreen("close-idle", {}, { create: false });
      return result;
    }
    const needsContext = ["start", "preview", "initialize"].includes(message.command);
    return sendOffscreen(message.command, message.payload || {}, { create: needsContext });
  };
  void run().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || "Falló la coordinación del lector." }));
  return true;
});
