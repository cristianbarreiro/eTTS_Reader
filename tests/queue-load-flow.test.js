import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_VOICE_CATALOG } from "../src/voice-catalog.js";
import { isVoicePreparedForQueue, runVoiceGatedQueueLoad } from "../src/queue-load-flow.js";

test("all four local voices require an actual matching ready status", () => {
  assert.equal(LOCAL_VOICE_CATALOG.length, 4);
  for (const voice of LOCAL_VOICE_CATALOG) {
    const ready = { voiceId: voice.id, provider: voice.provider, state: "ready", ...(voice.provider === "piper" ? { installed: true } : {}) };
    assert.equal(isVoicePreparedForQueue(ready, voice.id), true, `${voice.id} accepts its ready status`);
    assert.equal(isVoicePreparedForQueue({ ...ready, voiceId: "other" }, voice.id), false, `${voice.id} rejects a status for another voice`);
    assert.equal(isVoicePreparedForQueue({ ...ready, state: "cached" }, voice.id), false, `${voice.id} distinguishes cached files from an initialized runtime`);
    if (voice.provider === "piper") {
      assert.equal(isVoicePreparedForQueue({ ...ready, installed: false }, voice.id), false, "Piper also requires the installed model");
    }
  }
});

test("the first click prepares an unready voice without replacing the queue", async () => {
  for (const voice of LOCAL_VOICE_CATALOG) {
    let status = { voiceId: voice.id, provider: voice.provider, state: "cached", ...(voice.provider === "piper" ? { installed: true } : {}) };
    const calls = [];
    const result = await runVoiceGatedQueueLoad({
      voiceId: voice.id,
      async getPreparationStatus(id) { calls.push(["status", id]); return status; },
      async prepareVoice(id) { calls.push(["prepare", id]); status = { voiceId: id, provider: voice.provider, state: "ready", ...(voice.provider === "piper" ? { installed: true } : {}) }; return true; },
      async loadQueue() { calls.push(["load"]); return true; }
    });
    assert.equal(result.action, "voice-prepared", `${voice.id} uses a separate preparation action`);
    assert.deepEqual(calls.map(([action]) => action), ["status", "prepare", "status"]);
  }
});

test("a second click with a ready voice loads the queue without preparing again", async () => {
  const voice = LOCAL_VOICE_CATALOG[0];
  const calls = [];
  const result = await runVoiceGatedQueueLoad({
    voiceId: voice.id,
    async getPreparationStatus() { calls.push("status"); return { voiceId: voice.id, provider: voice.provider, state: "ready" }; },
    async prepareVoice() { calls.push("prepare"); },
    async loadQueue() { calls.push("load"); return "loaded"; }
  });
  assert.deepEqual(result, { action: "queue-loaded", result: "loaded", status: { voiceId: voice.id, provider: voice.provider, state: "ready" } });
  assert.deepEqual(calls, ["status", "load"]);
});

test("failed or stale voice preparation never starts loading or replaces the queue", async () => {
  const voice = LOCAL_VOICE_CATALOG[0];
  let loadCalls = 0;
  await assert.rejects(runVoiceGatedQueueLoad({
    voiceId: voice.id,
    async getPreparationStatus() { return { voiceId: voice.id, provider: voice.provider, state: "idle" }; },
    async prepareVoice() { return false; },
    async loadQueue() { loadCalls++; }
  }), (error) => error.code === "VOICE_PREPARATION_FAILED");
  assert.equal(loadCalls, 0);

  await assert.rejects(runVoiceGatedQueueLoad({
    voiceId: voice.id,
    async getPreparationStatus() { return { voiceId: voice.id, provider: voice.provider, state: "idle" }; },
    async prepareVoice() { return true; },
    async loadQueue() { loadCalls++; }
  }), (error) => error.code === "VOICE_NOT_READY_AFTER_PREPARATION");
  assert.equal(loadCalls, 0, "a success result from prepare is not enough until a fresh status confirms readiness");

  const stale = await runVoiceGatedQueueLoad({
    voiceId: voice.id,
    isCurrent: () => false,
    async getPreparationStatus() { return { voiceId: voice.id, provider: voice.provider, state: "idle" }; },
    async prepareVoice() {},
    async loadQueue() { loadCalls++; }
  });
  assert.deepEqual(stale, { action: "stale" });
  assert.equal(loadCalls, 0);
});
