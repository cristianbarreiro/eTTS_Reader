import { isSystemVoiceId } from "./voice-catalog.js";

export class TTSProviderRouter {
  constructor({ kokoro, systemSpeech }) {
    if (!kokoro || !systemSpeech) throw new TypeError("Se requieren los proveedores Kokoro y SpeechSynthesis.");
    this.kokoro = kokoro;
    this.systemSpeech = systemSpeech;
  }

  async initialize(onProgress = () => {}, voice = "af_heart") {
    if (isSystemVoiceId(voice)) {
      const available = (await this.systemSpeech.listVoices()).some((item) => item.id === voice);
      if (!available) throw new Error("La voz española del sistema ya no está disponible. Actualiza la lista de voces.");
      return { provider: "speechSynthesis", voices: [voice] };
    }
    const result = await this.kokoro.initialize(onProgress);
    return { ...result, provider: "kokoro" };
  }

  async synthesize(text, voice) {
    return isSystemVoiceId(voice)
      ? this.systemSpeech.synthesize(text, voice)
      : this.kokoro.synthesize(text, voice);
  }

  listSystemVoices() { return this.systemSpeech.listVoices(); }

  async dispose() {
    this.systemSpeech.cancel();
    await this.kokoro.dispose();
  }
}
