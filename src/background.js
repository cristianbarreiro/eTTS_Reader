const PANEL_PATH = chrome.runtime.getManifest().side_panel?.default_path || "sidepanel.html";
const OFFSCREEN_PATH = `${PANEL_PATH.slice(0, PANEL_PATH.lastIndexOf("/") + 1)}offscreen.html`;
let creatingOffscreen = null;

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

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") return undefined;
  const run = async () => {
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
