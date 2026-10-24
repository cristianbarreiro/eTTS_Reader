import test from "node:test";
import assert from "node:assert/strict";
import { validateWavBlob } from "../src/audio-utils.js";
import { PIPER_VOICE_CATALOG } from "../src/voice-catalog.js";
import { pcmToWavBlob, PiperTTSProvider, splitPiperText } from "../src/piper-tts.js";

const voice = PIPER_VOICE_CATALOG[0];
const config = {
  audio: { sample_rate: 22050 },
  espeak: { voice: "es-419" },
  inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
  speaker_id_map: {},
  phoneme_id_map: { _: [0], h: [1] }
};

test("Piper text splitting preserves all words and limits phonemizer input length", () => {
  const input = `Primera oración. ${"palabra ".repeat(100)} fin.`;
  const chunks = splitPiperText(input, 80);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
  assert.match(chunks.join(" "), /Primera oración\./);
  assert.match(chunks.join(" "), /fin\./);
});

test("Piper PCM is encoded as a valid 16-bit mono WAV at the model sample rate", async () => {
  const blob = pcmToWavBlob(Float32Array.of(-1, -0.5, 0, 0.5, 1), 22050);
  assert.equal(blob.type, "audio/wav");
  assert.equal(await validateWavBlob(blob), true);
  const bytes = new DataView(await blob.arrayBuffer());
  assert.equal(bytes.getUint32(24, true), 22050);
  assert.equal(bytes.getUint16(20, true), 1);
  assert.equal(bytes.getUint16(22, true), 1);
  assert.equal(bytes.getUint16(34, true), 16);
});

test("Piper initializes only from installed model data and uses the packaged WASM CPU backend", async () => {
  const captured = { tensors: [], runs: [], phonemizerCalls: 0, createCalls: 0 };
  class Tensor {
    constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; captured.tensors.push(this); }
  }
  const onnx = {
    env: { wasm: {} },
    Tensor,
    InferenceSession: {
      async create(model, options) {
        captured.createCalls++;
        captured.modelSize = model.byteLength;
        captured.sessionOptions = options;
        return { async run(feeds) { captured.runs.push(feeds); return { output: { data: Float32Array.of(0.25, -0.25, 0.5) } }; }, async release() {} };
      }
    }
  };
  let factoryOptions;
  const provider = new PiperTTSProvider({
    ortModule: onnx,
    modelStore: {
      async readInstalled(voiceId) {
        assert.equal(voiceId, voice.id);
        return { voice, config, model: new Blob([Uint8Array.of(1, 2, 3)]) };
      },
      async status() { return { installed: true }; },
      async install() { return { installed: true }; },
      async remove() { return { installed: false }; }
    },
    phonemizerFactory: async (options) => {
      captured.createCalls++;
      factoryOptions = options;
      return {
        ready: Promise.resolve(),
        callMain(args) {
          captured.phonemizerCalls++;
          assert.equal(args[0], "-l");
          assert.equal(args[1], "es-419");
          assert.equal(args[2], "--input");
          assert.match(args[3], /(?:Hola|Otra frase)\./);
          options.print(JSON.stringify({ phoneme_ids: [0, 1, 2, 0] }));
        }
      };
    }
  });
  const paths = {
    onnxWasm: "chrome-extension://test/ort/piper/",
    phonemizeWasm: "chrome-extension://test/piper/piper_phonemize.wasm",
    phonemizeData: "chrome-extension://test/piper/piper_phonemize.data"
  };

  const initialized = await provider.initialize(voice.id, paths);
  assert.equal(initialized.provider, "piper");
  assert.equal(onnx.env.wasm.wasmPaths, paths.onnxWasm);
  assert.equal(onnx.env.wasm.numThreads, 1);
  assert.equal(onnx.env.wasm.proxy, false);
  assert.deepEqual(captured.sessionOptions, { executionProviders: ["wasm"] });
  assert.equal(captured.modelSize, 3);
  const audio = await provider.synthesize("Hola.", voice.id, paths);
  assert.equal(factoryOptions.locateFile("piper_phonemize.wasm"), paths.phonemizeWasm);
  assert.equal(factoryOptions.locateFile("piper_phonemize.data"), paths.phonemizeData);
  assert.equal(await validateWavBlob(audio), true);
  assert.equal(new DataView(await audio.arrayBuffer()).getUint32(24, true), 22050);
  assert.equal(captured.phonemizerCalls, 1);
  assert.equal(captured.createCalls, 2, "one ORT session and one reusable phonemizer should be created");
  assert.ok(captured.runs[0].input.data instanceof BigInt64Array);
  assert.deepEqual([...captured.runs[0].input.data], [0n, 1n, 2n, 0n]);
  assert.deepEqual([...captured.runs[0].input_lengths.data], [4n]);

  await provider.synthesize("Otra frase.", voice.id, paths);
  assert.equal(captured.phonemizerCalls, 2);
  assert.equal(captured.createCalls, 2, "the phonemizer and ESpeak data are reused across fragments");
  await provider.dispose();
});

test("Piper initialization reports a missing local model and can retry after it is installed", async () => {
  let installed = false;
  const provider = new PiperTTSProvider({
    ortModule: { env: { wasm: {} }, Tensor: class Tensor {}, InferenceSession: { async create() { return {}; } } },
    modelStore: {
      async readInstalled() { if (!installed) throw new Error("Instala primero este modelo Piper."); return { voice, config, model: new Blob(["onnx"]) }; },
      async status() { return { installed }; }, async install() { installed = true; return { installed }; }, async remove() {}
    },
    phonemizerFactory: async () => ({ callMain() {} })
  });
  const paths = { onnxWasm: "extension://ort/", phonemizeWasm: "extension://piper.wasm", phonemizeData: "extension://piper.data" };
  await assert.rejects(provider.initialize(voice.id, paths), /Instala primero/);
  assert.equal(provider.session, null);
  installed = true;
  assert.equal((await provider.initialize(voice.id, paths)).ready, true);
  await provider.dispose();
});
