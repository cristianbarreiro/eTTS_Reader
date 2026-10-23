import test from "node:test";
import assert from "node:assert/strict";
import {
  getVoiceProvider,
  isSystemVoiceId,
  makeSystemVoiceId,
  spanishSystemVoiceCatalog,
  voiceSessionFields
} from "../src/voice-catalog.js";

test("system voice catalog filters to Spanish and does not guess gender", () => {
  const spanish = { name: "Microsoft Sabina", lang: "es-MX", voiceURI: "urn:voice:sabina" };
  const catalog = spanishSystemVoiceCatalog([
    spanish,
    { ...spanish },
    { name: "Microsoft David", lang: "en-US", voiceURI: "urn:voice:david" },
    { name: "Unknown language", lang: "", voiceURI: "urn:voice:unknown" }
  ]);

  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].name, "Microsoft Sabina");
  assert.equal(catalog[0].language, "es");
  assert.equal(catalog[0].locale, "es-MX");
  assert.equal(catalog[0].gender, null);
  assert.equal(catalog[0].provider, "speechSynthesis");
  assert.ok(isSystemVoiceId(catalog[0].id));
  assert.equal(getVoiceProvider(catalog[0].id), "speechSynthesis");
});

test("system voice IDs remain stable and session provider metadata follows the selected ID", () => {
  const voice = { name: "Microsoft Jorge", lang: "es-ES", voiceURI: "urn:voice:jorge" };
  const id = makeSystemVoiceId(voice);
  assert.equal(id, makeSystemVoiceId(voice));
  assert.deepEqual(voiceSessionFields(id), { voice: id, voiceId: id, voiceProvider: "speechSynthesis" });
  assert.deepEqual(voiceSessionFields("af_heart"), { voice: "af_heart", voiceId: "af_heart", voiceProvider: "kokoro" });
});
