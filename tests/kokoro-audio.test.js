import test from "node:test";
import assert from "node:assert/strict";
import { synthesizeKokoroText } from "../src/kokoro-audio.js";

test("Kokoro reports indeterminate model calls and measured completed parts without leaking text", async () => {
  const events = [];
  const generatedTexts = [];
  const model = {
    async generate(text, options) {
      generatedTexts.push({ text, options });
      return { audio: new Float32Array([0.25]), sampling_rate: 24_000 };
    }
  };
  class RawAudioMock {
    constructor(audio, sampleRate) { this.audio = audio; this.sampleRate = sampleRate; }
    toBlob() { return new Blob(["RIFF"], { type: "audio/wav" }); }
  }

  const blob = await synthesizeKokoroText(model, "A bounded sentence for a local speech synthesis regression. ".repeat(3), {
    voice: "af_heart", speed: 1, maxChars: 32, RawAudio: RawAudioMock, onProgress: (event) => events.push(event)
  });

  assert.equal(blob.type, "audio/wav");
  assert.ok(blob.size > 0);
  assert.ok(generatedTexts.length > 1);
  assert.equal(events[0].stage, "split-text");
  const inferences = events.filter((event) => event.stage === "model-generate");
  assert.equal(inferences.length, generatedTexts.length);
  assert.ok(inferences.every((event) => event.progress === null && Number.isInteger(event.partLength)));
  const completed = events.filter((event) => event.stage === "part-complete");
  assert.equal(completed.length, generatedTexts.length);
  assert.ok(completed.every((event) => event.progress > 0 && event.partDurationMs >= 0));
  assert.deepEqual(events.slice(-3).map((event) => event.stage), ["assemble-audio", "wav-conversion", "wav-created"]);
  assert.ok(events.every((event) => !Object.hasOwn(event, "text")));
});
