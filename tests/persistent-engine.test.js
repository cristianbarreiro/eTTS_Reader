import test from "node:test";
import assert from "node:assert/strict";
import { PersistentReaderEngine } from "../src/persistent-engine.js";
import { PIPER_VOICE_CATALOG } from "../src/voice-catalog.js";

function makeWavBlob(sampleRate = 24000) {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const write = (offset, value) => { for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index); };
  write(0, "RIFF"); view.setUint32(4, 40, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  write(36, "data"); view.setUint32(40, 4, true); view.setFloat32(44, 0.5, true);
  return new Blob([bytes], { type: "audio/wav" });
}

class MockAudio {
  listeners = new Map();
  src = "";
  currentTime = 0;
  duration = Number.NaN;
  playbackRate = 1;
  preservesPitch = false;
  paused = true;
  ended = false;
  error = null;
  playCount = 0;
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) { this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== listener)); }
  emit(name) { for (const listener of this.listeners.get(name) || []) listener({ type: name, target: this }); }
  removeAttribute(name) { if (name === "src") this.src = ""; }
  load() {
    if (!this.src) { this.currentTime = 0; this.duration = Number.NaN; this.ended = false; return; }
    this.currentTime = 0; this.duration = 4; this.ended = false; this.emit("loadedmetadata");
  }
  async play() { this.playCount++; this.paused = false; this.ended = false; this.emit("play"); }
  pause() { if (this.paused) return; this.paused = true; this.emit("pause"); }
  finish() { this.currentTime = this.duration; this.paused = true; this.ended = true; this.emit("timeupdate"); this.emit("ended"); }
}

class MemoryRepository {
  audio = new Map();
  sessions = new Map();
  async getAudioChunk(id) { return this.audio.get(id); }
  async saveAudioChunk(record) { this.audio.set(record.id, record); return record; }
  async saveSession(record) { this.sessions.set(record.id, { ...record }); return record; }
  async clearAudioCache() {
    this.audio.clear();
    for (const [id, session] of this.sessions) {
      this.sessions.set(id, {
        ...session,
        audioKeys: [],
        chunkStates: (session.chunks || []).map((_, index) => session.chunkStates?.[index] === "error" ? "error" : "pending")
      });
    }
  }
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, message = "Timed out waiting for the persistent engine") {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (predicate()) return;
    await delay();
  }
  assert.fail(message);
}

function makeEngine(repository, synthCalls = [], publish = () => {}) {
  const audio = new MockAudio();
  const inference = {
    async synthesize(text, voice) {
      synthCalls.push({ text, voice });
      await delay();
      return makeWavBlob();
    },
    preparationStatus(voiceId) { return { state: voiceId.startsWith("piper:") ? "cached" : "ready" }; },
    async initialize() { return { voices: ["af_heart", "am_michael"] }; },
    async dispose() {}
  };
  return { audio, engine: new PersistentReaderEngine({ audio, repository, inference, publish }) };
}

const session = () => ({
  id: "session-a", documentId: "document-a", sourceText: "First. Second.",
  chunks: ["First.", "Second."], selectedIndex: 0, position: 0,
  status: "text-ready", voice: "af_heart", speed: 1, audioKeys: []
});

test("voice preparation status reports the selected provider without starting playback or synthesis", async () => {
  const repository = new MemoryRepository();
  const synthCalls = [];
  const { engine } = makeEngine(repository, synthCalls);

  assert.deepEqual(await engine.handleCommand({ command: "voice-preparation-status", voiceId: "af_heart" }), {
    ok: true, voiceId: "af_heart", provider: "kokoro", state: "ready"
  });
  assert.deepEqual(await engine.handleCommand({ command: "voice-preparation-status", voiceId: PIPER_VOICE_CATALOG[0].id }), {
    ok: true, voiceId: PIPER_VOICE_CATALOG[0].id, provider: "piper", state: "cached"
  });
  assert.equal(synthCalls.length, 0);
  assert.equal(repository.sessions.size, 0);
  assert.equal(engine.player.snapshot().status, "empty");
});

test("Piper reset bypasses a pending initialization, reports its operation, and protects active playback", async () => {
  const repository = new MemoryRepository();
  const savedAudio = { id: "cached-wav", blob: makeWavBlob() };
  const savedSession = { ...session(), id: "saved-session", audioKeys: [savedAudio.id] };
  repository.audio.set(savedAudio.id, savedAudio);
  repository.sessions.set(savedSession.id, savedSession);
  const published = [];
  const voiceId = PIPER_VOICE_CATALOG[0].id;
  let rejectInitialization;
  let resetCalls = 0;
  const engine = new PersistentReaderEngine({
    audio: new MockAudio(),
    repository,
    publish: (message) => published.push(message),
    inference: {
      initialize() { return new Promise((_resolve, reject) => { rejectInitialization = reject; }); },
      async synthesize() { return makeWavBlob(); },
      resetPiperEngine() {
        resetCalls++;
        const error = new Error("Worker Piper restablecido.");
        error.code = "PIPER_WORKER_RESET";
        error.phase = "initialize";
        rejectInitialization(error);
        return { reset: true, modelPreserved: true };
      },
      async dispose() {}
    }
  });
  const initializing = engine.handleCommand({ command: "initialize", voice: voiceId, operationId: "panel-reset-test" });
  await waitFor(() => engine.providerOperations.get("piper")?.get(voiceId) === 1);

  assert.deepEqual(await engine.handleCommand({ command: "reset-piper-engine", voiceId }), {
    ok: true, reset: true, modelPreserved: true, voiceId
  });
  await assert.rejects(initializing, /Worker Piper restablecido/);
  assert.equal(resetCalls, 1);
  assert.ok(published.some((message) => message.operationId === "panel-reset-test" && message.state === "error" && message.code === "PIPER_WORKER_RESET"));
  assert.equal(repository.audio.get(savedAudio.id), savedAudio, "reset keeps generated audio cached");
  assert.equal(repository.sessions.get(savedSession.id), savedSession, "reset keeps reading sessions unchanged");

  engine.player.snapshot = () => ({ status: "playing", activeKind: "chunk", activeVoiceId: voiceId });
  await assert.rejects(engine.handleCommand({ command: "reset-piper-engine", voiceId }), /STORAGE_OPERATION_BUSY/);
  assert.equal(resetCalls, 1, "reset cannot interrupt audio that is using Piper");
});

test("offscreen engine prebuffers one next chunk and advances without a connected panel", async () => {
  const repository = new MemoryRepository();
  const synthCalls = [];
  const { audio, engine } = makeEngine(repository, synthCalls, () => { throw new Error("panel closed"); });

  await engine.handleCommand({ command: "start", session: session() });
  assert.equal(engine.player.snapshot().status, "playing");
  await waitFor(() => synthCalls.length === 2, "the next fragment was not synthesized while the first played");
  assert.deepEqual(synthCalls.map(({ text }) => text), ["First.", "Second."]);
  await waitFor(() => repository.audio.size === 2, "the audio buffer did not persist its next WAV");
  assert.equal(repository.audio.size, 2);
  await waitFor(() => repository.sessions.get("session-a")?.chunkStates?.every((state) => state === "ready"));

  audio.finish();
  await waitFor(() => engine.player.snapshot().status === "playing" && engine.player.snapshot().selectedIndex === 1);
  assert.deepEqual(synthCalls.map(({ text }) => text), ["First.", "Second."], "the prefetched audio should be reused without a second synthesis");
  audio.finish();
  await waitFor(() => engine.player.snapshot().status === "completed");
  await waitFor(() => repository.sessions.get("session-a")?.status === "completed");
});

test("the persistent engine rejects duplicate starts for its active session", async () => {
  const repository = new MemoryRepository();
  const calls = [];
  const { audio, engine } = makeEngine(repository, calls);
  const record = session();
  await engine.handleCommand({ command: "start", session: record });
  await engine.handleCommand({ command: "start", session: record });
  assert.equal(audio.playCount, 1);
  assert.equal(calls.filter(({ text }) => text === "First.").length, 1);
});

test("loading a prepared queue persists it without synthesizing or starting audio", async () => {
  const repository = new MemoryRepository();
  const calls = [];
  const { audio, engine } = makeEngine(repository, calls);
  const prepared = { ...session(), queuePrepared: true, queueVersion: "queue-v1" };

  const response = await engine.handleCommand({ command: "replace", session: prepared });
  assert.equal(response.snapshot.status, "text-ready");
  assert.deepEqual(response.snapshot.chunks, prepared.chunks);
  assert.equal(engine.activeSession.queuePrepared, true);
  assert.equal(repository.sessions.get(prepared.id).queueVersion, "queue-v1");
  assert.equal(audio.playCount, 0);
  assert.deepEqual(calls, []);
});

test("the persistent engine refuses to play an editor draft that was never loaded into the queue", async () => {
  const repository = new MemoryRepository();
  const calls = [];
  const { audio, engine } = makeEngine(repository, calls);

  await assert.rejects(
    engine.handleCommand({ command: "start", session: { ...session(), queuePrepared: false } }),
    /cola preparada/
  );
  assert.equal(audio.playCount, 0);
  assert.deepEqual(calls, []);
});

test("restoring a prepared queue never autoplays and reconnecting the same session does not reset it", async () => {
  const repository = new MemoryRepository();
  const { audio, engine } = makeEngine(repository);
  const prepared = { ...session(), status: "paused", position: 1.5, queuePrepared: true };

  const restored = await engine.handleCommand({ command: "restore", session: prepared });
  assert.equal(restored.snapshot.status, "paused");
  assert.equal(restored.snapshot.currentTime, 1.5);
  assert.equal(audio.playCount, 0);

  engine.player.state.selectedIndex = 1;
  engine.player.state.currentTime = 2.25;
  const reconnected = await engine.handleCommand({ command: "restore", session: prepared });
  assert.equal(reconnected.snapshot.selectedIndex, 1);
  assert.equal(reconnected.snapshot.currentTime, 2.25);
  assert.equal(audio.playCount, 0);
});

test("forgetting a deleted session fences late synthesis writes from restoring its record or WAV", async () => {
  const repository = new MemoryRepository();
  let finishSynthesis;
  const inference = {
    synthesize() { return new Promise((resolve) => { finishSynthesis = resolve; }); },
    async initialize() { return { voices: ["af_heart"] }; },
    async dispose() {}
  };
  const engine = new PersistentReaderEngine({ audio: new MockAudio(), repository, inference });
  const starting = engine.handleCommand({ command: "start", session: session() });
  await waitFor(() => typeof finishSynthesis === "function", "synthesis did not start");

  await engine.handleCommand({ command: "forget-session", sessionId: "session-a", preserve: false });
  repository.sessions.delete("session-a");
  finishSynthesis(makeWavBlob());
  await starting;
  await delay();

  assert.equal(repository.sessions.has("session-a"), false);
  assert.equal(repository.audio.size, 0);
  assert.equal(engine.activeSession, null);
});

test("saved playback recovers after the offscreen engine is recreated without autoplay", async () => {
  const repository = new MemoryRepository();
  const firstCalls = [];
  const first = makeEngine(repository, firstCalls);
  const oneChunkSession = { ...session(), sourceText: "First.", chunks: ["First."] };
  await first.engine.handleCommand({ command: "start", session: oneChunkSession });
  first.audio.currentTime = 2.5;
  first.audio.emit("timeupdate");
  await new Promise((resolve) => setTimeout(resolve, 1050));
  first.audio.emit("timeupdate");
  await waitFor(() => repository.sessions.get("session-a")?.position === 2.5);
  assert.equal(first.audio.playCount, 1);

  const secondCalls = [];
  const second = makeEngine(repository, secondCalls);
  const recovered = repository.sessions.get("session-a");
  second.engine.player.restore(recovered);
  assert.equal(second.engine.player.snapshot().status, "interrupted");
  assert.equal(second.audio.playCount, 0);
  await second.engine.handleCommand({ command: "start", session: recovered });
  assert.equal(second.audio.playCount, 1);
  assert.equal(second.audio.currentTime, 2.5);
  assert.deepEqual(secondCalls, [], "cached WAV should resume without synthesizing it again");
});

test("generation failures persist their chunk error and restore without autoplay", async () => {
  const repository = new MemoryRepository();
  const audio = new MockAudio();
  const inference = {
    async synthesize() { throw new Error("Kokoro no pudo iniciar."); },
    async initialize() { return { voices: ["af_heart", "am_michael"] }; },
    async dispose() {}
  };
  const first = new PersistentReaderEngine({ audio, repository, inference });

  await first.handleCommand({ command: "start", session: session() });
  await waitFor(() => repository.sessions.get("session-a")?.status === "error");
  const recovered = repository.sessions.get("session-a");
  assert.deepEqual(recovered.chunkStates, ["error", "pending"]);
  assert.equal(recovered.lastError, "Kokoro no pudo iniciar.");

  const second = makeEngine(repository);
  second.engine._applySession(recovered, { restore: true });
  assert.equal(second.engine.player.snapshot().status, "error");
  assert.equal(second.engine.player.snapshot().message, "Kokoro no pudo iniciar.");
  assert.equal(second.audio.playCount, 0);
});

test("Piper synthesis diagnostics keep their code and phase in model-state messages", async () => {
  const repository = new MemoryRepository();
  const published = [];
  const voiceId = PIPER_VOICE_CATALOG[0].id;
  const error = new Error("Piper synthesis timed out");
  error.code = "PIPER_SYNTHESIS_TIMEOUT";
  error.phase = "synthesis";
  const engine = new PersistentReaderEngine({
    audio: new MockAudio(), repository, publish: (message) => published.push(message),
    inference: { async synthesize() { throw error; }, async initialize() { return { ready: true }; }, async dispose() {} }
  });

  await engine.handleCommand({ command: "start", session: { ...session(), sourceText: "Hola.", chunks: ["Hola."], voice: voiceId } });
  await waitFor(() => published.some((message) => message.type === "reader:model" && message.state === "error"));
  const failure = published.find((message) => message.type === "reader:model" && message.state === "error");
  assert.equal(failure.code, "PIPER_SYNTHESIS_TIMEOUT");
  assert.equal(failure.phase, "synthesis");
});

test("audio-cache deletion refuses to remove WAVs while playback is using the reader", async () => {
  const repository = new MemoryRepository();
  const { audio, engine } = makeEngine(repository);
  await engine.handleCommand({ command: "start", session: { ...session(), chunks: ["First."], sourceText: "First." } });
  await waitFor(() => repository.audio.size === 1);
  await waitFor(() => repository.sessions.get("session-a")?.audioKeys?.length === 1);

  await assert.rejects(engine.handleCommand({ command: "clear-audio-cache" }), /STORAGE_OPERATION_BUSY/);
  assert.equal(engine.player.snapshot().status, "playing");
  assert.equal(audio.paused, false);
  assert.equal(repository.sessions.get("session-a").audioKeys[0], [...repository.audio.keys()][0]);
  assert.equal(repository.audio.size, 1);

  await engine.handleCommand({ command: "stop" });
  await waitFor(() => engine.inFlightAudio.size === 0, "stopped synthesis must finish before cache deletion");
  await engine.handleCommand({ command: "clear-audio-cache" });
  const saved = repository.sessions.get("session-a");
  assert.deepEqual(saved.audioKeys, []);
  assert.deepEqual(saved.chunkStates, ["pending"]);
  assert.equal(repository.audio.size, 0);
});

test("Kokoro model deletion is blocked while Kokoro is reading and disposes only Kokoro when idle", async () => {
  const repository = new MemoryRepository();
  const deleted = [];
  const removedStorageKeys = [];
  const audio = new MockAudio();
  const inference = {
    async initialize() { return { voices: ["af_heart"] }; },
    async synthesize() { return makeWavBlob(); },
    async deleteKokoroModel() { deleted.push("kokoro"); },
    async dispose() {}
  };
  const engine = new PersistentReaderEngine({ audio, repository, inference, storage: { async remove(key) { removedStorageKeys.push(key); } } });
  await engine.handleCommand({ command: "start", session: { ...session(), chunks: ["First."], sourceText: "First." } });
  await waitFor(() => repository.audio.size === 1);

  await assert.rejects(engine.handleCommand({ command: "delete-model" }), /STORAGE_OPERATION_BUSY/);
  assert.deepEqual(deleted, []);
  assert.equal(engine.player.snapshot().status, "playing");

  await engine.handleCommand({ command: "stop" });
  const result = await engine.handleCommand({ command: "delete-model" });
  assert.equal(result.provider, "kokoro");
  assert.deepEqual(deleted, ["kokoro"]);
  assert.deepEqual(removedStorageKeys, ["modelCached"]);
  assert.equal(repository.audio.size, 1, "deleting Kokoro must not clear saved WAVs");
});

test("deleting one Piper model is blocked while its voice is active", async () => {
  const repository = new MemoryRepository();
  const voice = PIPER_VOICE_CATALOG[0];
  const deleted = [];
  const audio = new MockAudio();
  const inference = {
    async initialize() { return { provider: "piper", voiceId: voice.id }; },
    async synthesize() { return makeWavBlob(22050); },
    async deletePiperModel(voiceId) { deleted.push(voiceId); return { voiceId, installed: false }; },
    async dispose() {}
  };
  const engine = new PersistentReaderEngine({ audio, repository, inference });
  const piperSession = { ...session(), voice: voice.id, voiceId: voice.id, voiceProvider: "piper", chunks: ["Hola."], sourceText: "Hola." };
  await engine.handleCommand({ command: "start", session: piperSession });
  await waitFor(() => repository.audio.size === 1);

  await assert.rejects(engine.handleCommand({ command: "delete-piper-model", voiceId: voice.id }), /STORAGE_OPERATION_BUSY/);
  assert.deepEqual(deleted, []);
  assert.equal(engine.player.snapshot().status, "playing");

  await engine.handleCommand({ command: "stop" });
  await engine.handleCommand({ command: "delete-piper-model", voiceId: voice.id });
  assert.deepEqual(deleted, [voice.id]);
  assert.equal(repository.audio.size, 1, "deleting Piper must not clear saved WAVs");
});

test("provider model deletion is blocked during model initialization and can be retried after it completes", async () => {
  const repository = new MemoryRepository();
  const deleted = [];
  let finishInitialization;
  const inference = {
    initialize() { return new Promise((resolve) => { finishInitialization = resolve; }); },
    async synthesize() { return makeWavBlob(); },
    async deleteKokoroModel() { deleted.push("kokoro"); },
    async dispose() {}
  };
  const engine = new PersistentReaderEngine({ audio: new MockAudio(), repository, inference, storage: { async remove() {} } });
  const initializing = engine.handleCommand({ command: "initialize", voice: "af_heart" });
  await waitFor(() => engine.providerOperations.get("kokoro")?.get("af_heart") === 1);

  await assert.rejects(engine.handleCommand({ command: "delete-model" }), /STORAGE_OPERATION_BUSY/);
  assert.deepEqual(deleted, []);
  finishInitialization({ voices: ["af_heart"] });
  await initializing;
  await engine.handleCommand({ command: "delete-model" });
  assert.deepEqual(deleted, ["kokoro"]);
});

test("Kokoro cleanup storage errors keep the command retryable and release the provider lock", async () => {
  const repository = new MemoryRepository();
  const deleted = [];
  let storageFailures = 1;
  const engine = new PersistentReaderEngine({
    audio: new MockAudio(),
    repository,
    inference: {
      async deleteKokoroModel() { deleted.push("kokoro"); },
      async initialize() {}, async synthesize() {}, async dispose() {}
    },
    storage: {
      async remove() {
        if (storageFailures-- > 0) throw new Error("Storage unavailable");
      }
    }
  });

  await assert.rejects(engine.handleCommand({ command: "delete-model" }), /Storage unavailable/);
  assert.equal(engine.providerMaintenance.has("kokoro"), false);
  await engine.handleCommand({ command: "delete-model" });
  assert.deepEqual(deleted, ["kokoro", "kokoro"]);
});

test("failed audio-cache transactions preserve the stored WAVs and session references", async () => {
  const repository = new MemoryRepository();
  await repository.saveAudioChunk({ id: "saved-wav", blob: makeWavBlob() });
  const saved = { ...session(), audioKeys: ["saved-wav", null], chunkStates: ["ready", "pending"] };
  await repository.saveSession(saved);
  repository.clearAudioCache = async () => { throw new Error("IndexedDB transaction failed"); };
  const engine = new PersistentReaderEngine({ audio: new MockAudio(), repository, inference: { async initialize() {}, async synthesize() {}, async dispose() {} } });
  engine.activeSession = saved;

  await assert.rejects(engine.handleCommand({ command: "clear-audio-cache" }), /IndexedDB transaction failed/);
  assert.equal(engine.audioCacheMaintenance, false);
  assert.ok(await repository.getAudioChunk("saved-wav"));
  assert.deepEqual((await repository.sessions.get("session-a")).audioKeys, ["saved-wav", null]);
  assert.deepEqual(engine.activeSession.audioKeys, ["saved-wav", null]);
});

test("Piper generates and caches local WAVs by pinned voice/model and switching voice clears stale keys", async () => {
  const repository = new MemoryRepository();
  const voice = PIPER_VOICE_CATALOG[0];
  const secondVoice = PIPER_VOICE_CATALOG[1];
  const synthCalls = [];
  const inference = {
    async initialize(_progress, voiceId) { return { provider: "piper", voiceId, ready: true }; },
    async synthesize(text, voiceId) { synthCalls.push({ text, voiceId }); return makeWavBlob(22050); },
    async dispose() {}
  };
  const engine = new PersistentReaderEngine({ audio: new MockAudio(), repository, inference });
  const piperSession = { ...session(), voice: voice.id, voiceId: voice.id, voiceProvider: "piper", audioKeys: [] };
  repository.sessions.set("session-other", { ...session(), id: "session-other", voice: "af_heart", voiceProvider: "kokoro" });

  const initialized = await engine.handleCommand({ command: "initialize", voice: voice.id });
  assert.equal(initialized.result.provider, "piper");
  assert.equal(initialized.result.voiceId, voice.id);
  const started = await engine.handleCommand({ command: "start", session: piperSession });
  await waitFor(() => repository.audio.size === 2, "both Piper WAV fragments should be cached");
  assert.equal(started.snapshot.activeProvider, "piper");
  assert.match(started.currentAudioKey, /^piper-v1-/);
  assert.deepEqual(synthCalls.map(({ voiceId }) => voiceId), [voice.id, voice.id]);
  const cached = [...repository.audio.values()];
  assert.ok(cached.every((record) => record.provider === "piper"));
  assert.ok(cached.every((record) => record.modelRevision === voice.modelRevision));
  assert.ok(cached.every((record) => record.sampleRate === 22050));
  assert.ok(cached.every((record) => record.blob.type === "audio/wav"));

  await engine.handleCommand({ command: "stop" });
  await engine.handleCommand({ command: "voice", value: secondVoice.id });
  assert.equal(repository.sessions.get("session-a").voice, secondVoice.id);
  assert.equal(repository.sessions.get("session-a").voiceProvider, "piper");
  assert.deepEqual(repository.sessions.get("session-a").audioKeys, [null, null]);
  assert.equal(repository.sessions.get("session-other").voice, "af_heart");
});
