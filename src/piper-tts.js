import createPiperPhonemize from "@diffusionstudio/piper-wasm/build/piper_phonemize.js";
import * as ortWasm from "onnxruntime-web/wasm";
import { PIPER_VOICE_CATALOG, getVoiceRecord } from "./voice-catalog.js";
import { PiperModelStore } from "./piper-model-store.js";

const MAX_PHONEME_CHUNK = 400;

export function splitPiperText(text, maxLength = MAX_PHONEME_CHUNK) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxLength) return [trimmed];
  const sentences = trimmed.match(/[^.!?…\n]+[.!?…]*\s*/g) || [trimmed];
  const chunks = [];
  let current = "";
  const push = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };
  for (const sentence of sentences) {
    if ((current + sentence).length > maxLength) push();
    if (sentence.length > maxLength) {
      let piece = "";
      for (const word of sentence.split(/\s+/)) {
        if ((piece + " " + word).trim().length > maxLength) {
          if (piece.trim()) chunks.push(piece.trim());
          piece = word;
        } else piece = piece ? `${piece} ${word}` : word;
      }
      current = piece;
    } else current += sentence;
  }
  push();
  return chunks;
}

export function pcmToWavBlob(pcm, sampleRate) {
  if (!(pcm instanceof Float32Array) || pcm.length === 0 || !Number.isInteger(sampleRate) || sampleRate < 8000) {
    throw new TypeError("Piper no devolvió muestras de audio PCM válidas.");
  }
  const headerLength = 44;
  const buffer = new ArrayBuffer(headerLength + pcm.length * 2);
  const view = new DataView(buffer);
  const write = (offset, value) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let index = 0, offset = headerLength; index < pcm.length; index++, offset += 2) {
    const sample = Math.max(-1, Math.min(1, pcm[index]));
    view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function joinPcm(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export class PiperTTSProvider {
  constructor({ modelStore = new PiperModelStore(), ortModule = ortWasm, phonemizerFactory = createPiperPhonemize } = {}) {
    this.modelStore = modelStore;
    this.ortModule = ortModule;
    this.phonemizerFactory = phonemizerFactory;
    this.session = null;
    this.ort = null;
    this.config = null;
    this.voiceId = null;
    this.initialization = null;
    this.phonemizer = null;
    this.phonemizerPaths = null;
    this.phonemizerOutput = [];
    this.phonemizerErrors = [];
  }

  catalog() { return PIPER_VOICE_CATALOG.map((voice) => ({ ...voice })); }
  modelStatus(voiceId) { return this.modelStore.status(voiceId); }
  installModel(voiceId, onProgress = () => {}) { return this.modelStore.install(voiceId, onProgress); }

  async initialize(voiceId, wasmPaths, onProgress = () => {}) {
    const voice = getVoiceRecord(voiceId);
    if (voice.provider !== "piper") throw new TypeError("La inicialización Piper requiere una voz Piper.");
    if (this.voiceId === voiceId && this.session) return { provider: "piper", voiceId, ready: true };
    if (this.initialization) await this.initialization.catch(() => {});
    if (this.session) await this.dispose();
    if (!wasmPaths?.onnxWasm || !wasmPaths?.phonemizeWasm || !wasmPaths?.phonemizeData) {
      throw new Error("Faltan las rutas locales de ONNX Runtime o del fonemizador Piper.");
    }
    const task = this._initialize(voice, wasmPaths, onProgress);
    this.initialization = task;
    try { return await task; }
    catch (error) {
      this.session = null;
      this.ort = null;
      this.config = null;
      this.voiceId = null;
      throw error;
    } finally {
      if (this.initialization === task) this.initialization = null;
    }
  }

  async _initialize(voice, wasmPaths, onProgress) {
    const installed = await this.modelStore.readInstalled(voice.id);
    const module = this.ortModule.default || this.ortModule;
    const env = module.env;
    if (!env?.wasm || !module.InferenceSession || !module.Tensor) {
      throw new Error("ONNX Runtime Web no expuso el backend WASM empaquetado.");
    }
    env.wasm.wasmPaths = wasmPaths.onnxWasm;
    env.wasm.numThreads = 1;
    env.wasm.proxy = false;
    const modelBuffer = await installed.model.arrayBuffer();
    const session = await module.InferenceSession.create(modelBuffer, { executionProviders: ["wasm"] });
    this.session = session;
    this.ort = module;
    this.config = installed.config;
    this.voiceId = voice.id;
    onProgress({ phase: "initialize", voiceId: voice.id, progress: 100 });
    return { provider: "piper", voiceId: voice.id, ready: true, modelRevision: voice.modelRevision };
  }

  async _phonemize(text, voiceId, wasmPaths) {
    const pathsKey = `${wasmPaths.phonemizeWasm}\n${wasmPaths.phonemizeData}`;
    if (!this.phonemizer || this.phonemizerPaths !== pathsKey) {
      const output = [];
      const errors = [];
      const phonemizer = await this.phonemizerFactory({
        print: (value) => output.push(String(value)),
        printErr: (value) => errors.push(String(value)),
        locateFile: (name) => name.endsWith(".wasm")
          ? wasmPaths.phonemizeWasm
          : name.endsWith(".data") ? wasmPaths.phonemizeData : name
      });
      if (phonemizer?.ready) await phonemizer.ready;
      this.phonemizer = phonemizer;
      this.phonemizerPaths = pathsKey;
      this.phonemizerOutput = output;
      this.phonemizerErrors = errors;
    }
    const phonemizer = this.phonemizer;
    const output = this.phonemizerOutput;
    const errors = this.phonemizerErrors;
    output.length = 0;
    errors.length = 0;
    const voice = getVoiceRecord(voiceId);
    try {
      phonemizer.callMain([
        "-l",
        this.config.espeak.voice,
        "--input",
        JSON.stringify([{ text: text.trim() }]),
        "--espeak_data",
        "/espeak-ng-data"
      ]);
    } catch (error) {
      if (!output.length) throw new Error(`No se pudo fonemizar el texto para ${voice.label}: ${error.message || error}`);
    }
    for (let index = output.length - 1; index >= 0; index--) {
      try {
        const result = JSON.parse(output[index]);
        if (Array.isArray(result.phoneme_ids) && result.phoneme_ids.length) return result.phoneme_ids;
      } catch { /* Emscripten may emit informational output before the JSON payload. */ }
    }
    throw new Error(errors.join(" ") || `El fonemizador Piper no devolvió fonemas para ${voice.label}.`);
  }

  async _synthesizeChunk(text, wasmPaths) {
    const phonemeIds = await this._phonemize(text, this.voiceId, wasmPaths);
    const config = this.config;
    const feeds = {
      input: new this.ort.Tensor("int64", BigInt64Array.from(phonemeIds, BigInt), [1, phonemeIds.length]),
      input_lengths: new this.ort.Tensor("int64", BigInt64Array.of(BigInt(phonemeIds.length)), [1]),
      scales: new this.ort.Tensor("float32", [
        config.inference.noise_scale,
        config.inference.length_scale,
        config.inference.noise_w
      ])
    };
    if (Object.keys(config.speaker_id_map || {}).length) {
      feeds.sid = new this.ort.Tensor("int64", BigInt64Array.of(0n), [1]);
    }
    const result = await this.session.run(feeds);
    const pcm = result?.output?.data;
    if (!(pcm instanceof Float32Array) || !pcm.length) throw new Error("El modelo Piper no devolvió audio PCM.");
    return pcm;
  }

  async synthesize(text, voiceId, wasmPaths, onProgress = () => {}) {
    if (this.voiceId !== voiceId || !this.session) throw new Error("Inicializa primero la voz Piper seleccionada.");
    const chunks = splitPiperText(text);
    if (!chunks.length) throw new Error("No hay texto para sintetizar con Piper.");
    const pcm = [];
    for (let index = 0; index < chunks.length; index++) {
      pcm.push(await this._synthesizeChunk(chunks[index], wasmPaths));
      onProgress({ phase: "synthesis", voiceId, loaded: index + 1, total: chunks.length, progress: (index + 1) / chunks.length * 100 });
    }
    return pcmToWavBlob(joinPcm(pcm), this.config.audio.sample_rate);
  }

  async removeModel(voiceId) {
    if (this.voiceId === voiceId) await this.dispose();
    return this.modelStore.remove(voiceId);
  }

  async dispose() {
    try { await this.session?.release?.(); } catch { /* Worker termination below also releases WASM memory. */ }
    this.session = null;
    this.ort = null;
    this.config = null;
    this.voiceId = null;
    this.phonemizer = null;
    this.phonemizerPaths = null;
    this.phonemizerOutput = [];
    this.phonemizerErrors = [];
  }
}
