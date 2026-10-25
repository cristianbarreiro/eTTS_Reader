import { getVoiceProvider, getVoiceRecord } from "./voice-catalog.js";

export class TTSProviderRouter {
  constructor({ kokoro, piper }) {
    if (!kokoro || !piper) throw new TypeError("Se requieren los proveedores locales Kokoro y Piper.");
    this.kokoro = kokoro;
    this.piper = piper;
  }

  async initialize(onProgress = () => {}, voice = "af_heart") {
    const provider = getVoiceProvider(voice);
    if (provider === "kokoro") {
      const result = await this.kokoro.initialize(onProgress);
      return { ...result, provider };
    }
    const result = await this.piper.initialize(voice, onProgress);
    return { ...result, provider };
  }

  async synthesize(text, voice, options = {}) {
    const provider = getVoiceProvider(voice);
    const status = await this.preparationStatus(voice);
    const ready = status?.voiceId === voice && status.state === "ready"
      && (provider !== "piper" || status.installed === true);
    if (!ready) {
      const error = new Error("La voz local todavía no está preparada. Pulsa «Cargar al reproductor» para prepararla y vuelve a cargar el texto.");
      error.name = "VoiceNotPreparedError";
      error.code = "VOICE_NOT_PREPARED";
      error.phase = "preflight";
      throw error;
    }
    if (provider === "kokoro") {
      options.onProgress?.({ phase: "synthesis", stage: "synthesizing" });
      return this.kokoro.synthesize(text, voice, options.onProgress);
    }
    return this.piper.synthesize(text, voice, options.onProgress);
  }

  piperCatalog() { return this.piper.catalog(); }
  piperModelStatus(voiceId) { getVoiceRecord(voiceId); return this.piper.modelStatus(voiceId); }
  preparationStatus(voiceId) {
    const provider = getVoiceProvider(voiceId);
    if (provider === "kokoro") return { ...this.kokoro.preparationStatus(), voiceId };
    if (typeof this.piper.preparationStatus === "function") {
      return Promise.resolve(this.piper.preparationStatus(voiceId)).then((status) => ({ ...status, provider, voiceId }));
    }
    return this.piper.listInstalled().then((voices) => {
      const status = voices.find((voice) => voice.voiceId === voiceId);
      return { ...status, provider, voiceId, state: status?.state || "idle", installed: status?.installed === true };
    });
  }
  installPiperModel(voiceId, onProgress) { getVoiceRecord(voiceId); return this.piper.installModel(voiceId, onProgress); }
  deletePiperModel(voiceId) { getVoiceRecord(voiceId); return this.piper.removeModel(voiceId); }
  listInstalledPiperModels() { return this.piper.listInstalled(); }
  resetPiperEngine() {
    if (typeof this.piper.reset !== "function") throw new Error("El motor Piper no permite restablecer su worker.");
    return this.piper.reset();
  }

  deleteKokoroModel() {
    if (typeof this.kokoro.deleteModel !== "function") throw new Error("Kokoro no permite eliminar sus recursos locales de forma independiente.");
    return this.kokoro.deleteModel();
  }

  async dispose() {
    await Promise.allSettled([this.kokoro.dispose(), this.piper.dispose()]);
  }
}
