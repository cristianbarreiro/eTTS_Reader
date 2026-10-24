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
  installPiperModel(voiceId, onProgress) { getVoiceRecord(voiceId); return this.piper.installModel(voiceId, onProgress); }
  deletePiperModel(voiceId) { getVoiceRecord(voiceId); return this.piper.removeModel(voiceId); }
  listInstalledPiperModels() { return this.piper.listInstalled(); }

  async dispose() {
    await Promise.allSettled([this.kokoro.dispose(), this.piper.dispose()]);
  }
}
