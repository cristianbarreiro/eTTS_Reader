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
