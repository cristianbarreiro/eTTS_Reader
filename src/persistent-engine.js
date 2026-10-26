import { PlaybackController } from "./player-controller.js";
import { makeAudioCacheKey } from "./persistence.js";
import { validateWavBlob } from "./audio-utils.js";
import { getVoiceProvider, getVoiceRecord, KOKORO_RUNTIME_VERSION, PIPER_PROVIDER_VERSION, voiceSessionFields } from "./voice-catalog.js";
import { isAudioStorageBusy, isProviderVoiceInUse, storageOperationBusyError } from "./storage-safety.js";
import { serializeErrorDiagnostics } from "./error-diagnostics.js";

export class PersistentReaderEngine {
  constructor({ audio, repository, inference, storage = globalThis.chrome?.storage?.local, publish = () => {}, now = () => Date.now(), progressWriteInterval = 1000 }) {
    if (!audio || !repository || !inference) throw new TypeError("El motor persistente necesita audio, almacenamiento e inferencia.");
    this.repository = repository;
    this.inference = inference;
    this.storage = storage;
    this.publishMessage = publish;
    this.now = now;
    this.progressWriteInterval = progressWriteInterval;
    this.activeSession = null;
    this.saveTail = Promise.resolve();
    this.synthesisTail = Promise.resolve();
    this.lastProgressWrite = 0;
    this.lastPublished = "";
    this.inFlightAudio = new Map();
    this.providerOperations = new Map();
    this.providerMaintenance = new Set();
    this.audioCacheMaintenance = false;
    this.sessionGeneration = 0;
    this.recordedDurations = new Set();
    this.previewAudioKey = null;
    this.previewVoiceId = null;
    this.modelOperationSequence = 0;
    this.queuePreparations = new Map();
    this.player = new PlaybackController({
      audio,
      synthesize: (text, { voice, onProgress }) => this._queueAudio(text, voice, this.player.snapshot().selectedIndex, onProgress),
      getVoice: () => this.activeSession?.voice || "af_heart",
      onState: (snapshot) => this._publishState(snapshot)
    });
  }

  _publish(type, detail = {}) {
    try { this.publishMessage({ target: "panel", type, ...detail }); } catch { /* no panel is connected while audio runs */ }
  }

  _nextModelOperationId() {
    return `engine-${++this.modelOperationSequence}`;
  }

  async _trackProviderOperation(provider, voiceId, operation) {
    if (this.audioCacheMaintenance) {
      throw storageOperationBusyError("Se están eliminando los audios guardados. Espera a que termine y vuelve a intentarlo.");
    }
    if (this.providerMaintenance.has(provider)) {
      throw storageOperationBusyError(`El motor ${provider === "piper" ? "Piper" : "Kokoro"} se está actualizando. Vuelve a intentarlo en un momento.`);
    }
    const voices = this.providerOperations.get(provider) || new Map();
    voices.set(voiceId, (voices.get(voiceId) || 0) + 1);
    this.providerOperations.set(provider, voices);
    try {
      return await operation();
    } finally {
      const remaining = voices.get(voiceId) - 1;
      if (remaining) voices.set(voiceId, remaining);
      else voices.delete(voiceId);
      if (!voices.size) this.providerOperations.delete(provider);
    }
  }

  async _withProviderMaintenance(provider, voiceId, operation) {
    if (this.providerMaintenance.has(provider)) {
      throw storageOperationBusyError(`El motor ${provider === "piper" ? "Piper" : "Kokoro"} ya se está actualizando. Vuelve a intentarlo en un momento.`);
    }
    const activeVoices = this.providerOperations.get(provider);
    const hasActiveOperation = voiceId
      ? Boolean(activeVoices?.get(voiceId))
      : Boolean(activeVoices?.size);
    if (hasActiveOperation) {
      throw storageOperationBusyError("El motor de voz seleccionado está inicializándose o generando audio. Espera a que termine y vuelve a intentarlo.");
    }
    this.providerMaintenance.add(provider);
    try {
      return await operation();
    } finally {
      this.providerMaintenance.delete(provider);
    }
  }

  _assertProviderNotInUse(provider, voiceId = null) {
    if (isProviderVoiceInUse({
      snapshot: this.player.snapshot(),
      session: this.activeSession,
      selectedVoiceId: this.previewVoiceId,
      provider,
      voiceId
    })) {
      const modelName = provider === "piper" ? "el modelo Piper seleccionado" : "los recursos de Kokoro";
      throw storageOperationBusyError(`La lectura o muestra está usando ${modelName}. Espera a que termine y vuelve a intentarlo.`);
    }
  }

  _hasProviderOperation() {
    return [...this.providerOperations.values()].some((voices) => voices.size > 0);
  }

  _persist(snapshot, force = false) {
    if (!this.activeSession || snapshot.activeKind === "preview") return;
    const now = this.now();
    const key = `${snapshot.status}:${snapshot.selectedIndex}:${snapshot.playingIndex}`;
    const stateChanged = key !== this.lastPublished;
    this.lastPublished = key;
    if (!force && !stateChanged && now - this.lastProgressWrite < this.progressWriteInterval) return;
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
    this._persist(snapshot);
    const activeAudioKey = this.activeSession?.audioKeys?.[snapshot.selectedIndex];
    const duration = snapshot.durations?.[snapshot.selectedIndex];
    if (activeAudioKey && Number.isFinite(duration) && duration > 0) {
      const marker = `${activeAudioKey}:${duration.toFixed(2)}`;
      if (!this.recordedDurations.has(marker)) {
        this.recordedDurations.add(marker);
        void this.repository.getAudioChunk(activeAudioKey).then((record) => record && this.repository.saveAudioChunk({
          ...record, format: "wav", duration
        })).catch(() => {});
      }
    }
    const currentAudioKey = snapshot.activeKind === "preview" ? this.previewAudioKey : activeAudioKey || null;
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

  async _queueAudio(text, voice, index, onProgress = () => {}) {
    if (this.audioCacheMaintenance) {
      throw storageOperationBusyError("Se están eliminando los audios guardados. Espera a que termine y vuelve a intentarlo.");
    }
    const generation = this.sessionGeneration;
    const voiceRecord = getVoiceRecord(voice);
    const provider = voiceRecord.provider;
    const modelId = voiceRecord.modelId;
    const providerVersion = provider === "kokoro"
      ? KOKORO_RUNTIME_VERSION
      : `${PIPER_PROVIDER_VERSION};${voiceRecord.modelRevision}`;
    const sampleRate = voiceRecord.sampleRate || 24000;
    const id = await makeAudioCacheKey(text, voice, modelId, provider, providerVersion);
    if (generation !== this.sessionGeneration) throw new Error("La sesión cambió antes de generar el audio.");
    const existing = this.inFlightAudio.get(id);
    if (existing?.generation === generation) return existing.task;
    const isSessionChunk = this.activeSession?.voice === voice && this.activeSession.chunks[index] === text && this.player.snapshot().activeKind !== "preview";
    if (isSessionChunk) {
      const chunkStates = [...(this.activeSession.chunkStates || this.activeSession.chunks.map(() => "pending"))];
      const audioKeys = [...(this.activeSession.audioKeys || [])];
      chunkStates[index] = "generating";
      this.activeSession = { ...this.activeSession, audioKeys, chunkStates, lastError: "" };
      this.saveTail = this.saveTail.then(() => this.repository.saveSession(this.activeSession)).catch((error) => {
        this._publish("reader:error", { message: `No se pudo guardar el estado del fragmento: ${error.message}` });
      });
    }
    let requestId = null;
    const reportProgress = (event = {}) => {
      if (event.requestId != null) requestId = event.requestId;
      const detail = {
        ...event,
        phase: event.phase || "synthesis",
        provider,
        voiceId: event.voiceId || voice,
        textLength: Number.isFinite(event.textLength) ? event.textLength : text.length,
        ...(event.requestId != null || requestId == null ? {} : { requestId })
      };
      try { onProgress(detail); } catch { /* Player progress is observational and cannot interrupt synthesis. */ }
      this._publish("reader:model-progress", { provider, voiceId: voice, event: detail });
    };
    const task = this.synthesisTail.then(async () => {
      if (generation !== this.sessionGeneration) throw new Error("La sesión cambió antes de generar el audio.");
      const cached = await this.repository.getAudioChunk(id);
      if (cached?.blob instanceof Blob && cached.blob.size > 0) {
        try {
          await validateWavBlob(cached.blob);
          reportProgress({ stage: "audio-cached", progress: 100 });
          return cached.blob;
        } catch {
          // A previously stored record is not trusted until it passes WAV validation.
          reportProgress({ stage: "invalid-cached-wav", progress: null });
        }
      }
      const blob = await this._trackProviderOperation(provider, voice, () => this.inference.synthesize(text, voice, { onProgress: reportProgress }));
      if (generation !== this.sessionGeneration) throw new Error("La sesión cambió durante la generación del audio.");
      reportProgress({ stage: "validating-wav", progress: null });
      await validateWavBlob(blob);
      reportProgress({ stage: "saving-cache", progress: null });
      await this.repository.saveAudioChunk({ id, blob, voice, provider, modelId, modelRevision: voiceRecord.modelRevision || null, providerVersion, text, format: "wav", sampleRate, duration: null });
      reportProgress({ stage: "audio-cached", progress: 100 });
      return blob;
    }).then(async (blob) => {
      if (generation !== this.sessionGeneration) throw new Error("La sesión cambió durante la preparación del audio.");
      if (this.player.snapshot().activeKind === "preview") this.previewAudioKey = id;
      if (this.activeSession?.voice === voice && this.activeSession.chunks[index] === text && this.player.snapshot().activeKind !== "preview") {
        const audioKeys = [...(this.activeSession.audioKeys || [])];
        const chunkStates = [...(this.activeSession.chunkStates || this.activeSession.chunks.map(() => "pending"))];
        audioKeys[index] = id;
        chunkStates[index] = "ready";
        this.activeSession = { ...this.activeSession, audioKeys, chunkStates, lastError: "" };
        await this.repository.saveSession(this.activeSession);
      }
      return blob;
    }).catch((error) => {
      if (generation === this.sessionGeneration && isSessionChunk && this.activeSession?.chunks[index] === text) {
        const chunkStates = [...(this.activeSession.chunkStates || this.activeSession.chunks.map(() => "pending"))];
        chunkStates[index] = "error";
        this.activeSession = { ...this.activeSession, chunkStates, lastError: error.message || "No se pudo generar este fragmento." };
        this.saveTail = this.saveTail.then(() => this.repository.saveSession(this.activeSession)).catch(() => {});
      }
      if (generation === this.sessionGeneration && typeof this.inference.preparationStatus === "function") {
        void Promise.resolve().then(() => this.inference.preparationStatus(voice)).then((status) => {
          const stillReady = status?.state === "ready" && (provider !== "piper" || status.installed === true);
          if (stillReady || generation !== this.sessionGeneration || this.activeSession?.voice !== voice) return;
          this._publish("reader:model", {
            provider,
            voiceId: voice,
            state: "error",
            phase: error.phase || "synthesis",
            code: error.code,
            diagnostics: serializeErrorDiagnostics(error),
            message: error.message || `No se pudo recuperar el motor ${provider === "piper" ? "Piper" : "Kokoro"}.`
          });
        }).catch(() => {});
      }
      throw error;
    }).finally(() => { if (this.inFlightAudio.get(id)?.task === task) this.inFlightAudio.delete(id); });
    this.inFlightAudio.set(id, { generation, task });
    this.synthesisTail = task.catch(() => {});
    return task;
  }

  _applySession(session, { restore = false } = {}) {
    this._cancelQueuePreparations("La sesión activa cambió antes de terminar la preparación.");
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
      currentAudioKey: snapshot.activeKind === "preview" ? this.previewAudioKey : this.activeSession?.audioKeys?.[snapshot.selectedIndex] || null
    };
  }

  _cancelQueuePreparations(message = "La preparación de la cola se canceló.", exceptId = null) {
    for (const [operationId, preparation] of this.queuePreparations) {
      if (operationId === exceptId) continue;
      preparation.cancelled = true;
      this._publish("reader:queue-audio-preparation", {
        operationId,
        sessionId: preparation.session.id,
        state: "cancelled",
        message
      });
    }
  }

  _assertQueuePreparationCurrent(preparation) {
    if (preparation.cancelled || preparation.generation !== this.sessionGeneration
        || this.queuePreparations.get(preparation.operationId) !== preparation) {
      const error = new Error("La preparación de audio quedó obsoleta y no se aplicó a la cola actual.");
      error.code = "QUEUE_PREPARATION_STALE";
      error.phase = "queue-commit";
      throw error;
    }
  }

  async _prepareQueueFirstAudio(preparation) {
    const { session, operationId } = preparation;
    const text = session.chunks[0];
    const voice = session.voice || session.voiceId;
    const voiceRecord = getVoiceRecord(voice);
    const provider = voiceRecord.provider;
    const modelId = voiceRecord.modelId;
    const providerVersion = provider === "kokoro"
      ? KOKORO_RUNTIME_VERSION
      : `${PIPER_PROVIDER_VERSION};${voiceRecord.modelRevision}`;
    const sampleRate = voiceRecord.sampleRate || 24000;
    const startedAt = this.now();
    const audioId = await makeAudioCacheKey(text, voice, modelId, provider, providerVersion);
    this._assertQueuePreparationCurrent(preparation);

    const publishProgress = (event = {}) => {
      if (preparation.cancelled) return;
      const safeEvent = {
        phase: String(event.phase || "synthesis"),
        ...(typeof event.stage === "string" ? { stage: event.stage } : {}),
        ...(Number.isFinite(event.progress) ? { progress: event.progress } : {}),
        ...(Number.isInteger(event.completedParts) ? { completedParts: event.completedParts } : {}),
        ...(Number.isInteger(event.totalParts) ? { totalParts: event.totalParts } : {}),
        ...(Number.isInteger(event.partIndex) ? { partIndex: event.partIndex } : {}),
        ...(Number.isInteger(event.partTotal) ? { partTotal: event.partTotal } : {}),
        ...(event.requestId != null ? { requestId: event.requestId } : {}),
        ...(Number.isFinite(event.elapsedMs) ? { elapsedMs: event.elapsedMs } : {}),
        voiceId: voice,
        textLength: text.length,
        sessionId: session.id,
        operationId,
        fragmentIndex: 0,
        fragmentTotal: session.chunks.length,
        elapsedMs: Math.max(0, this.now() - startedAt)
      };
      this._publish("reader:queue-audio-preparation", {
        operationId,
        sessionId: session.id,
        state: "generating",
        event: safeEvent,
        message: safeEvent.stage === "model-generate"
          ? "Inferencia Kokoro local en curso…"
          : safeEvent.stage === "wav-conversion"
            ? "Convirtiendo la síntesis a WAV…"
            : `Preparando el primer audio local · ${safeEvent.stage || safeEvent.phase}…`
      });
    };

    const task = this.synthesisTail.then(async () => {
      this._assertQueuePreparationCurrent(preparation);
      const cached = await this.repository.getAudioChunk(audioId);
      if (cached?.blob instanceof Blob && cached.blob.size > 0) {
        try {
          await validateWavBlob(cached.blob);
          this._assertQueuePreparationCurrent(preparation);
          publishProgress({ phase: "synthesis", stage: "audio-cached", progress: 100 });
          return cached.blob;
        } catch (error) {
          if (preparation.cancelled) throw error;
          publishProgress({ phase: "synthesis", stage: "invalid-cached-wav", progress: null });
        }
      }
      const blob = await this._trackProviderOperation(provider, voice, () => this.inference.synthesize(text, voice, {
        onProgress: publishProgress
      }));
      this._assertQueuePreparationCurrent(preparation);
      publishProgress({ phase: "synthesis", stage: "validating-wav", progress: null });
      await validateWavBlob(blob);
      this._assertQueuePreparationCurrent(preparation);
      publishProgress({ phase: "synthesis", stage: "saving-cache", progress: null });
      await this.repository.saveAudioChunk({
        id: audioId, blob, voice, provider, modelId,
        modelRevision: voiceRecord.modelRevision || null,
        providerVersion, text, format: "wav", sampleRate, duration: null
      });
      return blob;
    });
    this.synthesisTail = task.catch(() => {});

    try {
      await task;
      this._assertQueuePreparationCurrent(preparation);
      this._publish("reader:queue-audio-preparation", {
        operationId,
        sessionId: session.id,
        state: "ready",
        audioKey: audioId,
        voiceId: voice,
        textLength: text.length,
        elapsedMs: Math.max(0, this.now() - startedAt)
      });
      return { audioKey: audioId };
    } catch (error) {
      const diagnostics = serializeErrorDiagnostics(error);
      this._publish("reader:queue-audio-preparation", {
        operationId,
        sessionId: session.id,
        state: "error",
        message: error?.message || "No se pudo preparar el primer audio local.",
        code: error?.code,
        phase: error?.phase || "synthesis",
        requestId: error?.requestId,
        voiceId: voice,
        textLength: text.length,
        elapsedMs: Math.max(0, this.now() - startedAt),
        diagnostics
      });
      const status = await Promise.resolve(this.inference.preparationStatus?.(voice)).catch(() => null);
      if (status?.state === "error") {
        this._publish("reader:model", {
          provider, voiceId: voice, state: "error", phase: error?.phase || "synthesis",
          code: error?.code, diagnostics, message: error?.message || "Falló la síntesis local."
        });
      }
      throw error;
    } finally {
      if (this.queuePreparations.get(operationId) === preparation) this.queuePreparations.delete(operationId);
    }
  }

  async handleCommand(message) {
    switch (message.command) {
      case "status":
        await this.saveTail;
        return this._response();
      case "restore": {
        const session = message.session;
        if (!session?.id || session.queuePrepared === false || !Array.isArray(session.chunks) || !session.chunks.length) {
          throw new Error("La sesión guardada no contiene una cola preparada.");
        }
        if (this.activeSession?.id !== session.id) {
          if (this.activeSession) {
            this.player.stop();
            await this.saveTail;
          }
          this._applySession(session, { restore: true });
          await this.repository.saveSession(this.activeSession);
        }
        return this._response();
      }
      case "initialize": {
        const voice = message.voice || this.activeSession?.voice || "af_heart";
        const provider = getVoiceProvider(voice);
        const operationId = message.operationId || this._nextModelOperationId();
        this._publish("reader:model", {
          provider, voiceId: voice, state: "loading",
          operationId,
          message: provider === "piper" ? "Iniciando el motor Piper local." : "Cargando recursos locales de Kokoro."
        });
        try {
          const result = await this._trackProviderOperation(provider, voice, () => this.inference.initialize(
            (event) => this._publish("reader:model-progress", { provider, voiceId: voice, operationId, event }), voice
          ));
          this._publish("reader:model", {
            provider, voiceId: voice, state: "ready", operationId,
            message: provider === "piper" ? `Piper local listo · ${getVoiceRecord(voice).label}.` : "Modelo Kokoro local listo."
          });
          return { ok: true, result };
        } catch (error) {
          this._publish("reader:model", {
            provider, voiceId: voice, state: "error", operationId,
            phase: error.phase || "initialize", code: error.code,
            message: error.message || `No se pudo preparar ${provider === "piper" ? "Piper" : "Kokoro"}.`,
            diagnostics: serializeErrorDiagnostics(error)
          });
          throw error;
        }
      }
      case "piper-catalog": return { ok: true, voices: this.inference.piperCatalog() };
      case "piper-model-status": return { ok: true, ...(await this.inference.piperModelStatus(message.voiceId)) };
      case "voice-preparation-status": {
        const voice = getVoiceRecord(message.voiceId);
        if (typeof this.inference.preparationStatus !== "function") throw new Error("El motor local no puede consultar el estado real de preparación de esta voz.");
        return { ok: true, voiceId: voice.id, provider: voice.provider, ...(await this.inference.preparationStatus(voice.id)) };
      }
      case "list-installed-piper-models": return { ok: true, voices: await this.inference.listInstalledPiperModels() };
      case "install-piper-model": {
        const voiceId = message.voiceId;
        const voice = getVoiceRecord(voiceId);
        if (voice.provider !== "piper") throw new TypeError("Solo se pueden instalar voces Piper con esta acción.");
        const operationId = message.operationId || this._nextModelOperationId();
        this._publish("reader:model", { provider: "piper", voiceId, operationId, state: "loading", phase: "download", message: `Descargando ${voice.label} desde el repositorio oficial.` });
        try {
          const result = await this._trackProviderOperation("piper", voiceId, () => this.inference.installPiperModel(voiceId, (event) => this._publish("reader:model-progress", { provider: "piper", voiceId, operationId, event })));
          this._publish("reader:model", { provider: "piper", voiceId, operationId, state: "cached", phase: "download", message: `Modelo Piper instalado y verificado · ${voice.label}.` });
          return { ok: true, ...result };
        } catch (error) {
          this._publish("reader:model", {
            provider: "piper", voiceId, operationId, state: "error", phase: error.phase || "download", code: error.code,
            message: error.message || "No se pudo instalar el modelo Piper.",
            diagnostics: serializeErrorDiagnostics(error)
          });
          throw error;
        }
      }
      case "reset-piper-engine": {
        const voice = getVoiceRecord(message.voiceId);
        if (voice.provider !== "piper") throw new TypeError("Solo se puede restablecer el motor Piper para una voz Piper.");
        this._assertProviderNotInUse("piper", voice.id);
        if (typeof this.inference.resetPiperEngine !== "function") throw new Error("El motor Piper no permite restablecer su worker.");
        // This bypasses providerOperations and the worker's serialized queue so
        // a stuck initialization can be terminated directly. Active playback
        // is guarded above and cannot be interrupted by this action.
        return { ok: true, ...this.inference.resetPiperEngine(), voiceId: voice.id };
      }
      case "delete-piper-model": {
        const voice = getVoiceRecord(message.voiceId);
        if (voice.provider !== "piper") throw new TypeError("Solo se puede eliminar un modelo Piper con esta acción.");
        this._assertProviderNotInUse("piper", message.voiceId);
        const result = await this._withProviderMaintenance("piper", message.voiceId, () => this.inference.deletePiperModel(message.voiceId));
        this._publish("reader:model", { provider: "piper", voiceId: message.voiceId, state: "idle", phase: "download", message: "Modelo Piper eliminado de este dispositivo." });
        return { ok: true, ...result };
      }
      case "delete-model": {
        this._assertProviderNotInUse("kokoro");
        if (typeof this.inference.deleteKokoroModel !== "function") throw new Error("El motor local no permite eliminar los recursos de Kokoro de forma independiente.");
        await this._withProviderMaintenance("kokoro", null, async () => {
          await this.inference.deleteKokoroModel();
          if (typeof this.storage?.remove !== "function") throw new Error("No se pudo actualizar el estado local del modelo Kokoro.");
          await this.storage.remove("modelCached");
        });
        return { ok: true, provider: "kokoro", disposed: true };
      }
      case "start": {
        if (this.audioCacheMaintenance) throw storageOperationBusyError("Se están eliminando los audios guardados. Espera a que termine y vuelve a intentarlo.");
        const session = message.session;
        if (!session?.id || session.queuePrepared === false || !Array.isArray(session.chunks) || !session.chunks.length) {
          throw new Error("La sesión no contiene una cola preparada para leer.");
        }
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
      case "prepare-audio": {
        if (this.audioCacheMaintenance) throw storageOperationBusyError("Se están eliminando los audios guardados. Espera a que termine y vuelve a intentarlo.");
        if (!this.activeSession?.id || this.activeSession.id !== message.sessionId
            || !this.activeSession.queuePrepared || !this.activeSession.chunks?.length) {
          throw new Error("La sesión activa no coincide con la cola que quieres preparar.");
        }
        const snapshot = this.player.snapshot();
        if (["playing", "starting"].includes(snapshot.status)) return this._response();
        if (snapshot.status === "audio-ready" && snapshot.activeKind === "chunk") return this._response();
        // Start synthesis in the offscreen owner and return immediately. Player state
        // messages carry progress back to the panel; this command never autoplays.
        void this.player.prepare();
        return this._response();
      }
      case "prepare-queue-audio": {
        const session = message.session;
        const operationId = String(message.operationId || "");
        if (!operationId || !session?.id || !session.queuePrepared || !Array.isArray(session.chunks) || !session.chunks.length) {
          throw new Error("La solicitud no contiene una cola válida para preparar.");
        }
        getVoiceRecord(session.voice || session.voiceId);
        this._cancelQueuePreparations("Se inició otra preparación de cola.");
        const preparation = {
          operationId,
          session: { ...session, chunks: [...session.chunks] },
          generation: this.sessionGeneration,
          cancelled: false
        };
        this.queuePreparations.set(operationId, preparation);
        this._publish("reader:queue-audio-preparation", {
          operationId,
          sessionId: session.id,
          state: "generating",
          event: {
            phase: "synthesis", stage: "request-started", voiceId: session.voice || session.voiceId,
            textLength: session.chunks[0].length, fragmentIndex: 0, fragmentTotal: session.chunks.length,
            elapsedMs: 0
          },
          message: "Preparando el primer audio local…"
        });
        void this._prepareQueueFirstAudio(preparation).catch(() => {});
        return { ok: true, operationId, sessionId: this.activeSession?.id || null, snapshot: this.player.snapshot() };
      }
      case "cancel-queue-audio-preparation": {
        const preparation = this.queuePreparations.get(String(message.operationId || ""));
        if (preparation) {
          preparation.cancelled = true;
          this._publish("reader:queue-audio-preparation", {
            operationId: preparation.operationId, sessionId: preparation.session.id,
            state: "cancelled", message: "La preparación de audio se canceló; la cola anterior sigue intacta."
          });
        }
        break;
      }
      case "replace": {
        const session = message.session;
        if (!session?.id || !session.queuePrepared || !Array.isArray(session.chunks) || !session.chunks.length) {
          throw new Error("La sesión no contiene una cola preparada válida.");
        }
        if (this.activeSession?.id && this.activeSession.id !== session.id) {
          this.player.stop();
          await this.saveTail;
        }
        const candidate = { ...session, audioKeys: Array.isArray(session.audioKeys) ? [...session.audioKeys] : [] };
        await this.repository.saveSession(candidate);
        this._applySession(candidate);
        return this._response();
      }
      case "pause": this.player.pause(); break;
      case "stop":
        this.sessionGeneration++;
        this._cancelQueuePreparations("La preparación del primer audio se detuvo.");
        this.player.stop();
        break;
      case "forget-session": {
        const sessionId = message.sessionId;
        if (this.activeSession?.id !== sessionId) return this._response();
        const current = this.activeSession;
        const snapshot = this.player.snapshot();
        const preserve = Boolean(message.preserve);
        this.sessionGeneration++;
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
        getVoiceRecord(message.value);
        if (!this.activeSession) break;
        const playback = this.player.snapshot();
        const keepCurrentAudio = playback.activeProvider === getVoiceProvider(message.value)
          && playback.activeKind === "chunk"
          && playback.activeVoiceId === this.activeSession.voice
          && this.activeSession.voice === message.value;
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
        if (this.audioCacheMaintenance || isAudioStorageBusy(this.player.snapshot(), this.inFlightAudio.size > 0 || this._hasProviderOperation() || this.queuePreparations.size > 0)) {
          throw storageOperationBusyError("Hay una lectura o síntesis en curso. Espera a que termine antes de eliminar los audios guardados.");
        }
        this.audioCacheMaintenance = true;
        try {
          await this.saveTail;
          await this.repository.clearAudioCache();
          if (this.activeSession) {
            const chunkStates = this.activeSession.chunks.map((_, index) => this.activeSession.chunkStates?.[index] === "error" ? "error" : "pending");
            this.activeSession = {
              ...this.activeSession,
              audioKeys: [],
              chunkStates,
              lastError: chunkStates.includes("error") ? this.activeSession.lastError || "" : ""
            };
          }
        } finally {
          this.audioCacheMaintenance = false;
        }
        break;
      }
      case "preview":
        if (this.audioCacheMaintenance) throw storageOperationBusyError("Se están eliminando los audios guardados. Espera a que termine y vuelve a intentarlo.");
        if (!message.voice) throw new Error("Selecciona un perfil vocal compatible.");
        this.previewVoiceId = message.voice;
        this.previewAudioKey = null;
        await this.player.preview(getVoiceProvider(message.voice) === "piper"
          ? "Hola. Esta es una muestra de voz Piper en español, generada de forma local."
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
