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
  constructor({ runtime = globalThis.chrome?.runtime, onState = () => {}, onModel = () => {} } = {}) {
    if (!runtime) throw new Error("No se pudo conectar con la coordinación de la extensión.");
    this.runtime = runtime;
    this.onState = onState;
    this.onModel = onModel;
    this.session = null;
    this.state = snapshotFromSession();
    this.listener = (message) => {
      if (message?.target !== "panel") return;
      if (message.type === "reader:state") {
        if (message.sessionId && this.session?.id !== message.sessionId) return;
        this.state = { ...message.snapshot, currentAudioKey: message.currentAudioKey || null, downloadUrl: null };
        this.onState(this.snapshot());
      } else if (message.type === "reader:model" || message.type === "reader:model-progress") {
        this.onModel(message);
      } else if (message.type === "reader:error") {
        this.onModel({ type: "reader:model", state: "error", message: message.message });
      }
    };
    this.runtime.onMessage.addListener(this.listener);
  }

  snapshot() {
    return {
      ...this.state,
      chunks: [...this.state.chunks],
      chunkStates: [...(this.state.chunkStates || [])],
      durations: [...this.state.durations]
    };
  }

  setSession(session) {
    this.session = session ? { ...session } : null;
    this.state = snapshotFromSession(session);
    this.onState(this.snapshot());
  }

  async request(command, payload = {}) {
    const response = await this.runtime.sendMessage({ target: "background", command, payload });
    if (response?.ok === false) throw new Error(response.error || "Falló el motor local de lectura.");
    if (response?.snapshot && (!response.sessionId || response.sessionId === this.session?.id)) {
      this.state = { ...response.snapshot, currentAudioKey: response.currentAudioKey || this.session?.audioKeys?.[response.snapshot.selectedIndex] || null, downloadUrl: null };
      this.onState(this.snapshot());
    }
    return response || { ok: true };
  }

  async connect(session) {
    this.setSession(session);
    const response = await this.request("status");
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

  async play() {
    if (!this.session) return false;
    if (this.state.activeKind === "preview") {
      if (this.state.status === "completed") return this.preview(this.session.voice || "af_heart");
      const response = await this.request("resume");
      return response.ok !== false;
    }
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
  initialize(voice = this.session?.voice || "af_heart") { return this.request("initialize", { voice }); }
  clearAudioCache() { return this.request("clear-audio-cache"); }
  deleteModel() { return this.request("delete-model"); }
  async forgetSession(sessionId, preserve = false) {
    const response = await this.runtime.sendMessage({
      target: "background", command: "forget-session", payload: { sessionId, preserve }
    });
    if (response?.ok === false) throw new Error(response.error || "No se pudo detener el trabajo de la sesión.");
    return response || { ok: true };
  }
  dispose() { this.runtime.onMessage.removeListener(this.listener); }
}

export { snapshotFromSession };
