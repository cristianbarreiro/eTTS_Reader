import { ReaderRepository } from "./persistence.js";
import { KokoroWorkerClient } from "./tts-worker-client.js";
import { SystemSpeechProvider } from "./system-speech.js";
import { TTSProviderRouter } from "./tts-router.js";
import { PersistentReaderEngine } from "./persistent-engine.js";

const repository = new ReaderRepository();
const speech = new SystemSpeechProvider();
const inference = new TTSProviderRouter({ kokoro: new KokoroWorkerClient(), systemSpeech: speech });
const engine = new PersistentReaderEngine({
  audio: document.querySelector("#audio"),
  repository,
  inference,
  speech,
  publish: (message) => { void chrome.runtime.sendMessage(message).catch(() => {}); }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return undefined;
  void engine.handleCommand(message).then(sendResponse).catch((error) => sendResponse({
    ok: false,
    error: error?.message || "Falló el motor de lectura local."
  }));
  return true;
});
