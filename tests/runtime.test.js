import test from "node:test";
import assert from "node:assert/strict";
import { resolveKokoroAssetUrls, verifyWasmAssets } from "../src/onnx-assets.js";
import { attemptInitialization, deriveReaderControls } from "../src/reader-state.js";

const rootInstall = resolveKokoroAssetUrls("chrome-extension://abc/dist/assets/popup.js");
const distInstall = resolveKokoroAssetUrls("chrome-extension://abc/assets/popup.js");

test("extension asset URLs resolve beneath either unpacked extension root", () => {
  assert.equal(rootInstall.wasmBaseUrl, "chrome-extension://abc/dist/ort/");
  assert.equal(rootInstall.moduleUrl, "chrome-extension://abc/dist/ort/ort-wasm-simd-threaded.jsep.mjs");
  assert.equal(rootInstall.voiceUrl("af_heart"), "chrome-extension://abc/dist/voices/af_heart.bin");
  assert.equal(distInstall.wasmBaseUrl, "chrome-extension://abc/ort/");
  assert.equal(distInstall.wasmUrl, "chrome-extension://abc/ort/ort-wasm-simd-threaded.jsep.wasm");
});

test("runtime preflight accepts a served module and WASM binary", async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push([url, options.method || "GET"]);
    return new Response(options.method === "HEAD" ? null : "export default {};", {
      status: 200,
      headers: { "content-type": options.method === "HEAD" ? "application/wasm" : "text/javascript; charset=utf-8" }
    });
  };
  await verifyWasmAssets(rootInstall, fetchMock);
  assert.deepEqual(calls.map((call) => call[1]), ["GET", "HEAD"]);
});

test("runtime preflight reports missing resources instead of attempting model startup", async () => {
  await assert.rejects(
    verifyWasmAssets(rootInstall, async () => new Response("missing", { status: 404 })),
    /módulo ONNX local \(HTTP 404\)/
  );
  await assert.rejects(
    verifyWasmAssets(rootInstall, async (_url, options) => new Response(options.method === "HEAD" ? null : "ok", {
      status: options.method === "HEAD" ? 404 : 200,
      headers: { "content-type": options.method === "HEAD" ? "application/wasm" : "text/javascript" }
    })),
    /binario WASM local \(HTTP 404\)/
  );
});

test("runtime preflight reports an incompatible extension resource MIME type", async () => {
  await assert.rejects(
    verifyWasmAssets(rootInstall, async (_url, options) => new Response(options.method === "HEAD" ? null : "not JavaScript", {
      status: 200,
      headers: { "content-type": options.method === "HEAD" ? "application/wasm" : "text/html" }
    })),
    /módulo ONNX local tiene un tipo MIME incompatible \(text\/html\)/
  );
  await assert.rejects(
    verifyWasmAssets(rootInstall, async (_url, options) => new Response(options.method === "HEAD" ? null : "ok", {
      status: 200,
      headers: { "content-type": options.method === "HEAD" ? "application/octet-stream" : "text/javascript" }
    })),
    /binario WASM local tiene un tipo MIME incompatible \(application\/octet-stream\)/
  );
});

test("reader controls stay disabled while idle, loading, or failed; retry is enabled", () => {
  for (const status of ["idle", "loading", "error"]) {
    const controls = deriveReaderControls(status, 1);
    assert.equal(controls.canPlay, false);
    assert.equal(controls.canTestVoice, false);
  }
  assert.equal(deriveReaderControls("error", 1).canInitialize, true);
  const ready = deriveReaderControls("ready", 1);
  assert.equal(ready.canPlay, true);
  assert.equal(ready.canTestVoice, true);
  assert.equal(deriveReaderControls("ready", 0).canPlay, false);
});

test("cached model files do not count as an initialized engine", () => {
  const cached = deriveReaderControls("cached", 1);
  assert.equal(cached.canPlay, false);
  assert.equal(cached.canTestVoice, false);
  assert.equal(cached.canInitialize, true);

  const cachedAudio = deriveReaderControls("cached", 1, false, { audioAvailable: true });
  assert.equal(cachedAudio.canPlay, true, "an existing WAV can play without loading Kokoro");
  assert.equal(cachedAudio.canTestVoice, false, "a voice test still requires an initialized engine");
  assert.equal(cachedAudio.canInitialize, true);
  assert.equal(deriveReaderControls("error", 1, true).canPause, true, "an active player remains pausable after a model error");
});

test("a listed system voice can play and pause without initializing Kokoro", () => {
  const system = deriveReaderControls("idle", 1, false, { provider: "speechSynthesis", systemVoiceAvailable: true });
  assert.equal(system.canInitialize, false);
  assert.equal(system.canPlay, true);
  assert.equal(system.canTestVoice, true);
  assert.equal(system.canPause, false);

  const missing = deriveReaderControls("ready", 1, false, { provider: "speechSynthesis", systemVoiceAvailable: false });
  assert.equal(missing.canPlay, false);
  assert.equal(missing.canTestVoice, false);
});

test("failed model initialization enters error state and can be retried", async () => {
  const states = [];
  const failure = new Error("download failed");
  const failed = await attemptInitialization(async () => { throw failure; }, (state) => states.push(state));
  assert.deepEqual(states, ["loading", "error"]);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, failure);
  assert.equal(deriveReaderControls(states.at(-1), 1).canPlay, false);
  assert.equal(deriveReaderControls(states.at(-1), 1).canTestVoice, false);
  assert.equal(deriveReaderControls(states.at(-1), 1).canInitialize, true);

  const retried = await attemptInitialization(async () => {}, (state) => states.push(state));
  assert.equal(retried.ok, true);
  assert.deepEqual(states, ["loading", "error", "loading", "ready"]);
  assert.equal(deriveReaderControls(states.at(-1), 1).canTestVoice, true);
});
