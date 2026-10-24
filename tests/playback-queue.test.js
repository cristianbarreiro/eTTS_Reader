import test from "node:test";
import assert from "node:assert/strict";
import { playbackQueueMatchesEditor, preparePlaybackQueue } from "../src/playback-queue.js";

const makeId = (() => { let id = 0; return (prefix) => `${prefix}-${++id}`; })();

test("loading an empty or whitespace editor is rejected without producing a queue", () => {
  for (const text of ["", " \n\t "]) {
    assert.throws(() => preparePlaybackQueue({ text, chunks: [], makeId }), /antes de cargarlo/);
  }
});

test("a prepared queue captures the exact editor text, ordered chunks, provider, voice, and speed", () => {
  const queue = preparePlaybackQueue({
    editorSession: { id: "draft-1", documentId: "doc-1", sourceDocumentName: "Artículo", sourceText: "Hola. Mundo.", chunks: ["Hola.", "Mundo."], voice: "af_heart", audioKeys: [] },
    text: "Hola. Mundo.", chunks: ["Hola.", "Mundo."], voice: "af_heart", speed: 1.25,
    makeId, now: () => 1234
  });

  assert.equal(queue.id, "draft-1");
  assert.equal(queue.queuePrepared, true);
  assert.equal(queue.sourceText, "Hola. Mundo.");
  assert.deepEqual(queue.chunks, ["Hola.", "Mundo."]);
  assert.equal(queue.voice, "af_heart");
  assert.equal(queue.voiceProvider, "kokoro");
  assert.equal(queue.speed, 1.25);
  assert.equal(queue.preparedAt, 1234);
  assert.equal(queue.queueVersion, "queue-1");
  assert.deepEqual(queue.chunkStates, ["pending", "pending"]);
});

test("audio references survive only when their text, segmentation, and voice still match", () => {
  const source = {
    id: "session-old", sourceText: "First. Second.", chunks: ["First.", "Second."],
    voice: "af_heart", audioKeys: ["wav-1", "wav-2"], chunkStates: ["ready", "ready"],
    durations: [2.5, 3.5], selectedIndex: 1, position: 1.2, status: "paused", queuePrepared: true
  };
  const compatible = preparePlaybackQueue({ editorSession: source, text: source.sourceText, chunks: source.chunks, voice: "af_heart", speed: 1.5, loadedSession: source, makeId, now: () => 5 });
  assert.notEqual(compatible.id, source.id, "a new queue version must not overwrite the loaded version");
  assert.deepEqual(compatible.audioKeys, ["wav-1", "wav-2"]);
  assert.deepEqual(compatible.durations, [2.5, 3.5]);
  assert.equal(compatible.selectedIndex, 1);
  assert.equal(compatible.position, 1.2);

  const changedVoice = preparePlaybackQueue({ editorSession: source, text: source.sourceText, chunks: source.chunks, voice: "am_michael", speed: 1, loadedSession: source, makeId, now: () => 6 });
  assert.deepEqual(changedVoice.audioKeys, [null, null]);
  assert.deepEqual(changedVoice.durations, [null, null]);
  assert.equal(changedVoice.voiceProvider, "kokoro");

  const changedText = preparePlaybackQueue({ editorSession: source, text: "New text.", chunks: ["New text."], voice: "af_heart", speed: 1, loadedSession: source, makeId, now: () => 7 });
  assert.deepEqual(changedText.audioKeys, [null]);
  assert.equal(changedText.selectedIndex, 0);
});

test("reloading an unchanged queue keeps reusable audio but returns it to a non-playing ready state", () => {
  const loaded = {
    id: "session-ready", sourceText: "Hello.", chunks: ["Hello."], voice: "af_heart", speed: 1,
    status: "playing", selectedIndex: 0, position: 0.8, queuePrepared: true,
    audioKeys: ["wav-1"], chunkStates: ["ready"], durations: [2.4]
  };
  const queue = preparePlaybackQueue({
    editorSession: loaded, loadedSession: loaded, text: loaded.sourceText, chunks: loaded.chunks,
    voice: loaded.voice, speed: loaded.speed, makeId, now: () => 42
  });

  assert.equal(queue.id, loaded.id);
  assert.equal(queue.status, "text-ready");
  assert.equal(queue.preparedAt, 42);
  assert.deepEqual(queue.audioKeys, ["wav-1"]);
  assert.deepEqual(queue.durations, [2.4]);

  const legacy = preparePlaybackQueue({
    editorSession: { ...loaded, queuePrepared: undefined, queueVersion: undefined },
    loadedSession: { ...loaded, queuePrepared: undefined, queueVersion: undefined },
    text: loaded.sourceText, chunks: loaded.chunks, voice: loaded.voice, speed: loaded.speed,
    makeId, now: () => 43
  });
  assert.equal(legacy.queuePrepared, true, "legacy loaded sessions are upgraded before replace");
  assert.ok(legacy.queueVersion);
});

test("queue matching marks edited text or voice stale and excludes unprepared drafts", () => {
  const loaded = { id: "session-1", queuePrepared: true, sourceText: "Original.", voice: "af_heart", chunks: ["Original."] };
  assert.equal(playbackQueueMatchesEditor(loaded, { text: "Original.", voice: "af_heart" }), true);
  assert.equal(playbackQueueMatchesEditor(loaded, { text: "Edited.", voice: "af_heart" }), false);
  assert.equal(playbackQueueMatchesEditor(loaded, { text: "Original.", voice: "am_michael" }), false);
  assert.equal(playbackQueueMatchesEditor({ ...loaded, queuePrepared: false }, { text: "Original.", voice: "af_heart" }), false);
  assert.equal(playbackQueueMatchesEditor({ ...loaded, queuePrepared: undefined }, { text: "Original.", voice: "af_heart" }), true, "legacy sessions remain recoverable as prepared queues");
});

