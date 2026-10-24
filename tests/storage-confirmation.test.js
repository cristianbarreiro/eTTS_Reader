import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  kokoroModelDeleteConfirmation,
  piperModelDeleteConfirmation,
  savedAudioDeleteConfirmation
} from "../src/library-confirmation.js";

const main = await readFile(fileURLToPath(new URL("../src/main.js", import.meta.url)), "utf8");
const engine = await readFile(fileURLToPath(new URL("../src/persistent-engine.js", import.meta.url)), "utf8");
const kokoro = await readFile(fileURLToPath(new URL("../src/tts.js", import.meta.url)), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start + 1);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  assert.notEqual(end, -1, `missing ${endMarker}`);
  return main.slice(start, end);
}

const audioHandler = sourceBetween('ui.deleteAudioCache.addEventListener("click"', 'ui.deleteModel.addEventListener("click"');
const kokoroHandler = sourceBetween('ui.deleteModel.addEventListener("click"', 'ui.deletePiperModel?.addEventListener("click"');
const piperHandler = sourceBetween('ui.deletePiperModel?.addEventListener("click"', "function showError(");

test("storage deletion confirmations identify what is removed and what remains", () => {
  const audio = savedAudioDeleteConfirmation();
  assert.equal(audio.title, "¿Eliminar los audios guardados?");
  assert.equal(audio.confirmLabel, "Eliminar audios");
  assert.equal(audio.cancelLabel, "Cancelar");
  assert.match(audio.message, /documentos, las sesiones de lectura y los modelos de voz instalados se conservarán/);

  const piper = piperModelDeleteConfirmation("Español · Daniela · Argentina");
  assert.equal(piper.title, "¿Eliminar el modelo Piper?");
  assert.equal(piper.confirmLabel, "Eliminar modelo");
  assert.match(piper.message, /Daniela/);
  assert.match(piper.message, /modelos de otros proveedores se conservarán/);
  assert.match(piper.message, /descargar el modelo de nuevo/);

  const kokoro = kokoroModelDeleteConfirmation();
  assert.equal(kokoro.title, "¿Eliminar el modelo Kokoro?");
  assert.equal(kokoro.confirmLabel, "Eliminar modelo");
  assert.match(kokoro.message, /modelos Piper, los audios guardados, los documentos y las sesiones se conservarán/);
  assert.match(kokoro.message, /preparar sus recursos otra vez/);
});

test("saved-audio confirmation only runs the existing audio cleanup and refreshes links and metrics", () => {
  assert.match(audioHandler, /confirmDestructiveAction\(/);
  assert.match(audioHandler, /savedAudioDeleteConfirmation\(\)/);
  assert.match(audioHandler, /onConfirm: async \(\) =>/);
  assert.match(audioHandler, /player\.clearAudioCache\(\)/);
  assert.match(audioHandler, /refreshDownloadLink\(null\)/);
  assert.match(audioHandler, /refreshStorageUsage\(\)/);
  assert.doesNotMatch(audioHandler, /\b(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(audioHandler, /(?:caches\.delete|deleteModel|deletePiperModel|repository\.deleteDocument|repository\.deleteSession)\s*\(/);
  const cacheCommand = engine.slice(engine.indexOf('case "clear-audio-cache":'), engine.indexOf('case "preview":'));
  assert.match(cacheCommand, /isAudioStorageBusy\(/);
  assert.match(cacheCommand, /this\.audioCacheMaintenance = true/);
  assert.match(cacheCommand, /await this\.repository\.clearAudioCache\(\)/);
  assert.match(cacheCommand, /finally\s*\{\s*this\.audioCacheMaintenance = false/s);
});

test("Kokoro deletion clears only its caches under the engine lock and never touches Piper resources", () => {
  assert.match(kokoroHandler, /confirmDestructiveAction\(/);
  assert.match(kokoroHandler, /kokoroModelDeleteConfirmation\(\)/);
  assert.match(kokoroHandler, /player\.deleteModel\(\)/);
  assert.match(kokoroHandler, /refreshStorageUsage\(\)/);
  assert.doesNotMatch(kokoroHandler, /\b(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(kokoroHandler, /(?:deletePiperModel|clearAudioCache|repository\.deleteDocument|repository\.deleteSession)\s*\(/);
  assert.doesNotMatch(kokoroHandler, /(?:caches\.delete|chrome\.storage\.local\.remove)\s*\(/);
  assert.doesNotMatch(kokoroHandler, /player\.stop\(/);

  const deleteCommand = engine.slice(engine.indexOf('case "delete-model":'), engine.indexOf('case "start":'));
  assert.match(deleteCommand, /_withProviderMaintenance\("kokoro"/);
  assert.match(deleteCommand, /await this\.inference\.deleteKokoroModel\(\)/);
  assert.match(deleteCommand, /await this\.storage\.remove\("modelCached"\)/);
  assert.match(kokoro, /const CACHE_KEY = "edge-local-reader-kokoro-v1"/);
  assert.match(kokoro, /const VOICE_CACHE_KEY = "kokoro-voices"/);
  assert.match(kokoro, /globalThis\.caches\.delete\(CACHE_KEY\), globalThis\.caches\.delete\(VOICE_CACHE_KEY\)/);
});

test("Piper deletion targets the selected voice and keeps audio, Kokoro, documents, and sessions", () => {
  assert.match(piperHandler, /confirmDestructiveAction\(/);
  assert.match(piperHandler, /piperModelDeleteConfirmation\(voice\.label\)/);
  assert.match(piperHandler, /player\.deletePiperModel\(voiceId\)/);
  assert.match(piperHandler, /refreshStorageUsage\(\)/);
  assert.doesNotMatch(piperHandler, /\b(?:window\.)?confirm\s*\(/);
  assert.doesNotMatch(piperHandler, /(?:deleteModel|clearAudioCache|caches\.delete|repository\.deleteDocument|repository\.deleteSession)\s*\(/);
});
