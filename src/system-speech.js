import { decodeSystemVoiceId, isSystemVoiceId, spanishSystemVoiceCatalog, systemVoiceIdentity } from "./voice-catalog.js";

export const SYSTEM_SPEECH_RESULT = "system-speech";

export class SystemSpeechProvider {
  constructor({
    speechSynthesis = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    voicesWaitMs = 1000,
    startTimeoutMs = 12000
  } = {}) {
    this.speechSynthesis = speechSynthesis;
    this.Utterance = Utterance;
    this.voicesWaitMs = voicesWaitMs;
    this.startTimeoutMs = startTimeoutMs;
    this.currentUtterance = null;
    this.generation = 0;
    this.startTimer = null;
  }

  isAvailable() {
    return Boolean(this.speechSynthesis?.getVoices && this.speechSynthesis?.speak && this.Utterance);
  }

  async listVoices() {
    if (!this.isAvailable()) return [];
    let voices = this.speechSynthesis.getVoices() || [];
    if (!voices.length && this.voicesWaitMs > 0 && this.speechSynthesis.addEventListener) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.speechSynthesis.removeEventListener?.("voiceschanged", finish);
          resolve();
        };
        const timer = setTimeout(finish, this.voicesWaitMs);
        this.speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
      });
      voices = this.speechSynthesis.getVoices() || [];
    }
    return spanishSystemVoiceCatalog(voices);
  }

  _findVoice(voiceId) {
    if (!isSystemVoiceId(voiceId)) return null;
    const identity = decodeSystemVoiceId(voiceId);
    if (!identity || !this.isAvailable()) return null;
    return (this.speechSynthesis.getVoices() || []).find((voice) => systemVoiceIdentity(voice) === identity) || null;
  }

  async synthesize(text, voiceId) {
    const value = String(text || "").trim();
    if (!value) throw new Error("No hay texto para reproducir con la voz del sistema.");
    if (!this.isAvailable()) throw new Error("SpeechSynthesis no está disponible en este contexto de Edge.");
    if (!this._findVoice(voiceId)) throw new Error("La voz española del sistema ya no está disponible. Actualiza la lista de voces.");
    return { kind: SYSTEM_SPEECH_RESULT, provider: "speechSynthesis", voiceId, text: value };
  }

  play(result, { rate = 1, onStart = () => {}, onPause = () => {}, onResume = () => {}, onBoundary = () => {}, onEnd = () => {}, onError = () => {} } = {}) {
    if (result?.kind !== SYSTEM_SPEECH_RESULT) throw new TypeError("El resultado no pertenece a SpeechSynthesis.");
    const voice = this._findVoice(result.voiceId);
    if (!voice) throw new Error("La voz española del sistema ya no está disponible. Actualiza la lista de voces.");
    const utterance = new this.Utterance(result.text);
    const generation = ++this.generation;
    clearTimeout(this.startTimer);
    this.currentUtterance = utterance;
    let started = false;
    utterance.voice = voice;
    // SpeechSynthesisUtterance otherwise inherits the offscreen document's
    // lang value. Always request the language supported by the selected voice.
    utterance.lang = String(voice.lang || "es");
    utterance.rate = Math.min(2, Math.max(0.5, Number(rate) || 1));
    this.startTimer = setTimeout(() => {
      if (this.generation !== generation || started) return;
      this.currentUtterance = null;
      this.startTimer = null;
      this.generation++;
      this.speechSynthesis.cancel?.();
      onError(new Error("SpeechSynthesis no confirmó el inicio de la voz. Comprueba que la voz seleccionada siga disponible y vuelve a intentarlo."));
    }, this.startTimeoutMs);
    utterance.onstart = () => {
      if (this.generation !== generation) return;
      started = true;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      onStart();
    };
    utterance.onpause = () => { if (this.generation === generation) onPause(); };
    utterance.onresume = () => { if (this.generation === generation) onResume(); };
    utterance.onboundary = (event) => { if (this.generation === generation) onBoundary({ charIndex: Number(event?.charIndex) || 0, charLength: result.text.length }); };
    utterance.onend = () => {
      if (this.generation !== generation) return;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.currentUtterance = null;
      onEnd();
    };
    utterance.onerror = (event) => {
      if (this.generation !== generation) return;
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.currentUtterance = null;
      const voiceDetails = [voice.name, voice.lang, voice.localService === false ? "voz en línea" : voice.localService === true ? "voz local" : "voz del sistema"]
        .filter(Boolean)
        .join(" · ");
      const detail = event?.error === "canceled" || event?.error === "interrupted"
        ? "La reproducción de la voz del sistema fue interrumpida."
        : event?.error ? `SpeechSynthesis: ${event.error}${voiceDetails ? ` · ${voiceDetails}` : ""}` : "La voz del sistema no pudo reproducirse.";
      onError(new Error(detail));
    };
    try {
      this.speechSynthesis.speak(utterance);
    } catch (error) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
      this.currentUtterance = null;
      this.generation++;
      throw error;
    }
  }

  pause() {
    if (!this.currentUtterance) return false;
    this.speechSynthesis.pause();
    return true;
  }

  resume() {
    if (!this.currentUtterance) return false;
    this.speechSynthesis.resume();
    return true;
  }

  cancel() {
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.generation++;
    const hadSpeech = Boolean(this.currentUtterance);
    this.currentUtterance = null;
    if (hadSpeech) this.speechSynthesis?.cancel?.();
    return hadSpeech;
  }
}
