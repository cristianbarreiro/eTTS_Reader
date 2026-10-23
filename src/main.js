import "./style.css";
import { splitText } from "./text.js";
import { formatTime } from "./audio-utils.js";
import { attemptInitialization, deriveReaderControls } from "./reader-state.js";
import { makeId, ReaderRepository } from "./persistence.js";
import { ReaderClient } from "./reader-client.js";
import { KokoroWorkerClient } from "./tts-worker-client.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  text: $("#text-input"), count: $("#count"), chunks: $("#chunk-count"), file: $("#document-file"),
  fileStatus: $("#file-status"), drop: $("#dropzone"), documentSelect: $("#document-select"), sessionSelect: $("#session-select"),
  importTab: $("#import-tab"), importSelection: $("#import-selection"), importStatus: $("#tab-import-status"),
  importPreview: $("#tab-import-preview"), importMeta: $("#tab-import-meta"), importText: $("#tab-import-text"),
  replaceImport: $("#replace-with-import"), appendImport: $("#append-import"), cancelImport: $("#cancel-import"),
  voice: $("#voice-select"), speed: $("#speed"), install: $("#install-model"), test: $("#test-voice"),
  engineState: $("#engine-state"), modelStatus: $("#model-status"), downloadProgress: $("#download-progress"),
  play: $("#play"), pause: $("#pause"), stop: $("#stop"), previous: $("#previous"), next: $("#next"),
  position: $("#position"), playerState: $("#player-state"), playbackStatus: $("#playback-status"),
  progress: $("#read-progress"), progressFill: $("#read-progress-fill"), progressCaption: $("#progress-caption"),
  elapsed: $("#elapsed"), duration: $("#duration"), durationSummary: $("#duration-summary"), seek: $("#seek"),
  downloadAudio: $("#download-audio"), clearText: $("#clear-text"), deleteDocument: $("#delete-document"),
  deleteSession: $("#delete-session"), deleteAudioCache: $("#delete-audio-cache"), deleteModel: $("#delete-model"),
  storageUsage: $("#storage-usage")
};

const repository = new ReaderRepository();
let inferenceWorker = null;
let modelState = "idle";
let initializationPromise = null;
let currentDocument = null;
let currentSession = null;
let savedDocuments = [];
let savedSessions = [];
let fileReadId = 0;
let persistTimer = null;
let persistenceChain = Promise.resolve();
let downloadObjectUrl = null;
let downloadAudioKey = null;
let hydrationComplete = false;
let editingForked = false;
let pendingQueueReplacement = false;
let pendingTabImport = null;
let tabImportBusy = false;

const player = new ReaderClient({
  onState: (snapshot) => {
    if (currentSession && snapshot.activeKind !== "preview" && player?.session?.id === currentSession.id) {
      currentSession = {
        ...currentSession,
        selectedIndex: snapshot.selectedIndex,
        position: snapshot.currentTime,
        status: snapshot.status,
        speed: snapshot.speed,
        audioKeys: [...(currentSession.audioKeys || [])]
      };
      if (snapshot.currentAudioKey) currentSession.audioKeys[snapshot.selectedIndex] = snapshot.currentAudioKey;
    }
    renderPlayer(snapshot);
    void refreshDownloadLink(snapshot.currentAudioKey);
  },
  onModel: handleModelMessage
});

function controlsModelState() { return modelState === "cached" ? "ready" : modelState; }
function readerControls(snapshot = player.snapshot()) {
  return deriveReaderControls(controlsModelState(), snapshot.chunks.length, snapshot.status === "playing");
}

function modelLabel() {
  return ({
    idle: "Modelo sin descargar",
    cached: "Modelo guardado localmente",
    loading: "Cargando modelo local",
    ready: "Modelo local listo para usar",
    error: "Error del modelo"
  })[modelState] || "Modelo local";
}

function playerLabel(snapshot) {
  if (!snapshot.chunks.length && snapshot.activeKind !== "preview") return "Sin texto";
  if (snapshot.activeKind === "preview") {
    if (snapshot.status === "playing") return "Reproduciendo muestra";
    if (snapshot.status === "paused") return "Muestra pausada";
    if (snapshot.status === "completed") return "Muestra completada";
  }
  if (["text-ready", "stopped"].includes(snapshot.status) && !["ready", "cached"].includes(modelState)) return modelLabel();
  return ({
    "text-ready": "Texto preparado",
    generating: "Generando audio",
    "audio-ready": "Audio preparado",
    playing: "Reproduciendo en segundo plano",
    paused: "Pausado",
    interrupted: "Lectura interrumpida",
    stopped: "Detenido",
    completed: "Lectura completada",
    error: "Error recuperable"
  })[snapshot.status] || "Sin texto";
}

function describePlayer(snapshot) {
  if (snapshot.status === "playing") {
    if (snapshot.activeKind === "preview") return "Reproduciendo la muestra de voz local.";
    return `Reproduciendo fragmento ${(snapshot.playingIndex ?? snapshot.selectedIndex) + 1} de ${snapshot.chunks.length}.`;
  }
  if (snapshot.status === "paused") return snapshot.activeKind === "preview"
    ? `Muestra pausada en ${formatTime(snapshot.currentTime)}.`
    : `Lectura pausada en ${formatTime(snapshot.currentTime)} del fragmento ${snapshot.selectedIndex + 1}.`;
  if (snapshot.status === "interrupted") return snapshot.message || "La sesión se guardó. Pulsa Reanudar para continuar.";
  return snapshot.message;
}

function renderPlayer(snapshot) {
  const chunkCount = snapshot.chunks.length;
  const hasText = chunkCount > 0;
  const controls = readerControls(snapshot);
  const selected = hasText ? snapshot.selectedIndex + 1 : 0;
  const isPlaying = snapshot.status === "playing";
  const isGenerating = snapshot.status === "generating";

  ui.position.textContent = `${selected} / ${chunkCount}`;
  ui.position.setAttribute("aria-label", `Fragmento ${selected} de ${chunkCount}`);
  ui.playerState.textContent = playerLabel(snapshot);
  ui.playerState.dataset.state = snapshot.status;

  const progress = Number.isFinite(snapshot.totalProgress) ? snapshot.totalProgress : 0;
  ui.progressFill.style.width = `${Math.round(progress * 100)}%`;
  ui.progress.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  const progressText = snapshot.activeKind === "preview" ? "Muestra de voz · la lectura no cambia"
    : snapshot.totalDuration !== null
    ? `Progreso temporal · ${Math.round(progress * 100)}%`
    : hasText ? `${selected} de ${chunkCount} fragmentos · duración total pendiente` : "Sin progreso";
  ui.progress.setAttribute("aria-valuetext", progressText);
  ui.progressCaption.textContent = progressText;

  ui.elapsed.textContent = formatTime(snapshot.currentTime);
  ui.duration.textContent = formatTime(snapshot.duration ?? Number.NaN);
  ui.seek.min = "0";
  ui.seek.max = String(snapshot.duration || 0);
  ui.seek.step = "0.1";
  ui.seek.value = String(Math.min(snapshot.currentTime, snapshot.duration || 0));
  ui.seek.disabled = !Number.isFinite(snapshot.duration) || snapshot.duration <= 0 || !["playing", "paused"].includes(snapshot.status);
  ui.seek.setAttribute("aria-valuetext", `Fragmento ${selected}, ${formatTime(snapshot.currentTime)} de ${formatTime(snapshot.duration ?? Number.NaN)}`);

  const knownSeconds = snapshot.durations.reduce((sum, duration) => sum + (Number.isFinite(duration) ? duration : 0), 0);
  ui.durationSummary.textContent = snapshot.activeKind === "preview" ? `Duración de la muestra ${formatTime(snapshot.duration)}`
    : snapshot.totalDuration !== null
    ? `Duración total ${formatTime(snapshot.totalDuration)} · ${snapshot.knownDurationCount} fragmentos medidos`
    : hasText ? `Duración conocida ${formatTime(knownSeconds)} · total pendiente (${snapshot.knownDurationCount}/${chunkCount} fragmentos medidos)`
      : "La duración aparecerá cuando se genere audio.";

  ui.play.hidden = isPlaying;
  ui.pause.hidden = !isPlaying;
  const canResumePreview = snapshot.activeKind === "preview" && ["paused", "completed"].includes(snapshot.status);
  ui.play.disabled = (!controls.canPlay && !canResumePreview) || isGenerating;
  ui.pause.disabled = !controls.canPause;
  const playLabel = snapshot.status === "paused" || snapshot.status === "interrupted" ? "Reanudar"
    : snapshot.status === "completed" ? "Reproducir de nuevo" : "Reproducir";
  ui.play.querySelector("span").textContent = playLabel;
  ui.play.setAttribute("aria-label", snapshot.status === "paused" || snapshot.status === "interrupted" ? "Reanudar lectura"
    : snapshot.status === "completed" ? "Reproducir lectura desde el principio" : "Reproducir lectura");
  ui.stop.disabled = !(hasText || snapshot.activeKind === "preview") || !["playing", "paused", "generating", "audio-ready", "completed", "interrupted", "error"].includes(snapshot.status);
  ui.previous.disabled = snapshot.activeKind === "preview" || !controls.canPlay || snapshot.selectedIndex <= 0;
  ui.next.disabled = snapshot.activeKind === "preview" || !controls.canPlay || snapshot.selectedIndex >= chunkCount - 1;
  ui.test.disabled = !controls.canTestVoice || isPlaying || isGenerating;

  const message = describePlayer(snapshot) || (hasText ? "El texto está listo para reproducirse." : "Pega o carga texto para empezar.");
  if (ui.playbackStatus.textContent !== message) ui.playbackStatus.textContent = message;
}

async function refreshDownloadLink(audioKey) {
  if (!audioKey) {
    ui.downloadAudio.hidden = true;
    ui.downloadAudio.removeAttribute("href");
    if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
    downloadObjectUrl = null;
    downloadAudioKey = null;
    return;
  }
  if (downloadAudioKey === audioKey && downloadObjectUrl) return;
  try {
    const record = await repository.getAudioChunk(audioKey);
    if (player.snapshot().currentAudioKey !== audioKey || !record?.blob) return;
    if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
    downloadObjectUrl = URL.createObjectURL(record.blob);
    downloadAudioKey = audioKey;
    ui.downloadAudio.href = downloadObjectUrl;
    const selected = player.snapshot().selectedIndex + 1;
    const filename = player.snapshot().activeKind === "preview" ? `muestra-${ui.voice.value}.wav` : `lectura-fragmento-${String(selected).padStart(2, "0")}.wav`;
    ui.downloadAudio.download = filename;
    ui.downloadAudio.setAttribute("aria-label", `Descargar ${player.snapshot().activeKind === "preview" ? "muestra de voz" : `audio del fragmento ${selected}`}`);
    ui.downloadAudio.hidden = false;
  } catch (error) {
    ui.fileStatus.textContent = `No se pudo abrir el audio guardado: ${error.message}`;
  }
}

function handleModelMessage(message) {
  if (message.type === "reader:model-progress") {
    const event = message.event;
    if (event?.status === "progress" && Number.isFinite(event.progress)) {
      ui.downloadProgress.hidden = false;
      ui.downloadProgress.value = event.progress;
      ui.modelStatus.textContent = `Preparando ${event.file || "modelo local"}: ${Math.round(event.progress)}%`;
    }
    return;
  }
  if (message.state === "loading") {
    modelState = "loading";
    ui.modelStatus.textContent = message.message || "Kokoro se está cargando en el motor local.";
  } else if (message.state === "ready") {
    modelState = "ready";
    ui.modelStatus.textContent = message.message || "Motor Kokoro local listo.";
    ui.downloadProgress.hidden = true;
  } else if (message.state === "error") {
    modelState = "error";
    ui.modelStatus.textContent = `${message.message || "Falló el motor local."} Puedes reintentar.`;
    ui.downloadProgress.hidden = true;
  }
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
  renderPlayer(player.snapshot());
}

function updateTextInfo() {
  const text = ui.text.value;
  const segments = splitText(text);
  ui.count.textContent = `${text.length.toLocaleString()} caracteres`;
  ui.chunks.textContent = `${segments.length} ${segments.length === 1 ? "fragmento" : "fragmentos"}`;
  if (!currentSession || currentSession.sourceText !== text) {
    const liveStatus = player.snapshot().status;
    if (currentSession && !editingForked
        && (currentSession.status !== "text-ready" || currentSession.audioKeys?.some(Boolean)
          || ["playing", "paused", "interrupted", "completed", "error"].includes(liveStatus)
          || Boolean(player.snapshot().currentAudioKey))) {
      currentSession = {
        id: makeId("session"), documentId: currentDocument?.id,
        sourceText: text, chunks: segments, selectedIndex: 0, position: 0,
        status: "text-ready", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: []
      };
      editingForked = true;
    } else {
      currentSession = {
        ...(currentSession || {}),
        documentId: currentDocument?.id,
        sourceText: text,
        chunks: segments,
        selectedIndex: 0,
        position: 0,
        status: segments.length ? "text-ready" : "empty",
        voice: ui.voice.value,
        speed: Number(ui.speed.value),
        audioKeys: []
      };
    }
    player.setSession(currentSession);
    if (hydrationComplete) queuePersistence(true);
  }
}

function queuePersistence(replaceQueue = false) {
  pendingQueueReplacement ||= replaceQueue;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { void flushPersistence(); }, 250);
}

function flushPersistence({ replaceQueue = pendingQueueReplacement } = {}) {
  clearTimeout(persistTimer);
  if (!currentDocument || !currentSession) return persistenceChain;
  const documentDraft = { ...currentDocument, text: ui.text.value, extractionStatus: "ready" };
  const sessionDraft = {
    ...currentSession,
    sourceText: ui.text.value,
    chunks: splitText(ui.text.value),
    voice: ui.voice.value,
    speed: Number(ui.speed.value)
  };
  persistenceChain = persistenceChain.then(async () => {
    currentDocument = await repository.saveDocument(documentDraft);
    currentSession = await repository.saveSession(sessionDraft);
    await chrome.storage.local.set({ lastDocumentId: currentDocument.id, lastSessionId: currentSession.id });
    if (replaceQueue) {
      await player.replace(currentSession).catch((error) => {
        ui.playbackStatus.textContent = `El texto quedó guardado; no se pudo actualizar la cola activa: ${error.message}`;
      });
      pendingQueueReplacement = false;
    }
    await refreshLibrary();
    await refreshStorageUsage();
  }).catch((error) => {
    ui.fileStatus.textContent = `No se pudo guardar el texto local: ${error.message}. Reintenta o exporta el contenido.`;
  });
  return persistenceChain;
}

async function refreshLibrary() {
  savedDocuments = await repository.listDocuments();
  const selectedDocument = currentDocument?.id;
  ui.documentSelect.replaceChildren();
  for (const document of savedDocuments) {
    const option = new Option(`${document.name || "Documento"} · ${new Date(document.updatedAt).toLocaleDateString()}`, document.id);
    ui.documentSelect.add(option);
  }
  if (selectedDocument && savedDocuments.some((item) => item.id === selectedDocument)) ui.documentSelect.value = selectedDocument;
  savedSessions = currentDocument ? await repository.listSessions(currentDocument.id) : [];
  const selectedSession = currentSession?.id;
  ui.sessionSelect.replaceChildren();
  for (const session of savedSessions) {
    const date = new Date(session.updatedAt).toLocaleString();
    const status = session.status === "completed" ? " · completada" : session.status === "paused" ? " · pausada" : "";
    ui.sessionSelect.add(new Option(`${date}${status}`, session.id));
  }
  if (selectedSession && savedSessions.some((item) => item.id === selectedSession)) ui.sessionSelect.value = selectedSession;
  ui.deleteDocument.disabled = !currentDocument;
  ui.deleteSession.disabled = !currentSession;
}

async function refreshStorageUsage() {
  const estimate = await repository.estimateStorage();
  if (!estimate || !Number.isFinite(estimate.usage)) {
    ui.storageUsage.textContent = "Uso local disponible en los datos del navegador.";
    return;
  }
  const mb = (estimate.usage / 1024 / 1024).toFixed(1);
  const quota = Number.isFinite(estimate.quota) ? ` de ${(estimate.quota / 1024 / 1024).toFixed(0)} MB` : "";
  ui.storageUsage.textContent = `Almacenamiento de la extensión: ${mb} MB${quota}`;
}

function tabImportTypeLabel(type) {
  return ({
    article: "artículo web", "main-content": "contenido principal", "web-page": "página web",
    "text-document": "documento de texto", pdf: "PDF", selection: "selección de texto",
    restricted: "pestaña restringida", "permission-required": "permiso temporal requerido",
    "local-pdf": "PDF local", "local-document": "archivo local"
  })[type] || type || "contenido de pestaña";
}

async function runTabImport(selectionOnly = false) {
  if (tabImportBusy) return;
  tabImportBusy = true;
  pendingTabImport = null;
  ui.importPreview.hidden = true;
  ui.importStatus.textContent = "Detectando contenido de la pestaña activa…";
  ui.importTab.disabled = true;
  ui.importSelection.disabled = true;
  try {
    const { importCurrentTab } = await import("./tab-import.js");
    const result = await importCurrentTab({
      selectionOnly,
      onStatus: ({ message }) => { if (message) ui.importStatus.textContent = message; }
    });
    if (!result.ok) {
      const details = [result.title, result.type ? tabImportTypeLabel(result.type) : "", result.sourceUrl].filter(Boolean);
      ui.importStatus.textContent = `${details.length ? `${details.join(" · ")}\n` : ""}${result.message || "No se pudo extraer el contenido."}`;
      return;
    }
    pendingTabImport = result;
    ui.importText.value = result.text;
    const source = result.sourceUrl || "archivo o contenido local";
    const clipped = result.truncated ? " · texto limitado a 200.000 caracteres" : "";
    ui.importMeta.textContent = `${result.title || "Pestaña actual"} · ${tabImportTypeLabel(result.type)} · ${result.characters.toLocaleString()} caracteres${clipped}\n${source}`;
    ui.importStatus.textContent = result.message || "Extracción completada. Revisa el texto antes de importarlo.";
    ui.importPreview.hidden = false;
  } catch (error) {
    ui.importStatus.textContent = error?.message || "No se pudo extraer el contenido de esta pestaña.";
  } finally {
    tabImportBusy = false;
    ui.importTab.disabled = false;
    ui.importSelection.disabled = false;
  }
}

async function acceptTabImport(mode) {
  const imported = pendingTabImport;
  if (!imported?.text) return;
  const previousText = ui.text.value;
  const append = mode === "append";
  if (!append && previousText.trim() && !confirm("Reemplazar el texto del editor? El documento y las sesiones anteriores seguirán guardados.")) return;
  const maxLength = Number(ui.text.maxLength) || 200_000;
  const { combineImportedText } = await import("./tab-import.js");
  let merged = combineImportedText(previousText, imported.text, mode, { maxCharacters: maxLength });
  if (merged.confirmationRequired) {
    if (!confirm(`${merged.message} Añadirlo de todos modos?`)) return;
    merged = combineImportedText(previousText, imported.text, mode, { maxCharacters: maxLength, allowDuplicate: true });
  }
  if (!merged.ok) {
    ui.importStatus.textContent = `${merged.message} No se cambió el contenido.`;
    return;
  }
  const finalText = merged.text;
  let document;
  let session;
  try {
    await flushPersistence();
    // Retry persistence of the current editor before changing the active document.
    currentDocument = await repository.saveDocument({ ...currentDocument, text: previousText, extractionStatus: "ready" });
    currentSession = await repository.saveSession({
      ...currentSession, sourceText: previousText, chunks: splitText(previousText),
      voice: ui.voice.value, speed: Number(ui.speed.value)
    });
    await suspendCurrentReadForSwitch();
    const title = String(imported.title || "Pestaña importada").trim().slice(0, 160) || "Pestaña importada";
    const combined = append && Boolean(previousText.trim());
    const name = (combined ? `Combinado · ${currentDocument?.name || "Texto actual"} + ${title}` : title).slice(0, 180);
    const importedAt = Date.now();
    const sourceUrl = imported.sourceUrl || null;
    const documentDraft = {
      id: makeId("document"), name, type: combined ? "combined" : imported.type,
      text: finalText, sourceUrl, origin: sourceUrl ? new URL(sourceUrl).origin : "",
      importedFromTitle: title, importedCharacters: imported.text.length,
      importedAt, characterCount: finalText.length, extractionStatus: "ready"
    };
    document = await repository.saveDocument(documentDraft);
    try {
      session = await repository.saveSession({
        id: makeId("session"), documentId: document.id, sourceText: finalText, chunks: splitText(finalText),
        selectedIndex: 0, position: 0, status: "text-ready", voice: ui.voice.value,
        speed: Number(ui.speed.value), audioKeys: []
      });
    } catch (error) {
      await repository.deleteDocument(document.id).catch(() => {});
      throw error;
    }
  } catch (error) {
    ui.importStatus.textContent = `No se pudo guardar la importación: ${error?.message || "error local"}. El editor conserva su contenido.`;
    return;
  }

  currentDocument = document;
  currentSession = session;
  editingForked = false;
  ui.text.value = finalText;
  ui.fileStatus.textContent = `${document.name} · ${finalText.length.toLocaleString()} caracteres · guardado localmente.`;
  player.setSession(currentSession);
  hydrationComplete = true;
  updateTextInfo();
  pendingTabImport = null;
  ui.importPreview.hidden = true;
  ui.importStatus.textContent = `${append ? "Contenido añadido" : "Contenido reemplazado"} · ${imported.text.length.toLocaleString()} caracteres importados · ${currentSession.chunks.length} fragmentos. Pulsa Reproducir cuando estés listo.`;
  try {
    await chrome.storage.local.set({ lastDocumentId: currentDocument.id, lastSessionId: currentSession.id });
    await refreshLibrary();
    await refreshStorageUsage();
  } catch (error) {
    ui.fileStatus.textContent = `Contenido importado y guardado; no se actualizó alguna preferencia local: ${error.message}`;
  }
}

async function refreshModelCacheState() {
  try {
    const names = await caches.keys();
    if (names.includes("edge-local-reader-kokoro-v1") && modelState === "idle") {
      modelState = "cached";
      ui.modelStatus.textContent = "Modelo local encontrado en caché; Kokoro se cargará cuando lo necesites.";
      ui.install.textContent = "Preparar modelo local";
      ui.engineState.textContent = modelLabel();
      ui.engineState.dataset.state = modelState;
    }
  } catch {
    // Cache Storage may be unavailable in restricted profiles; the explicit load action can report it.
  }
  renderPlayer(player.snapshot());
}

async function initializeModel() {
  if (initializationPromise) return initializationPromise;
  modelState = "loading";
  ui.install.disabled = true;
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
  ui.modelStatus.textContent = "Cargando Kokoro y sus recursos locales bajo demanda.";
  ui.downloadProgress.hidden = false;
  ui.downloadProgress.removeAttribute("value");
  renderPlayer(player.snapshot());

  inferenceWorker ||= new KokoroWorkerClient();
  initializationPromise = (async () => {
    const result = await attemptInitialization(
      () => inferenceWorker.initialize((event) => {
        if (event?.status === "progress" && Number.isFinite(event.progress)) {
          ui.downloadProgress.value = event.progress;
          ui.modelStatus.textContent = `Descargando ${event.file || "modelo"}: ${Math.round(event.progress)}%`;
        } else if (event?.status === "done") ui.modelStatus.textContent = `Recurso local listo: ${event.file || "modelo"}`;
      }),
      (state) => { if (state === "loading" || state === "error") modelState = state; }
    );
    if (!result.ok) throw result.error;
    await inferenceWorker.dispose();
    inferenceWorker = null;
    modelState = "ready";
    await chrome.storage.local.set({ modelCached: true });
    ui.modelStatus.textContent = "Modelo y voces locales preparados. La memoria de inferencia se carga al iniciar la lectura.";
    ui.install.textContent = "Modelo preparado";
    ui.downloadProgress.hidden = true;
    renderPlayer(player.snapshot());
    return true;
  })().catch(async (error) => {
    await inferenceWorker?.dispose().catch(() => {});
    inferenceWorker = null;
    modelState = "error";
    ui.engineState.textContent = modelLabel();
    ui.engineState.dataset.state = modelState;
    ui.modelStatus.textContent = `${error.message || "No se pudo inicializar Kokoro."} Puedes reintentar. El texto permanece en este dispositivo.`;
    ui.install.textContent = "Reintentar carga local";
    ui.downloadProgress.hidden = true;
    renderPlayer(player.snapshot());
    return false;
  }).finally(() => {
    initializationPromise = null;
    ui.install.disabled = modelState === "ready";
  });
  return initializationPromise;
}

async function suspendCurrentReadForSwitch() {
  const status = player.snapshot().status;
  if (status === "playing") await player.pause().catch(() => {});
  else if (["generating", "audio-ready"].includes(status)) await player.stop().catch(() => {});
}

async function createNewDraft() {
  await suspendCurrentReadForSwitch();
  const document = await repository.saveDocument({ id: makeId("document"), name: "Texto pegado", type: "text", text: "" });
  currentDocument = document;
  currentSession = await repository.saveSession({
    id: makeId("session"), documentId: document.id, sourceText: "", chunks: [], selectedIndex: 0,
    position: 0, status: "empty", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: []
  });
  editingForked = false;
  ui.text.value = "";
  ui.fileStatus.textContent = "Editor vacío; los documentos anteriores siguen guardados.";
  player.setSession(currentSession);
  await chrome.storage.local.set({ lastDocumentId: document.id, lastSessionId: currentSession.id });
  await refreshLibrary();
  updateTextInfo();
}

async function activateDocument(document, preferredSessionId = null) {
  await suspendCurrentReadForSwitch();
  currentDocument = document;
  const sessions = await repository.listSessions(document.id);
  currentSession = sessions.find((item) => item.id === preferredSessionId) || sessions[0] || await repository.saveSession({
    id: makeId("session"), documentId: document.id, sourceText: document.text || "", chunks: splitText(document.text || ""),
    selectedIndex: 0, position: 0, status: document.text ? "text-ready" : "empty",
    voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: []
  });
  editingForked = false;
  ui.text.value = currentSession.sourceText ?? document.text ?? "";
  if (currentSession.voice && [...ui.voice.options].some((option) => option.value === currentSession.voice && !option.disabled)) ui.voice.value = currentSession.voice;
  if (currentSession.speed && [...ui.speed.options].some((option) => Number(option.value) === Number(currentSession.speed))) ui.speed.value = String(currentSession.speed);
  ui.fileStatus.textContent = document.name ? `Documento guardado · ${document.name}` : "Texto local recuperado.";
  player.setSession(currentSession);
  await chrome.storage.local.set({ lastDocumentId: document.id, lastSessionId: currentSession.id });
  hydrationComplete = true;
  updateTextInfo();
  await player.connect(currentSession);
  await refreshLibrary();
  await refreshStorageUsage();
}

async function boot() {
  const preferences = await chrome.storage.local.get(["lastDocumentId", "lastSessionId", "lastVoice", "speed"]);
  if (preferences.lastVoice && [...ui.voice.options].some((option) => option.value === preferences.lastVoice && !option.disabled)) ui.voice.value = preferences.lastVoice;
  if (preferences.speed && [...ui.speed.options].some((option) => Number(option.value) === Number(preferences.speed))) ui.speed.value = String(preferences.speed);
  savedDocuments = await repository.listDocuments();
  currentDocument = savedDocuments.find((document) => document.id === preferences.lastDocumentId) || savedDocuments[0] || null;
  if (!currentDocument) currentDocument = await repository.saveDocument({ id: makeId("document"), name: "Texto pegado", type: "text", text: "" });
  await activateDocument(currentDocument, preferences.lastSessionId);
  await refreshModelCacheState();
}

ui.text.addEventListener("input", () => {
  fileReadId++;
  updateTextInfo();
});

ui.clearText.addEventListener("click", async () => {
  if (ui.text.value && !confirm("Vaciar el editor y crear un borrador nuevo? El documento y las sesiones guardadas se conservarán en la biblioteca.")) return;
  fileReadId++;
  await createNewDraft();
});

ui.documentSelect.addEventListener("change", async () => {
  const document = savedDocuments.find((item) => item.id === ui.documentSelect.value);
  if (document) await activateDocument(document);
});

ui.sessionSelect.addEventListener("change", async () => {
  const session = savedSessions.find((item) => item.id === ui.sessionSelect.value);
  if (!session) return;
  await suspendCurrentReadForSwitch();
  currentSession = { ...session };
  editingForked = false;
  editingForked = false;
  ui.text.value = session.sourceText || "";
  ui.voice.value = session.voice;
  ui.speed.value = String(session.speed);
  player.setSession(currentSession);
  await chrome.storage.local.set({ lastSessionId: session.id });
  updateTextInfo();
  await player.connect(currentSession);
});

ui.file.addEventListener("change", async () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  const currentReadId = ++fileReadId;
  ui.fileStatus.textContent = `Procesando ${file.name}…`;
  try {
    const { extractDocument } = await import("./documents.js");
    const text = await extractDocument(file);
    if (currentReadId !== fileReadId) return;
    if (!text.trim()) throw new Error("El documento está vacío o no contiene texto.");
    await suspendCurrentReadForSwitch();
    currentDocument = await repository.saveDocument({ id: makeId("document"), name: file.name, type: file.name.split(".").at(-1).toLowerCase(), text, extractionStatus: "ready" });
    currentSession = await repository.saveSession({
      id: makeId("session"), documentId: currentDocument.id, sourceText: text, chunks: splitText(text),
      selectedIndex: 0, position: 0, status: "text-ready", voice: ui.voice.value,
      speed: Number(ui.speed.value), audioKeys: []
    });
    editingForked = false;
    ui.text.value = text;
    ui.fileStatus.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · texto guardado localmente.`;
    player.setSession(currentSession);
    await chrome.storage.local.set({ lastDocumentId: currentDocument.id, lastSessionId: currentSession.id });
    hydrationComplete = true;
    updateTextInfo();
    await refreshLibrary();
    await refreshStorageUsage();
  } catch (error) {
    if (currentReadId === fileReadId) ui.fileStatus.textContent = error.message || "No se pudo leer el archivo.";
  }
  ui.file.value = "";
});

ui.importTab.addEventListener("click", () => { void runTabImport(false); });
ui.importSelection.addEventListener("click", () => { void runTabImport(true); });
ui.replaceImport.addEventListener("click", () => { void acceptTabImport("replace"); });
ui.appendImport.addEventListener("click", () => { void acceptTabImport("append"); });
ui.cancelImport.addEventListener("click", () => {
  pendingTabImport = null;
  ui.importPreview.hidden = true;
  ui.importText.value = "";
  ui.importStatus.textContent = "Importación cancelada; el editor no cambió.";
});

for (const eventName of ["dragenter", "dragover"]) ui.drop.addEventListener(eventName, (event) => {
  event.preventDefault();
  ui.drop.classList.add("dragging");
});
for (const eventName of ["dragleave", "drop"]) ui.drop.addEventListener(eventName, (event) => {
  event.preventDefault();
  ui.drop.classList.remove("dragging");
});
ui.drop.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  ui.file.files = transfer.files;
  ui.file.dispatchEvent(new Event("change"));
});

ui.speed.addEventListener("input", () => { void player.setSpeed(Number(ui.speed.value)).catch(showError); });
ui.speed.addEventListener("change", () => {
  if (currentSession) currentSession = { ...currentSession, speed: Number(ui.speed.value) };
  void chrome.storage.local.set({ speed: Number(ui.speed.value) });
  queuePersistence(false);
});
ui.voice.addEventListener("change", () => {
  if (currentSession) currentSession = { ...currentSession, voice: ui.voice.value, audioKeys: [] };
  void chrome.storage.local.set({ lastVoice: ui.voice.value });
  if (currentSession) void player.setVoice(ui.voice.value).catch(showError);
  queuePersistence(false);
});

ui.install.addEventListener("click", () => { void initializeModel(); });
ui.test.addEventListener("click", () => {
  if (!["ready", "cached"].includes(modelState)) return;
  void player.preview(ui.voice.value).catch(showError);
});
ui.play.addEventListener("click", () => {
  if (!["ready", "cached"].includes(modelState)) return;
  void flushPersistence().then(() => player.play()).catch(showError);
});
ui.pause.addEventListener("click", () => { void player.pause().catch(showError); });
ui.stop.addEventListener("click", async () => {
  try {
    const wasPreview = player.snapshot().activeKind === "preview";
    await player.stop();
    const snapshot = player.snapshot();
    if (currentSession && !wasPreview) {
      currentSession = { ...currentSession, selectedIndex: snapshot.selectedIndex, position: 0, status: "stopped" };
      await repository.saveSession(currentSession);
      player.setSession(currentSession);
    }
  } catch (error) { showError(error); }
});
ui.previous.addEventListener("click", () => { void player.previous().catch(showError); });
ui.next.addEventListener("click", () => { void player.next().catch(showError); });
ui.seek.addEventListener("input", () => { void player.seek(Number(ui.seek.value)).catch(showError); });

ui.deleteDocument.addEventListener("click", async () => {
  if (!currentDocument || !confirm(`Eliminar “${currentDocument.name}”, sus sesiones y los audios que no use otra sesión? Esta acción no se puede deshacer.`)) return;
  try {
    await player.stop().catch(() => {});
    await repository.deleteDocument(currentDocument.id);
    currentDocument = null;
    currentSession = null;
    await createNewDraft();
    ui.fileStatus.textContent = "Documento, sesiones y audios asociados eliminados localmente.";
  } catch (error) { showError(error); }
});

ui.deleteSession.addEventListener("click", async () => {
  if (!currentSession || !confirm("Eliminar esta sesión y sus audios exclusivos? El documento se conservará.")) return;
  try {
    await player.stop().catch(() => {});
    await repository.deleteSession(currentSession.id);
    currentSession = await repository.saveSession({
      id: makeId("session"), documentId: currentDocument.id, sourceText: ui.text.value, chunks: splitText(ui.text.value),
      selectedIndex: 0, position: 0, status: ui.text.value ? "text-ready" : "empty", voice: ui.voice.value,
      speed: Number(ui.speed.value), audioKeys: []
    });
    player.setSession(currentSession);
    await chrome.storage.local.set({ lastSessionId: currentSession.id });
    await refreshLibrary();
  } catch (error) { showError(error); }
});

ui.deleteAudioCache.addEventListener("click", async () => {
  if (!confirm("Eliminar todos los WAV generados? Los documentos, sesiones y el modelo local se conservarán.")) return;
  try {
    await player.clearAudioCache();
    await repository.clearAudioCache();
    if (currentSession) {
      const chunkStates = currentSession.chunks.map((_, index) => currentSession.chunkStates?.[index] === "error" ? "error" : "pending");
      currentSession = {
        ...currentSession,
        audioKeys: [],
        chunkStates,
        lastError: chunkStates.includes("error") ? currentSession.lastError || "" : ""
      };
    }
    await refreshDownloadLink(null);
    await refreshStorageUsage();
    ui.fileStatus.textContent = "Audios generados eliminados; documentos y sesiones conservados.";
  } catch (error) { showError(error); }
});

ui.deleteModel.addEventListener("click", async () => {
  if (!confirm("Eliminar únicamente el modelo y las voces locales? Los documentos, sesiones y audios se conservarán.")) return;
  try {
    await player.stop().catch(() => {});
    await inferenceWorker?.dispose();
    inferenceWorker = null;
    await player.deleteModel().catch(() => {});
    await caches.delete("edge-local-reader-kokoro-v1");
    await caches.delete("kokoro-voices");
    await chrome.storage.local.remove("modelCached");
    modelState = "idle";
    ui.engineState.textContent = modelLabel();
    ui.engineState.dataset.state = modelState;
    ui.modelStatus.textContent = "Modelo local eliminado. Los documentos y la lectura guardada permanecen.";
    ui.install.textContent = "Descargar modelo local";
    renderPlayer(player.snapshot());
    await refreshStorageUsage();
  } catch (error) { showError(error); }
});

function showError(error) {
  const message = error?.message || "Ocurrió un error local.";
  ui.playbackStatus.textContent = message;
  ui.fileStatus.textContent = message;
}

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing = target instanceof Element && (target.isContentEditable || target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='slider']"));
  if (event.defaultPrevented || event.repeat || editing) return;
  if (!readerControls().canPlay) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (player.snapshot().status === "playing") void player.pause().catch(showError);
    else void player.play().catch(showError);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    void player.previous().catch(showError);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    void player.next().catch(showError);
  }
});

window.addEventListener("pagehide", () => {
  void flushPersistence({ replaceQueue: pendingQueueReplacement });
  if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
  player.dispose();
});

ui.engineState.textContent = modelLabel();
ui.engineState.dataset.state = modelState;
ui.downloadProgress.hidden = true;
void boot().catch((error) => {
  ui.fileStatus.textContent = `No se pudo recuperar la biblioteca local: ${error.message}. El texto no se eliminará.`;
  modelState = "error";
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
});
