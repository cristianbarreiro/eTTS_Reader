import test from "node:test";
import assert from "node:assert/strict";
import { PersistentReaderEngine } from "../src/persistent-engine.js";

function makeWavBlob() {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const write = (offset, value) => { for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index); };
  write(0, "RIFF"); view.setUint32(4, 40, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true); view.setUint32(28, 96000, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
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

test("explicit audio-cache deletion clears persisted references without stopping active playback", async () => {
  const repository = new MemoryRepository();
  const { audio, engine } = makeEngine(repository);
  await engine.handleCommand({ command: "start", session: { ...session(), chunks: ["First."], sourceText: "First." } });
  await waitFor(() => repository.audio.size === 1);

  await engine.handleCommand({ command: "clear-audio-cache" });
  repository.audio.clear();
  const saved = repository.sessions.get("session-a");
  assert.equal(engine.player.snapshot().status, "playing");
  assert.equal(audio.paused, false);
  assert.deepEqual(saved.audioKeys, []);
  assert.deepEqual(saved.chunkStates, ["pending"]);
  assert.equal(repository.audio.size, 0);
});
