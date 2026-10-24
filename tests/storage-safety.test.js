import test from "node:test";
import assert from "node:assert/strict";
import { isAudioStorageBusy, isProviderVoiceInUse, storageOperationBusyError, storageOperationBusyMessage } from "../src/storage-safety.js";

test("saved-audio cleanup is blocked during active playback, generation, or pending synthesis", () => {
  for (const status of ["starting", "generating", "playing"]) {
    assert.equal(isAudioStorageBusy({ status }), true, `${status} must keep its audio cache intact`);
  }
  assert.equal(isAudioStorageBusy({ status: "paused" }), false);
  assert.equal(isAudioStorageBusy({ status: "completed" }, true), true);
});

test("provider deletion only blocks a read that uses the provider or Piper voice being removed", () => {
  const piperVoice = "piper:es_AR-daniela-high";
  const piperSnapshot = { status: "playing", activeKind: "chunk", activeVoiceId: piperVoice };
  assert.equal(isProviderVoiceInUse({ snapshot: piperSnapshot, provider: "piper", voiceId: piperVoice }), true);
  assert.equal(isProviderVoiceInUse({ snapshot: piperSnapshot, provider: "piper", voiceId: "piper:es_ES-davefx-medium" }), false);
  assert.equal(isProviderVoiceInUse({ snapshot: piperSnapshot, provider: "kokoro" }), false);
  assert.equal(isProviderVoiceInUse({ snapshot: { status: "generating", activeKind: "chunk" }, session: { voice: "af_heart" }, provider: "kokoro" }), true);
  assert.equal(isProviderVoiceInUse({ snapshot: { status: "playing", activeKind: "preview" }, selectedVoiceId: "am_michael", provider: "kokoro" }), true);
});

test("busy model-operation errors keep a clear message across the background message boundary", () => {
  const error = storageOperationBusyError("La lectura está en curso.");
  assert.equal(storageOperationBusyMessage(error), "La lectura está en curso.");
  assert.equal(storageOperationBusyMessage(new Error(error.message)), "La lectura está en curso.");
  assert.equal(storageOperationBusyMessage(new Error("fallo de almacenamiento")), "");
});
