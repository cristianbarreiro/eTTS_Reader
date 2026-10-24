import test from "node:test";
import assert from "node:assert/strict";
import { ReaderClient, snapshotFromSession } from "../src/reader-client.js";
import { KokoroWorkerClient } from "../src/tts-worker-client.js";

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
  assert.deepEqual(await client.initialize(), { voices: ["af_heart"] });
  assert.equal(created, 1);
  assert.equal((await client.synthesize("Hello.", "af_heart")).size, 5);
  await client.dispose();
  assert.equal(terminated, 1);
});
