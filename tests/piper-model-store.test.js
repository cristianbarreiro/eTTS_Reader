import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PiperModelStore, PIPER_MANIFEST_FILE, PIPER_OPFS_DIRECTORY } from "../src/piper-model-store.js";
import { PIPER_VOICE_CATALOG } from "../src/voice-catalog.js";

class MemoryFileHandle {
  constructor(directory, name) { this.directory = directory; this.name = name; }
  async getFile() {
    const blob = this.directory.entries.get(this.name);
    if (!blob) throw new DOMException("File not found", "NotFoundError");
    return blob;
  }
  async createWritable() {
    const chunks = [];
    return {
      write: async (value) => chunks.push(typeof value === "string" ? new TextEncoder().encode(value) : value),
      close: async () => this.directory.entries.set(this.name, new Blob(chunks)),
      abort: async () => chunks.splice(0)
    };
  }
}

class MemoryDirectoryHandle {
  entries = new Map();
  directories = new Map();
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.directories.has(name)) {
      if (!create) throw new DOMException("Directory not found", "NotFoundError");
      this.directories.set(name, new MemoryDirectoryHandle());
    }
    return this.directories.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!create && !this.entries.has(name)) throw new DOMException("File not found", "NotFoundError");
    return new MemoryFileHandle(this, name);
  }
  async removeEntry(name) {
    if (!this.entries.delete(name)) throw new DOMException("File not found", "NotFoundError");
  }
}

const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const voice = {
  ...PIPER_VOICE_CATALOG[0],
  modelRevision: "0123456789abcdef0123456789abcdef01234567",
  modelPath: "es/test/voice/test.onnx",
  modelSizeBytes: bytes.byteLength,
  modelSha256: hash(bytes)
};
const config = {
  audio: { sample_rate: 22050 }, language: { code: "es_AR" }, phoneme_type: "espeak",
  espeak: { voice: "es-419" }, phoneme_id_map: { _: [0], h: [1] },
  inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 }
};
const responseWithBytes = (value, chunkSize = 3) => new Response(new ReadableStream({
  start(controller) {
    for (let offset = 0; offset < value.byteLength; offset += chunkSize) controller.enqueue(value.slice(offset, offset + chunkSize));
    controller.close();
  }
}), { status: 200, headers: { "content-length": String(value.byteLength) } });

function makeStore(fetchImpl, storage = { async getDirectory() { return new MemoryDirectoryHandle(); } }) {
  return new PiperModelStore({ storage, fetchImpl, catalog: [voice], now: () => 123 });
}

test("Piper downloads a pinned model, validates its config and SHA-256, and stores it in OPFS", async () => {
  const root = new MemoryDirectoryHandle();
  const calls = [];
  const progress = [];
  const store = makeStore(async (url) => {
    calls.push(url);
    if (url.endsWith(".onnx.json")) return new Response(JSON.stringify(config), { status: 200 });
    return responseWithBytes(bytes, 2);
  }, { async getDirectory() { return root; } });

  const installed = await store.install(voice.id, (event) => progress.push(event));
  assert.equal(installed.installed, true);
  assert.equal(installed.modelSizeBytes, bytes.byteLength);
  assert.equal(installed.modelRevision, voice.modelRevision);
  assert.deepEqual(calls, [
    `https://huggingface.co/rhasspy/piper-voices/resolve/${voice.modelRevision}/${voice.modelPath}.json`,
    `https://huggingface.co/rhasspy/piper-voices/resolve/${voice.modelRevision}/${voice.modelPath}`
  ]);
  assert.ok(progress.length >= 3);
  assert.equal(progress.at(-1).progress, 100);

  const directory = await root.getDirectoryHandle(PIPER_OPFS_DIRECTORY);
  const manifest = JSON.parse(await (await directory.getFileHandle(PIPER_MANIFEST_FILE)).getFile().then((file) => file.text()));
  assert.equal(manifest.models[voice.id].sha256, voice.modelSha256);
  assert.equal(manifest.models[voice.id].modelRevision, voice.modelRevision);
  assert.equal((await store.status(voice.id)).installed, true);
  assert.equal(await (await directory.getFileHandle(manifest.models[voice.id].modelFile)).getFile().then((file) => file.size), bytes.byteLength);

  const removed = await store.remove(voice.id);
  assert.equal(removed.installed, false);
  assert.equal((await store.status(voice.id)).installed, false);
});

test("Piper binds fetch to the worker global scope during config and model downloads", async () => {
  const root = new MemoryDirectoryHandle();
  const receivers = [];
  function workerFetch(url) {
    receivers.push(this);
    if (url.endsWith(".onnx.json")) return Promise.resolve(new Response(JSON.stringify(config), { status: 200 }));
    return Promise.resolve(responseWithBytes(bytes));
  }
  const store = new PiperModelStore({
    storage: { async getDirectory() { return root; } },
    fetchImpl: workerFetch,
    catalog: [voice],
    now: () => 123
  });

  assert.equal((await store.install(voice.id)).installed, true);
  assert.deepEqual(receivers, [globalThis, globalThis]);
});

test("removing one Piper voice preserves every other installed Piper model", async () => {
  const root = new MemoryDirectoryHandle();
  const otherVoice = {
    ...voice,
    id: "piper:es_AR-other-high",
    providerVoiceId: "es_AR-other-high",
    label: "Español · Otra voz",
    modelPath: "es/test/voice/other.onnx"
  };
  const store = new PiperModelStore({
    storage: { async getDirectory() { return root; } },
    catalog: [voice, otherVoice],
    fetchImpl: async (url) => url.endsWith(".onnx.json")
      ? new Response(JSON.stringify(config), { status: 200 })
      : responseWithBytes(bytes)
  });

  await store.install(voice.id);
  await store.install(otherVoice.id);
  const removed = await store.remove(voice.id);
  const otherStatus = await store.status(otherVoice.id);
  assert.equal(removed.installed, false);
  assert.equal((await store.status(voice.id)).installed, false);
  assert.equal(otherStatus.installed, true);
  const directory = await root.getDirectoryHandle(PIPER_OPFS_DIRECTORY);
  const manifest = JSON.parse(await (await directory.getFileHandle(PIPER_MANIFEST_FILE)).getFile().then((file) => file.text()));
  assert.deepEqual(Object.keys(manifest.models), [otherVoice.id]);
});

test("Piper accepts a pinned DaveFX v1 config without optional language metadata", async () => {
  const root = new MemoryDirectoryHandle();
  const daveFx = {
    ...PIPER_VOICE_CATALOG[1],
    modelRevision: "fedcba9876543210fedcba9876543210fedcba98",
    modelPath: "es/es_ES/davefx/medium/es_ES-davefx-medium.onnx",
    modelSizeBytes: bytes.byteLength,
    modelSha256: hash(bytes)
  };
  // The pinned upstream revision (2f8dbe0) omits this metadata. Its synthesis
  // fields remain present and match the model; the locale is already pinned
  // by the catalog entry.
  const daveFxConfig = {
    ...config,
    language: undefined,
    espeak: { voice: "es" }
  };
  const store = new PiperModelStore({
    storage: { async getDirectory() { return root; } },
    catalog: [daveFx],
    fetchImpl: async (url) => url.endsWith(".onnx.json")
      ? new Response(JSON.stringify(daveFxConfig), { status: 200 })
      : responseWithBytes(bytes)
  });

  const installed = await store.install(daveFx.id);
  assert.equal(installed.installed, true);
  assert.equal(installed.config.espeak.voice, "es");
  assert.equal((await store.status(daveFx.id)).installed, true);
});

test("corrupt or truncated Piper model downloads are rejected and partial files are removed", async () => {
  const root = new MemoryDirectoryHandle();
  const corruptVoice = { ...voice, modelSha256: "0".repeat(64) };
  const store = new PiperModelStore({
    storage: { async getDirectory() { return root; } },
    catalog: [corruptVoice],
    fetchImpl: async (url) => url.endsWith(".onnx.json")
      ? new Response(JSON.stringify(config), { status: 200 })
      : responseWithBytes(bytes),
    now: () => 123
  });
  await assert.rejects(store.install(voice.id), /no superó la verificación de integridad/);
  const directory = await root.getDirectoryHandle(PIPER_OPFS_DIRECTORY);
  assert.equal([...directory.entries.keys()].some((name) => name.endsWith(".partial")), false);
  assert.equal((await store.status(voice.id)).installed, false);
});

test("failed HTTP downloads can be retried without marking a model as installed", async () => {
  let modelRequests = 0;
  const store = makeStore(async (url) => {
    if (url.endsWith(".onnx.json")) return new Response(JSON.stringify(config), { status: 200 });
    modelRequests++;
    if (modelRequests === 1) return new Response("missing", { status: 404 });
    return responseWithBytes(bytes);
  });
  await assert.rejects(store.install(voice.id), /HTTP 404/);
  assert.equal((await store.status(voice.id)).installed, false);
  assert.equal((await store.install(voice.id)).installed, true);
  assert.equal(modelRequests, 2);
});

test("invalid Piper config and unavailable OPFS fail before model initialization", async () => {
  const badConfig = { ...config, language: { code: "en_US" } };
  const store = makeStore(async (url) => url.endsWith(".onnx.json")
    ? new Response(JSON.stringify(badConfig), { status: 200 })
    : responseWithBytes(bytes));
  await assert.rejects(store.install(voice.id), /no coincide con los metadatos/);
  await assert.rejects(makeStore(async () => new Response("ok"), {}).status(voice.id), /no ofrece almacenamiento OPFS/);
});
