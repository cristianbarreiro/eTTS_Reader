export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const KOKORO_RUNTIME_VERSION = "kokoro-js@1.2.1;transformers@3.8.1;onnxruntime-web@1.22.0-dev.20250409-89f8206ba4";
export const KOKORO_VOICE_IDS = Object.freeze(["af_heart", "am_michael"]);
export const PIPER_PROVIDER_VERSION = "piper-web-runtime@1.0.0";
export const PIPER_DEFAULT_VOICE_ID = "piper:es_AR-daniela-high";
export const LEGACY_SYSTEM_VOICE_PREFIX = "system:";
export const LEGACY_VOICE_MIGRATION_VERSION = 1;

export const PIPER_VOICE_CATALOG = Object.freeze([
  Object.freeze({
    id: "piper:es_AR-daniela-high",
    provider: "piper",
    providerVoiceId: "es_AR-daniela-high",
    modelId: "rhasspy/piper-voices/es/es_AR/daniela/high",
    modelFile: "es_AR-daniela-high.onnx",
    configFile: "es_AR-daniela-high.onnx.json",
    modelPath: "es/es_AR/daniela/high/es_AR-daniela-high.onnx",
    modelRevision: "375a0fe641dea077c2a47b4e9a056d6da521eed3",
    modelSizeBytes: 114199011,
    modelSha256: "7ceb1fc0dab349418c5b54a639ae9ee595212d7c9ea422220d8419163d5cc985",
    language: "es",
    languageCode: "es_AR",
    locale: "es-AR",
    region: "Argentina",
    label: "Español · Daniela · Argentina · alta (114 MB)",
    quality: "high",
    sampleRate: 22050,
    datasetLicense: "CC BY-SA 4.0",
    modelCardUrl: "https://huggingface.co/rhasspy/piper-voices/blob/375a0fe641dea077c2a47b4e9a056d6da521eed3/es/es_AR/daniela/high/MODEL_CARD"
  }),
  Object.freeze({
    id: "piper:es_ES-davefx-medium",
    provider: "piper",
    providerVoiceId: "es_ES-davefx-medium",
    modelId: "rhasspy/piper-voices/es/es_ES/davefx/medium",
    modelFile: "es_ES-davefx-medium.onnx",
    configFile: "es_ES-davefx-medium.onnx.json",
    modelPath: "es/es_ES/davefx/medium/es_ES-davefx-medium.onnx",
    modelRevision: "2f8dbe0bb0dde986411632bf014a13cdbe6596e7",
    modelSizeBytes: 63201294,
    modelSha256: "6658b03b1a6c316ee4c265a9896abc1393353c2d9e1bca7d66c2c442e222a917",
    language: "es",
    languageCode: "es_ES",
    locale: "es-ES",
    region: "España",
    label: "Español · DaveFX · España · media (63 MB)",
    quality: "medium",
    sampleRate: 22050,
    datasetLicense: "CC0",
    modelCardUrl: "https://huggingface.co/rhasspy/piper-voices/blob/2f8dbe0bb0dde986411632bf014a13cdbe6596e7/es/es_ES/davefx/medium/MODEL_CARD"
  })
]);

export const KOKORO_VOICE_CATALOG = Object.freeze([
  { id: "af_heart", label: "English · Heart · femenina", language: "en", locale: "en-US", gender: "female", provider: "kokoro", providerVoiceId: "af_heart", modelId: KOKORO_MODEL_ID, license: "Apache-2.0" },
  { id: "am_michael", label: "English · Michael · masculina", language: "en", locale: "en-US", gender: "male", provider: "kokoro", providerVoiceId: "am_michael", modelId: KOKORO_MODEL_ID, license: "Apache-2.0" }
]);

export const LOCAL_VOICE_CATALOG = Object.freeze([...KOKORO_VOICE_CATALOG, ...PIPER_VOICE_CATALOG]);

export function isLegacySystemVoiceId(id) {
  return typeof id === "string" && id.startsWith(LEGACY_SYSTEM_VOICE_PREFIX);
}

export function getVoiceRecord(id) {
  const record = LOCAL_VOICE_CATALOG.find((voice) => voice.id === id);
  if (!record) throw new TypeError(`Identificador de voz desconocido: ${String(id || "(vacío)")}.`);
  return record;
}

export function getVoiceProvider(id) {
  return getVoiceRecord(id).provider;
}

export function voiceSessionFields(id) {
  return { voice: id, voiceId: id, voiceProvider: getVoiceProvider(id) };
}

/**
 * Migrate only the retired Edge/Windows voice records. Document text, fragment
 * position, selection and user metadata are retained; provider audio is stale.
 */
export function migrateLegacyVoiceSession(session) {
  if (!session || typeof session !== "object") return { session, migrated: false };
  const previousVoice = session.voice || session.voiceId || "";
  if (!isLegacySystemVoiceId(previousVoice) && session.voiceProvider !== "speechSynthesis") {
    return { session, migrated: false };
  }

  const chunks = Array.isArray(session.chunks) ? session.chunks : [];
  const status = ["playing", "starting", "generating", "audio-ready"].includes(session.status)
    ? "interrupted"
    : session.status;
  return {
    migrated: true,
    session: {
      ...session,
      ...voiceSessionFields(PIPER_DEFAULT_VOICE_ID),
      audioKeys: chunks.map(() => null),
      chunkStates: chunks.map(() => "pending"),
      durations: chunks.map(() => null),
      status,
      lastError: "",
      voiceMigrationVersion: LEGACY_VOICE_MIGRATION_VERSION,
      voiceMigration: {
        version: LEGACY_VOICE_MIGRATION_VERSION,
        fromProvider: "speechSynthesis",
        fromVoice: previousVoice,
        toProvider: "piper",
        toVoice: PIPER_DEFAULT_VOICE_ID
      },
      voiceMigrationNotice: "La voz antigua de Edge/Windows se cambió por Daniela · Argentina. Instala el modelo Piper para generar audio. La sesión no se reprodujo automáticamente."
    }
  };
}
