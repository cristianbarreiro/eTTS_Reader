export const KOKORO_OPERATION_TIMEOUTS = Object.freeze({
  initializeIdleMs: 180_000,
  initializeMaxMs: 20 * 60_000,
  synthesisIdleMs: 300_000,
  synthesisMinMs: 5 * 60_000,
  synthesisMaxMs: 30 * 60_000
});

function operationLimits(type, payload, timeouts) {
  if (type === "initialize") return {
    idleMs: timeouts.initializeIdleMs,
    totalMs: timeouts.initializeMaxMs,
    code: "KOKORO_INITIALIZATION_TIMEOUT",
    phase: "initialize",
    message: "La preparación de Kokoro dejó de responder o superó los 20 minutos. El worker se reinició; los recursos en caché se conservaron. Puedes reintentar."
  };
  if (type === "synthesize") {
    const length = String(payload.text || "").length;
    return {
      idleMs: timeouts.synthesisIdleMs,
      totalMs: Math.min(timeouts.synthesisMaxMs, Math.max(timeouts.synthesisMinMs, length * 1_000)),
      code: "KOKORO_SYNTHESIS_TIMEOUT",
      phase: "synthesis",
      message: "La síntesis de Kokoro dejó de responder o superó su límite de tiempo. El worker se reinició; los recursos locales se conservaron. Puedes reintentar."
    };
  }
  return { totalMs: 15_000, code: "KOKORO_OPERATION_TIMEOUT", phase: type, message: "La operación local de Kokoro tardó demasiado." };
}

function kokoroError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "KokoroWorkerError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

export class KokoroWorkerClient {
  constructor({
    workerFactory = () => new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module", name: "kokoro-local-inference" }),
    timeouts = KOKORO_OPERATION_TIMEOUTS,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout
  } = {}) {
    this.workerFactory = workerFactory;
    this.timeouts = { ...KOKORO_OPERATION_TIMEOUTS, ...timeouts };
    this.setTimer = setTimer.bind(globalThis);
    this.clearTimer = clearTimer.bind(globalThis);
    this.worker = null;
    this.workerGeneration = 0;
    this.pending = new Map();
    this.sequence = 0;
    this.initialization = null;
    this.state = "idle";
  }

  _ensureWorker() {
    if (this.worker) return this.worker;
    if (typeof this.workerFactory !== "function") throw new Error("Este navegador no permite ejecutar Kokoro en un Web Worker.");
    const worker = this.workerFactory();
    const generation = ++this.workerGeneration;
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker || this.workerGeneration !== generation) return;
      const pending = this.pending.get(data?.id);
      if (!pending || pending.worker !== worker || pending.generation !== generation) return;
      if (data.type === "progress") {
        const event = data.event || {};
        if (typeof event.stage === "string") pending.lastPhase = event.stage;
        else if (typeof event.phase === "string") pending.lastPhase = event.phase;
        if (Number.isFinite(event.progress) || Number.isFinite(event.loaded) || event.stage || event.phase) pending.refreshIdleTimeout();
        try {
          pending.onProgress?.({
            ...event,
            requestId: data.id,
            voiceId: event.voiceId || pending.voiceId || undefined,
            textLength: Number.isFinite(event.textLength) ? event.textLength : pending.textLength,
            elapsedMs: Math.max(0, Date.now() - pending.startedAt)
          });
        } catch { /* UI progress cannot interrupt a worker request. */ }
        return;
      }
      if (data.type === "error") {
        const error = kokoroError(data.code || "KOKORO_WORKER_OPERATION_FAILED", data.message || "Falló la inferencia local.", {
          phase: data.phase || pending.lastPhase || pending.limits.phase,
          requestId: data.id,
          voiceId: pending.voiceId,
          textLength: pending.textLength,
          elapsedMs: Math.max(0, Date.now() - pending.startedAt),
          diagnostics: data.diagnostics || null
        });
        pending.reject(error);
      } else pending.resolve(data.value);
    };
    worker.onerror = (event) => {
      if (this.worker !== worker || this.workerGeneration !== generation) return;
      const diagnostics = {
        name: event.error?.name || "WorkerError",
        message: event.message || "Falló el Web Worker de Kokoro.",
        stack: event.error?.stack || "",
        filename: event.filename || "",
        lineno: Number.isFinite(event.lineno) ? event.lineno : undefined,
        colno: Number.isFinite(event.colno) ? event.colno : undefined
      };
      this._invalidateWorker(worker, kokoroError("KOKORO_WORKER_ERROR", diagnostics.message, { phase: "worker", diagnostics }));
    };
    this.worker = worker;
    return worker;
  }

  _request(type, payload = {}, onProgress) {
    const worker = this._ensureWorker();
    const generation = this.workerGeneration;
    const id = ++this.sequence;
    const limits = operationLimits(type, payload, this.timeouts);
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
        worker, generation, type, onProgress, limits, lastPhase: limits.phase,
        startedAt: Date.now(),
        voiceId: String(payload.voice || payload.voiceId || ""),
        textLength: typeof payload.text === "string" ? payload.text.length : null,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
        refreshIdleTimeout: () => {
          if (!limits.idleMs || settled) return;
          this.clearTimer(idleTimer);
          idleTimer = this.setTimer(() => this._timeoutWorker(worker, id, limits, "inactivity"), limits.idleMs);
        }
      };
      this.pending.set(id, pending);
      pending.refreshIdleTimeout();
      if (limits.totalMs) totalTimer = this.setTimer(() => this._timeoutWorker(worker, id, limits, "total"), limits.totalMs);
      if (type === "synthesize") {
        try {
          pending.onProgress?.({ phase: "synthesis", stage: "request-started", requestId: id, voiceId: pending.voiceId, textLength: pending.textLength, elapsedMs: 0 });
        } catch { /* Progress is advisory. */ }
      }
      try { worker.postMessage({ id, type, ...payload }); }
      catch (error) { pending.reject(error); }
    });
  }

  _timeoutWorker(worker, requestId, limits, timeoutKind) {
    const pending = this.pending.get(requestId);
    if (!pending || pending.worker !== worker) return;
    const error = kokoroError(limits.code, limits.message, {
      operation: pending.type,
      phase: pending.lastPhase || limits.phase,
      timeoutKind,
      requestId,
      voiceId: pending.voiceId,
      textLength: pending.textLength,
      elapsedMs: Math.max(0, Date.now() - pending.startedAt)
    });
    this._invalidateWorker(worker, error, requestId);
  }

  _invalidateWorker(worker, reason, timedOutRequestId = null) {
    if (!worker || this.worker !== worker) return false;
    this.worker = null;
    this.initialization = null;
    this.workerGeneration++;
    this.state = "error";
    worker.onmessage = null;
    worker.onerror = null;
    try { worker.terminate?.(); } catch { /* The client already invalidated the instance. */ }
    for (const [id, pending] of [...this.pending]) {
      if (pending.worker !== worker) continue;
      const error = id === timedOutRequestId
        ? reason
        : kokoroError("KOKORO_WORKER_RESET", "El worker Kokoro se reinició porque otra operación dejó de responder. Puedes reintentar.", {
          operation: pending.type,
          phase: pending.lastPhase,
          requestId: id,
          resetByRequestId: timedOutRequestId,
          voiceId: pending.voiceId,
          textLength: pending.textLength,
          elapsedMs: Math.max(0, Date.now() - pending.startedAt)
        });
      pending.reject(error);
    }
    return true;
  }

  initialize(onProgress = () => {}) {
    if (!this.initialization) {
      this.state = "loading";
      this.initialization = Promise.resolve().then(() => this._request("initialize", {}, onProgress)).then((result) => {
        this.state = "ready";
        return result;
      }).catch((error) => {
        this.initialization = null;
        this.state = "error";
        throw error;
      });
    }
    return this.initialization;
  }

  preparationStatus() { return { provider: "kokoro", state: this.state }; }

  synthesize(text, voice, onProgress = () => {}) {
    if (this.state !== "ready") {
      throw kokoroError("KOKORO_VOICE_NOT_PREPARED", "Kokoro todavía no está preparado. Pulsa Cargar al reproductor para preparar la voz y vuelve a cargar el texto.", { phase: "preflight" });
    }
    return this._request("synthesize", { text, voice }, onProgress);
  }

  preview(text, voice) { return this.synthesize(text, voice); }

  async dispose() {
    const worker = this.worker;
    if (worker) {
      this.worker = null;
      this.workerGeneration++;
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.terminate?.(); } catch { /* Best-effort worker cleanup. */ }
    }
    for (const pending of [...this.pending.values()]) pending.reject(new Error("Se cerró el contexto local de inferencia."));
    this.pending.clear();
    this.initialization = null;
    this.state = "idle";
  }
}
