import test from "node:test";
import assert from "node:assert/strict";
import { SystemSpeechProvider } from "../src/system-speech.js";

class FakeUtterance {
  constructor(text) { this.text = text; }
}

class FakeSpeechSynthesis {
  constructor(voices = []) {
    this.voices = voices;
    this.listeners = new Map();
    this.utterances = [];
    this.current = null;
  }
  getVoices() { return this.voices; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry !== listener));
  }
  emit(name) { for (const listener of this.listeners.get(name) || []) listener({ type: name }); }
  speak(utterance) { this.current = utterance; this.utterances.push(utterance); }
  pause() { this.current?.onpause?.(); }
  resume() { this.current?.onresume?.(); }
  cancel() { this.current?.onerror?.({ error: "canceled" }); this.current = null; }
}

const spanishVoices = [
  { name: "Microsoft Sabina", lang: "es-MX", voiceURI: "urn:voice:sabina" },
  { name: "Microsoft Jorge", lang: "es-ES", voiceURI: "urn:voice:jorge" },
  { name: "Microsoft David", lang: "en-US", voiceURI: "urn:voice:david" }
];

test("system speech waits for voiceschanged and lists only installed Spanish voices", async () => {
  const api = new FakeSpeechSynthesis();
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance, voicesWaitMs: 100 });
  const pending = provider.listVoices();
  api.voices = spanishVoices;
  api.emit("voiceschanged");
  const voices = await pending;
  assert.equal(voices.length, 2);
  assert.ok(voices.every((voice) => voice.provider === "speechSynthesis" && voice.language === "es"));
  assert.ok(voices.every((voice) => voice.gender === null));
});

test("system speech validates the selected voice, applies rate, forwards playback events and cancels safely", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices);
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance });
  const [voice] = await provider.listVoices();
  const result = await provider.synthesize("Hola, mundo.", voice.id);
  const events = [];
  provider.play(result, {
    rate: 1.5,
    onStart: () => events.push("start"),
    onPause: () => events.push("pause"),
    onResume: () => events.push("resume"),
    onBoundary: (event) => events.push(`boundary:${event.charIndex}/${event.charLength}`),
    onError: (error) => events.push(`error:${error.message}`)
  });

  const utterance = api.utterances[0];
  assert.equal(utterance.text, "Hola, mundo.");
  assert.equal(utterance.voice, spanishVoices.find((item) => item.voiceURI === voice.providerVoiceId));
  assert.equal(utterance.rate, 1.5);
  utterance.onstart();
  utterance.onpause();
  utterance.onresume();
  utterance.onboundary({ charIndex: 5 });
  assert.deepEqual(events, ["start", "pause", "resume", "boundary:5/12"]);

  provider.cancel();
  assert.deepEqual(events, ["start", "pause", "resume", "boundary:5/12"], "a canceled utterance must not be reported as a playback error");
  await assert.rejects(provider.synthesize("Hola", "system:missing"), /ya no está disponible/);
});

test("system speech reports non-cancellation playback failures", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices);
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance });
  const [voice] = await provider.listVoices();
  const result = await provider.synthesize("Hola.", voice.id);
  const errors = [];
  provider.play(result, { onError: (error) => errors.push(error.message) });
  api.current.onerror({ error: "audio-busy" });
  assert.deepEqual(errors, ["SpeechSynthesis: audio-busy"]);
});

test("an external system interruption reaches the player as an error", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices);
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance });
  const [voice] = await provider.listVoices();
  const result = await provider.synthesize("Hola.", voice.id);
  const errors = [];
  provider.play(result, { onError: (error) => errors.push(error.message) });
  api.current.onerror({ error: "interrupted" });
  assert.deepEqual(errors, ["La reproducción de la voz del sistema fue interrumpida."]);
});
