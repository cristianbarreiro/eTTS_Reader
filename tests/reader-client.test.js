import test from "node:test";
import assert from "node:assert/strict";
import { ReaderClient, snapshotFromSession } from "../src/reader-client.js";
import { KokoroWorkerClient } from "../src/tts-worker-client.js";
import { PiperWorkerClient } from "../src/piper-worker-client.js";

function fakeRuntime(handler = async () => ({ ok: true })) {
  const listeners = new Set();
  const messages = [];
  return {
    messages,
    onMessage: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      emit(message) { for (const listener of listeners) listener(message); }
    },
    async sendMessage(message) { messages.push(message); return handler(message); }
  };
}

test("restored active work is reported as interrupted and keeps its saved position", () => {
  const snapshot = snapshotFromSession({
    id: "session-1", sourceText: "First. Second.", chunks: ["First.", "Second."],
    selectedIndex: 1, position: 3.5, status: "playing", speed: 1.25,
    durations: [2, 8], audioKeys: ["a", "b"]
  });
  assert.equal(snapshot.status, "interrupted");
  assert.equal(snapshot.selectedIndex, 1);
  assert.equal(snapshot.currentTime, 3.5);
  assert.equal(snapshot.duration, 8);
  assert.equal(snapshot.speed, 1.25);
  assert.equal(snapshot.currentAudioKey, "b");
  assert.equal(snapshot.pendingChunkIndices.length, 0);
});

test("ReaderClient exposes a live synthesis elapsed time without persisting a polling counter", () => {
  const client = new ReaderClient({ runtime: fakeRuntime() });
  client.state = {
    chunks: ["Read."], chunkStates: ["generating"], durations: [null],
    status: "generating", generationStartedAt: Date.now() - 2_000
  };
  const first = client.snapshot().generationElapsedMs;
  const second = client.snapshot().generationElapsedMs;
  assert.ok(first >= 2_000);
  assert.ok(second >= first);
  client.dispose();
});

test("reopening reconnects to an active audio session without issuing another play", async () => {
  const runtime = fakeRuntime(async ({ command }) => command === "restore" ? {
    ok: true,
    sessionId: "session-1",
    currentAudioKey: "audio-current",
    snapshot: { chunks: ["Read."], status: "playing", selectedIndex: 0, playingIndex: 0, currentTime: 2, duration: 5, speed: 1, durations: [5], totalProgress: 0.4, activeKind: "chunk" }
  } : { ok: true });
  const updates = [];
  const client = new ReaderClient({ runtime, onState: (state) => updates.push(state.status) });
  await client.connect({ id: "session-1", chunks: ["Read."], sourceText: "Read.", status: "playing", audioKeys: [] });

  assert.deepEqual(runtime.messages.map((message) => message.command), ["restore"]);
  assert.equal(client.snapshot().status, "playing");
  assert.equal(client.snapshot().currentAudioKey, "audio-current");
  assert.ok(updates.includes("playing"));
  client.dispose();
});

test("loading a queue sends replace without sending a play command", async () => {
  const runtime = fakeRuntime(async ({ command, payload }) => command === "replace" ? {
    ok: true, sessionId: payload.session.id,
    snapshot: { chunks: payload.session.chunks, status: "text-ready", selectedIndex: 0, speed: 1, durations: [null], activeKind: "chunk" }
  } : { ok: true });
  const client = new ReaderClient({ runtime });
  const session = { id: "session-load", sourceText: "Read.", chunks: ["Read."], status: "text-ready", queuePrepared: true, voice: "af_heart" };

  await client.replace(session);
  assert.deepEqual(runtime.messages.map(({ command }) => command), ["replace"]);
  assert.equal(client.snapshot().status, "text-ready");
  assert.equal(client.session.queuePrepared, true);
  client.dispose();
});

test("preparing a loaded queue sends a dedicated non-play command", async () => {
  const runtime = fakeRuntime(async ({ command, payload }) => command === "prepare-audio" ? {
    ok: true, sessionId: payload.sessionId,
    snapshot: { chunks: ["Read."], status: "generating", selectedIndex: 0, speed: 1, durations: [null], generationProgress: null }
  } : { ok: true });
  const client = new ReaderClient({ runtime });
  await client.replace({ id: "session-prepare", sourceText: "Read.", chunks: ["Read."], queuePrepared: true, voice: "af_heart" });
  await client.prepareAudio();

  assert.deepEqual(runtime.messages.map(({ command, payload }) => [command, payload.sessionId || null]), [
    ["replace", null],
    ["prepare-audio", "session-prepare"]
  ]);
  assert.equal(client.snapshot().status, "generating");
  client.dispose();
});

test("queue candidate progress is visible while the prior queue remains active until the first WAV is accepted", async () => {
  let runtime;
  runtime = fakeRuntime(async ({ command, payload }) => {
    if (command === "prepare-queue-audio") {
      runtime.onMessage.emit({
        target: "panel", type: "reader:queue-audio-preparation", operationId: payload.operationId,
        sessionId: payload.session.id, state: "generating",
        message: "Inferencia Kokoro local en curso…",
        event: { phase: "synthesis", stage: "model-generate", partIndex: 1, totalParts: 3, completedParts: 0, textLength: 15 }
      });
      queueMicrotask(() => runtime.onMessage.emit({
        target: "panel", type: "reader:queue-audio-preparation", operationId: payload.operationId,
        sessionId: payload.session.id, state: "ready",
        audioKeys: ["first-wav"], durations: [1.25], chunkStates: ["ready"],
        fragmentTotal: 1, voiceId: "af_heart"
      }));
      return {
        ok: true, sessionId: "previous-session",
        snapshot: { chunks: ["Old text."], status: "text-ready", selectedIndex: 0, speed: 1, durations: [null], activeKind: "chunk" }
      };
    }
    return { ok: true };
  });
  const updates = [];
  const client = new ReaderClient({ runtime, onState: (state) => updates.push(state) });
  const previous = { id: "previous-session", chunks: ["Old text."], sourceText: "Old text.", queuePrepared: true, voice: "af_heart" };
  const candidate = { id: "candidate-session", chunks: ["New text for reading."], sourceText: "New text for reading.", queuePrepared: true, voice: "af_heart" };
  client.setSession(previous);

  const preparing = client.prepareQueueAudio(candidate, "candidate-op");
  assert.equal(client.session.id, previous.id);
  assert.deepEqual(client.snapshot().chunks, candidate.chunks);
  const result = await preparing;

  assert.ok(updates.some((state) => state.generationStage === "model-generate" && state.generationProgress === null),
    "the UI receives an indeterminate generation state while Kokoro model.generate() runs");
  assert.deepEqual(result.audioKeys, ["first-wav"]);
  assert.deepEqual(result.durations, [1.25]);
  assert.equal(client.session.id, previous.id, "the client queue stays on the previous session until commit");
  assert.equal(client.snapshot().queuePreparation, true);
  assert.equal(client.snapshot().generationStage, "document-audio-ready");
  assert.equal(client.snapshot().knownDurationCount, 1);
  assert.equal(client.snapshot().totalDuration, 1.25);
  assert.deepEqual(runtime.messages.map(({ command }) => command), ["prepare-queue-audio"]);
  client.setSession({ ...candidate, audioKeys: result.audioKeys, durations: result.durations, chunkStates: ["ready"] });
  assert.equal(client.snapshot().queuePreparation, undefined);
  assert.equal(client.session.id, candidate.id);
  client.dispose();
});

test("queue preparation errors restore the prior snapshot, and lost terminal events have a deadline", async () => {
  const prior = { id: "previous-session", chunks: ["Old text."], sourceText: "Old text.", queuePrepared: true, voice: "af_heart" };
  const candidate = { id: "candidate-session", chunks: ["New text."], sourceText: "New text.", queuePrepared: true, voice: "af_heart" };
  let runtime;
  runtime = fakeRuntime(async ({ command, payload }) => {
    if (command === "prepare-queue-audio") {
      queueMicrotask(() => runtime.onMessage.emit({
        target: "panel", type: "reader:queue-audio-preparation", operationId: payload.operationId,
        sessionId: payload.session.id, state: "error", message: "Kokoro synthesis timed out.",
        code: "KOKORO_SYNTHESIS_TIMEOUT", phase: "model-generate"
      }));
      return { ok: true, sessionId: prior.id, snapshot: { chunks: prior.chunks, status: "text-ready", selectedIndex: 0, speed: 1, durations: [null] } };
    }
    return { ok: true };
  });
  const client = new ReaderClient({ runtime, timeouts: { queuePreparationMs: 50 } });
  client.setSession(prior);
  await assert.rejects(client.prepareQueueAudio(candidate, "error-op"), (error) => {
    assert.equal(error.code, "KOKORO_SYNTHESIS_TIMEOUT");
    assert.equal(error.phase, "model-generate");
    return true;
  });
  assert.equal(client.session.id, prior.id);
  assert.deepEqual(client.snapshot().chunks, prior.chunks);
  assert.equal(client.snapshot().queuePreparation, undefined);

  runtime = fakeRuntime(async () => ({ ok: true, sessionId: prior.id, snapshot: { chunks: prior.chunks, status: "text-ready", selectedIndex: 0, speed: 1, durations: [null] } }));
  const timedClient = new ReaderClient({ runtime, timeouts: { queuePreparationMs: 10 } });
  timedClient.setSession(prior);
  await assert.rejects(timedClient.prepareQueueAudio(candidate, "lost-event-op"), (error) => error.code === "READER_QUEUE_PREPARATION_TIMEOUT");
  assert.equal(timedClient.session.id, prior.id);
  assert.deepEqual(runtime.messages.map(({ command }) => command), ["prepare-queue-audio", "cancel-queue-audio-preparation"]);
  assert.equal(timedClient.snapshot().queuePreparation, undefined);
  timedClient.dispose();
  client.dispose();
});

test("Play completes every missing fragment before sending the playback command", async () => {
  let runtime;
  runtime = fakeRuntime(async ({ command, payload }) => {
    if (command === "prepare-queue-audio") {
      queueMicrotask(() => runtime.onMessage.emit({
        target: "panel", type: "reader:queue-audio-preparation", operationId: payload.operationId,
        sessionId: payload.session.id, state: "ready",
        audioKeys: ["wav-1", "wav-2"], durations: [12.5, 8.25], chunkStates: ["ready", "ready"], fragmentTotal: 2
      }));
      return { ok: true, sessionId: null, snapshot: { status: "empty", chunks: [], durations: [] } };
    }
    if (command === "replace") return {
      ok: true, sessionId: payload.session.id,
      snapshot: { ...payload.session, status: "text-ready", activeKind: "chunk", selectedIndex: 0, currentTime: 0, totalDuration: 20.75 }
    };
    if (command === "start") return {
      ok: true, sessionId: payload.session.id,
      snapshot: { ...payload.session, status: "playing", activeKind: "chunk", selectedIndex: 0, currentTime: 0, totalDuration: 20.75 }
    };
    return { ok: true };
  });
  const client = new ReaderClient({ runtime });
  client.setSession({
    id: "old-session", sourceText: "One. Two.", chunks: ["One.", "Two."], queuePrepared: true,
    voice: "af_heart", audioKeys: [], durations: [null, null], chunkStates: ["pending", "pending"]
  });

  assert.equal(await client.play(), true);
  assert.deepEqual(runtime.messages.map(({ command }) => command), ["prepare-queue-audio", "replace", "start"]);
  const start = runtime.messages.find(({ command }) => command === "start");
  assert.deepEqual(start.payload.session.audioKeys, ["wav-1", "wav-2"]);
  assert.deepEqual(start.payload.session.durations, [12.5, 8.25]);
  assert.ok(start.payload.session.chunkStates.every((state) => state === "ready"));
  client.dispose();
});

test("voice preparation state requests are read-only background queries", async () => {
  const runtime = fakeRuntime(async ({ command, payload }) => command === "voice-preparation-status"
    ? { ok: true, voiceId: payload.voiceId, provider: "kokoro", state: "ready" }
    : { ok: true });
  const client = new ReaderClient({ runtime });

  assert.deepEqual(await client.voicePreparationStatus("af_heart"), {
    ok: true, voiceId: "af_heart", provider: "kokoro", state: "ready"
  });
  assert.deepEqual(runtime.messages.map(({ command }) => command), ["voice-preparation-status"]);
  client.dispose();
});

test("a background command that never answers rejects on its bounded deadline", async () => {
  const runtime = fakeRuntime(() => new Promise(() => {}));
  const client = new ReaderClient({ runtime, timeouts: { statusMs: 8 } });

  await assert.rejects(client.voicePreparationStatus("af_heart"), (error) => {
    assert.equal(error.code, "READER_COMMAND_TIMEOUT");
    assert.equal(error.phase, "background-message");
    assert.equal(error.command, "voice-preparation-status");
    return true;
  });
  client.dispose();
});

test("Piper operation identifiers reach the offscreen coordinator and coded errors survive the message bridge", async () => {
  const diagnostics = { name: "TypeError", message: "Illegal invocation", phase: "initializing-onnx", stack: "TypeError: Illegal invocation\\n at fetch" };
  const runtime = fakeRuntime(async ({ command }) => command === "initialize"
    ? { ok: false, error: "La inicialización de Piper superó el tiempo máximo.", code: "PIPER_INITIALIZATION_TIMEOUT", phase: "initialize", diagnostics }
    : { ok: true, reset: true });
  const client = new ReaderClient({ runtime });

  await assert.rejects(client.initialize("piper:es_AR-daniela-high", "panel-42"), (error) => {
    assert.equal(error.code, "PIPER_INITIALIZATION_TIMEOUT");
    assert.equal(error.phase, "initialize");
    assert.deepEqual(error.diagnostics, diagnostics);
    return true;
  });
  await client.installPiperModel("piper:es_AR-daniela-high", "panel-43");
  await client.resetPiperEngine("piper:es_AR-daniela-high");
  assert.deepEqual(runtime.messages.map(({ command, payload }) => [command, payload.operationId || null]), [
    ["initialize", "panel-42"],
    ["install-piper-model", "panel-43"],
    ["reset-piper-engine", null]
  ]);
  client.dispose();
});

test("paused preview playback resumes without creating or replacing a reading session", async () => {
  const runtime = fakeRuntime(async ({ command }) => command === "preview" ? {
    ok: true,
    snapshot: { chunks: ["Hola."], status: "paused", selectedIndex: 0, speed: 1, durations: [1], activeKind: "preview", activeVoiceId: "piper:es_AR-daniela-high" }
  } : { ok: true });
  const client = new ReaderClient({ runtime });

  await client.preview("piper:es_AR-daniela-high");
  await client.play();
  assert.deepEqual(runtime.messages.map(({ command }) => command), ["preview", "resume"]);
  assert.equal(client.session, null);
  assert.equal(client.snapshot().activeKind, "preview");
  client.dispose();
});

test("completed preview can be tested again with the same Piper voice and no session", async () => {
  const runtime = fakeRuntime(async ({ command }) => command === "preview" ? {
    ok: true,
    snapshot: { chunks: ["Hola."], status: "completed", selectedIndex: 0, speed: 1, durations: [1], activeKind: "preview", activeVoiceId: "piper:es_ES-davefx-medium" }
  } : { ok: true });
  const client = new ReaderClient({ runtime });

  await client.preview("piper:es_ES-davefx-medium");
  await client.play();
  assert.deepEqual(runtime.messages.map(({ command }) => command), ["preview", "preview"]);
  assert.equal(runtime.messages[1].payload.voice, "piper:es_ES-davefx-medium");
  assert.equal(client.session, null);
  client.dispose();
});

test("Kokoro worker is not created on panel startup and can be disposed after explicit preparation", async () => {
  let created = 0;
  let terminated = 0;
  const worker = {
    postMessage(message) {
      queueMicrotask(() => this.onmessage({ data: {
        id: message.id,
        type: "result",
        value: message.type === "initialize" ? { voices: ["af_heart"] } : new Blob(["audio"])
      } }));
    },
    terminate() { terminated++; }
  };
  const client = new KokoroWorkerClient({ workerFactory: () => { created++; return worker; } });
  assert.equal(created, 0);
  assert.equal(client.preparationStatus().state, "idle");
  const preparation = client.initialize();
  assert.equal(client.preparationStatus().state, "loading");
  assert.deepEqual(await preparation, { voices: ["af_heart"] });
  assert.equal(client.preparationStatus().state, "ready");
  assert.equal(created, 1);
  assert.equal((await client.synthesize("Hello.", "af_heart")).size, 5);
  await client.dispose();
  assert.equal(client.preparationStatus().state, "idle");
  assert.equal(terminated, 1);
});

test("Kokoro synthesis refuses to initialize implicitly and requires a prepared voice", async () => {
  let created = 0;
  const client = new KokoroWorkerClient({ workerFactory: () => { created++; return {}; } });
  assert.throws(() => client.synthesize("Hello.", "af_heart"), (error) => error.code === "KOKORO_VOICE_NOT_PREPARED");
  assert.equal(created, 0);
  assert.equal(client.preparationStatus().state, "idle");
});

test("Kokoro worker errors reject the matching request with safe synthesis metadata", async () => {
  const client = new KokoroWorkerClient({ workerFactory: () => ({
    postMessage(message) {
      const data = message.type === "initialize"
        ? { id: message.id, type: "result", value: { voices: ["af_heart"] } }
        : { id: message.id, type: "error", code: "KOKORO_SYNTHESIS_FAILED", message: "ONNX failed", phase: "model-generate" };
      queueMicrotask(() => this.onmessage({ data }));
    },
    terminate() {}
  }) });

  await client.initialize();
  await assert.rejects(client.synthesize("Hello there.", "af_heart"), (error) => {
    assert.equal(error.code, "KOKORO_SYNTHESIS_FAILED");
    assert.equal(error.phase, "model-generate");
    assert.equal(error.requestId, 2);
    assert.equal(error.voiceId, "af_heart");
    assert.equal(error.textLength, 12);
    assert.ok(Number.isFinite(error.elapsedMs));
    return true;
  });
  await client.dispose();
});

test("Kokoro timeout terminates a stuck worker and permits a clean preparation retry", async () => {
  const workers = [];
  const client = new KokoroWorkerClient({
    timeouts: { initializeIdleMs: 8, initializeMaxMs: 30 },
    workerFactory: () => {
      const worker = {
        postMessage(message) {
          if (workers.length > 1 && message.type === "initialize") {
            queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "result", value: { voices: ["af_heart", "am_michael"] } } }));
          }
        },
        terminate() { this.terminated = true; }
      };
      workers.push(worker);
      return worker;
    }
  });

  await assert.rejects(client.initialize(), (error) => error.code === "KOKORO_INITIALIZATION_TIMEOUT" && error.phase === "initialize");
  assert.equal(workers[0].terminated, true);
  assert.equal(client.preparationStatus().state, "error");
  assert.equal(client.pending.size, 0);

  assert.deepEqual(await client.initialize(), { voices: ["af_heart", "am_michael"] });
  assert.equal(workers.length, 2);
  assert.equal(client.preparationStatus().state, "ready");
  assert.equal(client.pending.size, 0);
  await client.dispose();
});

test("Kokoro synthesis timeout rejects every pending operation and permits a clean retry", async () => {
  const workers = [];
  const progressEvents = [];
  const client = new KokoroWorkerClient({
    timeouts: { initializeIdleMs: 100, initializeMaxMs: 200, synthesisIdleMs: 25, synthesisMinMs: 60, synthesisMaxMs: 100 },
    workerFactory: () => {
      const worker = {
        postMessage(message) {
          if (message.type === "initialize") queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "result", value: { voices: ["af_heart"] } } }));
          if (message.type === "synthesize" && workers.length === 1) {
            queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "progress", event: {
              phase: "synthesis", stage: "model-generate", progress: null
            } } }));
          }
          if (message.type === "synthesize" && workers.length > 1) queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "result", value: new Blob(["audio"]) } }));
        },
        terminate() { this.terminated = true; }
      };
      workers.push(worker);
      return worker;
    }
  });

  await client.initialize();
  const firstAttempt = client.synthesize("Hello.", "af_heart", (event) => progressEvents.push(event));
  const secondAttempt = client.synthesize("Another request.", "af_heart", (event) => progressEvents.push(event));
  const lateMessageHandler = workers[0].onmessage;
  await assert.rejects(firstAttempt, (error) => error.code === "KOKORO_SYNTHESIS_TIMEOUT"
    && error.phase === "model-generate" && error.requestId === 2 && error.voiceId === "af_heart"
    && error.textLength === 6 && error.elapsedMs >= 0 && error.timeoutKind === "inactivity");
  await assert.rejects(secondAttempt, (error) => error.code === "KOKORO_WORKER_RESET"
    && error.phase === "model-generate" && error.requestId === 3
    && error.resetByRequestId === 2 && error.voiceId === "af_heart"
    && error.textLength === 16 && error.elapsedMs >= 0);
  assert.ok(progressEvents.some((event) => event.stage === "model-generate"
    && event.requestId === 2 && event.voiceId === "af_heart" && event.textLength === 6
    && Number.isFinite(event.elapsedMs)), "worker progress must reach the reader with safe request metadata");
  assert.equal(workers[0].terminated, true);
  assert.equal(client.preparationStatus().state, "error");
  assert.equal(client.pending.size, 0);
  const progressCountAfterTimeout = progressEvents.length;
  lateMessageHandler({ data: { id: 2, type: "progress", event: { stage: "wav-created", progress: 100 } } });
  lateMessageHandler({ data: { id: 2, type: "result", value: new Blob(["stale"]) } });
  lateMessageHandler({ data: { id: 3, type: "result", value: new Blob(["stale second request"]) } });
  assert.equal(progressEvents.length, progressCountAfterTimeout, "messages from a terminated worker must not revive the operation");
  await client.initialize();
  assert.equal((await client.synthesize("Hello again.", "af_heart")).size, 5);
  assert.equal(workers.length, 2);
  await client.dispose();
});

test("Piper installed-voice status distinguishes cached files from a prepared runtime", async () => {
  const voiceId = "piper:es_AR-daniela-high";
  const worker = {
    postMessage(message) {
      const value = message.type === "list-installed" ? [{ voiceId, installed: true }]
        : message.type === "initialize" ? { provider: "piper", voiceId, ready: true } : true;
      queueMicrotask(() => this.onmessage({ data: { id: message.id, type: "result", value } }));
    },
    terminate() {}
  };
  const client = new PiperWorkerClient({ workerFactory: () => worker, paths: () => ({}) });

  assert.deepEqual(await client.listInstalled(), [{ voiceId, installed: true, state: "cached" }]);
  await client.initialize(voiceId);
  assert.deepEqual(await client.listInstalled(), [{ voiceId, installed: true, state: "ready" }]);
  await client.dispose();
});

test("Piper synthesis refuses to initialize implicitly", async () => {
  let created = 0;
  const client = new PiperWorkerClient({ workerFactory: () => { created++; return {}; }, paths: () => ({}) });
  await assert.rejects(client.synthesize("Hola.", "piper:es_AR-daniela-high"), (error) => error.code === "PIPER_VOICE_NOT_PREPARED");
  assert.equal(created, 0);
});
