export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_VOICE_IDS = Object.freeze(["af_heart", "am_michael"]);
export const SYSTEM_VOICE_PREFIX = "system:";

export const KOKORO_VOICE_CATALOG = Object.freeze([
  { id: "af_heart", label: "English — Female · Heart · Kokoro", language: "en", locale: "en-US", gender: "female", provider: "kokoro", providerVoiceId: "af_heart", modelId: KOKORO_MODEL_ID, license: "Apache-2.0" },
  { id: "am_michael", label: "English — Male · Michael · Kokoro", language: "en", locale: "en-US", gender: "male", provider: "kokoro", providerVoiceId: "am_michael", modelId: KOKORO_MODEL_ID, license: "Apache-2.0" }
]);

export function isSystemVoiceId(id) {
  return typeof id === "string" && id.startsWith(SYSTEM_VOICE_PREFIX);
}

export function systemVoiceIdentity(voice) {
  return String(voice?.voiceURI || `${voice?.name || ""}\u0000${voice?.lang || ""}`);
}

export function makeSystemVoiceId(voice) {
  const identity = systemVoiceIdentity(voice);
  return identity ? `${SYSTEM_VOICE_PREFIX}${encodeURIComponent(identity)}` : "";
}

export function decodeSystemVoiceId(id) {
  if (!isSystemVoiceId(id)) return "";
  try { return decodeURIComponent(id.slice(SYSTEM_VOICE_PREFIX.length)); } catch { return ""; }
}

export function systemVoiceRecord(voice) {
  const id = makeSystemVoiceId(voice);
  const lang = String(voice?.lang || "").trim();
  const name = String(voice?.name || "Voz del sistema").trim();
  if (!id || !/^es(?:-|$)/i.test(lang)) return null;
  return {
    id,
    label: `${name} · ${lang}`,
    name,
    language: "es",
    locale: lang,
    gender: null,
    provider: "speechSynthesis",
    providerVoiceId: systemVoiceIdentity(voice),
    modelId: null,
    license: "Voz instalada y administrada por Edge/Windows"
  };
}

export function spanishSystemVoiceCatalog(voices = []) {
  const unique = new Map();
  for (const voice of voices) {
    const record = systemVoiceRecord(voice);
    if (record) unique.set(record.id, record);
  }
  return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function getVoiceProvider(id) {
  return isSystemVoiceId(id) ? "speechSynthesis" : "kokoro";
}

export function voiceSessionFields(id) {
  return { voice: id, voiceId: id, voiceProvider: getVoiceProvider(id) };
}
