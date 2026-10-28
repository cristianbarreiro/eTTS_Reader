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

async function prepareAndCommitQueue(engine, repository, record) {
  const operationId = `test-queue-${Math.random().toString(36).slice(2)}`;
  await engine.handleCommand({ command: "prepare-queue-audio", session: record, operationId });
  await waitFor(() => !engine.queuePreparations.has(operationId), "complete queue preparation did not finish");
  const audioRecords = record.chunks.map((text) => [...repository.audio.values()].find((item) => item.text === text && item.voice === record.voice));
  if (audioRecords.some((item) => !item?.blob)) throw new Error("queue preparation did not cache every WAV");
  const prepared = {
    ...record,
    audioKeys: audioRecords.map((item) => item.id),
    durations: audioRecords.map((item) => item.duration),
    chunkStates: audioRecords.map(() => "ready")
  };
  await engine.handleCommand({ command: "replace", session: prepared });
  return prepared;
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

test("offscreen engine prepares the whole queue before sequential playback, without a connected panel", async () => {
  const repository = new MemoryRepository();
  const synthCalls = [];
  const { audio, engine } = makeEngine(repository, synthCalls, () => { throw new Error("panel closed"); });

  const prepared = await prepareAndCommitQueue(engine, repository, { ...session(), queuePrepared: true });
  assert.equal(synthCalls.length, 2, "every fragment is synthesized before playback starts");
  assert.equal(audio.playCount, 0, "queue preparation never autoplays");
  assert.deepEqual(prepared.chunkStates, ["ready", "ready"]);
  assert.equal(prepared.durations.length, 2);
  assert.ok(prepared.durations.every((duration) => duration > 0));
  await engine.handleCommand({ command: "start", session: prepared });
  assert.equal(engine.player.snapshot().status, "playing");
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
  const record = await prepareAndCommitQueue(engine, repository, { ...session(), queuePrepared: true });
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

test("queue replacement waits for every valid WAV and preserves the previous session until commit", async () => {
  const repository = new MemoryRepository();
  const calls = [];
  const published = [];
  const { audio, engine } = makeEngine(repository, calls, (message) => published.push(message));
  const previous = { ...session(), id: "previous-session", queuePrepared: true, audioKeys: [] };
  const candidate = {
    ...session(), id: "candidate-session", sourceText: "Candidate first. Candidate second.", chunks: ["Candidate first.", "Candidate second."],
    queuePrepared: true, voice: "af_heart", audioKeys: []
  };
  await engine.handleCommand({ command: "restore", session: previous });
  await repository.saveSession(previous);

  await engine.handleCommand({ command: "prepare-queue-audio", session: candidate, operationId: "candidate-op" });
  assert.equal(engine.activeSession.id, previous.id, "candidate synthesis must not replace the active queue");
  assert.ok(repository.sessions.has(previous.id));
  assert.equal(repository.sessions.has(candidate.id), false, "the candidate is not persisted before all WAVs succeed");
  assert.equal(audio.playCount, 0);

  await waitFor(() => published.some((message) => message.type === "reader:queue-audio-preparation" && message.state === "ready"));
  const result = published.find((message) => message.type === "reader:queue-audio-preparation" && message.state === "ready");
  assert.equal(engine.activeSession.id, previous.id);
  assert.equal(result.audioKeys.length, candidate.chunks.length);
  assert.equal(result.durations.length, candidate.chunks.length);
  assert.ok(result.chunkStates.every((state) => state === "ready"));
  assert.equal(repository.audio.size, candidate.chunks.length);
  assert.ok(result.audioKeys.every((key) => repository.audio.get(key).blob.size > 0));
  const secondFragmentProgress = published.find((message) => message.type === "reader:queue-audio-preparation"
    && message.state === "generating" && message.event?.fragmentIndex === 2 && message.event?.stage === "fragment-ready");
  assert.equal(secondFragmentProgress.event.fragmentTotal, 2);
  assert.equal(secondFragmentProgress.event.progress, 100);
  assert.equal(audio.playCount, 0, "complete queue preparation must not autoplay");
  assert.equal(JSON.stringify(published).includes("Candidate text."), false, "progress messages must never expose the source text");

  const committed = {
    ...candidate,
    audioKeys: result.audioKeys,
    durations: result.durations,
    chunkStates: result.chunkStates
  };
  await engine.handleCommand({ command: "replace", session: committed });
  assert.equal(engine.activeSession.id, candidate.id);
  assert.deepEqual(engine.activeSession.audioKeys, result.audioKeys);
  assert.equal(engine.player.snapshot().totalDuration, result.durations.reduce((sum, duration) => sum + duration, 0));
  assert.equal(audio.playCount, 0);
});

test("an invalid first WAV fails candidate preparation without caching it or replacing the previous queue", async () => {
  const repository = new MemoryRepository();
  const published = [];
  const previous = { ...session(), id: "previous-session", queuePrepared: true, audioKeys: [] };
  const candidate = {
    ...session(), id: "candidate-session", sourceText: "Invalid candidate.", chunks: ["Invalid candidate."],
    queuePrepared: true, voice: "af_heart", audioKeys: []
  };
  const audio = new MockAudio();
  const engine = new PersistentReaderEngine({
    audio, repository, publish: (message) => published.push(message),
    inference: {
      async synthesize() { return new Blob([], { type: "audio/wav" }); },
      preparationStatus() { return { state: "ready" }; },
      async dispose() {}
    }
  });
  await repository.saveSession(previous);
  await engine.handleCommand({ command: "restore", session: previous });

  await engine.handleCommand({ command: "prepare-queue-audio", session: candidate, operationId: "invalid-op" });
  await waitFor(() => published.some((message) => message.type === "reader:queue-audio-preparation" && message.state === "error"));
  const failure = published.find((message) => message.type === "reader:queue-audio-preparation" && message.state === "error");
  assert.match(failure.message, /WAV|audio|válido/i);
  assert.equal(engine.activeSession.id, previous.id);
  assert.equal(repository.sessions.has(candidate.id), false);
  assert.equal(repository.sessions.has(previous.id), true);
  assert.equal(repository.audio.size, 0, "empty/invalid output must never enter the audio cache");
  assert.equal(audio.playCount, 0);
});

test("a later fragment failure never marks a partially cached candidate as ready", async () => {
  const repository = new MemoryRepository();
  const published = [];
  let calls = 0;
  const previous = { ...session(), id: "previous-session", queuePrepared: true };
  const candidate = {
    ...session(), id: "candidate-session", sourceText: "First candidate. Second candidate.",
    chunks: ["First candidate.", "Second candidate."], queuePrepared: true, audioKeys: []
  };
  const engine = new PersistentReaderEngine({
    audio: new MockAudio(), repository, publish: (message) => published.push(message),
    inference: {
      async synthesize() {
        calls++;
        if (calls === 2) throw new Error("second fragment failed");
        return makeWavBlob();
      },
      preparationStatus() { return { state: "ready" }; }
    }
  });
  await engine.handleCommand({ command: "restore", session: previous });
  await engine.handleCommand({ command: "prepare-queue-audio", session: candidate, operationId: "second-fragment-failure" });
  await waitFor(() => !engine.queuePreparations.has("second-fragment-failure"));

  assert.equal(engine.activeSession.id, previous.id);
  assert.equal(repository.sessions.has(candidate.id), false);
  assert.equal(repository.audio.size, 1, "the successfully generated WAV may remain cached for a retry");
  assert.equal(published.some((message) => message.type === "reader:queue-audio-preparation" && message.state === "ready"), false);
  assert.ok(published.some((message) => message.type === "reader:queue-audio-preparation" && message.state === "error"));
});

test("prepare-audio synthesizes the first fragment in the offscreen engine without starting playback", async () => {
  const repository = new MemoryRepository();
  const calls = [];
  const { audio, engine } = makeEngine(repository, calls);
  const prepared = { ...session(), queuePrepared: true, queueVersion: "queue-v1" };
  await engine.handleCommand({ command: "replace", session: prepared });

  const started = await engine.handleCommand({ command: "prepare-audio", sessionId: prepared.id });
  assert.equal(started.snapshot.status, "generating");
  assert.equal(audio.playCount, 0);
  await waitFor(() => calls.length === 1, "the first synthesis did not start after the prepare command returned");
  assert.deepEqual(calls.map(({ text }) => text), ["First."]);

  await waitFor(() => engine.player.snapshot().status === "audio-ready");
  await waitFor(() => repository.sessions.get(prepared.id)?.audioKeys?.[0]);
  assert.equal(audio.playCount, 0, "audio generation must never start playback");
  assert.equal(engine.player.snapshot().hasDownloadableAudio, true);
  assert.deepEqual(calls.map(({ text }) => text), ["First."]);
});

test("prepare-audio rejects stale or unprepared queue identifiers", async () => {
  const repository = new MemoryRepository();
  const { audio, engine } = makeEngine(repository);
  const prepared = { ...session(), queuePrepared: true };
  await engine.handleCommand({ command: "replace", session: prepared });

  await assert.rejects(engine.handleCommand({ command: "prepare-audio", sessionId: "another-session" }), /no coincide/);
  await assert.rejects(engine.handleCommand({ command: "prepare-audio", sessionId: "" }), /no coincide/);
  assert.equal(audio.playCount, 0);
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

test("the persistent engine refuses playback until every WAV is cached and validated", async () => {
  const repository = new MemoryRepository();
  const calls = [];
  const { audio, engine } = makeEngine(repository, calls);
  const previous = { ...session(), id: "previous-session", queuePrepared: true };
  const incomplete = { ...session(), id: "incomplete-session", queuePrepared: true };
  await engine.handleCommand({ command: "replace", session: previous });

  await assert.rejects(engine.handleCommand({ command: "start", session: incomplete }), (error) => error.code === "AUDIO_QUEUE_NOT_PREPARED");
  assert.equal(engine.activeSession.id, previous.id, "a partial candidate does not replace the active queue");
  assert.equal(audio.playCount, 0);
  assert.deepEqual(calls, [], "start must never lazily synthesize while the player is active");
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

test("cancelling complete queue preparation fences late synthesis writes from caching a WAV", async () => {
  const repository = new MemoryRepository();
  let finishSynthesis;
  const inference = {
    synthesize() { return new Promise((resolve) => { finishSynthesis = resolve; }); },
    async initialize() { return { voices: ["af_heart"] }; },
    async dispose() {}
  };
  const engine = new PersistentReaderEngine({ audio: new MockAudio(), repository, inference });
  const candidate = { ...session(), queuePrepared: true };
  await engine.handleCommand({ command: "replace", session: candidate });
  await engine.handleCommand({ command: "prepare-queue-audio", session: candidate, operationId: "late-synthesis" });
  await waitFor(() => typeof finishSynthesis === "function", "synthesis did not start");

  await engine.handleCommand({ command: "forget-session", sessionId: "session-a", preserve: false });
  repository.sessions.delete("session-a");
  finishSynthesis(makeWavBlob());
  await waitFor(() => !engine.queuePreparations.has("late-synthesis"));
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
  const prepared = await prepareAndCommitQueue(first.engine, repository, { ...oneChunkSession, queuePrepared: true });
  await first.engine.handleCommand({ command: "start", session: prepared });
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

test("a fragment failure leaves the candidate queue uncommitted and does not autoplay", async () => {
  const repository = new MemoryRepository();
  const audio = new MockAudio();
  const inference = {
    async synthesize() { throw new Error("Kokoro no pudo iniciar."); },
    async initialize() { return { voices: ["af_heart", "am_michael"] }; },
    async dispose() {}
  };
  const first = new PersistentReaderEngine({ audio, repository, inference });

  const candidate = { ...session(), queuePrepared: true };
  await first.handleCommand({ command: "prepare-queue-audio", session: candidate, operationId: "failure-op" });
  await waitFor(() => !first.queuePreparations.has("failure-op"));
  assert.equal(repository.sessions.has(candidate.id), false);
  assert.equal(repository.audio.size, 0);
  assert.equal(audio.playCount, 0);
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
    inference: {
      async synthesize() { throw error; },
      preparationStatus(id) { return { provider: "piper", voiceId: id, state: "error", installed: true }; },
      async initialize() { return { ready: true }; },
      async dispose() {}
    }
  });

  await engine.handleCommand({ command: "prepare-queue-audio", session: { ...session(), sourceText: "Hola.", chunks: ["Hola."], voice: voiceId, queuePrepared: true }, operationId: "piper-failure" });
  await waitFor(() => published.some((message) => message.type === "reader:model" && message.state === "error"));
  const failure = published.find((message) => message.type === "reader:model" && message.state === "error");
  assert.equal(failure.code, "PIPER_SYNTHESIS_TIMEOUT");
  assert.equal(failure.phase, "synthesis");
});

test("audio-cache deletion refuses to remove WAVs while playback is using the reader", async () => {
  const repository = new MemoryRepository();
  const { audio, engine } = makeEngine(repository);
  const prepared = await prepareAndCommitQueue(engine, repository, { ...session(), chunks: ["First."], sourceText: "First.", queuePrepared: true });
  await engine.handleCommand({ command: "start", session: prepared });

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
  const prepared = await prepareAndCommitQueue(engine, repository, { ...session(), chunks: ["First."], sourceText: "First.", queuePrepared: true });
  await engine.handleCommand({ command: "start", session: prepared });

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
  const prepared = await prepareAndCommitQueue(engine, repository, { ...piperSession, queuePrepared: true });
  const started = await engine.handleCommand({ command: "start", session: prepared });
  await waitFor(() => repository.audio.size === 1);

  await assert.rejects(engine.handleCommand({ command: "delete-piper-model", voiceId: voice.id }), /STORAGE_OPERATION_BUSY/);
  assert.deepEqual(deleted, []);
  assert.equal(engine.player.snapshot().status, "playing");

  await engine.handleCommand({ command: "stop" });
  await engine.handleCommand({ command: "delete-piper-model", voiceId: voice.id });
  assert.deepEqual(deleted, [voice.id]);
  assert.equal(repository.audio.size, 1, "deleting Piper must not clear saved WAVs");
});

test("Piper reset and model deletion are blocked throughout a candidate queue preparation", async () => {
  const repository = new MemoryRepository();
  const voice = PIPER_VOICE_CATALOG[0];
  let finishSynthesis;
  let synthCount = 0;
  let resetCalls = 0;
  const engine = new PersistentReaderEngine({
    audio: new MockAudio(), repository,
    inference: {
      synthesize() {
        synthCount++;
        return synthCount === 1
          ? new Promise((resolve) => { finishSynthesis = resolve; })
          : Promise.resolve(makeWavBlob(22050));
      },
      resetPiperEngine() { resetCalls++; return { reset: true }; },
      async deletePiperModel() { return { deleted: true }; }
    }
  });
  const candidate = { ...session(), voice: voice.id, voiceId: voice.id, voiceProvider: "piper", queuePrepared: true };
  await engine.handleCommand({ command: "prepare-queue-audio", session: candidate, operationId: "piper-maintenance-guard" });
  await waitFor(() => typeof finishSynthesis === "function");

  await assert.rejects(engine.handleCommand({ command: "reset-piper-engine", voiceId: voice.id }), /STORAGE_OPERATION_BUSY/);
  await assert.rejects(engine.handleCommand({ command: "delete-piper-model", voiceId: voice.id }), /STORAGE_OPERATION_BUSY/);
  assert.equal(resetCalls, 0);

  finishSynthesis(makeWavBlob(22050));
  await waitFor(() => !engine.queuePreparations.has("piper-maintenance-guard"));
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
  const prepared = await prepareAndCommitQueue(engine, repository, { ...piperSession, queuePrepared: true });
  const started = await engine.handleCommand({ command: "start", session: prepared });
  assert.equal(repository.audio.size, 2, "both Piper WAV fragments are cached before playback");
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
