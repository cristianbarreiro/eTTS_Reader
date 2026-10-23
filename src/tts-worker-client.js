export class KokoroWorkerClient {
  constructor({ workerFactory = () => new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module", name: "kokoro-local-inference" }) } = {}) {
    this.workerFactory = workerFactory;
    this.worker = null;
    this.pending = new Map();
    this.sequence = 0;
    this.initialization = null;
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    if (typeof this.workerFactory !== "function") throw new Error("Este navegador no permite ejecutar Kokoro en un Web Worker.");
    const worker = this.workerFactory();
    worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      if (data.type === "progress") {
        pending.onProgress?.(data.event);
        return;
      }
      this.pending.delete(data.id);
      if (data.type === "error") pending.reject(new Error(data.message || "Falló la inferencia local."));
      else pending.resolve(data.value);
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "Falló el Web Worker de Kokoro.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.initialization = null;
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
      worker.postMessage({ id, type, ...payload });
    });
  }

  initialize(onProgress = () => {}) {
    if (!this.initialization) {
      this.initialization = this._request("initialize", {}, onProgress).catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  async synthesize(text, voice) {
    await this.initialize();
    return this._request("synthesize", { text, voice });
  }

  async preview(text, voice) { return this.synthesize(text, voice); }

  async dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error("Se cerró el contexto local de inferencia."));
    this.pending.clear();
    this.initialization = null;
  }
}
