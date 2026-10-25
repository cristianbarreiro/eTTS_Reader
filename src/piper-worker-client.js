import { PIPER_VOICE_CATALOG } from "./voice-catalog.js";

export const PIPER_OPERATION_TIMEOUTS = Object.freeze({
  statusMs: 15_000,
  initializeMs: 180_000,
  synthesisIdleMs: 90_000,
  synthesisMaxMs: 15 * 60_000,
  downloadIdleMs: 45_000,
  downloadMaxMs: 10 * 60_000
});

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

function piperError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "PiperWorkerError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function requestTimeout(type, payload, timeouts) {
  if (type === "initialize") return {
    totalMs: timeouts.initializeMs,
    code: "PIPER_INITIALIZATION_TIMEOUT",
    phase: "initialize",
    message: "La inicialización de Piper superó los 180 segundos. El worker se reinició; el modelo guardado se conservó. Puedes reintentar."
  };
  if (type === "synthesize") {
    const textLength = String(payload.text || "").length;
    return {
      idleMs: timeouts.synthesisIdleMs,
      totalMs: Math.min(timeouts.synthesisMaxMs, Math.max(180_000, textLength * 500)),
      code: "PIPER_SYNTHESIS_TIMEOUT",
      phase: "synthesis",
      message: "La síntesis Piper dejó de responder. El worker se reinició; puedes volver a intentarlo."
    };
  }
  if (type === "install") return {
    idleMs: timeouts.downloadIdleMs,
    totalMs: timeouts.downloadMaxMs,
    code: "PIPER_DOWNLOAD_TIMEOUT",
    phase: "download",
    message: "La descarga del modelo Piper dejó de avanzar o superó los 10 minutos. Los archivos parciales se limpiarán al reintentar."
  };
  return { totalMs: timeouts.statusMs, code: "PIPER_OPERATION_TIMEOUT", message: "La operación del motor Piper tardó demasiado." };
}

function hasValidProgress(event) {
  return Boolean(event && (
    Number.isFinite(event.progress)
    || Number.isFinite(event.loaded)
    || typeof event.stage === "string"
    || typeof event.phase === "string"
  ));
}

export class PiperWorkerClient {
  constructor({ workerFactory = () => new Worker(new URL("./piper-tts-worker.js", import.meta.url), { type: "module", name: "piper-local-inference" }), paths = assetPaths, timeouts = PIPER_OPERATION_TIMEOUTS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.workerFactory = workerFactory;
    this.paths = paths;
    this.timeouts = { ...PIPER_OPERATION_TIMEOUTS, ...timeouts };
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.worker = null;
    this.workerGeneration = 0;
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
    const generation = ++this.workerGeneration;
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker || this.workerGeneration !== generation) return;
      const pending = this.pending.get(data?.id);
      if (!pending || pending.worker !== worker || pending.generation !== generation) return;
      if (data.type === "progress") {
        if (typeof data.event?.stage === "string") pending.lastPhase = data.event.stage;
        else if (typeof data.event?.phase === "string") pending.lastPhase = data.event.phase;
        if (hasValidProgress(data.event)) pending.refreshIdleTimeout();
        try { pending.onProgress?.(data.event); } catch { /* UI progress callbacks must not break an inference request. */ }
        return;
      }
      if (data.type === "error") {
        pending.reject(piperError(data.code || "PIPER_WORKER_OPERATION_FAILED", data.message || "Falló la inferencia Piper local.", {
          phase: data.phase,
          diagnostics: data.diagnostics || null
        }));
      } else pending.resolve(data.value);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker || this.workerGeneration !== generation) return;
      const diagnostics = {
        name: event.error?.name || "WorkerError",
        message: event.message || "Falló el Web Worker Piper.",
        stack: event.error?.stack || "",
        filename: event.filename || "",
        lineno: Number.isFinite(event.lineno) ? event.lineno : undefined,
        colno: Number.isFinite(event.colno) ? event.colno : undefined
      };
      this._invalidateWorker(worker, piperError("PIPER_WORKER_ERROR", event.message || "Falló el Web Worker Piper.", {
        phase: "worker",
        diagnostics
      }));
    };
    this.worker = worker;
    return worker;
  }

  _request(type, payload = {}, onProgress) {
    const worker = this._ensureWorker();
    const generation = this.workerGeneration;
    const id = ++this.sequence;
    const limits = requestTimeout(type, payload, this.timeouts);
    const idleMs = limits.idleMs;
    const totalMs = limits.totalMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      let idleTimer = null;
      let totalTimer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.clearTimer(idleTimer);
        this.clearTimer(totalTimer);
        this.pending.delete(id);
        callback(value);
      };
      const pending = {
        worker,
        generation,
        type,
        onProgress,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
        refreshIdleTimeout: () => {
          if (!idleMs || settled) return;
          this.clearTimer(idleTimer);
          idleTimer = this.setTimer(() => this._timeoutWorker(worker, id, limits), idleMs);
        }
      };
      this.pending.set(id, pending);
      if (idleMs) pending.refreshIdleTimeout();
      if (totalMs) totalTimer = this.setTimer(() => this._timeoutWorker(worker, id, limits), totalMs);
      try { worker.postMessage({ id, type, ...payload }); }
      catch (error) { pending.reject(error); }
    });
  }

  _timeoutWorker(worker, requestId, limits) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.worker !== worker) return;
    const error = piperError(limits.code, limits.message, { operation: pending.type, phase: pending.lastPhase || limits.phase });
    this._invalidateWorker(worker, error, requestId);
  }

  _invalidateWorker(worker, reason, timedOutRequestId = null) {
    if (!worker || this.worker !== worker) return false;
    this.worker = null;
    this.initializedVoice = null;
    this.workerGeneration++;
    // Detach first: termination can enqueue late message/error events.
    worker.onmessage = null;
    worker.onerror = null;
    try { worker.terminate?.(); } catch { /* Termination is best-effort; the instance is already invalidated. */ }
    for (const [id, pending] of [...this.pending]) {
      if (pending.worker !== worker) continue;
      const error = id === timedOutRequestId
        ? reason
        : piperError("PIPER_WORKER_RESET", "El worker Piper se reinició porque otra operación dejó de responder. Puedes reintentar.");
      pending.reject(error);
    }
    return true;
  }

  reset() {
    const worker = this.worker;
    this.initializedVoice = null;
    if (worker) this._invalidateWorker(worker, piperError("PIPER_WORKER_RESET", "El motor Piper se restableció. El modelo local se conservó."));
    else this.workerGeneration++;
    return { reset: true, modelPreserved: true };
  }

  _enqueue(operation) {
    const task = this.operationQueue.then(operation, operation);
    this.operationQueue = task.catch(() => {});
    return task;
  }

  modelStatus(voiceId) { return this._enqueue(() => this._request("status", { voiceId })); }
  async _listInstalledUnlocked() {
    const voices = await this._request("list-installed");
    return voices.map((voice) => ({
      ...voice,
      state: this.initializedVoice === voice.voiceId ? "ready" : voice.installed ? "cached" : "idle"
    }));
  }
  listInstalled() { return this._enqueue(() => this._listInstalledUnlocked()); }
  preparationStatus(voiceId) {
    return this._enqueue(async () => (await this._listInstalledUnlocked())
      .find((voice) => voice.voiceId === voiceId) || { voiceId, state: "idle", installed: false });
  }
  installModel(voiceId, onProgress = () => {}) { return this._enqueue(() => this._request("install", { voiceId }, onProgress)); }

  _initializeUnlocked(voiceId, onProgress = () => {}) {
    return (async () => {
      const worker = this._ensureWorker();
      const generation = this.workerGeneration;
      if (this.initializedVoice === voiceId) return { provider: "piper", voiceId, ready: true };
      if (this.initializedVoice) {
        await this._request("dispose");
        if (this.worker !== worker || this.workerGeneration !== generation) throw piperError("PIPER_WORKER_RESET", "El worker Piper cambió durante el cambio de voz.");
        this.initializedVoice = null;
      }
      const result = await this._request("initialize", { voiceId, wasmPaths: this.paths() }, onProgress);
      if (this.worker !== worker || this.workerGeneration !== generation) throw piperError("PIPER_WORKER_RESET", "Se descartó una inicialización de un worker Piper anterior.");
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

  dispose() { return this.reset(); }
}
