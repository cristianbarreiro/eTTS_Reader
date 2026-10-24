import { PIPER_VOICE_CATALOG } from "./voice-catalog.js";

export function resolvePiperAssetPaths(moduleUrl = import.meta.url) {
  // The extension manifest points into dist/, so getURL("ort/piper/") would
  // incorrectly address the extension root. Resolve from this emitted bundle
  // instead; this also works when dist itself is loaded as the extension root.
  const outputRoot = new URL("../", moduleUrl);
  return {
    onnxWasm: new URL("ort/piper/", outputRoot).href,
    phonemizeWasm: new URL("piper/piper_phonemize.wasm", outputRoot).href,
    phonemizeData: new URL("piper/piper_phonemize.data", outputRoot).href
  };
}

function assetPaths() { return resolvePiperAssetPaths(); }

export class PiperWorkerClient {
  constructor({ workerFactory = () => new Worker(new URL("./piper-tts-worker.js", import.meta.url), { type: "module", name: "piper-local-inference" }), paths = assetPaths } = {}) {
    this.workerFactory = workerFactory;
    this.paths = paths;
    this.worker = null;
    this.pending = new Map();
    this.sequence = 0;
    this.initializedVoice = null;
    this.operationQueue = Promise.resolve();
  }

  catalog() { return PIPER_VOICE_CATALOG.map((voice) => ({ ...voice })); }

  _ensureWorker() {
    if (this.worker) return this.worker;
    if (typeof this.workerFactory !== "function") throw new Error("Este navegador no permite ejecutar Piper en un Web Worker.");
    const worker = this.workerFactory();
    worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.type === "progress") {
        pending.onProgress?.(data.event);
        return;
      }
      this.pending.delete(data.id);
      if (data.type === "error") pending.reject(new Error(data.message || "Falló la inferencia Piper local."));
      else pending.resolve(data.value);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "Falló el Web Worker Piper.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.initializedVoice = null;
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  _request(type, payload = {}, onProgress) {
    const worker = this._ensureWorker();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      try { worker.postMessage({ id, type, ...payload }); }
      catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _enqueue(operation) {
    const task = this.operationQueue.then(operation, operation);
    this.operationQueue = task.catch(() => {});
    return task;
  }

  modelStatus(voiceId) { return this._enqueue(() => this._request("status", { voiceId })); }
  listInstalled() { return this._enqueue(() => this._request("list-installed")); }
  installModel(voiceId, onProgress = () => {}) { return this._enqueue(() => this._request("install", { voiceId }, onProgress)); }

  _initializeUnlocked(voiceId, onProgress = () => {}) {
    return (async () => {
      this._ensureWorker();
      if (this.initializedVoice === voiceId) return { provider: "piper", voiceId, ready: true };
      if (this.initializedVoice) {
        await this._request("dispose");
        this.initializedVoice = null;
      }
      const result = await this._request("initialize", { voiceId, wasmPaths: this.paths() }, onProgress);
      this.initializedVoice = voiceId;
      return result;
    })();
  }

  initialize(voiceId, onProgress = () => {}) {
    return this._enqueue(() => this._initializeUnlocked(voiceId, onProgress));
  }

  synthesize(text, voiceId, onProgress = () => {}) {
    return this._enqueue(async () => {
      await this._initializeUnlocked(voiceId, onProgress);
      return this._request("synthesize", { text, voiceId, wasmPaths: this.paths() }, onProgress);
    });
  }

  removeModel(voiceId) {
    return this._enqueue(async () => {
      if (this.initializedVoice === voiceId) {
        await this._request("dispose");
        this.initializedVoice = null;
      }
      return this._request("remove", { voiceId });
    });
  }

  dispose() {
    return this._enqueue(async () => {
      if (this.worker) {
        try { await this._request("dispose"); } catch { /* Termination below releases any partial WASM state. */ }
      }
      this._destroyWorker();
    });
  }

  _destroyWorker() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.initializedVoice = null;
    for (const pending of this.pending.values()) pending.reject(new Error("Se cerró el contexto local de inferencia Piper."));
    this.pending.clear();
  }
}
