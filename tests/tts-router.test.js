import test from "node:test";
import assert from "node:assert/strict";
import { TTSProviderRouter } from "../src/tts-router.js";

test("router initializes and synthesizes through only the selected local provider", async () => {
  const calls = [];
  const kokoro = {
    async initialize(progress) { calls.push(["kokoro:init", typeof progress]); return { voices: ["af_heart"] }; },
    preparationStatus() { return { provider: "kokoro", state: "ready" }; },
    async synthesize(text, voice) { calls.push(["kokoro:synthesize", text, voice]); return new Blob(["kokoro wav"]); },
    async dispose() { calls.push(["kokoro:dispose"]); }
  };
  const piper = {
    async initialize(voice, progress) { calls.push(["piper:init", voice, typeof progress]); return { voiceId: voice, ready: true }; },
    async synthesize(text, voice, progress) { calls.push(["piper:synthesize", text, voice, typeof progress]); return new Blob(["piper wav"]); },
    async modelStatus(voiceId) { return { voiceId, installed: true }; },
    async installModel(voiceId) { return { voiceId, installed: true }; },
    async removeModel(voiceId) { return { voiceId, installed: false }; },
    catalog() { return [{ id: "piper:es_AR-daniela-high" }]; },
    async listInstalled() { return [{ voiceId: "piper:es_AR-daniela-high", installed: true }]; },
    async preparationStatus(voiceId) { return { provider: "piper", voiceId, state: "ready", installed: true }; },
    async dispose() { calls.push(["piper:dispose"]); }
  };
  const router = new TTSProviderRouter({ kokoro, piper });

  assert.equal((await router.initialize(() => {}, "piper:es_AR-daniela-high")).provider, "piper");
  assert.equal((await router.synthesize("Hola.", "piper:es_AR-daniela-high")) instanceof Blob, true);
  assert.equal((await router.initialize(() => {}, "af_heart")).provider, "kokoro");
  assert.equal((await router.synthesize("Hello.", "af_heart")) instanceof Blob, true);
  assert.deepEqual(await router.piperModelStatus("piper:es_AR-daniela-high"), { voiceId: "piper:es_AR-daniela-high", installed: true });
  assert.deepEqual(await router.installPiperModel("piper:es_AR-daniela-high"), { voiceId: "piper:es_AR-daniela-high", installed: true });
  assert.deepEqual(await router.deletePiperModel("piper:es_AR-daniela-high"), { voiceId: "piper:es_AR-daniela-high", installed: false });
  assert.deepEqual(router.piperCatalog(), [{ id: "piper:es_AR-daniela-high" }]);
  assert.deepEqual(await router.listInstalledPiperModels(), [{ voiceId: "piper:es_AR-daniela-high", installed: true }]);
  assert.deepEqual(await router.preparationStatus("af_heart"), { provider: "kokoro", state: "ready", voiceId: "af_heart" });
  assert.deepEqual(await router.preparationStatus("piper:es_AR-daniela-high"), { provider: "piper", voiceId: "piper:es_AR-daniela-high", state: "ready", installed: true });
  await router.dispose();

  assert.deepEqual(calls.slice(0, 4), [
    ["piper:init", "piper:es_AR-daniela-high", "function"],
    ["piper:synthesize", "Hola.", "piper:es_AR-daniela-high", "undefined"],
    ["kokoro:init", "function"],
    ["kokoro:synthesize", "Hello.", "af_heart"]
  ]);
  assert.ok(calls.some(([name]) => name === "kokoro:dispose"));
  assert.ok(calls.some(([name]) => name === "piper:dispose"));
});

test("router rejects unknown and cross-provider voice IDs without silently falling back", async () => {
  const calls = [];
  const router = new TTSProviderRouter({
    kokoro: { async initialize() { calls.push("kokoro"); }, async synthesize() {}, async dispose() {} },
    piper: { async initialize() { calls.push("piper"); }, async synthesize() {}, async dispose() {} }
  });
  await assert.rejects(router.initialize(() => {}, "system:old-edge-voice"), /desconocido/);
  await assert.rejects(router.synthesize("Hola", "not-a-voice"), /desconocido/);
  assert.deepEqual(calls, []);
});

test("router never initializes a provider implicitly during synthesis", async () => {
  const calls = [];
  const router = new TTSProviderRouter({
    kokoro: {
      preparationStatus() { return { state: "idle" }; },
      async initialize() { calls.push("kokoro:init"); },
      async synthesize() { calls.push("kokoro:synthesize"); },
      async dispose() {}
    },
    piper: {
      async preparationStatus(voiceId) { return { provider: "piper", voiceId, state: "cached", installed: true }; },
      async initialize() { calls.push("piper:init"); },
      async synthesize() { calls.push("piper:synthesize"); },
      async dispose() {}
    }
  });

  await assert.rejects(router.synthesize("Hello.", "af_heart"), (error) => error.code === "VOICE_NOT_PREPARED");
  await assert.rejects(router.synthesize("Hola.", "piper:es_AR-daniela-high"), (error) => error.code === "VOICE_NOT_PREPARED");
  assert.deepEqual(calls, [], "unprepared synthesis must not initialize or infer behind the Play action");
});

test("router decorates Piper readiness with its provider and selected voice", async () => {
  const router = new TTSProviderRouter({
    kokoro: { async initialize() {}, async synthesize() {}, preparationStatus() { return { state: "idle" }; }, async dispose() {} },
    piper: {
      async preparationStatus(voiceId) { return { voiceId, state: "ready", installed: true }; },
      async initialize() {}, async synthesize() {}, async dispose() {}
    }
  });

  assert.deepEqual(await router.preparationStatus("piper:es_AR-daniela-high"), {
    provider: "piper", voiceId: "piper:es_AR-daniela-high", state: "ready", installed: true
  });
});

test("Kokoro removal deletes only its own resources without disposing Piper", async () => {
  const calls = [];
  const router = new TTSProviderRouter({
    kokoro: { async initialize() {}, async synthesize() {}, async dispose() {}, async deleteModel() { calls.push("kokoro:delete-model"); } },
    piper: { async initialize() {}, async synthesize() {}, async removeModel() {}, async dispose() { calls.push("piper:dispose"); } }
  });

  await router.deleteKokoroModel();
  assert.deepEqual(calls, ["kokoro:delete-model"]);
  assert.equal(calls.filter((name) => name === "piper:dispose").length, 0);
});
