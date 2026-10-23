import test from "node:test";
import assert from "node:assert/strict";
import { formatTime, validateWavBlob } from "../src/audio-utils.js";
import { PlaybackController } from "../src/player-controller.js";

function makeWavBlob(sample = 1) {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  write(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 96000, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  write(36, "data");
  view.setUint32(40, 4, true);
  view.setFloat32(44, sample, true);
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
  rejectPlay = null;
  playCount = 0;

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  emit(name) {
    for (const listener of this.listeners.get(name) || []) listener({ type: name, target: this });
  }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }

  load() {
    if (!this.src) {
      this.currentTime = 0;
      this.duration = Number.NaN;
      this.ended = false;
      return;
    }
    this.currentTime = 0;
    this.duration = 8;
    this.ended = false;
    this.emit("loadedmetadata");
  }

  async play() {
    this.playCount++;
    if (this.rejectPlay) throw this.rejectPlay;
    this.paused = false;
    this.ended = false;
    this.emit("play");
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }

  finish() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.emit("timeupdate");
    this.emit("ended");
  }
}

function makePlayer({ synthesize, onState = () => {}, createObjectURL, revokeObjectURL } = {}) {
  const audio = new MockAudio();
  const synthCalls = [];
  const revoked = [];
  let urlIndex = 0;
  const player = new PlaybackController({
    audio,
    synthesize: synthesize || (async (text, options) => {
      synthCalls.push({ text, options });
      return makeWavBlob();
    }),
    onState,
    createObjectURL: createObjectURL || (() => `blob:reader-${++urlIndex}`),
    revokeObjectURL: revokeObjectURL || ((url) => revoked.push({ url, src: audio.src }))
  });
  return { audio, player, synthCalls, revoked };
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(predicate, message = "Timed out waiting for player state") {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay();
  }
  assert.fail(message);
}

test("WAV validation accepts generated RIFF audio and rejects corrupt payloads", async () => {
  assert.equal(await validateWavBlob(makeWavBlob()), true);
  await assert.rejects(validateWavBlob(new Blob(["not audio"])), /vacío o incompleto/);
  await assert.rejects(validateWavBlob(new Blob([new Uint8Array(44)])), /cabecera WAV válida/);
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(formatTime(3661), "1:01:01");
  assert.equal(formatTime(Number.NaN), "--:--");
});

test("a multi-fragment reading generates and plays fragments sequentially without overlap", async () => {
  const { audio, player, synthCalls } = makePlayer();
  player.setChunks(["First.", "Second.", "Third."]);
  assert.equal(await player.play(), true);
  assert.deepEqual(synthCalls.map(({ text }) => text), ["First."]);
  assert.equal(player.snapshot().status, "playing");
  assert.equal(await player.play(), true);
  assert.equal(audio.playCount, 1);
  assert.deepEqual(player.snapshot().pendingChunkIndices, [1, 2]);

  audio.finish();
  await waitFor(() => synthCalls.length === 2 && player.snapshot().status === "playing");
  assert.equal(player.snapshot().selectedIndex, 1);
  audio.finish();
  await waitFor(() => synthCalls.length === 3 && player.snapshot().status === "playing");
  assert.equal(player.snapshot().selectedIndex, 2);
  audio.finish();
  await waitFor(() => player.snapshot().status === "completed");
  assert.equal(player.snapshot().playingIndex, null);
  assert.equal(player.snapshot().pendingChunkIndices.length, 0);
  assert.equal(player.snapshot().totalDuration, 24);
});

test("pause and resume preserve the current position and reuse the WAV", async () => {
  const { audio, player, synthCalls } = makePlayer();
  player.setChunks(["Resume this clip."]);
  await player.play();
  audio.currentTime = 3.25;
  audio.emit("timeupdate");
  assert.equal(player.pause(), true);
  assert.equal(player.snapshot().status, "paused");
  assert.equal(player.snapshot().currentTime, 3.25);
  await player.play();
  assert.equal(player.snapshot().status, "playing");
  assert.equal(audio.currentTime, 3.25);
  assert.equal(synthCalls.length, 1);
});

test("seek uses real fragment metadata and reports real current time", async () => {
  const { audio, player } = makePlayer();
  player.setChunks(["Seek this clip."]);
  assert.equal(player.seek(2), false);
  await player.play();
  assert.equal(player.snapshot().duration, 8);
  assert.equal(player.seek(3.5), true);
  assert.equal(audio.currentTime, 3.5);
  assert.equal(player.snapshot().currentTime, 3.5);
  assert.equal(player.snapshot().totalProgress, 3.5 / 8);
  assert.equal(player.seek(99), true);
  assert.equal(audio.currentTime, 8);
});

test("stop resets to the first fragment and the next play works without reloading", async () => {
  const { audio, player, synthCalls, revoked } = makePlayer();
  player.setChunks(["One.", "Two."]);
  await player.play();
  audio.currentTime = 5;
  player.stop();
  assert.equal(player.snapshot().status, "stopped");
  assert.equal(player.snapshot().selectedIndex, 0);
  assert.equal(player.snapshot().currentTime, 0);
  assert.equal(audio.src, "");
  assert.deepEqual(revoked.map(({ src }) => src), [""]);
  await player.play();
  assert.equal(player.snapshot().status, "playing");
  assert.equal(player.snapshot().selectedIndex, 0);
  assert.deepEqual(synthCalls.map(({ text }) => text), ["One.", "One."]);
});

test("previous and next select real chunks and replace active playback", async () => {
  const { player, synthCalls } = makePlayer();
  player.setChunks(["One.", "Two.", "Three."]);
  assert.equal(await player.next(), true);
  assert.equal(player.snapshot().selectedIndex, 1);
  assert.equal(await player.previous(), true);
  assert.equal(player.snapshot().selectedIndex, 0);
  assert.equal(await player.previous(), false);
  await player.play();
  assert.equal(await player.next(), true);
  assert.equal(player.snapshot().selectedIndex, 1);
  assert.equal(player.snapshot().playingIndex, 1);
  assert.deepEqual(synthCalls.map(({ text }) => text), ["One.", "Two."]);
});

test("playback speed applies immediately and remains in effect on the next fragment", async () => {
  const { audio, player } = makePlayer();
  player.setChunks(["One.", "Two."]);
  await player.play();
  assert.equal(player.setSpeed(1.5), true);
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(audio.preservesPitch, true);
  audio.finish();
  await waitFor(() => player.snapshot().status === "playing" && player.snapshot().selectedIndex === 1);
  assert.equal(audio.playbackRate, 1.5);
});

test("replaying a completed reading starts again at the beginning", async () => {
  const { audio, player, synthCalls } = makePlayer();
  player.setChunks(["Only fragment."]);
  await player.play();
  audio.finish();
  await waitFor(() => player.snapshot().status === "completed");
  await player.play();
  assert.equal(player.snapshot().selectedIndex, 0);
  assert.equal(player.snapshot().status, "playing");
  assert.equal(audio.currentTime, 0);
  assert.deepEqual(synthCalls.map(({ text }) => text), ["Only fragment."]);
});

test("text replacement invalidates old synthesis and prevents stale audio from taking over", async () => {
  let resolveOld;
  const synthCalls = [];
  const { audio, player } = makePlayer({
    synthesize: (text) => {
      synthCalls.push(text);
      if (text === "Old text.") return new Promise((resolve) => { resolveOld = resolve; });
      return Promise.resolve(makeWavBlob());
    }
  });
  player.setChunks(["Old text."]);
  const oldTask = player.play();
  await waitFor(() => typeof resolveOld === "function");
  player.setChunks(["New text."]);
  const newTask = player.play();
  resolveOld(makeWavBlob());
  await oldTask;
  await newTask;
  assert.deepEqual(synthCalls, ["Old text.", "New text."]);
  assert.equal(player.snapshot().status, "playing");
  assert.equal(audio.src, "blob:reader-1");
});

test("synthesis and playback errors are visible and can be recovered", async () => {
  let failSynthesis = true;
  const { audio, player, synthCalls } = makePlayer({
    synthesize: async (text, options) => {
      synthCalls.push({ text, options });
      if (failSynthesis) throw new Error("synthesis offline");
      return makeWavBlob();
    }
  });
  player.setChunks(["Try again."]);
  assert.equal(await player.play(), false);
  assert.equal(player.snapshot().status, "error");
  assert.match(player.snapshot().message, /synthesis offline/);
  failSynthesis = false;
  assert.equal(await player.play(), true);
  audio.rejectPlay = new Error("play blocked");
  audio.finish();
  await waitFor(() => player.snapshot().status === "completed");
  player.stop();
  await player.play();
  assert.equal(player.snapshot().status, "error");
  assert.match(player.snapshot().message, /play blocked/);
  audio.rejectPlay = null;
  assert.equal(await player.play(), true);
  assert.equal(player.snapshot().status, "playing");
});

test("repeated play while synthesis is pending does not start parallel generation", async () => {
  let resolveSynthesis;
  const calls = [];
  const { player } = makePlayer({
    synthesize: (text) => {
      calls.push(text);
      return new Promise((resolve) => { resolveSynthesis = resolve; });
    }
  });
  player.setChunks(["One."]);
  const first = player.play();
  const second = player.play();
  await waitFor(() => typeof resolveSynthesis === "function");
  assert.deepEqual(calls, ["One."]);
  resolveSynthesis(makeWavBlob());
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(player.snapshot().status, "playing");
});

test("current-fragment WAV download is named clearly and Blob URLs release after detaching", async () => {
  const { audio, player, revoked } = makePlayer();
  player.setChunks(["Download this."]);
  await player.play();
  assert.equal(player.snapshot().downloadUrl, audio.src);
  assert.equal(player.snapshot().downloadFilename, "lectura-fragmento-01.wav");
  player.setChunks(["Replacement."]);
  assert.equal(audio.src, "");
  assert.deepEqual(revoked, [{ url: "blob:reader-1", src: "" }]);
});

test("voice sample uses the same player and WAV download path", async () => {
  const { audio, player } = makePlayer();
  player.setChunks(["Read this."]);
  await player.preview("Hello from the sample.", { voice: "am_michael" });
  assert.equal(player.snapshot().activeKind, "preview");
  assert.equal(player.snapshot().status, "playing");
  assert.equal(player.snapshot().downloadFilename, "muestra-am_michael.wav");
  audio.finish();
  await waitFor(() => player.snapshot().status === "completed");
  assert.equal(player.snapshot().message, "Muestra de voz completada.");
});

test("voice sample can pause, resume, replay, and stop without document text", async () => {
  const { audio, player, synthCalls } = makePlayer();
  await player.preview("Hello.", { voice: "af_heart" });
  audio.currentTime = 2;
  assert.equal(player.pause(), true);
  assert.equal(player.snapshot().status, "paused");
  assert.equal(await player.play(), true);
  assert.equal(audio.currentTime, 2);
  audio.finish();
  await waitFor(() => player.snapshot().status === "completed");
  assert.equal(await player.play(), true);
  assert.equal(audio.currentTime, 0);
  assert.equal(player.snapshot().status, "playing");
  player.stop();
  assert.equal(player.snapshot().status, "empty");
  assert.equal(audio.src, "");
  assert.deepEqual(synthCalls.map(({ text }) => text), ["Hello."]);
});
