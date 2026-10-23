import { PlaybackController } from "./player-controller.js";
import { makeAudioCacheKey } from "./persistence.js";
import { validateWavBlob } from "./audio-utils.js";
import { isSystemVoiceId, KOKORO_MODEL_ID, voiceSessionFields } from "./voice-catalog.js";

export class PersistentReaderEngine {
  constructor({ audio, repository, inference, speech = null, publish = () => {}, now = () => Date.now(), progressWriteInterval = 1000 }) {
    if (!audio || !repository || !inference) throw new TypeError("El motor persistente necesita audio, almacenamiento e inferencia.");
    this.repository = repository;
    this.inference = inference;
    this.speech = speech;
    this.publishMessage = publish;
    this.now = now;
    this.progressWriteInterval = progressWriteInterval;
    this.activeSession = null;
    this.saveTail = Promise.resolve();
    this.synthesisTail = Promise.resolve();
    this.lastProgressWrite = 0;
    this.lastPublished = "";
    this.inFlightAudio = new Map();
    this.sessionGeneration = 0;
    this.recordedDurations = new Set();
    this.previewAudioKey = null;
    this.player = new PlaybackController({
      audio,
      speech,
      synthesize: (text, { voice }) => this._queueAudio(text, voice, this.player.snapshot().selectedIndex),
      getVoice: () => this.activeSession?.voice || "af_heart",
      onState: (snapshot) => this._publishState(snapshot)
    });
  }

  _publish(type, detail = {}) {
    try { this.publishMessage({ target: "panel", type, ...detail }); } catch { /* no panel is connected while audio runs */ }
  }

  _persist(snapshot, force = false) {
    if (!this.activeSession || snapshot.activeKind === "preview") return;
    const now = this.now();
    const key = `${snapshot.status}:${snapshot.selectedIndex}:${snapshot.playingIndex}`;
    const stateChanged = key !== this.lastPublished;
    this.lastPublished = key;
    if (!force && !stateChanged && snapshot.status === "playing" && now - this.lastProgressWrite < this.progressWriteInterval) return;
    this.lastProgressWrite = now;
    const chunkStates = snapshot.chunks.map((_, index) => {
      if (this.activeSession.audioKeys?.[index]) return "ready";
      if (index === snapshot.selectedIndex && snapshot.status === "generating") return "generating";
      if (index === snapshot.selectedIndex && snapshot.status === "error") return "error";
      return this.activeSession.chunkStates?.[index] === "error" ? "error" : "pending";
    });
    const record = {
      ...this.activeSession,
      chunks: snapshot.chunks,
      selectedIndex: snapshot.selectedIndex,
      position: snapshot.currentTime,
      status: snapshot.status,
      durations: snapshot.durations,
      voice: this.activeSession.voice,
      speed: snapshot.speed,
      audioKeys: this.activeSession.audioKeys || [],
      chunkStates,
      lastError: snapshot.status === "error"
        ? snapshot.message
        : chunkStates.includes("error") ? this.activeSession.lastError || "" : ""
    };
    this.activeSession = record;
    this.saveTail = this.saveTail.then(() => this.repository.saveSession(record)).catch((error) => {
      this._publish("reader:error", { message: `No se pudo guardar el progreso local: ${error.message}` });
    });
  }

  _publishState(snapshot) {
    this._persist(snapshot, snapshot.status !== "playing");
    const activeAudioKey = this.activeSession?.audioKeys?.[snapshot.selectedIndex];
    const duration = snapshot.durations?.[snapshot.selectedIndex];
    if (activeAudioKey && Number.isFinite(duration) && duration > 0) {
      const marker = `${activeAudioKey}:${duration.toFixed(2)}`;
      if (!this.recordedDurations.has(marker)) {
        this.recordedDurations.add(marker);
        void this.repository.getAudioChunk(activeAudioKey).then((record) => record && this.repository.saveAudioChunk({
          ...record, format: "wav", sampleRate: 24000, duration
        })).catch(() => {});
      }
    }
    const currentAudioKey = snapshot.activeKind === "preview"
      ? this.previewAudioKey
      : snapshot.activeProvider === "speechSynthesis" ? null : activeAudioKey || null;
    this._publish("reader:state", {
      sessionId: this.activeSession?.id || null,
      snapshot: { ...snapshot, chunkStates: [...(this.activeSession?.chunkStates || [])], downloadUrl: null },
      currentAudioKey
    });
    if (snapshot.status === "playing" && snapshot.activeKind === "chunk") {
      const nextIndex = snapshot.playingIndex + 1;
      if (this.activeSession && nextIndex < this.activeSession.chunks.length) {
        void this._queueAudio(this.activeSession.chunks[nextIndex], this.activeSession.voice, nextIndex).catch(() => {});
      }
    }
  }

  async _queueAudio(text, voice, index) {
    const generation = this.sessionGeneration;
    const systemVoice = isSystemVoiceId(voice);
    const id = systemVoice ? `system:${voice}:${text}` : await makeAudioCacheKey(text, voice, KOKORO_MODEL_ID, "kokoro");
    if (generation !== this.sessionGeneration) throw new Error("La sesión cambió antes de generar el audio.");
    const existing = this.inFlightAudio.get(id);
    if (existing?.generation === generation) return existing.task;
    const isSessionChunk = this.activeSession?.voice === voice && this.activeSession.chunks[index] === text && this.player.snapshot().activeKind !== "preview";
    if (isSessionChunk) {
      const chunkStates = [...(this.activeSession.chunkStates || this.activeSession.chunks.map(() => "pending"))];
      const audioKeys = [...(this.activeSession.audioKeys || [])];
      if (systemVoice) audioKeys[index] = null;
      chunkStates[index] = "generating";
      this.activeSession = { ...this.activeSession, audioKeys, chunkStates, lastError: "" };
      this.saveTail = this.saveTail.then(() => this.repository.saveSession(this.activeSession)).catch((error) => {
        this._publish("reader:error", { message: `No se pudo guardar el estado del fragmento: ${error.message}` });
      });
    }
    const task = this.synthesisTail.then(async () => {
      if (generation !== this.sessionGeneration) throw new Error("La sesión cambió antes de generar el audio.");
      if (systemVoice) {
        const result = await this.inference.synthesize(text, voice);
        if (result?.kind !== "system-speech") throw new Error("El proveedor del sistema no preparó la voz seleccionada.");
        return result;
      }
      const cached = await this.repository.getAudioChunk(id);
      if (cached?.blob instanceof Blob && cached.blob.size > 0) return cached.blob;
      this._publish("reader:model", { state: "loading", message: "Preparando Kokoro local en segundo plano." });
      const blob = await this.inference.synthesize(text, voice);
      if (generation !== this.sessionGeneration) throw new Error("La sesión cambió durante la generación del audio.");
      await validateWavBlob(blob);
      await this.repository.saveAudioChunk({ id, blob, voice, provider: "kokoro", modelId: KOKORO_MODEL_ID, providerVersion: "kokoro-js@1.2.1", text, format: "wav", sampleRate: 24000, duration: null });
      return blob;
    }).then(async (blob) => {
      if (generation !== this.sessionGeneration) throw new Error("La sesión cambió durante la preparación del audio.");
      if (blob?.kind === "system-speech") return blob;
      if (this.player.snapshot().activeKind === "preview") this.previewAudioKey = id;
      if (this.activeSession?.voice === voice && this.activeSession.chunks[index] === text && this.player.snapshot().activeKind !== "preview") {
        const audioKeys = [...(this.activeSession.audioKeys || [])];
        const chunkStates = [...(this.activeSession.chunkStates || this.activeSession.chunks.map(() => "pending"))];
        audioKeys[index] = id;
        chunkStates[index] = "ready";
        this.activeSession = { ...this.activeSession, audioKeys, chunkStates, lastError: "" };
        await this.repository.saveSession(this.activeSession);
      }
      if (!systemVoice) this._publish("reader:model", { state: "ready", message: "Kokoro local listo." });
      return blob;
    }).catch((error) => {
      if (generation === this.sessionGeneration && isSessionChunk && this.activeSession?.chunks[index] === text) {
        const chunkStates = [...(this.activeSession.chunkStates || this.activeSession.chunks.map(() => "pending"))];
        chunkStates[index] = "error";
        this.activeSession = { ...this.activeSession, chunkStates, lastError: error.message || "No se pudo generar este fragmento." };
        this.saveTail = this.saveTail.then(() => this.repository.saveSession(this.activeSession)).catch(() => {});
      }
      if (generation === this.sessionGeneration && !systemVoice) this._publish("reader:model", { state: "error", message: error.message || "No se pudo preparar Kokoro." });
      throw error;
    }).finally(() => { if (this.inFlightAudio.get(id)?.task === task) this.inFlightAudio.delete(id); });
    this.inFlightAudio.set(id, { generation, task });
    this.synthesisTail = task.catch(() => {});
    return task;
  }

  _applySession(session, { restore = false } = {}) {
    this.sessionGeneration++;
    this.activeSession = { ...session, audioKeys: Array.isArray(session.audioKeys) ? [...session.audioKeys] : [] };
    this.previewAudioKey = null;
    if (restore) {
      this.player.restore({
        chunks: this.activeSession.chunks,
        selectedIndex: this.activeSession.selectedIndex,
        position: this.activeSession.position,
        status: this.activeSession.status,
        speed: this.activeSession.speed,
        durations: this.activeSession.durations,
        lastError: this.activeSession.lastError
      });
    } else {
      this.player.setChunks(this.activeSession.chunks);
      this.player.setSpeed(this.activeSession.speed);
    }
  }

  _response(ok = true) {
    const snapshot = this.player.snapshot();
    return {
      ok,
      sessionId: this.activeSession?.id || null,
      snapshot: this.activeSession
        ? { ...snapshot, chunkStates: [...(this.activeSession.chunkStates || [])], downloadUrl: null }
        : snapshot.activeKind === "preview" ? { ...snapshot, downloadUrl: null } : null,
      currentAudioKey: snapshot.activeKind === "preview" ? this.previewAudioKey : snapshot.activeProvider === "speechSynthesis" ? null : this.activeSession?.audioKeys?.[snapshot.selectedIndex] || null
    };
  }

  async handleCommand(message) {
    switch (message.command) {
      case "status":
        await this.saveTail;
        return this._response();
      case "initialize": {
        const voice = message.voice || this.activeSession?.voice || "af_heart";
        if (isSystemVoiceId(voice)) {
          const result = await this.inference.initialize(() => {}, voice);
          return { ok: true, result };
        }
        this._publish("reader:model", { state: "loading", message: "Cargando recursos locales de Kokoro." });
        const result = await this.inference.initialize((event) => this._publish("reader:model-progress", { event }), voice);
        return { ok: true, result };
      }
      case "start": {
        const session = message.session;
        if (!session?.id || !Array.isArray(session.chunks) || !session.chunks.length) throw new Error("La sesión no contiene fragmentos para leer.");
        if (this.activeSession?.id === session.id && this.player.snapshot().status === "playing") return this._response();
        if (this.activeSession?.id === session.id) {
          const started = await this.player.play();
          await this.saveTail;
          return this._response(started);
        }
        if (this.activeSession) {
          this.player.stop();
          await this.saveTail;
        }
        this._applySession(session, { restore: true });
        const started = await this.player.play();
        await this.saveTail;
        return this._response(started);
      }
      case "replace": {
        const session = message.session;
        if (!session?.id) throw new Error("La sesión no es válida.");
        if (this.activeSession?.id && this.activeSession.id !== session.id) {
          this.player.stop();
          await this.saveTail;
        }
        this._applySession(session);
        await this.repository.saveSession(this.activeSession);
        return this._response();
      }
      case "pause": this.player.pause(); break;
      case "stop": this.player.stop(); break;
      case "forget-session": {
        const sessionId = message.sessionId;
        if (this.activeSession?.id !== sessionId) return this._response();
        const current = this.activeSession;
        const snapshot = this.player.snapshot();
        const preserve = Boolean(message.preserve);
        this.sessionGeneration++;
        this.inFlightAudio.clear();
        this.player.stop();
        const stoppedSnapshot = this.player.snapshot();
        const progress = preserve ? {
          ...current,
          selectedIndex: snapshot.selectedIndex,
          position: snapshot.currentTime,
          status: snapshot.status === "playing" ? "paused" : snapshot.status === "generating" ? "interrupted" : snapshot.status,
          audioKeys: [...(current.audioKeys || [])]
        } : null;
        const writes = this.saveTail;
        this.activeSession = null;
        await writes;
        if (progress) await this.repository.saveSession(progress);
        this.player.setChunks([]);
        this.lastPublished = "";
        return {
          ok: true,
          sessionId: null,
          snapshot: { ...stoppedSnapshot, chunks: [], status: "empty", selectedIndex: 0, currentTime: 0, activeKind: null, currentAudioKey: null },
          currentAudioKey: null
        };
      }
      case "resume": await this.player.play(); break;
      case "previous": await this.player.previous(); break;
      case "next": await this.player.next(); break;
      case "seek": this.player.seek(Number(message.value)); break;
      case "speed":
        if (!this.player.setSpeed(Number(message.value))) throw new Error("Velocidad no válida.");
        if (this.activeSession) this.activeSession = { ...this.activeSession, speed: Number(message.value) };
        break;
      case "voice": {
        const isKokoro = ["af_heart", "am_michael"].includes(message.value);
        const isAvailableSystemVoice = isSystemVoiceId(message.value)
          && (await this.inference.listSystemVoices()).some((voice) => voice.id === message.value);
        if (!isKokoro && !isAvailableSystemVoice) throw new Error("El perfil vocal seleccionado no está disponible.");
        if (!this.activeSession) break;
        const playback = this.player.snapshot();
        const keepCurrentAudio = playback.activeProvider === "kokoro"
          && playback.activeKind === "chunk"
          && playback.activeVoiceId === this.activeSession.voice;
        const currentIndex = playback.selectedIndex;
        this.activeSession = {
          ...this.activeSession,
          ...voiceSessionFields(message.value),
          audioKeys: this.activeSession.chunks.map((_, index) => keepCurrentAudio && index === currentIndex ? this.activeSession.audioKeys?.[index] || null : null),
          chunkStates: this.activeSession.chunks.map((_, index) => keepCurrentAudio && index === currentIndex && this.activeSession.audioKeys?.[index] ? "ready" : "pending"),
          durations: this.activeSession.chunks.map((_, index) => keepCurrentAudio && index === currentIndex ? playback.durations[index] ?? null : null)
        };
        this.player.clearDurations({ preserveActive: keepCurrentAudio });
        await this.repository.saveSession(this.activeSession);
        break;
      }
      case "clear-audio-cache": {
        await this.saveTail;
        if (this.activeSession) {
          const chunkStates = this.activeSession.chunks.map((_, index) => this.activeSession.chunkStates?.[index] === "error" ? "error" : "pending");
          this.activeSession = {
            ...this.activeSession,
            audioKeys: [],
            chunkStates,
            lastError: chunkStates.includes("error") ? this.activeSession.lastError || "" : ""
          };
          await this.repository.saveSession(this.activeSession);
        }
        break;
      }
      case "preview":
        if (!message.voice) throw new Error("Selecciona un perfil vocal compatible.");
        this.previewAudioKey = null;
        await this.player.preview(isSystemVoiceId(message.voice)
          ? "Hola. Esta es una muestra de la voz del sistema."
          : "Hello. This is a local voice sample.", { voice: message.voice });
        break;
      case "close-idle":
        if (this.player.snapshot().status !== "playing" && this.player.snapshot().status !== "generating") await this.inference.dispose();
        break;
      default: throw new Error(`Comando desconocido: ${message.command}`);
    }
    await this.saveTail;
    return this._response();
  }

  async dispose() {
    await this.saveTail;
    await this.inference.dispose();
  }
}
