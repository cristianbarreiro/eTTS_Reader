import test from "node:test";
import assert from "node:assert/strict";
import { attachPiperWorker } from "../src/piper-tts-worker.js";
import { PiperWorkerClient, resolvePiperAssetPaths } from "../src/piper-worker-client.js";

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
  assert.deepEqual(harness.messages.at(-1), { id: 41, type: "error", code: "PIPER_WORKER_OPERATION_FAILED", phase: null, message: "Falta el modelo instalado." });
  await harness.send({ id: 42, type: "unknown" });
  assert.deepEqual(harness.messages.at(-1), { id: 42, type: "error", code: "PIPER_WORKER_OPERATION_FAILED", phase: null, message: "Comando Piper desconocido: unknown" });
  harness.detach();
});

test("a timed-out initialization terminates its worker and the operation queue can create a fresh worker", async () => {
  const voiceId = "piper:es_AR-daniela-high";
  const workers = [];
  const client = new PiperWorkerClient({
    timeouts: { initializeMs: 12, statusMs: 30 },
    workerFactory: () => {
      const worker = {
        postMessage(message) {
          if (message.type === "initialize" && workers.length === 1) queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "progress", event: { phase: "initialize", stage: "reading-model", indeterminate: true } } }));
          if (workers.length > 1 && message.type === "status") queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "result", value: { voiceId, installed: true } } }));
        },
        terminate() { this.terminated = true; }
      };
      workers.push(worker);
      return worker;
    }
  });

  await assert.rejects(client.initialize(voiceId), (error) => error.code === "PIPER_INITIALIZATION_TIMEOUT" && error.phase === "reading-model");
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  assert.equal(client.initializedVoice, null);
  assert.equal(client.pending.size, 0);

  const status = await client.modelStatus(voiceId);
  assert.deepEqual(status, { voiceId, installed: true });
  assert.equal(workers.length, 2, "the next operation creates a replacement worker");
  assert.equal(client.pending.size, 0);
  client.dispose();
});

test("reset rejects every pending request, clears timers, and ignores late messages from the old worker", async () => {
  const timers = new Map();
  let sequence = 0;
  let oldWorker;
  const client = new PiperWorkerClient({
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    workerFactory: () => (oldWorker = {
      postMessage() {},
      terminate() { this.terminated = true; }
    })
  });

  const first = client._request("initialize", { voiceId: "piper:test" });
  const second = client._request("status", { voiceId: "piper:test" });
  const oldMessageHandler = oldWorker.onmessage;
  const outcomes = [first, second].map((request) => request.then(() => null, (error) => error));
  client.reset();
  const errors = await Promise.all(outcomes);

  assert.equal(oldWorker.terminated, true);
  assert.equal(client.pending.size, 0);
  assert.equal(timers.size, 0);
  assert.ok(errors.every((error) => error.code === "PIPER_WORKER_RESET"));
  oldMessageHandler({ data: { id: 1, type: "result", value: { ready: true } } });
  assert.equal(client.initializedVoice, null);
  assert.equal(client.worker, null);
});

test("download progress renews inactivity timeout while a silent worker is terminated", async () => {
  let workersCreated = 0;
  const progressing = new PiperWorkerClient({
    timeouts: { downloadIdleMs: 80, downloadMaxMs: 200 },
    workerFactory: () => {
      workersCreated++;
      return {
        postMessage(message) {
          setTimeout(() => this.onmessage({ data: { id: message.id, type: "progress", event: { loaded: 1, total: 2 } } }), 10);
          setTimeout(() => this.onmessage({ data: { id: message.id, type: "progress", event: { loaded: 2, total: 2 } } }), 30);
          setTimeout(() => this.onmessage({ data: { id: message.id, type: "result", value: { installed: true } } }), 50);
        }, terminate() {}
      };
    }
  });
  assert.deepEqual(await progressing.installModel("piper:test"), { installed: true });
  progressing.dispose();

  let stalledWorker;
  const stalled = new PiperWorkerClient({
    timeouts: { downloadIdleMs: 10, downloadMaxMs: 100 },
    workerFactory: () => (stalledWorker = { postMessage() {}, terminate() { this.terminated = true; } })
  });
  await assert.rejects(stalled.installModel("piper:test"), (error) => error.code === "PIPER_DOWNLOAD_TIMEOUT");
  assert.equal(stalledWorker.terminated, true);
  assert.equal(stalled.pending.size, 0);
  assert.equal(workersCreated, 1);
});
