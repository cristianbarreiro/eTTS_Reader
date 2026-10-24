import test from "node:test";
import assert from "node:assert/strict";
import { attachPiperWorker } from "../src/piper-tts-worker.js";
import { resolvePiperAssetPaths } from "../src/piper-worker-client.js";

test("Piper runtime and phonemizer assets resolve relative to either extension root layout", () => {
  assert.deepEqual(resolvePiperAssetPaths("chrome-extension://abc/dist/assets/offscreen.js"), {
    onnxWasm: "chrome-extension://abc/dist/ort/piper/",
    phonemizeWasm: "chrome-extension://abc/dist/piper/piper_phonemize.wasm",
    phonemizeData: "chrome-extension://abc/dist/piper/piper_phonemize.data"
  });
  assert.deepEqual(resolvePiperAssetPaths("chrome-extension://abc/assets/offscreen.js"), {
    onnxWasm: "chrome-extension://abc/ort/piper/",
    phonemizeWasm: "chrome-extension://abc/piper/piper_phonemize.wasm",
    phonemizeData: "chrome-extension://abc/piper/piper_phonemize.data"
  });
});

function makeWorkerHarness(provider) {
  const messages = [];
  let listener;
  const scope = {
    addEventListener(type, callback) { assert.equal(type, "message"); listener = callback; },
    removeEventListener(type, callback) { if (type === "message" && listener === callback) listener = null; },
    postMessage(message) { messages.push(message); }
  };
  const detach = attachPiperWorker(scope, provider);
  return {
    messages,
    detach,
    async send(data) { await listener({ data }); }
  };
}

test("Piper worker initializes an installed voice, forwards progress, and synthesizes with its packaged paths", async () => {
  const calls = [];
  const provider = {
    catalog: () => [{ id: "piper:test" }],
    modelStore: { async listInstalled() { return ["piper:test"]; } },
    async modelStatus(id) { return { id, installed: true }; },
    async installModel(id, progress) { progress({ loaded: 10, total: 20 }); return { id, installed: true }; },
    async initialize(id, paths) { calls.push({ type: "initialize", id, paths }); return { provider: "piper", ready: true }; },
    async synthesize(text, id, paths) { calls.push({ type: "synthesize", text, id, paths }); return new Blob(["wav"], { type: "audio/wav" }); },
    async removeModel(id) { return { id, installed: false }; },
    async dispose() { calls.push({ type: "dispose" }); }
  };
  const harness = makeWorkerHarness(provider);
  const paths = { onnxWasm: "extension://ort/piper/", phonemizeWasm: "extension://piper/a.wasm", phonemizeData: "extension://piper/a.data" };

  await harness.send({ id: 1, type: "initialize", voiceId: "piper:test", wasmPaths: paths });
  assert.deepEqual(harness.messages.at(-1), { id: 1, type: "result", value: { provider: "piper", ready: true } });
  assert.deepEqual(calls[0], { type: "initialize", id: "piper:test", paths });

  await harness.send({ id: 2, type: "synthesize", voiceId: "piper:test", text: "Hola." });
  assert.equal(calls[1].paths, paths, "the worker retains the extension-local paths configured at initialization");
  assert.equal(calls[1].text, "Hola.");
  assert.equal(harness.messages.at(-1).value.type, "audio/wav");

  await harness.send({ id: 3, type: "install", voiceId: "piper:test" });
  assert.deepEqual(harness.messages.slice(-2), [
    { id: 3, type: "progress", event: { loaded: 10, total: 20 } },
    { id: 3, type: "result", value: { id: "piper:test", installed: true } }
  ]);
  harness.detach();
});

test("Piper worker reports initialization and unknown-command errors through its request id", async () => {
  const provider = {
    modelStore: { async listInstalled() { return []; } },
    async initialize() { throw new Error("Falta el modelo instalado."); }
  };
  const harness = makeWorkerHarness(provider);
  await harness.send({ id: 41, type: "initialize", voiceId: "piper:test", wasmPaths: {} });
  assert.deepEqual(harness.messages.at(-1), { id: 41, type: "error", message: "Falta el modelo instalado." });
  await harness.send({ id: 42, type: "unknown" });
  assert.deepEqual(harness.messages.at(-1), { id: 42, type: "error", message: "Comando Piper desconocido: unknown" });
  harness.detach();
});
