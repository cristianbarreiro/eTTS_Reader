import { validateWavBlob } from "./audio-utils.js";
import { getVoiceProvider } from "./voice-catalog.js";

const finite = (value) => Number.isFinite(value) && value >= 0;

export class PlaybackController {
  constructor({
    audio,
    synthesize,
    getVoice = () => "af_heart",
    onState = () => {},
    createObjectURL = (blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url) => URL.revokeObjectURL(url),
    validateBlob = validateWavBlob
  }) {
    if (!audio || typeof synthesize !== "function") throw new TypeError("Se requiere un elemento de audio y una función de síntesis.");
    this.audio = audio;
    this.synthesize = synthesize;
    this.getVoice = getVoice;
    this.onState = onState;
    this.createObjectURL = createObjectURL;
    this.revokeObjectURL = revokeObjectURL;
    this.validateBlob = validateBlob;
    this.operationId = 0;
    this.synthesisTail = Promise.resolve();
    this.currentTask = null;
    this.currentTaskKey = null;
    this.activeUrl = null;
    this.activeBlob = null;
    this.activeIndex = null;
    this.activeKind = null;
    this.restartOnPlay = false;
    this.pendingResumePosition = 0;
    this.state = {
      chunks: [],
      status: "empty",
      synthesisStatus: "idle",
      selectedIndex: 0,
      playingIndex: null,
      pendingChunkIndices: [],
      durations: [],
      currentTime: 0,
      duration: null,
      speed: 1,
      message: "",
      generationProgress: null,
      generationPhase: "",
      generationStage: "",
      generationStartedAt: null,
      generationRequestId: null,
      generationVoiceId: null,
      generationTextLength: null,
      generationCompletedParts: null,
      generationTotalParts: null,
      downloadUrl: null,
      downloadFilename: null,
      activeKind: null
    };
    this._bindAudioEvents();
  }

  _bindAudioEvents() {
    this.audio.addEventListener("play", () => {
      this._handlePlaybackStart(this.operationId);
    });
    this.audio.addEventListener("pause", () => {
      this._handlePlaybackPause();
    });
    this.audio.addEventListener("timeupdate", () => {
      this._syncTime();
      this._publish();
    });
    this.audio.addEventListener("loadedmetadata", () => {
      if (!this.activeUrl || !finite(this.audio.duration) || this.audio.duration === 0) return;
      this.state.duration = this.audio.duration;
      if (this.activeIndex !== null) this.state.durations[this.activeIndex] = this.audio.duration;
      if (this.pendingResumePosition > 0 && this.activeIndex === this.state.selectedIndex) {
        this.audio.currentTime = Math.min(this.pendingResumePosition, this.audio.duration);
        this.pendingResumePosition = 0;
      }
      this._syncTime();
      this._publish();
    });
    this.audio.addEventListener("ended", () => { void this._handleEnded(); });
    this.audio.addEventListener("error", () => {
      if (!this.activeUrl || this.state.status === "stopped") return;
      const detail = this.audio.error?.message || "El elemento de audio no pudo reproducir el WAV.";
      this._fail(new Error(detail), this.operationId);
    });
  }

  snapshot() {
    const chunks = [...this.state.chunks];
    const durations = [...this.state.durations];
    const knownDurationCount = durations.filter(finite).length;
    const allDurationsKnown = chunks.length > 0 && knownDurationCount === chunks.length;
    const totalDuration = allDurationsKnown ? durations.reduce((sum, duration) => sum + duration, 0) : null;
    const fragmentProgress = finite(this.state.duration) && this.state.duration > 0
      ? Math.min(1, this.state.currentTime / this.state.duration)
      : this.state.status === "completed" && this.activeKind === "chunk" ? 1 : 0;
    const priorDuration = this.state.selectedIndex > 0
      ? durations.slice(0, this.state.selectedIndex).reduce((sum, duration) => sum + (finite(duration) ? duration : 0), 0)
      : 0;
    const totalProgress = chunks.length === 0 || this.activeKind === "preview"
      ? 0
      : allDurationsKnown && totalDuration > 0
        ? Math.min(1, (priorDuration + this.state.currentTime) / totalDuration)
        : Math.min(1, (this.state.selectedIndex + fragmentProgress) / chunks.length);

    return {
      ...this.state,
      chunks,
      durations,
      generationElapsedMs: this.state.status === "generating" && Number.isFinite(this.state.generationStartedAt)
        ? Math.max(0, Date.now() - this.state.generationStartedAt) : null,
      knownDurationCount,
      totalDuration,
      totalProgress,
      fragmentProgress,
      activeKind: this.activeKind,
      activeProvider: this.activeBlob && this.activeVoiceId ? getVoiceProvider(this.activeVoiceId) : null,
      activeVoiceId: this.activeVoiceId || null,
      hasDownloadableAudio: Boolean(this.activeBlob),
      downloadUrl: this.activeUrl,
      downloadFilename: this.state.downloadFilename
    };
  }

  _publish() {
    this.onState(this.snapshot());
  }

  _resetGeneration() {
    this.state.generationProgress = null;
    this.state.generationPhase = "";
    this.state.generationStage = "";
    this.state.generationStartedAt = null;
    this.state.generationRequestId = null;
    this.state.generationVoiceId = null;
    this.state.generationTextLength = null;
    this.state.generationCompletedParts = null;
    this.state.generationTotalParts = null;
  }

  _syncTime() {
    if (finite(this.audio.currentTime)) this.state.currentTime = this.audio.currentTime;
    if (finite(this.audio.duration) && this.audio.duration > 0) this.state.duration = this.audio.duration;
  }

  _clearAudio() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (this.activeUrl) this.revokeObjectURL(this.activeUrl);
    this.activeUrl = null;
    this.activeBlob = null;
    this.activeVoiceId = null;
    this.activeIndex = null;
    this.activeKind = null;
    this.state.downloadUrl = null;
    this.state.downloadFilename = null;
    this.state.activeKind = null;
  }

  _serializeSynthesis(text, voice, onProgress = () => {}) {
    const task = this.synthesisTail.then(() => this.synthesize(text, { voice, speed: 1, onProgress }));
    this.synthesisTail = task.catch(() => {});
    return task;
  }

  _activateBlob(blob, { index = null, kind = "chunk", filename, voice }) {
    this.activeUrl = this.createObjectURL(blob);
    this.activeBlob = blob;
    this.activeVoiceId = voice || this.getVoice?.() || null;
    this.activeIndex = index;
    this.activeKind = kind;
    this.state.activeKind = kind;
    this.state.downloadUrl = this.activeUrl;
    this.state.downloadFilename = filename;
    this.state.currentTime = 0;
    this.state.duration = index === null ? null : this.state.durations[index] ?? null;
    this.audio.playbackRate = this.state.speed;
    if ("preservesPitch" in this.audio) this.audio.preservesPitch = true;
    this.audio.src = this.activeUrl;
    this.audio.load();
  }

  _handlePlaybackStart(token) {
    if (token !== this.operationId || !this.activeUrl) return;
    this.state.status = "playing";
    this.state.playingIndex = this.activeIndex;
    this.state.message = "";
    this._publish();
  }

  _handlePlaybackPause() {
    if (this.state.status !== "playing") return;
    this._syncTime();
    this.state.status = "paused";
    this.state.playingIndex = null;
    this.state.message = "";
    this._publish();
  }

  async _requestPlay(token) {
    try {
      if (this.pendingResumePosition > 0) {
        if (!finite(this.audio.duration) || this.audio.duration <= 0) {
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              this.audio.removeEventListener("loadedmetadata", loaded);
              this.audio.removeEventListener("error", failed);
            };
            const loaded = () => { cleanup(); resolve(); };
            const failed = () => { cleanup(); reject(new Error("No se pudieron leer los metadatos del audio guardado.")); };
            this.audio.addEventListener("loadedmetadata", loaded, { once: true });
            this.audio.addEventListener("error", failed, { once: true });
          });
        }
        if (token !== this.operationId) return false;
        this.audio.currentTime = Math.min(this.pendingResumePosition, finite(this.audio.duration) ? this.audio.duration : this.pendingResumePosition);
        this.pendingResumePosition = 0;
        this._syncTime();
      }
      this.audio.playbackRate = this.state.speed;
      if ("preservesPitch" in this.audio) this.audio.preservesPitch = true;
      await this.audio.play();
      return true;
    } catch (error) {
      this._fail(error, token);
      return false;
    }
  }

  _fail(error, token) {
    if (token !== this.operationId) return;
    this.state.status = "error";
    this.state.synthesisStatus = "idle";
    this._resetGeneration();
    this.state.playingIndex = null;
    this.state.message = error?.message || "No se pudo preparar o reproducir el audio.";
    this._publish();
  }

  setChunks(chunks) {
    this.operationId++;
    this.currentTask = null;
    this.currentTaskKey = null;
    this.state.chunks = [...chunks];
    this.state.selectedIndex = 0;
    this.state.playingIndex = null;
    this.state.pendingChunkIndices = chunks.map((_, index) => index);
    this.state.durations = chunks.map(() => null);
    this.state.currentTime = 0;
    this.state.duration = null;
    this.state.synthesisStatus = "idle";
    this._resetGeneration();
    this.state.status = chunks.length ? "text-ready" : "empty";
    this.state.message = chunks.length ? "Texto preparado para leer." : "Pega o carga texto para empezar.";
    this.restartOnPlay = false;
    this.pendingResumePosition = 0;
    this._clearAudio();
    this._publish();
  }

  restore({ chunks = [], selectedIndex = 0, position = 0, status = "text-ready", speed = 1, durations = [], lastError = "" } = {}) {
    this.operationId++;
    this.currentTask = null;
    this.currentTaskKey = null;
    this._clearAudio();
    this.state.chunks = [...chunks];
    this.state.selectedIndex = Math.max(0, Math.min(Number(selectedIndex) || 0, Math.max(0, chunks.length - 1)));
    this.state.playingIndex = null;
    this.state.pendingChunkIndices = this.state.chunks.slice(this.state.selectedIndex + 1).map((_, offset) => this.state.selectedIndex + offset + 1);
    this.state.durations = this.state.chunks.map((_, index) => finite(durations[index]) ? durations[index] : null);
    this.pendingResumePosition = Math.max(0, Number(position) || 0);
    this.state.currentTime = this.pendingResumePosition;
    this.state.duration = this.state.durations[this.state.selectedIndex] ?? null;
    this.state.speed = Number.isFinite(Number(speed)) ? Number(speed) : 1;
    this.audio.playbackRate = this.state.speed;
    this.state.synthesisStatus = "idle";
    this._resetGeneration();
    this.state.status = ["playing", "generating", "audio-ready", "interrupted"].includes(status)
      ? "interrupted"
      : status === "paused" || status === "error" || status === "stopped" || status === "completed"
        ? status
        : this.state.chunks.length ? "text-ready" : "empty";
    this.state.message = ["playing", "generating", "audio-ready", "interrupted"].includes(status)
      ? "La sesión se recuperó tras una interrupción. Pulsa Reanudar para continuar."
      : status === "error" ? String(lastError || "La sesión guardada requiere reintento.")
        : status === "paused" ? "Sesión pausada recuperada."
        : this.state.chunks.length ? "Sesión recuperada y lista para continuar." : "Pega o carga texto para empezar.";
    this.restartOnPlay = false;
    this._publish();
  }

  setSpeed(speed) {
    const normalized = Number(speed);
    if (!Number.isFinite(normalized) || normalized < 0.5 || normalized > 2) return false;
    this.state.speed = normalized;
    if (this.activeUrl) {
      this.audio.playbackRate = normalized;
      if ("preservesPitch" in this.audio) this.audio.preservesPitch = true;
    }
    this._publish();
    return true;
  }

  clearDurations({ preserveActive = false } = {}) {
    this.state.durations = this.state.chunks.map(() => null);
    this.state.duration = null;
    if (preserveActive && this.activeUrl && this.activeIndex !== null && finite(this.audio.duration) && this.audio.duration > 0) {
      this.state.durations[this.activeIndex] = this.audio.duration;
      this.state.duration = this.audio.duration;
    }
    this._publish();
  }

  seek(time) {
    if (!this.activeUrl || !finite(this.state.duration) || this.state.duration <= 0 || !finite(time)) return false;
    const target = Math.max(0, Math.min(time, this.state.duration));
    try {
      this.audio.currentTime = target;
      this.state.currentTime = target;
      this._publish();
      return true;
    } catch (error) {
      this._fail(error, this.operationId);
      return false;
    }
  }

  async _startChunk(index, { autoplay = true, preserveQueue = false } = {}) {
    if (index < 0 || index >= this.state.chunks.length) return false;
    if (this.state.status === "generating" && this.currentTask && this.currentTaskKey === `chunk:${index}`) return this.currentTask;
    const token = ++this.operationId;
    const text = this.state.chunks[index];
    const voice = this.getVoice?.() ?? "af_heart";
    this.currentTaskKey = `chunk:${index}`;
    this.state.selectedIndex = index;
    this.state.playingIndex = null;
    if (!preserveQueue) this.state.pendingChunkIndices = this.state.chunks.slice(index + 1).map((_, offset) => index + offset + 1);
    this.state.synthesisStatus = "generating";
    this.state.status = "generating";
    this.state.generationProgress = null;
    this.state.generationPhase = "synthesis";
    this.state.generationStage = "request-started";
    this.state.generationStartedAt = Date.now();
    this.state.generationRequestId = null;
    this.state.generationVoiceId = voice;
    this.state.generationTextLength = text.length;
    this.state.generationCompletedParts = null;
    this.state.generationTotalParts = null;
    this.state.currentTime = 0;
    this.state.duration = this.state.durations[index] ?? null;
    this.state.message = `Generando el fragmento ${index + 1} de ${this.state.chunks.length}…`;
    this.restartOnPlay = false;
    this._clearAudio();
    this._publish();

    let task;
    const onProgress = (event = {}) => {
      if (token !== this.operationId) return;
      const phase = String(event.phase || (event.stage ? "initialize" : "synthesis"));
      const rawProgress = Number.isFinite(event.progress)
        ? event.progress
        : Number.isFinite(event.loaded) && Number.isFinite(event.total) && event.total > 0
          ? event.loaded / event.total * 100
          : null;
      this.state.generationPhase = phase;
      this.state.generationStage = String(event.stage || "");
      this.state.generationRequestId = event.requestId ?? this.state.generationRequestId;
      this.state.generationVoiceId = event.voiceId || this.state.generationVoiceId;
      this.state.generationTextLength = Number.isFinite(event.textLength) ? event.textLength : this.state.generationTextLength;
      this.state.generationProgress = rawProgress === null
        ? null
        : Math.max(0, Math.min(1, rawProgress / 100));
      this.state.generationCompletedParts = Number.isInteger(event.completedParts) ? event.completedParts : null;
      this.state.generationTotalParts = Number.isInteger(event.totalParts) ? event.totalParts : null;
      this._publish();
    };
    task = this._serializeSynthesis(text, voice, onProgress).then(async (result) => {
      if (token !== this.operationId) return false;
      await this.validateBlob(result);
      if (token !== this.operationId) return false;
      this._activateBlob(result, {
        index,
        kind: "chunk",
        filename: `lectura-fragmento-${String(index + 1).padStart(2, "0")}.wav`,
        voice
      });
      this.state.synthesisStatus = "idle";
      this.state.status = "audio-ready";
      this._resetGeneration();
      this.state.message = `Fragmento ${index + 1} preparado.`;
      this._publish();
      return autoplay ? this._requestPlay(token) : true;
    }).catch((error) => {
      this._fail(error, token);
      return false;
    }).finally(() => {
      if (this.currentTask === task) {
        this.currentTask = null;
        this.currentTaskKey = null;
      }
    });
    this.currentTask = task;
    return task;
  }

  async _startPreview(text, { voice, filename }) {
    const token = ++this.operationId;
    this.currentTask = null;
    this.currentTaskKey = "preview";
    this.state.playingIndex = null;
    this.state.synthesisStatus = "generating";
    this.state.status = "generating";
    this.state.generationProgress = null;
    this.state.generationPhase = "synthesis";
    this.state.generationStage = "request-started";
    this.state.generationStartedAt = Date.now();
    this.state.generationRequestId = null;
    this.state.generationVoiceId = voice;
    this.state.generationTextLength = text.length;
    this.state.generationCompletedParts = null;
    this.state.generationTotalParts = null;
    this.state.currentTime = 0;
    this.state.duration = null;
    this.state.message = "Generando muestra de voz local…";
    this._clearAudio();
    this.activeKind = "preview";
    this.state.activeKind = "preview";
    this._publish();

    let task;
    const onProgress = (event = {}) => {
      if (token !== this.operationId) return;
      const phase = String(event.phase || (event.stage ? "initialize" : "synthesis"));
      const rawProgress = Number.isFinite(event.progress)
        ? event.progress
        : Number.isFinite(event.loaded) && Number.isFinite(event.total) && event.total > 0
          ? event.loaded / event.total * 100
          : null;
      this.state.generationPhase = phase;
      this.state.generationStage = String(event.stage || "");
      this.state.generationRequestId = event.requestId ?? this.state.generationRequestId;
      this.state.generationVoiceId = event.voiceId || this.state.generationVoiceId;
      this.state.generationTextLength = Number.isFinite(event.textLength) ? event.textLength : this.state.generationTextLength;
      this.state.generationProgress = rawProgress === null
        ? null
        : Math.max(0, Math.min(1, rawProgress / 100));
      this.state.generationCompletedParts = Number.isInteger(event.completedParts) ? event.completedParts : null;
      this.state.generationTotalParts = Number.isInteger(event.totalParts) ? event.totalParts : null;
      this._publish();
    };
    task = this._serializeSynthesis(text, voice, onProgress).then(async (result) => {
      if (token !== this.operationId) return false;
      await this.validateBlob(result);
      if (token !== this.operationId) return false;
      this._activateBlob(result, { kind: "preview", filename, voice });
      this.state.synthesisStatus = "idle";
      this.state.status = "audio-ready";
      this._resetGeneration();
      this.state.message = "Muestra preparada.";
      this._publish();
      return this._requestPlay(token);
    }).catch((error) => {
      this._fail(error, token);
      return false;
    }).finally(() => {
      if (this.currentTask === task) {
        this.currentTask = null;
        this.currentTaskKey = null;
      }
    });
    this.currentTask = task;
    return task;
  }

  async preview(text, { voice = "af_heart" } = {}) {
    if (!String(text).trim()) return false;
    return this._startPreview(text, { voice, filename: `muestra-${voice}.wav` });
  }

  async prepare() {
    if (!this.state.chunks.length) return false;
    if (["playing", "starting"].includes(this.state.status)) return false;
    const index = this.state.selectedIndex;
    if (this.state.status === "generating" && this.currentTask && this.currentTaskKey === `chunk:${index}`) return this.currentTask;
    if (this.activeKind === "chunk" && this.activeIndex === index && this.activeUrl) return true;
    return this._startChunk(index, { autoplay: false });
  }

  async play() {
    if (!this.state.chunks.length) {
      if (this.activeKind === "preview" && this.activeUrl && this.state.status === "paused") return this._requestPlay(this.operationId);
      if (this.activeKind === "preview" && this.activeUrl && this.state.status === "completed") {
        try {
          if (this.activeUrl) this.audio.currentTime = 0;
          this.state.currentTime = 0;
          this.state.status = "audio-ready";
          this.state.message = "Muestra preparada.";
          this._publish();
          return this._requestPlay(this.operationId);
        } catch (error) {
          this._fail(error, this.operationId);
          return false;
        }
      }
      return false;
    }
    if (this.state.status === "playing" || this.state.status === "starting") return true;
    if (this.state.status === "generating" && this.currentTask && this.currentTaskKey === `chunk:${this.state.selectedIndex}`) {
      return this.currentTask;
    }
    if (this.activeKind === "preview" && this.activeUrl && this.state.status !== "completed") {
      return this._requestPlay(this.operationId);
    }
    const restart = this.state.status === "completed" && this.restartOnPlay;
    const index = restart ? 0 : this.state.selectedIndex;
    this.restartOnPlay = false;
    if (this.activeKind === "chunk" && this.activeIndex === index && this.activeVoiceId === (this.getVoice?.() ?? "af_heart") && this.activeUrl) {
      if (restart) {
        try {
          if (this.activeUrl) this.audio.currentTime = 0;
          this.state.currentTime = 0;
          this._publish();
        } catch (error) {
          this._fail(error, this.operationId);
          return false;
        }
      }
      return this._requestPlay(this.operationId);
    }
    return this._startChunk(index, { autoplay: true });
  }

  pause() {
    if (this.state.status !== "playing") return false;
    this.audio.pause();
    return true;
  }

  stop() {
    this.operationId++;
    this.currentTask = null;
    this.currentTaskKey = null;
    this.state.selectedIndex = 0;
    this.state.playingIndex = null;
    this.state.pendingChunkIndices = this.state.chunks.map((_, index) => index);
    this.state.currentTime = 0;
    this.state.duration = this.state.durations[0] ?? null;
    this.state.synthesisStatus = "idle";
    this._resetGeneration();
    this.state.status = this.state.chunks.length ? "stopped" : "empty";
    this.state.message = this.state.chunks.length ? "Lectura detenida. La próxima reproducción empieza desde el principio." : "Pega o carga texto para empezar.";
    this.restartOnPlay = false;
    this._clearAudio();
    this._publish();
  }

  async _navigate(delta) {
    const target = this.state.selectedIndex + delta;
    if (target < 0 || target >= this.state.chunks.length) return false;
    const autoplay = this.state.status === "playing";
    this.operationId++;
    this.currentTask = null;
    this.currentTaskKey = null;
    this.state.selectedIndex = target;
    this.state.playingIndex = null;
    this.state.pendingChunkIndices = this.state.chunks.slice(target + 1).map((_, offset) => target + offset + 1);
    this.state.currentTime = 0;
    this.state.duration = this.state.durations[target] ?? null;
    this.state.synthesisStatus = "idle";
    this._resetGeneration();
    this.pendingResumePosition = 0;
    this.state.status = "text-ready";
    this.state.message = `Seleccionado el fragmento ${target + 1} de ${this.state.chunks.length}.`;
    this.restartOnPlay = false;
    this._clearAudio();
    this._publish();
    return autoplay ? this._startChunk(target, { autoplay: true }) : true;
  }

  previous() { return this._navigate(-1); }
  next() { return this._navigate(1); }

  async _handleEnded() {
    if (!this.activeUrl) return;
    this._syncTime();
    this.state.playingIndex = null;
    if (this.activeKind === "preview") {
      this.state.status = "completed";
      this.state.synthesisStatus = "idle";
      this.state.message = "Muestra de voz completada.";
      this._publish();
      return;
    }

    if (this.state.pendingChunkIndices.length) {
      const [nextIndex, ...remaining] = this.state.pendingChunkIndices;
      this.state.pendingChunkIndices = remaining;
      this._publish();
      await this._startChunk(nextIndex, { autoplay: true, preserveQueue: true });
      return;
    }

    this.state.status = "completed";
    this.state.synthesisStatus = "idle";
    this.state.currentTime = this.state.duration ?? this.state.currentTime;
    this.state.message = "Lectura completada. Pulsa reproducir para empezar desde el principio.";
    this.restartOnPlay = true;
    this._publish();
  }

  dispose() {
    this.operationId++;
    this.currentTask = null;
    this.currentTaskKey = null;
    this._clearAudio();
    this.state.status = this.state.chunks.length ? "stopped" : "empty";
    this.state.playingIndex = null;
    this.state.synthesisStatus = "idle";
    this._publish();
  }
}
