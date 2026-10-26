import { getVoiceProvider } from "./voice-catalog.js";

export const READER_COMMAND_TIMEOUTS = Object.freeze({
  defaultMs: 120_000,
  statusMs: 20_000,
  prepareAudioMs: 30_000,
  piperInstallMs: 11 * 60_000,
  piperInitializeMs: 220_000,
  kokoroInitializeMs: 21 * 60_000,
  previewMs: 5 * 60_000,
  queuePreparationMs: 31 * 60_000
});

function timeoutForCommand(command, payload, timeouts) {
  if (command === "voice-preparation-status" || command === "piper-model-status" || command === "piper-catalog" || command === "list-installed-piper-models") return timeouts.statusMs;
  if (command === "prepare-audio") return timeouts.prepareAudioMs;
  if (command === "install-piper-model") return timeouts.piperInstallMs;
  if (command === "initialize") return String(payload.voice || "").startsWith("piper:") ? timeouts.piperInitializeMs : timeouts.kokoroInitializeMs;
  if (command === "preview") return timeouts.previewMs;
  return timeouts.defaultMs;
}

function snapshotFromSession(session = null) {
  const chunks = Array.isArray(session?.chunks) ? [...session.chunks] : [];
  const index = Math.max(0, Math.min(Number(session?.selectedIndex) || 0, Math.max(0, chunks.length - 1)));
  const savedStatus = session?.status || (chunks.length ? "text-ready" : "empty");
  const status = ["playing", "generating", "audio-ready"].includes(savedStatus) ? "interrupted" : savedStatus;
  const durations = chunks.map((_, chunkIndex) => Number.isFinite(session?.durations?.[chunkIndex]) ? session.durations[chunkIndex] : null);
  const knownDurationCount = durations.filter(Number.isFinite).length;
  const totalDuration = chunks.length && knownDurationCount === chunks.length
    ? durations.reduce((sum, duration) => sum + duration, 0) : null;
  return {
    chunks,
    status,
    synthesisStatus: "idle",
    selectedIndex: index,
    playingIndex: null,
    pendingChunkIndices: chunks.slice(index + 1).map((_, offset) => index + offset + 1),
    durations,
    currentTime: Number(session?.position) || 0,
    duration: durations[index] ?? null,
    speed: Number(session?.speed) || 1,
    chunkStates: Array.isArray(session?.chunkStates) ? [...session.chunkStates] : chunks.map((_, chunkIndex) => session?.audioKeys?.[chunkIndex] ? "ready" : "pending"),
    activeProvider: chunks.length ? session?.voiceProvider || getVoiceProvider(session?.voice || session?.voiceId || "af_heart") : null,
    activeVoiceId: chunks.length ? session?.voice || session?.voiceId || null : null,
    message: status === "interrupted"
      ? "La lectura se interrumpió. Pulsa Reanudar para continuar."
      : status === "error" ? String(session?.lastError || "La sesión guardada requiere reintento.") : "",
    downloadUrl: null,
    downloadFilename: null,
    activeKind: chunks.length ? "chunk" : null,
    currentAudioKey: session?.audioKeys?.[index] || null,
    knownDurationCount,
    totalDuration,
    totalProgress: chunks.length ? index / chunks.length : 0,
    fragmentProgress: 0
  };
}

export class ReaderClient {
  constructor({ runtime = globalThis.chrome?.runtime, onState = () => {}, onModel = () => {}, timeouts = READER_COMMAND_TIMEOUTS, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
    if (!runtime) throw new Error("No se pudo conectar con la coordinación de la extensión.");
    this.runtime = runtime;
    this.onState = onState;
    this.onModel = onModel;
    this.timeouts = { ...READER_COMMAND_TIMEOUTS, ...timeouts };
    this.setTimer = setTimer.bind(globalThis);
    this.clearTimer = clearTimer.bind(globalThis);
    this.session = null;
    this.state = snapshotFromSession();
    this.queuePreparation = null;
    this.queuePreparationWaiters = new Map();
    this.listener = (message) => {
      if (message?.target !== "panel") return;
      if (message.type === "reader:state") {
        if (message.sessionId && this.session?.id !== message.sessionId) return;
        this.state = { ...message.snapshot, currentAudioKey: message.currentAudioKey || null, downloadUrl: null };
        this.onState(this.snapshot());
      } else if (message.type === "reader:model" || message.type === "reader:model-progress") {
        this.onModel(message);
      } else if (message.type === "reader:queue-audio-preparation") {
        this._handleQueueAudioPreparation(message);
      } else if (message.type === "reader:error") {
        this.onModel({ type: "reader:model", state: "error", message: message.message, diagnostics: message.diagnostics, code: message.code, phase: message.phase });
      }
    };
    this.runtime.onMessage.addListener(this.listener);
  }

  snapshot() {
    const snapshot = {
      ...this.state,
      generationElapsedMs: this.state.status === "generating" && Number.isFinite(this.state.generationStartedAt)
        ? Math.max(0, Date.now() - this.state.generationStartedAt) : null,
      chunks: [...this.state.chunks],
      chunkStates: [...(this.state.chunkStates || [])],
      durations: [...this.state.durations]
    };
    const preparation = this.queuePreparation;
    if (!preparation) return snapshot;
    const { session, event = {} } = preparation;
    const ready = preparation.state === "ready";
    const progress = Number.isFinite(event.progress)
      ? Math.max(0, Math.min(1, event.progress / 100))
      : ready ? 1 : null;
    const durations = Array.isArray(session.durations) ? [...session.durations] : session.chunks.map(() => null);
    return {
      ...snapshot,
      chunks: [...session.chunks],
      status: "generating",
      synthesisStatus: "generating",
      selectedIndex: 0,
      playingIndex: null,
      pendingChunkIndices: session.chunks.slice(1).map((_, index) => index + 1),
      durations,
      currentTime: 0,
      duration: durations[0] ?? null,
      speed: Number(session.speed) || 1,
      generationProgress: progress,
      generationPhase: event.phase || "synthesis",
      generationStage: ready ? "first-wav-ready" : event.stage || "request-started",
      generationStartedAt: preparation.startedAt,
      generationElapsedMs: Math.max(0, Date.now() - preparation.startedAt),
      generationRequestId: event.requestId ?? null,
      generationVoiceId: session.voice || session.voiceId || null,
      generationTextLength: Number.isFinite(event.textLength) ? event.textLength : String(session.chunks[0] || "").length,
      generationCompletedParts: Number.isInteger(event.completedParts) ? event.completedParts : null,
      generationTotalParts: Number.isInteger(event.totalParts) ? event.totalParts : null,
      activeKind: "chunk",
      activeProvider: preparation.provider || snapshot.activeProvider,
      activeVoiceId: session.voice || session.voiceId || null,
      hasDownloadableAudio: false,
      currentAudioKey: null,
      downloadUrl: null,
      downloadFilename: null,
      message: preparation.message || "Preparando el primer audio local…",
      queuePreparation: true
    };
  }

  setSession(session) {
    this.queuePreparation = null;
    this.session = session ? { ...session } : null;
    this.state = snapshotFromSession(session);
    this.onState(this.snapshot());
  }

  async request(command, payload = {}) {
    const timeoutMs = timeoutForCommand(command, payload, this.timeouts);
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = this.setTimer(() => {
        const error = new Error(`El comando «${command}» no recibió respuesta en ${Math.round(timeoutMs / 1000)} segundos. Puedes reintentar; los datos locales se conservan.`);
        error.name = "ReaderCommandTimeoutError";
        error.code = "READER_COMMAND_TIMEOUT";
        error.phase = "background-message";
        error.command = command;
        reject(error);
      }, timeoutMs);
    });
    let response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() => this.runtime.sendMessage({ target: "background", command, payload })),
        timeout
      ]);
    } finally {
      this.clearTimer(timeoutId);
    }
    if (response?.ok === false) {
      const error = new Error(response.error || "Falló el motor local de lectura.");
      if (response.code) error.code = response.code;
      if (response.phase) error.phase = response.phase;
      if (response.diagnostics) error.diagnostics = response.diagnostics;
      throw error;
    }
    if (response?.snapshot && (!response.sessionId || response.sessionId === this.session?.id)) {
      const currentAudioKey = command === "clear-audio-cache"
        ? null
        : response.currentAudioKey || this.session?.audioKeys?.[response.snapshot.selectedIndex] || null;
      this.state = { ...response.snapshot, currentAudioKey, downloadUrl: null };
      this.onState(this.snapshot());
    }
    return response || { ok: true };
  }

  async connect(session) {
    this.setSession(session);
    const response = await this.request("restore", { session });
    if (response.sessionId && response.sessionId === session?.id && response.snapshot) {
      this.state = { ...response.snapshot, currentAudioKey: response.currentAudioKey || null, downloadUrl: null };
      this.onState(this.snapshot());
    }
    return this.snapshot();
  }

  async replace(session) {
    this.setSession(session);
    return this.request("replace", { session });
  }

  prepareQueueAudio(session, operationId) {
    if (!session?.id || !operationId) throw new TypeError("Se requiere una cola y un identificador de preparación.");
    if (this.queuePreparationWaiters.has(operationId)) throw new Error("Esta cola ya se está preparando.");
    let timeoutId;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      rejectCompletion = reject;
      this.queuePreparationWaiters.set(operationId, { resolve, reject });
    });
    timeoutId = this.setTimer(() => {
      const timeout = new Error("La preparación del primer audio no terminó dentro del límite. La cola anterior se conserva; puedes reintentar.");
      timeout.name = "ReaderQueuePreparationTimeoutError";
      timeout.code = "READER_QUEUE_PREPARATION_TIMEOUT";
      timeout.phase = "queue-preparation";
      void Promise.resolve(this.runtime.sendMessage({ target: "background", command: "cancel-queue-audio-preparation", payload: { operationId } })).catch(() => {});
      rejectCompletion(timeout);
    }, this.timeouts.queuePreparationMs);
    this.queuePreparation = {
      operationId,
      session: { ...session, chunks: [...session.chunks] },
      state: "generating",
      provider: getVoiceProvider(session.voice || session.voiceId),
      event: { phase: "synthesis", stage: "request-started", textLength: String(session.chunks[0] || "").length },
      startedAt: Date.now(),
      message: "Preparando el primer audio local…"
    };
    this.onState(this.snapshot());

    const start = this.request("prepare-queue-audio", { session, operationId });
    return Promise.all([start, completion]).then(([, result]) => result).catch((error) => {
      const waiter = this.queuePreparationWaiters.get(operationId);
      this.queuePreparationWaiters.delete(operationId);
      if (waiter) waiter.reject(error);
      if (this.queuePreparation?.operationId === operationId) {
        this.queuePreparation = null;
        this.onState(this.snapshot());
      }
      throw error;
    }).finally(() => this.clearTimer(timeoutId));
  }

  cancelQueueAudioPreparation(operationId) {
    if (this.queuePreparation?.operationId === operationId) {
      this.queuePreparation = null;
      this.onState(this.snapshot());
    }
    const waiter = this.queuePreparationWaiters.get(operationId);
    this.queuePreparationWaiters.delete(operationId);
    if (waiter) {
      const error = new Error("La preparación de audio se canceló; la cola anterior sigue intacta.");
      error.code = "QUEUE_PREPARATION_CANCELLED";
      error.phase = "queue-preparation";
      waiter.reject(error);
    }
    return Promise.resolve(this.runtime.sendMessage({ target: "background", command: "cancel-queue-audio-preparation", payload: { operationId } }));
  }

  _handleQueueAudioPreparation(message) {
    const preparation = this.queuePreparation;
    if (!preparation || message.operationId !== preparation.operationId || message.sessionId !== preparation.session.id) return;
    if (message.state === "generating") {
      preparation.event = message.event || preparation.event;
      preparation.message = message.message || preparation.message;
      this.onState(this.snapshot());
      return;
    }
    const waiter = this.queuePreparationWaiters.get(message.operationId);
    this.queuePreparationWaiters.delete(message.operationId);
    if (message.state === "ready") {
      preparation.state = "ready";
      preparation.audioKey = message.audioKey;
      preparation.message = "Primer audio generado, validado y guardado. Aplicando la cola…";
      preparation.event = { phase: "synthesis", stage: "first-wav-ready", progress: 100, textLength: message.textLength };
      this.onState(this.snapshot());
      waiter?.resolve(message);
      return;
    }
    this.queuePreparation = null;
    this.onState(this.snapshot());
    const error = new Error(message.message || (message.state === "cancelled" ? "Se canceló la preparación de audio." : "No se pudo preparar el primer audio local."));
    if (message.code) error.code = message.code;
    if (message.phase) error.phase = message.phase;
    if (message.requestId != null) error.requestId = message.requestId;
    if (message.voiceId) error.voiceId = message.voiceId;
    if (Number.isFinite(message.textLength)) error.textLength = message.textLength;
    if (Number.isFinite(message.elapsedMs)) error.elapsedMs = message.elapsedMs;
    if (message.diagnostics) error.diagnostics = message.diagnostics;
    waiter?.reject(error);
  }

  prepareAudio(sessionId = this.session?.id) {
    return this.request("prepare-audio", { sessionId });
  }

  async play() {
    if (this.state.activeKind === "preview") {
      if (this.state.status === "completed") return this.preview(this.state.activeVoiceId || this.session?.voice || "af_heart");
      const response = await this.request("resume");
      return response.ok !== false;
    }
    if (!this.session) return false;
    const response = await this.request("start", { session: this.session });
    return response.ok !== false;
  }

  pause() { return this.request("pause"); }
  stop() { return this.request("stop"); }
  previous() { return this.request("previous"); }
  next() { return this.request("next"); }
  seek(value) { return this.request("seek", { value }); }
  setSpeed(value) {
    this.state = { ...this.state, speed: Number(value) };
    this.onState(this.snapshot());
    return this.request("speed", { value });
  }
  setVoice(value) { return this.request("voice", { value }); }
  preview(voice) { return this.request("preview", { voice }); }
  initialize(voice = this.session?.voice || "af_heart", operationId) { return this.request("initialize", { voice, operationId }); }
  piperCatalog() { return this.request("piper-catalog"); }
  piperModelStatus(voiceId) { return this.request("piper-model-status", { voiceId }); }
  voicePreparationStatus(voiceId) { return this.request("voice-preparation-status", { voiceId }); }
  listInstalledPiperModels() { return this.request("list-installed-piper-models"); }
  installPiperModel(voiceId, operationId) { return this.request("install-piper-model", { voiceId, operationId }); }
  resetPiperEngine(voiceId) { return this.request("reset-piper-engine", { voiceId }); }
  deletePiperModel(voiceId) { return this.request("delete-piper-model", { voiceId }); }
  clearAudioCache() { return this.request("clear-audio-cache"); }
  deleteModel() { return this.request("delete-model"); }
  async forgetSession(sessionId, preserve = false) {
    const response = await this.runtime.sendMessage({
      target: "background", command: "forget-session", payload: { sessionId, preserve }
    });
    if (response?.ok === false) throw new Error(response.error || "No se pudo detener el trabajo de la sesión.");
    return response || { ok: true };
  }
  dispose() {
    this.runtime.onMessage.removeListener(this.listener);
    if (this.queuePreparation?.operationId) void this.cancelQueueAudioPreparation(this.queuePreparation.operationId).catch(() => {});
    for (const waiter of this.queuePreparationWaiters.values()) waiter.reject(new Error("Se cerró el panel durante la preparación de audio."));
    this.queuePreparationWaiters.clear();
    this.queuePreparation = null;
  }
}

export { snapshotFromSession };
