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
    if (provider === "kokoro") return this.kokoro.synthesize(text, voice);
    return this.piper.synthesize(text, voice, options.onProgress);
  }

  piperCatalog() { return this.piper.catalog(); }
  piperModelStatus(voiceId) { getVoiceRecord(voiceId); return this.piper.modelStatus(voiceId); }
  preparationStatus(voiceId) {
    const provider = getVoiceProvider(voiceId);
    if (provider === "kokoro") return this.kokoro.preparationStatus();
    if (typeof this.piper.preparationStatus === "function") return this.piper.preparationStatus(voiceId);
    return this.piper.listInstalled().then((voices) => {
      const status = voices.find((voice) => voice.voiceId === voiceId);
      return status || { provider, voiceId, state: "idle", installed: false };
    });
  }
  installPiperModel(voiceId, onProgress) { getVoiceRecord(voiceId); return this.piper.installModel(voiceId, onProgress); }
  deletePiperModel(voiceId) { getVoiceRecord(voiceId); return this.piper.removeModel(voiceId); }
  listInstalledPiperModels() { return this.piper.listInstalled(); }

  deleteKokoroModel() {
    if (typeof this.kokoro.deleteModel !== "function") throw new Error("Kokoro no permite eliminar sus recursos locales de forma independiente.");
    return this.kokoro.deleteModel();
  }

  async dispose() {
    await Promise.allSettled([this.kokoro.dispose(), this.piper.dispose()]);
  }
}
