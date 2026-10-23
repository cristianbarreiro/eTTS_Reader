import test from "node:test";
import assert from "node:assert/strict";
import { TTSProviderRouter } from "../src/tts-router.js";
import { makeSystemVoiceId } from "../src/voice-catalog.js";

test("router initializes and synthesizes with only the selected provider", async () => {
  const voice = { name: "Microsoft Sabina", lang: "es-MX", voiceURI: "urn:voice:sabina" };
  const systemId = makeSystemVoiceId(voice);
  const calls = [];
  const kokoro = {
    async initialize() { calls.push("kokoro:init"); return { voices: ["af_heart"] }; },
    async synthesize(text, voiceId) { calls.push(`kokoro:${voiceId}:${text}`); return new Blob(["wav"]); },
    async dispose() { calls.push("kokoro:dispose"); }
  };
  const systemSpeech = {
    async listVoices() { return [{ id: systemId }]; },
    async synthesize(text, voiceId) { calls.push(`system:${voiceId}:${text}`); return { kind: "system-speech", voiceId, text }; },
    cancel() { calls.push("system:cancel"); }
  };
  const router = new TTSProviderRouter({ kokoro, systemSpeech });

  assert.equal((await router.initialize(() => {}, systemId)).provider, "speechSynthesis");
  assert.deepEqual(calls, []);
  const spanish = await router.synthesize("Hola.", systemId);
  assert.equal(spanish.kind, "system-speech");
  assert.equal((await router.initialize()).provider, "kokoro");
  const english = await router.synthesize("Hello.", "af_heart");
  assert.ok(english instanceof Blob);
  assert.deepEqual(calls, [
    `system:${systemId}:Hola.`,
    "kokoro:init",
    "kokoro:af_heart:Hello."
  ]);
});

test("router rejects a system voice that disappeared and disposes providers", async () => {
  const calls = [];
  const router = new TTSProviderRouter({
    kokoro: { async initialize() { calls.push("kokoro:init"); }, async synthesize() {}, async dispose() { calls.push("kokoro:dispose"); } },
    systemSpeech: { async listVoices() { return []; }, async synthesize() {}, cancel() { calls.push("system:cancel"); } }
  });
  const missingId = makeSystemVoiceId({ name: "Missing", lang: "es-ES", voiceURI: "urn:voice:missing" });
  await assert.rejects(router.initialize(() => {}, missingId), /ya no está disponible/);
  await router.dispose();
  assert.deepEqual(calls, ["system:cancel", "kokoro:dispose"]);
});
