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
  { name: "Microsoft Sabina", lang: "es-MX", voiceURI: "urn:voice:sabina", localService: false },
  { name: "Microsoft Jorge", lang: "es-ES", voiceURI: "urn:voice:jorge", localService: true },
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
  assert.equal(voices.find((voice) => voice.name === "Microsoft Sabina").connection, "online");
  assert.equal(voices.find((voice) => voice.name === "Microsoft Jorge").connection, "local");
});

test("catalog updates on voiceschanged and marks voices that disappear without disrupting speech", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices);
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance });
  let updated;
  provider.onCatalogChange((voices) => { updated = voices; });
  const selected = (await provider.listVoices()).find((voice) => voice.name === "Microsoft Sabina");
  const result = await provider.synthesize("Hola", selected.id);
  provider.play(result);
  api.voices = [spanishVoices[1]];
  api.emit("voiceschanged");
  assert.equal(provider.voiceStatus(selected.id), "unavailable");
  assert.equal(api.current.text, "Hola", "refreshing the list must not cancel an active utterance");
  assert.equal(updated.length, 1);
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
  assert.equal(utterance.lang, voice.locale, "the utterance must use its selected voice language, not the offscreen document default");
  assert.equal(utterance.rate, 1.5);
  utterance.onstart();
  utterance.onpause();
  utterance.onresume();
  utterance.onboundary({ charIndex: 5 });
  assert.deepEqual(events, ["start", "pause", "resume", "boundary:5/12"]);

  provider.cancel();
  assert.deepEqual(events, ["start", "pause", "resume", "boundary:5/12"], "a canceled utterance must not be reported as a playback error");
  assert.equal(provider.voiceStatus(voice.id), "interrupted");
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
  assert.deepEqual(errors, [`El motor de audio está ocupado. Espera y vuelve a intentarlo. · ${voice.name} · ${voice.locale} · voz local`]);
  assert.equal(provider.voiceStatus(voice.id), "temporary-failure");
});

test("system speech diagnostics identify the selected voice without exposing the spoken text", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices.map((voice) => ({ ...voice, localService: false })));
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance });
  const [voice] = await provider.listVoices();
  const result = await provider.synthesize("private text", voice.id);
  const errors = [];
  provider.play(result, { onError: (error) => errors.push(error.message) });
  api.current.onerror({ error: "synthesis-failed" });

  assert.deepEqual(errors, [`El motor de voz no pudo completar la síntesis. · ${voice.name} · ${voice.locale} · voz en línea`]);
  assert.doesNotMatch(errors[0], /private text/);
  assert.equal(provider.voiceStatus(voice.id), "temporary-failure");
});

test("a voice is marked successful only on end and can be retried after a temporary failure", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices);
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance });
  const [voice] = await provider.listVoices();
  const result = await provider.synthesize("Hola", voice.id);
  const errors = [];
  provider.play(result, { onError: (error) => errors.push(error) });
  assert.equal(provider.voiceStatus(voice.id), "pending-test");
  api.current.onerror({ error: "network" });
  assert.equal(provider.voiceStatus(voice.id), "temporary-failure");
  assert.match(errors[0].message, /conexión/);
  const retry = await provider.synthesize("Hola", voice.id);
  provider.play(retry);
  api.current.onstart();
  assert.equal(provider.voiceStatus(voice.id), "pending-test");
  api.current.onend();
  assert.equal(provider.voiceStatus(voice.id), "tested-successfully");
});

test("an external system interruption reaches the player as an error", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices);
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance });
  const [voice] = await provider.listVoices();
  const result = await provider.synthesize("Hola.", voice.id);
  const errors = [];
  provider.play(result, { onError: (error) => errors.push(error.message) });
  api.current.onerror({ error: "interrupted" });
  assert.match(errors[0], /interrumpida/);
  assert.equal(provider.voiceStatus(voice.id), "interrupted");
});

test("system speech reports a voice that never starts instead of leaving playback pending", async () => {
  const api = new FakeSpeechSynthesis(spanishVoices);
  let cancelled = 0;
  api.cancel = () => { cancelled++; api.current = null; };
  const provider = new SystemSpeechProvider({ speechSynthesis: api, Utterance: FakeUtterance, startTimeoutMs: 5 });
  const [voice] = await provider.listVoices();
  const result = await provider.synthesize("Hola.", voice.id);
  const errors = [];
  provider.play(result, { onError: (error) => errors.push(error.message) });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(cancelled, 1);
  assert.equal(provider.currentUtterance, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no confirmó el inicio/);
  assert.equal(provider.voiceStatus(voice.id), "temporary-failure");
});
