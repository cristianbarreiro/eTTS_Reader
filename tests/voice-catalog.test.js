import test from "node:test";
import assert from "node:assert/strict";
import {
  getVoiceProvider,
  getVoiceRecord,
  isLegacySystemVoiceId,
  KOKORO_VOICE_CATALOG,
  PIPER_DEFAULT_VOICE_ID,
  PIPER_VOICE_CATALOG,
  voiceSessionFields,
  migrateLegacyVoiceSession
} from "../src/voice-catalog.js";

test("the local catalog contains only the pinned Kokoro and Spanish Piper voices", () => {
  assert.deepEqual(KOKORO_VOICE_CATALOG.map(({ id }) => id), ["af_heart", "am_michael"]);
  assert.deepEqual(PIPER_VOICE_CATALOG.map(({ id }) => id), ["piper:es_AR-daniela-high", "piper:es_ES-davefx-medium"]);
  for (const voice of PIPER_VOICE_CATALOG) {
    assert.equal(getVoiceProvider(voice.id), "piper");
    assert.match(voice.modelRevision, /^[a-f0-9]{40}$/);
    assert.match(voice.modelSha256, /^[a-f0-9]{64}$/);
    assert.ok(voice.modelSizeBytes > 1_000_000);
    assert.equal(voice.sampleRate, 22050);
  }
  assert.equal(getVoiceProvider("af_heart"), "kokoro");
  assert.equal(getVoiceRecord(PIPER_DEFAULT_VOICE_ID).providerVoiceId, "es_AR-daniela-high");
  assert.throws(() => getVoiceProvider("system:old-edge-id"), /desconocido/);
});

test("session metadata follows the voice ID and only recognizes system IDs for migration", () => {
  assert.deepEqual(voiceSessionFields("piper:es_AR-daniela-high"), {
    voice: "piper:es_AR-daniela-high", voiceId: "piper:es_AR-daniela-high", voiceProvider: "piper"
  });
  assert.deepEqual(voiceSessionFields("af_heart"), { voice: "af_heart", voiceId: "af_heart", voiceProvider: "kokoro" });
  assert.equal(isLegacySystemVoiceId("system:old-voice"), true);
  assert.equal(isLegacySystemVoiceId("piper:es_AR-daniela-high"), false);
});

test("legacy Edge sessions migrate to Piper without losing text, document, or reading position", () => {
  const legacy = {
    id: "old-session", documentId: "doc-1", sourceText: "Hola. Adiós.", sourceDocumentName: "nota.txt",
    chunks: ["Hola.", "Adiós."], selectedIndex: 1, position: 1.75, speed: 1.25,
    voice: "system:Microsoft%20Sabina%00es-MX", voiceProvider: "speechSynthesis",
    audioKeys: ["old-audio-1", "old-audio-2"], chunkStates: ["ready", "ready"], durations: [2, 3],
    status: "playing", customMetadata: "keep"
  };
  const result = migrateLegacyVoiceSession(legacy);
  assert.equal(result.migrated, true);
  assert.equal(result.session.voice, PIPER_DEFAULT_VOICE_ID);
  assert.equal(result.session.voiceProvider, "piper");
  assert.equal(result.session.documentId, "doc-1");
  assert.equal(result.session.sourceText, legacy.sourceText);
  assert.deepEqual(result.session.chunks, legacy.chunks);
  assert.equal(result.session.selectedIndex, 1);
  assert.equal(result.session.position, 1.75);
  assert.equal(result.session.speed, 1.25);
  assert.equal(result.session.status, "interrupted");
  assert.deepEqual(result.session.audioKeys, [null, null]);
  assert.deepEqual(result.session.chunkStates, ["pending", "pending"]);
  assert.deepEqual(result.session.durations, [null, null]);
  assert.equal(result.session.customMetadata, "keep");
  assert.ok(result.session.voiceMigrationNotice);
  assert.equal(result.session.voiceMigration.toVoice, PIPER_DEFAULT_VOICE_ID);
});

test("migration leaves local voice sessions and already-migrated sessions unchanged", () => {
  const piper = { voice: PIPER_DEFAULT_VOICE_ID, voiceProvider: "piper", chunks: ["Hola."] };
  assert.deepEqual(migrateLegacyVoiceSession(piper), { session: piper, migrated: false });
  const legacy = { voiceProvider: "speechSynthesis", chunks: ["Hola."], status: "text-ready" };
  const first = migrateLegacyVoiceSession(legacy).session;
  assert.equal(migrateLegacyVoiceSession(first).migrated, false);
});
