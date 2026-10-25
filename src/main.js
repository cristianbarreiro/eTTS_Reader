import "./style.css";
import { splitText } from "./text.js";
import { formatTime } from "./audio-utils.js";
import { attemptInitialization, deriveReaderControls, prepareAndRunVoiceTest } from "./reader-state.js";
import { makeId, ReaderRepository } from "./persistence.js";
import { persistEditorSnapshot } from "./editor-persistence.js";
import { buildLibraryEntries, libraryActionFor, openLibraryEntry, resumeLibrarySession } from "./library.js";
import { ReaderClient } from "./reader-client.js";
import { getVoiceProvider, getVoiceRecord, isLegacySystemVoiceId, PIPER_DEFAULT_VOICE_ID, PIPER_VOICE_CATALOG, voiceSessionFields } from "./voice-catalog.js";
import { isSelectedPiperVoiceMessage, shouldAcceptPiperOperationMessage } from "./piper-ui-state.js";
import { requestSitePermissionFromClick, requestTabsPermissionFromClick } from "./tab-permissions.js";
import { createPanelStatusState, userFacingErrorMessage } from "./ui-presentation.js";
import { formatErrorDiagnostics } from "./error-diagnostics.js";
import { kokoroEngineLabel, playerHeaderState, readingDurationSummary, readingProgressCaption } from "./player-presentation.js";
import { createTabFaviconPresenter, safeTabTitle } from "./tab-card-presentation.js";
import { playbackQueueMatchesEditor, preparePlaybackQueue } from "./playback-queue.js";
import { createConfirmAction } from "./confirm-action.js";
import {
  createModelManagementDisclosure,
  getVoicePreparationState,
  MODEL_STATUS_CHECK_TIMEOUT_MS,
  withBoundedWait
} from "./model-management-disclosure.js";
import {
  documentDeleteConfirmation,
  kokoroModelDeleteConfirmation,
  piperModelDeleteConfirmation,
  recoveredSessionsDeleteConfirmation,
  savedAudioDeleteConfirmation,
  sessionDeleteConfirmation
} from "./library-confirmation.js";
import { isAudioStorageBusy, isProviderVoiceInUse, storageOperationBusyError, storageOperationBusyMessage } from "./storage-safety.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  text: $("#text-input"), count: $("#count"), chunks: $("#chunk-count"), file: $("#document-file"),
  fileStatus: $("#file-status"), drop: $("#dropzone"), chooseSourceFile: $("#choose-source-file"), retryFileAccess: $("#retry-file-access"), retryAuthenticatedPdf: $("#retry-authenticated-pdf"),
  library: $("#library-details"), librarySummary: $("#library-summary-count"), libraryList: $("#library-list"),
  libraryStatus: $("#library-status"),
  confirmDialog: $("#library-confirm-dialog"), confirmTitle: $("#library-confirm-title"),
  confirmMessage: $("#library-confirm-message"), confirmStatus: $("#library-confirm-status"),
  confirmCancel: $("#library-confirm-cancel"), confirmAccept: $("#library-confirm-accept"),
  loadPlayer: $("#load-player"), queueSyncStatus: $("#queue-sync-status"),
  appAlert: $("#app-alert"), appAlertMessage: $("#app-alert-message"), errorDetails: $("#app-error-details"), errorTechnical: $("#app-error-technical"), dismissAppAlert: $("#dismiss-app-alert"),
  sourceCard: $("#source-card"), activeTabKind: $("#active-tab-kind"), activeTabDomain: $("#active-tab-domain"),
  activeTabFavicon: $("#active-tab-favicon"), activeTabFaviconFallback: $("#active-tab-favicon-fallback"),
  importTab: $("#import-tab"), importSelection: $("#import-selection"), importStatus: $("#tab-import-status"),
  followActiveTab: $("#follow-active-tab"), activeTabTitle: $("#active-tab-title"), activeTabStatus: $("#active-tab-status"),
  importPreview: $("#tab-import-preview"), importMeta: $("#tab-import-meta"), importText: $("#tab-import-text"),
  replaceImport: $("#replace-with-import"), appendImport: $("#append-import"), cancelImport: $("#cancel-import"),
  voice: $("#voice-select"), speed: $("#speed"), install: $("#install-model"), test: $("#test-voice"), voiceNote: $("#voice-note"), privacyNote: $("#privacy-note"),
  engineState: $("#engine-state"), modelStatus: $("#model-status"), downloadProgress: $("#download-progress"), resetPiperEngine: $("#reset-piper-engine"),
  play: $("#play"), pause: $("#pause"), stop: $("#stop"), previous: $("#previous"), next: $("#next"),
  position: $("#position"), playerState: $("#player-state"), playbackStatus: $("#playback-status"),
  progress: $("#read-progress"), progressFill: $("#read-progress-fill"), progressCaption: $("#progress-caption"),
  elapsed: $("#elapsed"), duration: $("#duration"), durationSummary: $("#duration-summary"), seek: $("#seek"),
  downloadAudio: $("#download-audio"), clearText: $("#clear-text"), deleteAudioCache: $("#delete-audio-cache"), deleteModel: $("#delete-model"), deletePiperModel: $("#delete-piper-model"),
  storageUsage: $("#storage-usage"), modelManagement: $("#model-management")
};

const confirmDestructiveAction = createConfirmAction({
  dialog: ui.confirmDialog,
  titleElement: ui.confirmTitle,
  messageElement: ui.confirmMessage,
  statusElement: ui.confirmStatus,
  cancelButton: ui.confirmCancel,
  confirmButton: ui.confirmAccept,
  document,
  fallbackFocus: () => document.querySelector("#library-details > summary") || document.querySelector("#model-management > summary")
});

const repository = new ReaderRepository();
const presentTabFavicon = createTabFaviconPresenter(ui.activeTabFavicon, ui.activeTabFaviconFallback);
let modelState = "checking";
let initializationPromise = null;
const piperStates = new Map(PIPER_VOICE_CATALOG.map((voice) => [voice.id, { state: "checking", installed: false, modelSizeBytes: voice.modelSizeBytes }]));
const piperInstallPromises = new Map();
let piperOperationSequence = 0;
const retiredPiperOperations = new Map();
const modelManagementDisclosure = createModelManagementDisclosure({
  details: ui.modelManagement,
  getSelectedVoiceId: () => ui.voice.value,
  getPreparationState: (voiceId) => getVoicePreparationState(voiceId, {
    getVoiceProvider,
    piperStates,
    kokoroState: modelState
  })
});
let currentDocument = null;
let currentSession = null;
let savedDocuments = [];
let savedSessions = [];
let selectionEpoch = 0;
let libraryRefreshEpoch = 0;
let libraryMutationBusy = false;
let fileReadId = 0;
let persistTimer = null;
let persistenceChain = Promise.resolve();
let downloadObjectUrl = null;
let downloadAudioKey = null;
let hydrationComplete = false;
let editingForked = false;
let pendingTabImport = null;
let tabImportBusy = false;
let currentTabContext = null;
let pendingAuthenticatedPdfContext = null;
let activeImportOperation = 0;
let followChangeSequence = 0;
let fileSelectionPurpose = "document";
let queueLoadBusy = false;
let staleQueueStopPending = false;
let staleQueueStopPromise = null;
const DOCUMENT_FILE_ACCEPT = ".pdf,.docx,.txt,.md,.markdown,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const panelStatus = createPanelStatusState();

const player = new ReaderClient({
  onState: (snapshot) => {
    if (snapshot.activeKind !== "preview" && player?.session?.id) {
      const loadedSession = {
        ...player.session,
        selectedIndex: snapshot.selectedIndex,
        position: snapshot.currentTime,
        status: snapshot.status,
        speed: snapshot.speed,
        audioKeys: [...(player.session.audioKeys || [])]
      };
      if (snapshot.currentAudioKey) loadedSession.audioKeys[snapshot.selectedIndex] = snapshot.currentAudioKey;
      player.session = loadedSession;
      if (currentSession?.id === loadedSession.id) currentSession = loadedSession;
    }
    renderPlayer(snapshot);
    if (snapshot.status === "error" && snapshot.message) showError(snapshot.message, "playback");
    void refreshDownloadLink(snapshot.currentAudioKey);
  },
  onModel: handleModelMessage
});

function assertAudioCacheCanBeCleared() {
  if (isAudioStorageBusy(player.snapshot())) {
    throw storageOperationBusyError("La lectura o síntesis está en curso. Espera a que termine antes de eliminar los audios guardados.");
  }
}

function assertProviderCanBeRemoved(provider, voiceId = null) {
  const voiceState = voiceId ? piperStates.get(voiceId) : null;
  const operationPending = provider === "kokoro"
    ? modelState === "loading" || Boolean(initializationPromise)
    : voiceState?.state === "loading" || piperInstallPromises.has(voiceId);
  if (operationPending) {
    throw storageOperationBusyError(`El motor ${provider === "piper" ? "Piper" : "Kokoro"} está preparando la voz. Espera a que termine y vuelve a intentarlo.`);
  }

  if (isProviderVoiceInUse({
    snapshot: player.snapshot(),
    session: player.session,
    selectedVoiceId: ui.voice.value,
    provider,
    voiceId
  })) {
    throw storageOperationBusyError("La lectura o muestra está usando este modelo. Espera a que termine y vuelve a intentarlo.");
  }
}

function storageConfirmationError(error, action, retryMessage) {
  const busyMessage = storageOperationBusyMessage(error);
  if (busyMessage) {
    if (action === "model") ui.modelStatus.textContent = busyMessage;
    else ui.fileStatus.textContent = busyMessage;
    return busyMessage;
  }
  showError(error, action);
  return retryMessage;
}

function syncImportButtons() {
  const canImport = panelStatus.snapshot().tab.canImport;
  const unavailable = libraryMutationBusy || tabImportBusy || !canImport;
  ui.importTab.disabled = unavailable;
  ui.importSelection.disabled = unavailable;
}

function setContentBusy(busy) {
  ui.library.setAttribute("aria-busy", String(busy));
  for (const control of [ui.text, ui.file, ui.chooseSourceFile, ui.retryFileAccess, ui.retryAuthenticatedPdf, ui.clearText, ui.replaceImport, ui.appendImport, ui.cancelImport, ui.voice, ui.speed, ui.loadPlayer]) {
    if (control) control.disabled = busy;
  }
  syncImportButtons();
  for (const button of ui.library.querySelectorAll("button")) button.disabled = busy;
  updateQueueSyncUI();
}

function updateQueueSyncUI(override = "") {
  if (!ui.queueSyncStatus) return;
  const hasText = Boolean(ui.text.value.trim());
  const queue = player?.session;
  const matches = currentQueueMatchesEditor();
  let message = override;
  let state = override ? "error" : "empty";
  if (!override && queueLoadBusy) {
    message = "Preparando la cola de reproducción…";
    state = "loading";
  } else if (!override && matches) {
    message = "Cola cargada · el primer audio local se generará al reproducir.";
    state = "current";
  } else if (!override && queue?.id) {
    message = "El reproductor conserva una cola anterior. Carga el texto actual antes de reproducir.";
    state = "stale";
  } else if (!override && hasText) {
    message = "El texto está en el editor. Cárgalo para preparar la cola.";
    state = "ready";
  } else if (!override) {
    message = "Escribe o importa texto y cárgalo cuando quieras preparar la cola.";
    state = "empty";
  }
  ui.queueSyncStatus.textContent = message;
  ui.queueSyncStatus.dataset.state = state;
  ui.loadPlayer.disabled = !hasText || libraryMutationBusy || queueLoadBusy;
}

function controlsModelState(voiceId = ui.voice.value) {
  return getVoiceProvider(voiceId) === "piper" ? piperStates.get(voiceId)?.state || "checking" : modelState;
}

function setKokoroModelState(nextState) {
  const previousState = modelState;
  modelState = nextState;
  if (getVoiceProvider(ui.voice.value) === "kokoro") {
    modelManagementDisclosure.onProviderStateChange(ui.voice.value, previousState, nextState);
  }
}

function currentQueueMatchesEditor() {
  return playbackQueueMatchesEditor(player.session, { text: ui.text.value, voice: ui.voice.value });
}

function readerControls(snapshot = player.snapshot()) {
  const voiceId = ui.voice.value;
  const provider = getVoiceProvider(voiceId);
  const queueMatches = snapshot.activeKind === "preview" || currentQueueMatchesEditor();
  const queueChunkCount = queueMatches ? snapshot.chunks.length : 0;
  return deriveReaderControls(controlsModelState(voiceId), queueChunkCount, snapshot.status === "playing", {
    provider,
    audioAvailable: queueMatches && Boolean(snapshot.currentAudioKey || player.session?.audioKeys?.[snapshot.selectedIndex]),
    allowLazyInitialization: provider === "kokoro" && queueMatches,
    allowLazyVoiceTest: provider === "kokoro"
      ? ["idle", "cached"].includes(controlsModelState(voiceId))
      : provider === "piper" && piperStates.get(voiceId)?.installed === true
  });
}

function updateVoiceProviderUI() {
  const selected = ui.voice.value;
  const record = getVoiceRecord(selected);
  if (record.provider === "piper") {
    const state = piperStates.get(selected) || { state: "checking", installed: false, modelSizeBytes: record.modelSizeBytes };
    const labels = { checking: "Comprobando Piper", idle: "Piper sin descargar", cached: "Piper guardado", loading: "Preparando Piper", ready: "Piper listo", error: "Error de Piper" };
    ui.engineState.textContent = labels[state.state] || "Piper local";
    ui.engineState.dataset.state = state.state;
    ui.voiceNote.textContent = `${record.label}. El modelo se descarga cuando lo solicitas; después, texto y síntesis permanecen en este dispositivo.`;
    ui.privacyNote.textContent = "Piper procesa el texto localmente. La conexión solo se usa para descargar el modelo oficial cuando lo solicitas.";
    ui.deleteModel.hidden = true;
    if (ui.deletePiperModel) {
      ui.deletePiperModel.hidden = !state.installed;
      ui.deletePiperModel.disabled = state.state === "loading";
    }
    if (ui.resetPiperEngine) {
      ui.resetPiperEngine.hidden = !(state.state === "error" && state.installed && state.phase !== "download");
      ui.resetPiperEngine.disabled = state.state === "loading";
    }
    ui.install.disabled = ["checking", "loading", "ready"].includes(state.state);
    if (state.state === "checking") ui.install.textContent = "Comprobando modelo local…";
    else if (state.state === "loading") ui.install.textContent = state.phase === "download" ? "Descargando Piper…" : "Preparando Piper…";
    else if (state.state === "ready") ui.install.textContent = "Voz preparada";
    else if (state.installed) ui.install.textContent = state.state === "error" ? "Reintentar preparación" : "Preparar voz Piper";
    else ui.install.textContent = state.state === "error" ? `Reintentar descarga · ${Math.round(record.modelSizeBytes / 1_000_000)} MB` : `Descargar voz · ${Math.round(record.modelSizeBytes / 1_000_000)} MB`;
    return;
  }
  ui.deleteModel.hidden = false;
  if (ui.deletePiperModel) ui.deletePiperModel.hidden = true;
  if (ui.resetPiperEngine) ui.resetPiperEngine.hidden = true;
  ui.engineState.textContent = kokoroEngineLabel(modelState);
  ui.engineState.dataset.state = modelState;
  const migratedSession = Boolean(currentSession?.voiceMigrationVersion);
  ui.voiceNote.textContent = migratedSession && isLegacySystemVoiceId(currentSession?.voiceMigration?.fromVoice)
    ? "Esta sesión usaba una voz de Edge/Windows. Conservamos el texto y el progreso, y cambiamos su proveedor de forma segura; instala Piper para volver a generar audio."
    : "Kokoro local genera WAV descargable para Heart y Michael. «Probar voz» prepara el modelo la primera vez y reproduce una muestra.";
  ui.privacyNote.textContent = "Las voces locales sintetizan el texto en este dispositivo; solo se conecta a internet al descargar el modelo solicitado.";
  ui.install.disabled = ["checking", "loading", "ready"].includes(modelState);
  ui.install.textContent = ({ checking: "Comprobando Kokoro…", idle: "Preparar Kokoro local", cached: "Cargar modelo local", loading: "Preparando Kokoro…", ready: "Modelo preparado", error: "Reintentar carga local" })[modelState] || "Preparar Kokoro local";
}

function modelLabel() {
  return ({
    checking: "Comprobando el motor local",
    idle: "Modelo sin descargar",
    cached: "Modelo guardado localmente",
    loading: "Cargando modelo local",
    ready: "Modelo local listo para usar",
    error: "Error del modelo"
  })[modelState] || "Modelo local";
}

function describePlayer(snapshot) {
  const activeProvider = snapshot.activeProvider || getVoiceProvider(ui.voice.value);
  if (snapshot.status === "text-ready" && modelState === "loading" && activeProvider === "kokoro") {
    return "Preparando Kokoro local antes de generar el primer audio.";
  }
  if (snapshot.status === "text-ready" && snapshot.chunks.length) return "Cola preparada. El primer audio se generará al reproducir.";
  if (snapshot.status === "starting") return "Esperando la confirmación de inicio del proveedor de voz.";
  if (snapshot.status === "playing") {
    if (snapshot.activeKind === "preview") return "Muestra de voz local; la lectura del documento no cambia.";
    return "Audio WAV local del fragmento actual.";
  }
  if (snapshot.status === "generating") return snapshot.activeKind === "preview"
    ? "Preparando una muestra local de voz."
    : `Síntesis del fragmento ${snapshot.selectedIndex + 1} de ${snapshot.chunks.length} en curso.`;
  if (snapshot.status === "audio-ready") return snapshot.activeKind === "preview"
    ? "La muestra local está lista para reproducirse."
    : "El audio del fragmento está listo para reproducirse o descargarse.";
  if (snapshot.status === "paused") return `Posición conservada en ${formatTime(snapshot.currentTime)}.`;
  if (snapshot.status === "interrupted") return snapshot.message || "La sesión se guardó. Pulsa Reanudar para continuar.";
  if (snapshot.status === "error") return userFacingErrorMessage(snapshot.message, "playback");
  if (snapshot.status === "completed") return snapshot.activeKind === "preview"
    ? "La muestra terminó y puede volver a probarse."
    : "Pulsa Reproducir para comenzar desde el principio.";
  return snapshot.message;
}

function renderPlayer(snapshot) {
  updateVoiceProviderUI();
  const chunkCount = snapshot.chunks.length;
  const hasText = chunkCount > 0;
  const controls = readerControls(snapshot);
  const selected = hasText ? snapshot.selectedIndex + 1 : 0;
  const isPlaying = snapshot.status === "playing";
  const isGenerating = ["generating", "starting"].includes(snapshot.status);
  const activeProvider = snapshot.activeProvider || getVoiceProvider(ui.voice.value);

  ui.position.textContent = `${selected} / ${chunkCount}`;
  ui.position.setAttribute("aria-label", `Fragmento ${selected} de ${chunkCount}`);
  const headerState = playerHeaderState(snapshot.status);
  ui.playerState.textContent = headerState;
  ui.playerState.hidden = !headerState;
  ui.playerState.dataset.state = snapshot.status;

  const progress = Number.isFinite(snapshot.totalProgress) ? snapshot.totalProgress : 0;
  ui.progressFill.style.width = `${Math.round(progress * 100)}%`;
  ui.progress.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  const progressText = readingProgressCaption({ ...snapshot, activeProvider });
  ui.progress.setAttribute("aria-valuetext", progressText);
  ui.progressCaption.textContent = progressText;

  ui.elapsed.textContent = formatTime(snapshot.currentTime);
  ui.duration.textContent = formatTime(snapshot.duration ?? Number.NaN);
  ui.seek.min = "0";
  ui.seek.max = String(snapshot.duration || 0);
  ui.seek.step = "0.1";
  ui.seek.value = String(Math.min(snapshot.currentTime, snapshot.duration || 0));
  const queueMatchesEditor = snapshot.activeKind === "preview" || currentQueueMatchesEditor();
  ui.seek.disabled = !queueMatchesEditor || !Number.isFinite(snapshot.duration)
    || snapshot.duration <= 0 || !["playing", "paused"].includes(snapshot.status);
  ui.seek.setAttribute("aria-valuetext", `Fragmento ${selected}, ${formatTime(snapshot.currentTime)} de ${formatTime(snapshot.duration ?? Number.NaN)}`);

  ui.durationSummary.textContent = readingDurationSummary(snapshot, activeProvider);

  ui.play.hidden = isPlaying;
  ui.pause.hidden = !isPlaying;
  const canResumePreview = snapshot.activeKind === "preview" && ["paused", "completed"].includes(snapshot.status) && controls.canTestVoice;
  ui.play.disabled = (!controls.canPlay && !canResumePreview) || isGenerating;
  ui.pause.disabled = !controls.canPause;
  ui.play.setAttribute("aria-label", snapshot.status === "paused" || snapshot.status === "interrupted" ? "Reanudar lectura"
    : snapshot.status === "completed" ? "Reproducir lectura desde el principio" : "Reproducir lectura");
  ui.stop.disabled = !(hasText || snapshot.activeKind === "preview") || !["playing", "starting", "paused", "generating", "audio-ready", "completed", "interrupted", "error"].includes(snapshot.status);
  ui.previous.disabled = snapshot.activeKind === "preview" || !controls.canPlay || snapshot.selectedIndex <= 0;
  ui.next.disabled = snapshot.activeKind === "preview" || !controls.canPlay || snapshot.selectedIndex >= chunkCount - 1;
  ui.test.disabled = !controls.canRequestVoiceTest || isPlaying || isGenerating;

  const staleQueue = snapshot.activeKind !== "preview" && !currentQueueMatchesEditor();
  const message = staleQueue
    ? player.session?.id ? "El texto del editor cambió. Carga el contenido actual antes de iniciar la reproducción."
      : "Carga el texto al reproductor para preparar la lectura."
    : describePlayer(snapshot) || (hasText ? "La cola está lista para reproducirse." : "Pega o carga texto para empezar.");
  if (ui.playbackStatus.textContent !== message) ui.playbackStatus.textContent = message;
  updateQueueSyncUI();
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
    ui.fileStatus.textContent = showError(error, "playback");
  }
}

function setPiperVoiceState(voiceId, patch) {
  const previous = piperStates.get(voiceId);
  if (!previous) return;
  const next = { ...previous, ...patch };
  piperStates.set(voiceId, next);
  if (previous.state !== next.state) {
    modelManagementDisclosure.onProviderStateChange(voiceId, previous.state, next.state);
  }
}

function retirePiperOperation(voiceId, operationId) {
  if (!operationId) return;
  const retired = retiredPiperOperations.get(voiceId) || new Set();
  retired.add(operationId);
  while (retired.size > 24) retired.delete(retired.values().next().value);
  retiredPiperOperations.set(voiceId, retired);
}

function beginPiperOperation(voiceId, patch) {
  const previous = piperStates.get(voiceId) || {};
  retirePiperOperation(voiceId, previous.operationId);
  const operationId = `panel-${++piperOperationSequence}`;
  setPiperVoiceState(voiceId, { ...patch, operationId });
  return operationId;
}

function acceptPiperOperationMessage(message) {
  const previous = piperStates.get(message.voiceId) || {};
  const retired = retiredPiperOperations.get(message.voiceId) || new Set();
  if (!shouldAcceptPiperOperationMessage(message, previous, retired)) return false;
  if (!message.voiceId || !message.operationId || previous.operationId === message.operationId) return true;
  retirePiperOperation(message.voiceId, previous.operationId);
  setPiperVoiceState(message.voiceId, { operationId: message.operationId });
  return true;
}

function piperStageLabel(event = {}) {
  return ({
    "downloading-config": "Descargando configuración de voz…",
    "config-ready": "Configuración descargada; verificando la voz…",
    "downloading-model": "Descargando modelo Piper…",
    "saving-config": "Guardando configuración validada…",
    "saving-model": "Guardando modelo verificado en el dispositivo…",
    "model-ready": "Modelo Piper verificado y guardado.",
    "checking-model": "Comprobando el modelo instalado…",
    "reading-model": "Leyendo el modelo desde el almacenamiento local…",
    "initializing-onnx": "Inicializando ONNX Runtime local (WASM/CPU)…",
    "creating-session": "Creando la sesión de inferencia…",
    ready: "Voz Piper preparada."
  })[event.stage] || (event.phase === "synthesis" ? "Generando audio Piper local…" : "Preparando Piper…");
}

function handleModelMessage(message) {
  if (message.type === "reader:model-progress") {
    const event = message.event;
    const isPiper = message.provider === "piper";
    if (isPiper && message.voiceId) {
      if (!acceptPiperOperationMessage(message)) return;
      const previous = piperStates.get(message.voiceId) || {};
      setPiperVoiceState(message.voiceId, {
        state: "loading",
        installed: previous.installed || event?.phase !== "download",
        phase: event?.phase || "initialize",
        stage: event?.stage || "",
        operationId: message.operationId || previous.operationId
      });
      if (!isSelectedPiperVoiceMessage(message.voiceId, ui.voice.value)) return;
      ui.downloadProgress.hidden = false;
      if (Number.isFinite(event?.progress)) ui.downloadProgress.value = event.progress;
      else ui.downloadProgress.removeAttribute("value");
      ui.modelStatus.textContent = Number.isFinite(event?.progress)
        ? `${piperStageLabel(event)} · ${Math.round(event.progress)}%`
        : piperStageLabel(event);
      updateVoiceProviderUI();
      return;
    }
    if (Number.isFinite(event?.progress)) {
      ui.downloadProgress.hidden = false;
      ui.downloadProgress.value = event.progress;
      ui.modelStatus.textContent = `Kokoro · ${event.file || event.voiceId || "modelo local"}: ${Math.round(event.progress)}%`;
      updateVoiceProviderUI();
    }
    return;
  }
  if (message.provider === "piper" && message.voiceId) {
    if (!acceptPiperOperationMessage(message)) return;
    const previous = piperStates.get(message.voiceId) || {};
    setPiperVoiceState(message.voiceId, {
      state: message.state,
      installed: message.state === "idle" ? false : message.state === "cached" || message.state === "ready" || previous.installed,
      phase: message.phase || "initialize",
      error: message.state === "error" ? message.message : "",
      errorCode: message.state === "error" ? message.code || "PIPER_WORKER_OPERATION_FAILED" : "",
      operationId: message.operationId || previous.operationId
    });
    if (isSelectedPiperVoiceMessage(message.voiceId, ui.voice.value)) {
      if (message.message) ui.modelStatus.textContent = message.message;
      ui.downloadProgress.hidden = true;
      updateVoiceProviderUI();
      renderPlayer(player.snapshot());
    }
    return;
  }
  if (message.state === "loading") {
    setKokoroModelState("loading");
    ui.modelStatus.textContent = message.message || "Kokoro se está cargando en el motor local.";
  } else if (message.state === "ready") {
    setKokoroModelState("ready");
    ui.modelStatus.textContent = message.message || "Motor Kokoro local listo.";
    ui.downloadProgress.hidden = true;
  } else if (message.state === "error") {
    setKokoroModelState("error");
    ui.modelStatus.textContent = showError(message, "model");
    ui.downloadProgress.hidden = true;
  }
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
  updateVoiceProviderUI();
  renderPlayer(player.snapshot());
}

function selectVoice(voiceId) {
  const selected = isLegacySystemVoiceId(voiceId) ? PIPER_DEFAULT_VOICE_ID : voiceId;
  if (selected && [...ui.voice.options].some((option) => option.value === selected)) ui.voice.value = selected;
  updateVoiceProviderUI();
}

async function refreshPiperModelStates() {
  try {
    const { voices = [] } = await withBoundedWait(
      player.listInstalledPiperModels(),
      MODEL_STATUS_CHECK_TIMEOUT_MS,
      "La comprobación de los modelos Piper tardó demasiado. Puedes reintentar la preparación desde esta sección."
    );
    for (const voice of voices) {
      setPiperVoiceState(voice.voiceId, {
        state: voice.state || (voice.reason ? "error" : voice.installed ? "cached" : "idle"),
        installed: Boolean(voice.installed),
        modelSizeBytes: voice.modelSizeBytes,
        error: voice.reason || ""
      });
    }
  } catch (error) {
    for (const voice of PIPER_VOICE_CATALOG) setPiperVoiceState(voice.id, { state: "error", installed: false, phase: "status", error: error.message || String(error) });
    ui.modelStatus.textContent = showError(error, "model");
  }
  updateVoiceProviderUI();
  renderPlayer(player.snapshot());
}

function updateTextInfo() {
  const text = ui.text.value;
  const segments = splitText(text);
  ui.count.textContent = `${text.length.toLocaleString()} caracteres`;
  ui.chunks.textContent = `${segments.length} ${segments.length === 1 ? "fragmento" : "fragmentos"}`;
  if (!currentSession || currentSession.sourceText !== text
      || (currentSession.voice || currentSession.voiceId) !== ui.voice.value) {
    const snapshot = player.snapshot();
    const loadedSession = player.session;
    const changesLoadedQueue = Boolean(loadedSession?.id && currentSession?.id === loadedSession.id
      && (loadedSession.sourceText !== text || (loadedSession.voice || loadedSession.voiceId) !== ui.voice.value));
    if (currentSession && !editingForked
        && (changesLoadedQueue || currentSession.status !== "text-ready" || currentSession.audioKeys?.some(Boolean)
          || ["playing", "paused", "interrupted", "completed", "error"].includes(snapshot.status)
          || Boolean(snapshot.currentAudioKey))) {
      currentSession = {
        id: makeId("session"), documentId: currentDocument?.id,
        sourceDocumentName: currentDocument?.name || "Texto pegado",
        sourceText: text, chunks: segments, selectedIndex: 0, position: 0,
        status: segments.length ? "text-ready" : "empty", ...voiceSessionFields(ui.voice.value),
        speed: Number(ui.speed.value), audioKeys: [], chunkStates: segments.map(() => "pending"),
        durations: segments.map(() => null), queuePrepared: false
      };
      editingForked = true;
    } else {
      currentSession = {
        ...(currentSession || {}),
        documentId: currentDocument?.id,
        sourceDocumentName: currentDocument?.name || "Texto pegado",
        sourceText: text,
        chunks: segments,
        selectedIndex: 0,
        position: 0,
        status: segments.length ? "text-ready" : "empty",
        ...voiceSessionFields(ui.voice.value),
        speed: Number(ui.speed.value),
        audioKeys: [], chunkStates: segments.map(() => "pending"),
        durations: segments.map(() => null), queuePrepared: false
      };
    }
    if (changesLoadedQueue && snapshot.activeKind !== "preview"
        && ["playing", "starting", "generating", "audio-ready"].includes(snapshot.status)
        && !staleQueueStopPending) {
      staleQueueStopPending = true;
      staleQueueStopPromise = player.stop().catch(showError).finally(() => {
        staleQueueStopPending = false;
        staleQueueStopPromise = null;
      });
      void staleQueueStopPromise;
    }
    if (hydrationComplete) queuePersistence(false);
  }
  updateQueueSyncUI();
  renderPlayer(player.snapshot());
}

function queuePersistence() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { void flushPersistence(); }, 250);
}

function flushPersistence() {
  clearTimeout(persistTimer);
  const text = ui.text.value;
  // An empty editor is an unsaved draft. It must never overwrite a saved
  // document or enqueue an empty session, but earlier valid writes still drain.
  if (!text.trim()) return persistenceChain;
  if (!currentDocument) currentDocument = { id: makeId("document"), name: "Texto pegado", type: "text" };
  if (!currentSession) currentSession = { id: makeId("session"), documentId: currentDocument.id, audioKeys: [] };
  if (!currentSession.id) currentSession = { ...currentSession, id: makeId("session") };
  const documentDraft = { ...currentDocument, text, extractionStatus: "ready" };
  const sessionDraft = {
    ...currentSession,
    id: currentSession.id || makeId("session"),
    documentId: currentDocument.id,
    sourceText: ui.text.value,
    sourceDocumentName: currentDocument.name || currentSession.sourceDocumentName || "Texto pegado",
    chunks: splitText(ui.text.value),
    voice: ui.voice.value,
    ...voiceSessionFields(ui.voice.value),
    speed: Number(ui.speed.value),
    queuePrepared: currentSession.queuePrepared !== false
      && currentSession.sourceText === text
      && (currentSession.voice || currentSession.voiceId) === ui.voice.value
  };
  const generation = selectionEpoch;
  persistenceChain = persistenceChain.then(async () => {
    if (generation !== selectionEpoch || currentDocument?.id !== documentDraft.id || currentSession?.id !== sessionDraft.id) return;
    const saved = await persistEditorSnapshot(repository, {
      document: documentDraft, session: sessionDraft, text: documentDraft.text,
      voice: sessionDraft.voice, speed: sessionDraft.speed
    });
    currentDocument = saved.document;
    currentSession = saved.session;
    await chrome.storage.local.set({ lastDocumentId: currentDocument.id, lastSessionId: currentSession.id });
    if (ui.library.open) await refreshLibrary();
    await refreshStorageUsage();
  }).catch((error) => {
    ui.fileStatus.textContent = showError(error, "storage");
  });
  return persistenceChain;
}

async function loadEditorToPlayer() {
  updateTextInfo();
  const text = String(ui.text.value ?? "");
  const chunks = splitText(text);
  const voice = ui.voice.value;
  if (!text.trim() || !chunks.length) {
    updateQueueSyncUI("Escribe o importa texto antes de cargarlo al reproductor.");
    return false;
  }
  if (queueLoadBusy || libraryMutationBusy) return false;

  let previousQueue = player.session ? { ...player.session } : null;
  let loadFailure = "";
  queueLoadBusy = true;
  setContentBusy(true);
  updateQueueSyncUI();
  try {
    if (staleQueueStopPromise) await staleQueueStopPromise;
    if (["playing", "starting", "generating", "audio-ready"].includes(player.snapshot().status)) {
      await player.stop();
    }
    previousQueue = player.session ? { ...player.session } : null;
    // Queue loading never downloads a model or synthesizes audio.
    await flushPersistence();
    const prepared = preparePlaybackQueue({
      editorSession: currentSession,
      loadedSession: player.session,
      text,
      chunks,
      voice,
      speed: Number(ui.speed.value),
      makeId,
      now: () => Date.now()
    });
    await player.replace(prepared);
    currentSession = player.session || prepared;
    editingForked = false;
    await chrome.storage.local.set({
      ...(currentDocument?.id ? { lastDocumentId: currentDocument.id } : {}),
      lastSessionId: currentSession.id
    });
    ui.queueSyncStatus.textContent = "Cola cargada · el primer audio local se generará al reproducir.";
    ui.queueSyncStatus.dataset.state = "current";
    if (ui.library.open) await refreshLibrary();
    await refreshStorageUsage();
    return true;
  } catch (error) {
    player.setSession(previousQueue);
    const message = showError(error, "playback");
    loadFailure = `No se pudo cargar la cola. ${message}`;
    return false;
  } finally {
    queueLoadBusy = false;
    setContentBusy(false);
    updateQueueSyncUI(loadFailure);
  }
}

async function startCurrentPlayback() {
  updateTextInfo();
  if (!playbackQueueMatchesEditor(player.session, { text: ui.text.value, voice: ui.voice.value })) {
    updateQueueSyncUI("Carga el texto actual al reproductor antes de iniciar la lectura.");
    return false;
  }
  const queue = player.session;
  const voice = queue.voice || queue.voiceId;
  const provider = getVoiceProvider(voice);
  const hasCachedAudio = Boolean(queue.audioKeys?.[player.snapshot().selectedIndex]);
  const state = controlsModelState(voice);
  if (!hasCachedAudio && state !== "ready") {
    if (provider === "piper" && !piperStates.get(voice)?.installed) {
      ui.modelStatus.textContent = "Descarga el modelo Piper seleccionado antes de iniciar la lectura.";
      updateVoiceProviderUI();
      return false;
    }
    if (provider === "kokoro" && !["idle", "cached"].includes(state)) return false;
    const initialized = provider === "piper" ? await initializePiperVoice(voice) : await initializeModel();
    if (!initialized || player.session?.id !== queue.id
        || !playbackQueueMatchesEditor(player.session, { text: ui.text.value, voice: ui.voice.value })) return false;
  }
  if (!playbackQueueMatchesEditor(player.session, { text: ui.text.value, voice: ui.voice.value })) return false;
  await player.play();
  return true;
}

async function refreshLibrary() {
  if (!ui.library.open) return;
  const requestId = ++libraryRefreshEpoch;
  const [documents, sessions] = await Promise.all([repository.listDocuments(), repository.listSessions()]);
  if (requestId !== libraryRefreshEpoch || !ui.library.open) return;
  savedDocuments = documents;
  savedSessions = sessions;
  const entries = buildLibraryEntries(savedDocuments, savedSessions);
  ui.libraryList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "library-empty hint";
    empty.textContent = "Todavía no hay documentos guardados.";
    ui.libraryList.append(empty);
  }
  const dateText = (value) => value ? new Date(value).toLocaleDateString("es-UY", { day: "2-digit", month: "2-digit", year: "numeric" }) : "fecha desconocida";
  const typeText = (type) => ({
    text: "Texto pegado", pdf: "PDF", docx: "DOCX", txt: "TXT", md: "Markdown", markdown: "Markdown",
    article: "Artículo web", "main-content": "Página web", "web-page": "Página web", "google-docs-visible": "Google Docs · páginas visibles",
    selection: "Selección web", combined: "Texto combinado", recovered: "Texto recuperado"
  })[type] || String(type || "Documento").toUpperCase();
  const sessionState = (status) => ({
    playing: "en reproducción", generating: "generando audio", "audio-ready": "audio listo", paused: "pausada",
    interrupted: "interrumpida", completed: "completada", error: "con error", stopped: "detenida", "text-ready": "lista para leer", empty: "vacía"
  })[status] || "guardada";
  const voiceName = (voice) => [...ui.voice.options].find((option) => option.value === voice)?.textContent?.trim() || voice || "voz predeterminada";
  const entryCard = ({ title, detail, active, openLabel, continueLabel, deleteLabel, onOpen, onContinue, onDelete, sessions: entrySessions }) => {
    const card = document.createElement("article");
    card.className = "library-entry";
    card.setAttribute("role", "listitem");
    if (active) card.dataset.active = "true";
    const content = document.createElement("div");
    content.className = "library-entry-content";
    const heading = document.createElement("strong");
    heading.className = "library-entry-title";
    heading.textContent = title;
    heading.title = title;
    const metadata = document.createElement("span");
    metadata.className = "library-entry-meta";
    metadata.textContent = detail;
    content.append(heading, metadata);
    const actions = document.createElement("div");
    actions.className = "library-entry-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "library-open";
    open.textContent = openLabel;
    open.addEventListener("click", onOpen);
    const proceed = document.createElement("button");
    proceed.type = "button";
    proceed.className = "library-open library-resume";
    proceed.textContent = continueLabel;
    proceed.addEventListener("click", onContinue);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "library-delete";
    remove.title = deleteLabel;
    remove.setAttribute("aria-label", deleteLabel);
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
    remove.addEventListener("click", onDelete);
    actions.append(open, proceed, remove);
    card.append(content, actions);

    if (entrySessions.length) {
      const details = document.createElement("details");
      details.className = "library-session-details";
      const summary = document.createElement("summary");
      summary.textContent = entrySessions.length === 1 ? "Detalles de lectura" : `${entrySessions.length} sesiones de lectura`;
      const sessionList = document.createElement("div");
      sessionList.className = "library-session-list";
      sessionList.setAttribute("role", "list");
      for (const session of entrySessions) {
        const sessionRow = document.createElement("div");
        sessionRow.className = "library-session-row";
        sessionRow.setAttribute("role", "listitem");
        const sessionMeta = document.createElement("span");
        const chunkCount = session.chunks?.length || 0;
        const fragment = chunkCount ? Math.min((session.selectedIndex || 0) + 1, chunkCount) : 0;
        const speed = `${Number(session.speed || 1).toLocaleString("es-UY", { maximumFractionDigits: 2 })}×`;
        sessionMeta.textContent = `${dateText(session.updatedAt || session.createdAt)} · ${sessionState(session.status)} · ${voiceName(session.voice)} · ${speed} · fragmento ${fragment}/${chunkCount} · ${formatTime(Number(session.position) || 0)}`;
        const sessionActions = document.createElement("div");
        sessionActions.className = "library-entry-actions";
        const resume = document.createElement("button");
        resume.type = "button";
        resume.className = "library-open library-resume";
        resume.textContent = "Reanudar";
        resume.addEventListener("click", () => { if (!libraryMutationBusy) void resumeLibrarySession(session, activateSession, startCurrentPlayback).catch(showError); });
        const deleteSession = document.createElement("button");
        deleteSession.type = "button";
        deleteSession.className = "library-delete";
        const sessionName = session.sourceDocumentName || title;
        deleteSession.title = `Eliminar sesión de lectura ${sessionName}`;
        deleteSession.setAttribute("aria-label", `Eliminar sesión de lectura ${sessionName}`);
        deleteSession.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
        deleteSession.addEventListener("click", () => { void deleteLibrarySession(session.id); });
        sessionActions.append(resume, deleteSession);
        sessionRow.append(sessionMeta, sessionActions);
        sessionList.append(sessionRow);
      }
      details.append(summary, sessionList);
      card.append(details);
    }
    return card;
  };

  for (const entry of entries) {
    const latestSession = entry.sessions[0] || null;
    const document = entry.document;
    const title = document?.name || latestSession?.sourceDocumentName || "Lectura recuperada";
    const text = document?.text ?? latestSession?.sourceText ?? "";
    const characters = text.length.toLocaleString();
    const active = Boolean((document && currentDocument?.id === document.id) || entry.sessions.some((session) => session.id === currentSession?.id));
    const matchingSession = libraryActionFor(entry, text) === "resume" ? latestSession : null;
    const sessionSummary = latestSession
      ? `${sessionState(latestSession.status)} · ${voiceName(latestSession.voice)} · ${Number(latestSession.speed || 1).toLocaleString("es-UY", { maximumFractionDigits: 2 })}× · fragmento ${latestSession.chunks?.length ? Math.min((latestSession.selectedIndex || 0) + 1, latestSession.chunks.length) : 0}/${latestSession.chunks?.length || 0} · ${formatTime(Number(latestSession.position) || 0)}`
      : "Sin sesión de lectura";
    const detail = `${typeText(document?.type || "recovered")} · ${characters} caracteres · ${dateText(document?.updatedAt || document?.importedAt || latestSession?.updatedAt)} · ${sessionSummary}${active ? " · Activo" : ""}`;
    const card = entryCard({
      title, detail, active,
      openLabel: active ? "Abierto" : "Abrir",
      continueLabel: matchingSession ? "Reanudar" : "Leer",
      deleteLabel: document
        ? `Eliminar documento ${title}; las sesiones se conservarán`
        : `Eliminar ${entry.sessions.length === 1 ? "sesión" : `${entry.sessions.length} sesiones`} recuperable(s) de ${title}`,
      sessions: entry.sessions,
      onOpen: () => {
        if (libraryMutationBusy) return;
        if (document) void openLibraryEntry(entry, (saved) => activateDocument(saved, null, false, { restoreSession: false }));
        else if (latestSession) void activateSession(latestSession);
      },
      onContinue: () => {
        if (libraryMutationBusy) return;
        if (matchingSession) void resumeLibrarySession(matchingSession, activateSession, startCurrentPlayback).catch(showError);
        else void (async () => {
          if (document) await activateDocument(document, null, false, { restoreSession: false });
          else if (latestSession) await activateSession(latestSession);
          if (await loadEditorToPlayer()) await startCurrentPlayback();
        })().catch(showError);
      },
      onDelete: (event) => {
        event.stopPropagation();
        if (document) void deleteLibraryDocument(document.id);
        else void deleteRecoveredLibraryEntry(entry);
      }
    });
    ui.libraryList.append(card);
  }
  const sessionCount = entries.reduce((sum, entry) => sum + entry.sessions.length, 0);
  ui.librarySummary.textContent = `${entries.length} entradas · ${sessionCount} ${sessionCount === 1 ? "sesión" : "sesiones"}`;
  for (const button of ui.library.querySelectorAll("button")) button.disabled = libraryMutationBusy;
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
    "google-docs-visible": "Google Docs · texto visible", "google-docs": "Google Docs",
    restricted: "pestaña restringida", "permission-required": "permiso temporal requerido",
    "local-pdf": "PDF local", "local-document": "archivo local"
  })[type] || type || "contenido de pestaña";
}

function sameTabDocument(left, right) {
  return Boolean(left && right
    && left.tabId === right.tabId
    && left.url === right.url
    && left.documentToken === right.documentToken);
}

function setImportStatus(message, state = "info") {
  const view = panelStatus.setImportStatus(message, state);
  ui.importStatus.textContent = view.import.message;
  ui.importStatus.dataset.state = view.import.state;
}

function applyActiveTabContext(context, following) {
  const previous = currentTabContext;
  const changed = previous && !sameTabDocument(previous, context);
  currentTabContext = context || null;
  if (typeof following === "boolean") ui.followActiveTab.checked = following;
  else if (typeof context?.following === "boolean") ui.followActiveTab.checked = context.following;

  const presentation = panelStatus.setTabContext(context).tab;
  ui.sourceCard.dataset.state = presentation.state;
  ui.activeTabTitle.textContent = presentation.title;
  ui.activeTabTitle.title = safeTabTitle(presentation.title, context?.url || "");
  ui.activeTabDomain.textContent = presentation.domain;
  ui.activeTabDomain.hidden = !presentation.domain;
  ui.activeTabDomain.title = presentation.domain;
  presentTabFavicon(context);
  ui.activeTabKind.textContent = presentation.contentType;
  ui.activeTabKind.dataset.state = presentation.state;
  ui.activeTabStatus.textContent = presentation.status;
  syncImportButtons();

  if (changed) {
    const discardedPreview = Boolean(pendingTabImport);
    const interruptedImport = tabImportBusy;
    activeImportOperation++;
    tabImportBusy = false;
    pendingAuthenticatedPdfContext = null;
    pendingTabImport = null;
    ui.importPreview.hidden = true;
    ui.importText.value = "";
    ui.retryAuthenticatedPdf.hidden = true;
    syncImportButtons();
    if (interruptedImport || discardedPreview) {
      const message = "La pestaña de origen cambió. Se descartó la importación pendiente; el editor y la sesión actual siguen intactos.";
      setImportStatus(message, "warning");
    }
  }
}

async function refreshActiveTabContext() {
  const response = await chrome.runtime.sendMessage({ target: "background", command: "get-active-tab-context" }).catch(() => null);
  if (response?.context) applyActiveTabContext(response.context, response.following);
  return response;
}



async function runTabImport(selectionOnly = false, { authenticatedPdf = false, expectedContext = null } = {}) {
  if (tabImportBusy || libraryMutationBusy) return;
  const operationId = ++activeImportOperation;
  const initialContext = expectedContext || currentTabContext;
  if (expectedContext && !sameTabDocument(expectedContext, currentTabContext)) {
    pendingAuthenticatedPdfContext = null;
    ui.retryAuthenticatedPdf.hidden = true;
    setImportStatus("La pestaña ya no es el PDF que originó el error. Vuelve a importar desde la pestaña deseada.", "warning");
    return;
  }
  const pdfSelection = selectionOnly && ["pdf", "local-pdf"].includes(initialContext?.state);
  // Keep the optional permission prompt inside the direct user click handler.
  const permissionRequest = pdfSelection ? null : requestSitePermissionFromClick(initialContext, chrome.permissions);
  tabImportBusy = true;
  pendingTabImport = null;
  pendingAuthenticatedPdfContext = null;
  ui.importPreview.hidden = true;
  setImportStatus("Extracción en curso…", "loading");
  syncImportButtons();
  ui.chooseSourceFile.hidden = true;
  ui.retryFileAccess.hidden = true;
  ui.retryAuthenticatedPdf.hidden = true;
  ui.chooseSourceFile.textContent = "Elegir archivo para importar";
  ui.chooseSourceFile.dataset.previewPdf = "false";
  try {
    if (!initialContext?.tabId || !initialContext.url || !initialContext.documentToken) {
      await refreshActiveTabContext();
      if (operationId === activeImportOperation) {
        setImportStatus("No se conoce la dirección actual. Activa «Seguir pestaña activa» o abre el lector desde la pestaña deseada y vuelve a intentarlo.", "warning");
      }
      return;
    }
    if (permissionRequest) {
      let granted = false;
      try { granted = await permissionRequest; } catch { granted = false; }
      if (operationId !== activeImportOperation) return;
      if (!granted) {
        setImportStatus("No se concedió permiso para este sitio. Sin esa autorización, Edge no permite extraer su contenido. Puedes copiar y pegar el texto.", "error");
        return;
      }
    }

    const latestResponse = await chrome.runtime.sendMessage({ target: "background", command: "get-active-tab-context" }).catch(() => null);
    if (operationId !== activeImportOperation) return;
    const latestContext = latestResponse?.context;
    if (!latestContext || !sameTabDocument(initialContext, latestContext)) {
      if (latestContext) applyActiveTabContext(latestContext, latestResponse.following);
      setImportStatus("La pestaña o el documento cambió antes de iniciar la extracción. Revisa el origen actual y vuelve a intentarlo.", "warning");
      return;
    }
    applyActiveTabContext(latestContext, latestResponse.following);
    let result = await chrome.runtime.sendMessage({
      target: "background", command: "extract-current-tab", selectionOnly,
      context: latestContext, operationId
    });
    if (operationId !== activeImportOperation || result?.operationId !== operationId) return;
    if (result?.state === "pdf-target" || result?.state === "local-pdf-target") {
      const localPdf = result.state === "local-pdf-target";
      setImportStatus(localPdf ? "PDF local detectado · intentando recuperar el archivo…" : "PDF detectado · extrayendo texto localmente…", "loading");
      const pdfTarget = result;
      const { importCurrentTab } = await import("./tab-import.js");
      result = await importCurrentTab({
        targetTab: pdfTarget.targetTab,
        fileAccessAllowed: localPdf && pdfTarget.fileAccessAllowed === true,
        selectionOnly: false,
        authenticatedPdf: authenticatedPdf && !localPdf,
        permissionsApi: chrome.permissions,
        validateTarget: authenticatedPdf && !localPdf ? async () => {
          if (operationId !== activeImportOperation) return { ok: false, state: "stale-context", message: "La operación ya no está activa. No se envió la solicitud autenticada." };
          const validation = await chrome.runtime.sendMessage({
            target: "background", command: "validate-current-import",
            context: pdfTarget.documentContext, operationId
          }).catch(() => ({ ok: false, state: "stale-context", message: "No se pudo confirmar la pestaña actual. No se envió la solicitud autenticada." }));
          return operationId === activeImportOperation
            ? validation
            : { ok: false, state: "stale-context", message: "La pestaña cambió durante la validación. No se envió la solicitud autenticada." };
        } : null,
        onStatus: ({ message }) => { if (message && operationId === activeImportOperation) setImportStatus(message); }
      });
      if (operationId !== activeImportOperation) return;
      if (result.ok) {
        const validation = await chrome.runtime.sendMessage({
          target: "background", command: "validate-current-import",
          context: pdfTarget.documentContext, operationId
        });
        if (operationId !== activeImportOperation) return;
        if (!validation?.ok) result = { ...validation, type: localPdf ? "local-pdf" : "pdf", title: localPdf ? "PDF local" : "PDF" };
      }
    }
    if (operationId !== activeImportOperation) return;
    if (!result.ok) {
      const details = [result.title, result.type ? tabImportTypeLabel(result.type) : "", result.sourceUrl].filter(Boolean);
      const message = `${details.length ? `${details.join(" · ")}\n` : ""}${result.message || "No se pudo extraer el contenido."}`;
      setImportStatus(message, "error");
      const { localPdfRecoveryActions, remotePdfRecoveryActions } = await import("./tab-import.js");
      const actions = localPdfRecoveryActions(result);
      const remoteActions = remotePdfRecoveryActions(result);
      ui.chooseSourceFile.hidden = !actions.selectPdf;
      ui.chooseSourceFile.textContent = actions.previewSelectedPdf ? "Seleccionar este PDF" : "Elegir archivo para importar";
      ui.chooseSourceFile.dataset.previewPdf = String(actions.previewSelectedPdf);
      ui.retryFileAccess.hidden = !actions.retryFileAccess;
      ui.retryAuthenticatedPdf.hidden = !remoteActions.retryWithSiteSession;
      pendingAuthenticatedPdfContext = remoteActions.retryWithSiteSession ? latestContext : null;
      return;
    }
    showTabImportPreview(result);
    setImportStatus(`Vista previa extraída · ${result.characters.toLocaleString()} caracteres · pendiente de confirmación.`, "preview");
  } catch (error) {
    if (operationId !== activeImportOperation) return;
    setImportStatus(showError(error, "import"), "error");
    ui.chooseSourceFile.hidden = false;
    ui.retryAuthenticatedPdf.hidden = true;
  } finally {
    if (operationId === activeImportOperation) {
      tabImportBusy = false;
      syncImportButtons();
    }
  }
}

function showTabImportPreview(result) {
  pendingTabImport = result;
  ui.importText.value = result.text;
  const source = result.sourceUrl || "Origen local o no expuesto";
  const clipped = result.truncated ? " · limitado a 200.000 caracteres" : "";
  const coverage = result.coverage === "visible-pages" ? " · solo páginas visibles accesibles" : "";
  const frames = result.inaccessibleFrameCount ? ` · ${result.inaccessibleFrameCount} frame(s) no accesible(s)` : "";
  ui.importMeta.textContent = `${result.title || "Pestaña actual"} · ${tabImportTypeLabel(result.type)} · ${Number(result.characters ?? result.text.length).toLocaleString()} caracteres${clipped}${coverage}${frames}\n${source}`;
  setImportStatus(result.message || "Vista previa lista. Confirma si quieres reemplazar o añadir el texto.", "preview");
  ui.importPreview.hidden = false;
  ui.chooseSourceFile.hidden = true;
  ui.retryFileAccess.hidden = true;
  ui.retryAuthenticatedPdf.hidden = true;
  pendingAuthenticatedPdfContext = null;
  ui.chooseSourceFile.dataset.previewPdf = "false";
}

async function acceptTabImport(mode) {
  if (libraryMutationBusy) return;
  const imported = pendingTabImport;
  if (!imported?.text) return;
  const { combineImportedText } = await import("./tab-import.js");
  const previousText = ui.text.value;
  const append = mode === "append";
  if (!append && previousText.trim() && !confirm("Reemplazar el texto del editor? El documento y las sesiones anteriores seguirán guardados.")) {
    setImportStatus("Importación cancelada. El contenido del editor sigue intacto.", "cancelled");
    return;
  }
  const maxLength = Number(ui.text.maxLength) || 200_000;
  let merged = combineImportedText(previousText, imported.text, mode, { maxCharacters: maxLength });
  if (merged.confirmationRequired) {
    if (!confirm(`${merged.message} Añadirlo de todos modos?`)) {
      setImportStatus("Adición cancelada. El contenido del editor sigue intacto.", "cancelled");
      return;
    }
    merged = combineImportedText(previousText, imported.text, mode, { maxCharacters: maxLength, allowDuplicate: true });
  }
  if (!merged.ok) {
    setImportStatus(`${merged.message} No se cambió el contenido.`, "warning");
    return;
  }
  if (!merged.text.trim()) {
    setImportStatus("La importación no contiene texto. No se creó un documento vacío.", "warning");
    return;
  }
  if (libraryMutationBusy) return;
  libraryMutationBusy = true;
  setContentBusy(true);
  const finalText = merged.text;
  let document;
  let session;
  try {
    await flushPersistence();
    // A valid editor snapshot is persisted by flushPersistence; an empty draft
    // intentionally has no document or session to write here.
    await suspendCurrentReadForSwitch();
    selectionEpoch++;
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
        id: makeId("session"), documentId: document.id, sourceDocumentName: document.name, sourceText: finalText, chunks: splitText(finalText),
        selectedIndex: 0, position: 0, status: "text-ready", voice: ui.voice.value,
        speed: Number(ui.speed.value), audioKeys: [], queuePrepared: false
      });
    } catch (error) {
      await repository.deleteDocument(document.id).catch(() => {});
      throw error;
    }

    currentDocument = document;
    currentSession = session;
    editingForked = false;
    ui.text.value = finalText;
    ui.fileStatus.textContent = `${document.name} · ${finalText.length.toLocaleString()} caracteres · guardado localmente.`;
    player.setSession(null);
    hydrationComplete = true;
    updateTextInfo();
    pendingTabImport = null;
    ui.importPreview.hidden = true;
    setImportStatus(`${append ? "Contenido añadido" : "Contenido reemplazado"} · ${imported.text.length.toLocaleString()} caracteres importados · ${currentSession.chunks.length} fragmentos. El texto ya está en el editor.`, "success");
    try {
      await chrome.storage.local.set({ lastDocumentId: currentDocument.id, lastSessionId: currentSession.id });
      if (ui.library.open) await refreshLibrary();
      await refreshStorageUsage();
    } catch (error) {
      const message = showError(error, "storage");
      ui.fileStatus.textContent = `Contenido importado y guardado; una preferencia local no se actualizó. ${message}`;
    }
  } catch (error) {
    setImportStatus(showError(error, "storage"), "error");
    return;
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    if (ui.library.open) await refreshLibrary();
  }
}

async function refreshModelCacheState() {
  let modelCached = false;
  try {
    const names = await caches.keys();
    modelCached = names.includes("edge-local-reader-kokoro-v1");
  } catch {
    // Cache Storage may be unavailable in restricted profiles; the explicit load action can report it.
  }

  try {
    const status = await withBoundedWait(
      player.voicePreparationStatus("af_heart"),
      MODEL_STATUS_CHECK_TIMEOUT_MS,
      "La comprobación del estado de Kokoro tardó demasiado. Puedes reintentar la preparación desde esta sección."
    );
    const state = status.state === "idle" && modelCached ? "cached" : status.state || (modelCached ? "cached" : "idle");
    setKokoroModelState(state);
    if (state === "cached") ui.modelStatus.textContent = "Modelo local encontrado en caché; Kokoro se cargará cuando lo necesites.";
    else if (state === "ready") ui.modelStatus.textContent = "Kokoro ya está preparado en el motor local.";
  } catch (error) {
    setKokoroModelState("error");
    ui.modelStatus.textContent = showError(error, "model");
  }
  renderPlayer(player.snapshot());
}

async function installPiperModel(voiceId = ui.voice.value) {
  const existingTask = piperInstallPromises.get(voiceId);
  if (existingTask) return existingTask;
  const voice = getVoiceRecord(voiceId);
  if (voice.provider !== "piper") return false;
  const previous = piperStates.get(voiceId) || {};
  const operationId = beginPiperOperation(voiceId, { state: "loading", phase: "download", installed: Boolean(previous.installed), error: "", errorCode: "" });
  if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
    ui.modelStatus.textContent = `Descargando el modelo oficial ${voice.label}.`;
    ui.downloadProgress.hidden = false;
    ui.downloadProgress.removeAttribute("value");
    updateVoiceProviderUI();
    renderPlayer(player.snapshot());
  }
  const task = player.installPiperModel(voiceId, operationId).then((result) => {
    setPiperVoiceState(voiceId, { state: "cached", phase: "download", installed: true, error: "", errorCode: "", operationId });
    if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
      ui.modelStatus.textContent = `Modelo Piper descargado y verificado · ${voice.label}. Pulsa «Probar voz» para inicializarlo y escuchar una muestra, o «Preparar voz Piper» para dejarlo listo.`;
      ui.downloadProgress.hidden = true;
      updateVoiceProviderUI();
      renderPlayer(player.snapshot());
    }
    return Boolean(result?.installed);
  }).catch((error) => {
    setPiperVoiceState(voiceId, { state: "error", phase: error.phase || "download", installed: Boolean(previous.installed), error: error.message || String(error), errorCode: error.code || "PIPER_DOWNLOAD_FAILED", operationId });
    if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
      ui.modelStatus.textContent = showError(error, "model");
      ui.downloadProgress.hidden = true;
      updateVoiceProviderUI();
      renderPlayer(player.snapshot());
    }
    return false;
  }).finally(() => piperInstallPromises.delete(voiceId));
  piperInstallPromises.set(voiceId, task);
  return task;
}

async function initializePiperVoice(voiceId = ui.voice.value) {
  const voice = getVoiceRecord(voiceId);
  if (voice.provider !== "piper") return false;
  const state = piperStates.get(voiceId);
  if (!state?.installed) {
    if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
      ui.modelStatus.textContent = `Descarga primero ${voice.label}; la descarga es manual y no comienza al cargar el texto.`;
      updateVoiceProviderUI();
    }
    return false;
  }
  const operationId = beginPiperOperation(voiceId, { state: "loading", phase: "initialize", error: "", errorCode: "" });
  if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
    ui.modelStatus.textContent = `Inicializando ${voice.label} en el motor local.`;
    ui.downloadProgress.hidden = false;
    ui.downloadProgress.removeAttribute("value");
    updateVoiceProviderUI();
    renderPlayer(player.snapshot());
  }
  try {
    await player.initialize(voiceId, operationId);
    setPiperVoiceState(voiceId, { state: "ready", phase: "initialize", installed: true, error: "", errorCode: "", operationId });
    if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
      ui.modelStatus.textContent = `Voz lista · ${voice.label}. El audio WAV se generará al reproducir.`;
      ui.downloadProgress.hidden = true;
      updateVoiceProviderUI();
      renderPlayer(player.snapshot());
    }
    return true;
  } catch (error) {
    setPiperVoiceState(voiceId, { state: "error", phase: error.phase || "initialize", installed: true, error: error.message || String(error), errorCode: error.code || "PIPER_INITIALIZATION_FAILED", operationId });
    if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
      ui.modelStatus.textContent = showError(error, "model");
      ui.downloadProgress.hidden = true;
      updateVoiceProviderUI();
      renderPlayer(player.snapshot());
    }
    return false;
  }
}

async function resetPiperEngine(voiceId = ui.voice.value) {
  const voice = getVoiceRecord(voiceId);
  if (voice.provider !== "piper") return false;
  try {
    await player.resetPiperEngine(voiceId);
    const previous = piperStates.get(voiceId) || {};
    retirePiperOperation(voiceId, previous.operationId);
    setPiperVoiceState(voiceId, {
      state: previous.installed ? "cached" : "idle",
      phase: "initialize",
      installed: Boolean(previous.installed),
      operationId: "",
      error: "",
      errorCode: ""
    });
    if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) {
      ui.modelStatus.textContent = `Motor Piper restablecido. El modelo local ${previous.installed ? "se conservó" : "no se había instalado"}; puedes volver a intentarlo.`;
      ui.downloadProgress.hidden = true;
      updateVoiceProviderUI();
      renderPlayer(player.snapshot());
    }
    return true;
  } catch (error) {
    if (isSelectedPiperVoiceMessage(voiceId, ui.voice.value)) ui.modelStatus.textContent = showError(error, "model");
    return false;
  }
}

async function handleInstallAction() {
  const voiceId = ui.voice.value;
  if (getVoiceProvider(voiceId) === "piper") {
    return piperStates.get(voiceId)?.installed ? initializePiperVoice(voiceId) : installPiperModel(voiceId);
  }
  return initializeModel();
}

async function initializeModel(voiceId = ui.voice.value) {
  if (getVoiceProvider(voiceId) !== "kokoro") return false;
  if (initializationPromise) return initializationPromise;
  setKokoroModelState("loading");
  ui.modelStatus.textContent = "Cargando Kokoro y sus recursos locales bajo demanda.";
  ui.downloadProgress.hidden = false;
  ui.downloadProgress.removeAttribute("value");
  updateVoiceProviderUI();
  renderPlayer(player.snapshot());

  initializationPromise = (async () => {
    const result = await attemptInitialization(
      () => player.initialize(voiceId),
      (state) => {
        if (state === "loading" || state === "error") setKokoroModelState(state);
        updateVoiceProviderUI();
      }
    );
    if (!result.ok) throw result.error;
    setKokoroModelState("ready");
    await chrome.storage.local.set({ modelCached: true });
    ui.modelStatus.textContent = "Modelo Kokoro preparado. Los WAV ingleses se guardan y exportan desde este dispositivo.";
    ui.downloadProgress.hidden = true;
    updateVoiceProviderUI();
    renderPlayer(player.snapshot());
    return true;
  })().catch((error) => {
    setKokoroModelState("error");
    ui.modelStatus.textContent = showError(error, "model");
    ui.downloadProgress.hidden = true;
    updateVoiceProviderUI();
    renderPlayer(player.snapshot());
    return false;
  }).finally(() => {
    initializationPromise = null;
    updateVoiceProviderUI();
  });
  return initializationPromise;
}

async function suspendCurrentReadForSwitch() {
  const status = player.snapshot().status;
  if (["playing", "starting"].includes(status)) await player.pause().catch(() => {});
  else if (["generating", "audio-ready"].includes(status)) await player.stop().catch(() => {});
}

async function createNewDraft() {
  await flushPersistence();
  await suspendCurrentReadForSwitch();
  selectionEpoch++;
  currentDocument = null;
  currentSession = {
    id: null, documentId: null, sourceDocumentName: "Texto pegado", sourceText: "", chunks: [], selectedIndex: 0,
    position: 0, status: "empty", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: [], queuePrepared: false
  };
  editingForked = false;
  ui.text.value = "";
  ui.fileStatus.textContent = "Editor vacío; los documentos anteriores siguen guardados.";
  player.setSession(null);
  await chrome.storage.local.remove(["lastDocumentId", "lastSessionId"]);
  hydrationComplete = true;
  if (ui.library.open) await refreshLibrary();
  updateTextInfo();
}

async function activateDocument(document, preferredSessionId = null, internal = false, { restoreSession = true, skipFlush = false } = {}) {
  if (libraryMutationBusy && !internal) return;
  if (!internal) { libraryMutationBusy = true; setContentBusy(true); }
  try {
  if (!skipFlush) await flushPersistence();
  await suspendCurrentReadForSwitch();
  selectionEpoch++;
  currentDocument = document;
  const sessions = await repository.listSessions(document.id);
  const savedSession = restoreSession
    ? sessions.find((item) => item.id === preferredSessionId) || sessions[0] || null
    : null;
  const editorText = restoreSession ? (savedSession?.sourceText ?? document.text) : document.text;
  const canUseSavedSession = savedSession && savedSession.sourceText === editorText;
  currentSession = canUseSavedSession ? savedSession : {
    id: null, documentId: document.id, sourceDocumentName: document.name, sourceText: editorText, chunks: splitText(editorText),
    selectedIndex: 0, position: 0, status: editorText.trim() ? "text-ready" : "empty",
    voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: [], queuePrepared: false
  };
  editingForked = false;
  ui.text.value = editorText;
  selectVoice(currentSession.voiceId || currentSession.voice);
  if (currentSession.speed && [...ui.speed.options].some((option) => Number(option.value) === Number(currentSession.speed))) ui.speed.value = String(currentSession.speed);
  ui.fileStatus.textContent = document.name ? `Documento guardado · ${document.name}` : "Texto local recuperado.";
  const preference = { lastDocumentId: document.id };
  if (currentSession.id) preference.lastSessionId = currentSession.id;
  else await chrome.storage.local.remove("lastSessionId");
  await chrome.storage.local.set(preference);
  hydrationComplete = true;
  if (currentSession.id && currentSession.queuePrepared !== false && currentSession.chunks?.length) {
    await player.connect(currentSession);
  } else {
    player.setSession(null);
  }
  updateTextInfo();
  modelManagementDisclosure.onVoiceSelection(ui.voice.value);
  if (ui.library.open) await refreshLibrary();
  await refreshStorageUsage();
  } finally {
    if (!internal) {
      libraryMutationBusy = false;
      setContentBusy(false);
      if (ui.library.open) await refreshLibrary();
    }
  }
}

async function activateSession(session, internal = false, { skipFlush = false } = {}) {
  if (libraryMutationBusy && !internal) return;
  if (!internal) { libraryMutationBusy = true; setContentBusy(true); }
  try {
  if (!skipFlush) await flushPersistence();
  await suspendCurrentReadForSwitch();
  selectionEpoch++;
  let selected = { ...(await repository.getSession(session.id)) || session };
  let document = selected.documentId ? await repository.getDocument(selected.documentId) : null;
  if (!document) {
    const recoveredName = selected.sourceDocumentName || "Lectura recuperada";
    if (String(selected.sourceText || "").trim()) {
      document = await repository.saveDocument({
        id: makeId("document"), name: `Recuperado · ${recoveredName}`.slice(0, 180), type: "recovered",
        text: selected.sourceText, extractionStatus: "ready"
      });
      selected = await repository.saveSession({ ...selected, documentId: document.id, sourceDocumentName: recoveredName, documentDeletedAt: null });
    } else {
      selected = { ...selected, documentId: null };
    }
  }
  const sessionText = String(selected.sourceText || document?.text || "");
  if (sessionText.trim()) {
    const preparedSession = preparePlaybackQueue({
      editorSession: selected,
      loadedSession: null,
      text: sessionText,
      chunks: splitText(sessionText),
      voice: selected.voice || selected.voiceId || ui.voice.value,
      speed: Number(selected.speed) || Number(ui.speed.value),
      makeId,
      now: () => Date.now()
    });
    selected = {
      ...preparedSession,
      status: selected.queuePrepared === false ? "text-ready" : selected.status || "text-ready"
    };
    selected = await repository.saveSession(selected);
  } else {
    selected = { ...selected, queuePrepared: false };
  }
  currentDocument = document;
  currentSession = selected;
  editingForked = false;
  ui.text.value = selected.sourceText || document?.text || "";
  selectVoice(selected.voiceId || selected.voice);
  if ([...ui.speed.options].some((option) => Number(option.value) === Number(selected.speed))) ui.speed.value = String(selected.speed);
  ui.fileStatus.textContent = `Sesión recuperada · ${selected.sourceDocumentName || document?.name || "lectura guardada"}`;
  if (document) await chrome.storage.local.set({ lastDocumentId: document.id, lastSessionId: currentSession.id });
  else {
    await chrome.storage.local.remove("lastDocumentId");
    await chrome.storage.local.set({ lastSessionId: currentSession.id });
  }
  hydrationComplete = true;
  if (currentSession.queuePrepared !== false && currentSession.chunks?.length) {
    await player.connect(currentSession);
  } else {
    player.setSession(null);
  }
  updateTextInfo();
  modelManagementDisclosure.onVoiceSelection(ui.voice.value);
  if (ui.library.open) await refreshLibrary();
  } finally {
    if (!internal) {
      libraryMutationBusy = false;
      setContentBusy(false);
      if (ui.library.open) await refreshLibrary();
    }
  }
}

async function deleteLibraryDocument(documentId) {
  if (libraryMutationBusy) return;
  let document;
  let dependentSessions;
  try {
    document = await repository.getDocument(documentId);
    if (!document) { if (ui.library.open) await refreshLibrary(); return false; }
    dependentSessions = await repository.listSessions(documentId);
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    return false;
  }

  try {
    return await confirmDestructiveAction({
      ...documentDeleteConfirmation(document, dependentSessions),
      busyLabel: "Eliminando…",
      failureMessage: "No se pudo completar la eliminación. Revisa el estado de la biblioteca e inténtalo de nuevo.",
      onConfirm: () => performLibraryDocumentDelete(documentId, document, dependentSessions),
      onError: (error) => {
        ui.libraryStatus.textContent = showError(error, "library");
        return ui.libraryStatus.textContent;
      }
    });
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    return false;
  }
}

async function performLibraryDocumentDelete(documentId, document, dependentSessions) {
  if (libraryMutationBusy) return false;

  libraryMutationBusy = true;
  setContentBusy(true);
  libraryRefreshEpoch++;
  const wasActive = currentDocument?.id === documentId;
  const previousQueue = player.session ? { ...player.session } : null;
  const wasLoadedQueue = dependentSessions.some((session) => session.id === previousQueue?.id);
  if (wasActive) selectionEpoch++;
  const previousDocument = currentDocument;
  const previousSession = currentSession;
  let documentDeleted = false;
  try {
    if (wasActive) {
      fileReadId++;
      ui.text.disabled = true;
      ui.file.disabled = true;
      ui.chooseSourceFile.disabled = true;
      await flushPersistence();
      clearTimeout(persistTimer);
      currentDocument = null;
      currentSession = null;
      ui.text.value = "";
      player.setSession(null);
    }
    await Promise.all(dependentSessions.map((session) => player.forgetSession(session.id, true)));
    if (wasLoadedQueue && !wasActive) player.setSession(null);
    documentDeleted = await repository.deleteDocument(documentId);
    if (!documentDeleted) throw new Error("El documento ya no existe en la biblioteca local.");
    if (wasActive) {
      await chrome.storage.local.remove(["lastDocumentId", "lastSessionId"]);
      const nextDocument = (await repository.listDocuments())[0];
      if (nextDocument) await activateDocument(nextDocument, null, true, { skipFlush: true });
      else await createNewDraft();
      ui.fileStatus.textContent = `Documento “${document.name}” eliminado. Las sesiones asociadas se conservaron.`;
    }
    ui.libraryStatus.textContent = `Documento “${document.name}” eliminado.`;
    await refreshStorageUsage();
    return true;
  } catch (error) {
    if (wasActive && !documentDeleted) {
      currentDocument = previousDocument;
      currentSession = previousSession;
      if (previousQueue?.id && previousQueue.id !== currentSession?.id && previousQueue.queuePrepared !== false) {
        await player.connect(previousQueue).catch(() => {});
      } else if (currentSession?.id && currentSession.queuePrepared !== false) await player.connect(currentSession).catch(() => {});
      else player.setSession(null);
    } else if (!documentDeleted && wasLoadedQueue && previousQueue?.queuePrepared !== false) {
      await player.connect(previousQueue).catch(() => {});
    } else if (wasActive) {
      currentDocument = null;
      currentSession = null;
      ui.text.value = "";
      await chrome.storage.local.remove(["lastDocumentId", "lastSessionId"]).catch(() => {});
      try {
        const nextDocument = (await repository.listDocuments())[0];
        if (nextDocument) await activateDocument(nextDocument, null, true, { skipFlush: true });
        else await createNewDraft();
      } catch { player.setSession(null); }
      ui.fileStatus.textContent = `Documento “${document.name}” eliminado; hubo un problema al actualizar la selección.`;
    }
    ui.libraryStatus.textContent = showError(error, "library");
    return documentDeleted;
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    ui.text.disabled = false;
    ui.file.disabled = false;
    ui.chooseSourceFile.disabled = false;
    if (ui.library.open) {
      try { await refreshLibrary(); } catch (error) { ui.libraryStatus.textContent = showError(error, "library"); }
    }
  }
}

async function deleteLibrarySession(sessionId) {
  if (libraryMutationBusy) return;
  let session;
  try {
    session = await repository.getSession(sessionId);
    if (!session) { if (ui.library.open) await refreshLibrary(); return false; }
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    return false;
  }

  try {
    return await confirmDestructiveAction({
      ...sessionDeleteConfirmation(session),
      busyLabel: "Eliminando…",
      failureMessage: "No se pudo completar la eliminación. Revisa el estado de la biblioteca e inténtalo de nuevo.",
      onConfirm: () => performLibrarySessionDelete(sessionId, session),
      onError: (error) => {
        ui.libraryStatus.textContent = showError(error, "library");
        return ui.libraryStatus.textContent;
      }
    });
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    return false;
  }
}

async function performLibrarySessionDelete(sessionId, session) {
  if (libraryMutationBusy) return false;

  libraryMutationBusy = true;
  setContentBusy(true);
  libraryRefreshEpoch++;
  const wasActive = currentSession?.id === sessionId;
  const wasLoadedQueue = player.session?.id === sessionId;
  if (wasActive) selectionEpoch++;
  const document = currentDocument;
  const editorText = ui.text.value;
  const name = session.sourceDocumentName || session.sourceText?.trim().slice(0, 48) || "Texto pegado";
  let sessionDeleted = false;
  if (wasActive) ui.text.disabled = true;
  if (wasLoadedQueue) player.setSession(null);
  try {
    if (wasActive) {
      await flushPersistence();
      clearTimeout(persistTimer);
      currentSession = null;
    }
    await player.forgetSession(sessionId, false);
    await repository.deleteSession(sessionId);
    sessionDeleted = true;
    if (wasActive && document) {
      const nextSession = (await repository.listSessions(document.id))[0];
      if (nextSession) await activateSession(nextSession, true, { skipFlush: true });
      else if (editorText.trim()) {
        currentSession = {
          id: null, documentId: document.id, sourceDocumentName: document.name,
          sourceText: editorText, chunks: splitText(editorText), selectedIndex: 0, position: 0,
          status: "text-ready", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: [], queuePrepared: false
        };
        if (wasLoadedQueue) player.setSession(null);
        await chrome.storage.local.remove("lastSessionId");
      } else {
        currentSession = { id: null, documentId: document.id, sourceDocumentName: document.name, sourceText: "", chunks: [], selectedIndex: 0, position: 0, status: "empty", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: [], queuePrepared: false };
        if (wasLoadedQueue) player.setSession(null);
        await chrome.storage.local.remove("lastSessionId");
      }
    } else if (wasActive) {
      currentSession = null;
      await chrome.storage.local.remove("lastSessionId");
    }
    ui.libraryStatus.textContent = `Sesión “${name}” eliminada. Los audios compartidos y el modelo se conservaron.`;
    await refreshStorageUsage();
    return true;
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    if (wasActive) {
      currentSession = await repository.getSession(sessionId).catch(() => null);
      if (currentSession) {
        if (wasLoadedQueue && currentSession.queuePrepared !== false) await player.connect(currentSession).catch(() => {});
        else if (wasLoadedQueue) player.setSession(null);
      }
    } else if (wasLoadedQueue) {
      const restoreQueue = await repository.getSession(sessionId).catch(() => null);
      if (restoreQueue?.id && restoreQueue.queuePrepared !== false) await player.connect(restoreQueue).catch(() => {});
    }
    return sessionDeleted;
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    ui.text.disabled = false;
    if (ui.library.open) {
      try { await refreshLibrary(); } catch (error) { ui.libraryStatus.textContent = showError(error, "library"); }
    }
  }
}

async function deleteRecoveredLibraryEntry(entry) {
  if (libraryMutationBusy || !entry?.sessions?.length) return;
  const sessions = [...entry.sessions];
  try {
    return await confirmDestructiveAction({
      ...recoveredSessionsDeleteConfirmation(sessions),
      busyLabel: "Eliminando…",
      failureMessage: "No se pudo completar la eliminación. Revisa el estado de la biblioteca e inténtalo de nuevo.",
      onConfirm: () => performRecoveredLibrarySessionsDelete(sessions),
      onError: (error) => {
        ui.libraryStatus.textContent = showError(error, "library");
        return ui.libraryStatus.textContent;
      }
    });
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    return false;
  }
}

async function performRecoveredLibrarySessionsDelete(sessions) {
  if (libraryMutationBusy || !sessions.length) return false;
  libraryMutationBusy = true;
  setContentBusy(true);
  libraryRefreshEpoch++;
  const deletedIds = new Set(sessions.map((session) => session.id));
  const wasActive = deletedIds.has(currentSession?.id);
  const wasLoadedQueue = deletedIds.has(player.session?.id);
  const editorText = ui.text.value;
  let deletedCount = 0;
  if (wasActive) selectionEpoch++;
  if (wasActive) ui.text.disabled = true;
  if (wasLoadedQueue) player.setSession(null);
  try {
    if (wasActive) {
      await flushPersistence();
      clearTimeout(persistTimer);
      currentSession = null;
    }
    for (const session of sessions) {
      await player.forgetSession(session.id, false);
      await repository.deleteSession(session.id);
      deletedCount++;
    }
    if (wasActive) {
      if (currentDocument && editorText.trim()) {
        currentSession = { id: null, documentId: currentDocument.id, sourceDocumentName: currentDocument.name, sourceText: editorText, chunks: splitText(editorText), selectedIndex: 0, position: 0, status: "text-ready", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: [], queuePrepared: false };
        await chrome.storage.local.remove("lastSessionId");
      } else {
        currentSession = null;
        await chrome.storage.local.remove("lastSessionId");
      }
    }
    ui.libraryStatus.textContent = `${sessions.length === 1 ? "Sesión recuperada eliminada" : `${sessions.length} sesiones recuperadas eliminadas`}. Los audios compartidos y el modelo se conservaron.`;
    await refreshStorageUsage();
    return true;
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    if (wasLoadedQueue) {
      for (const session of sessions) {
        const restoreQueue = await repository.getSession(session.id).catch(() => null);
        if (restoreQueue?.id && restoreQueue.queuePrepared !== false) {
          await player.connect(restoreQueue).catch(() => {});
          break;
        }
      }
    }
    return deletedCount === sessions.length;
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    ui.text.disabled = false;
    if (ui.library.open) {
      try { await refreshLibrary(); } catch (error) { ui.libraryStatus.textContent = showError(error, "library"); }
    }
  }
}

async function boot() {
  await repository.cleanEmptyDocuments();
  await refreshPiperModelStates();
  const preferences = await chrome.storage.local.get(["lastDocumentId", "lastSessionId", "lastVoice", "speed"]);
  if (preferences.lastVoice) {
    selectVoice(preferences.lastVoice);
    if (isLegacySystemVoiceId(preferences.lastVoice)) await chrome.storage.local.set({ lastVoice: PIPER_DEFAULT_VOICE_ID });
  }
  if (preferences.speed && [...ui.speed.options].some((option) => Number(option.value) === Number(preferences.speed))) ui.speed.value = String(preferences.speed);
  const preferredSession = preferences.lastSessionId ? await repository.getSession(preferences.lastSessionId) : null;
  currentDocument = preferences.lastDocumentId ? await repository.getDocument(preferences.lastDocumentId) : null;
  if (!currentDocument && preferredSession) {
    await activateSession(preferredSession);
    await refreshModelCacheState();
    modelManagementDisclosure.onVoiceSelection(ui.voice.value);
    if (currentSession?.voiceMigrationNotice) ui.fileStatus.textContent = currentSession.voiceMigrationNotice;
    await refreshActiveTabContext();
    const pending = await chrome.runtime.sendMessage({ target: "background", command: "take-pending-selection" }).catch(() => null);
    if (pending?.selection) handlePendingSelection(pending.selection);
    return;
  }
  if (!currentDocument) currentDocument = (await repository.listDocuments())[0] || null;
  if (!currentDocument) await createNewDraft();
  else await activateDocument(currentDocument, preferences.lastSessionId, false, { restoreSession: true });
  await refreshModelCacheState();
  modelManagementDisclosure.onVoiceSelection(ui.voice.value);
  if (currentSession?.voiceMigrationNotice) ui.fileStatus.textContent = currentSession.voiceMigrationNotice;
  await refreshActiveTabContext();
  const pending = await chrome.runtime.sendMessage({ target: "background", command: "take-pending-selection" }).catch(() => null);
  if (pending?.selection) handlePendingSelection(pending.selection);
}

ui.text.addEventListener("input", () => {
  fileReadId++;
  updateTextInfo();
});

ui.clearText.addEventListener("click", async () => {
  if (libraryMutationBusy) return;
  if (ui.text.value && !confirm("Vaciar el editor y crear un borrador nuevo? El documento y las sesiones guardadas se conservarán en la biblioteca.")) return;
  libraryMutationBusy = true;
  setContentBusy(true);
  fileReadId++;
  try {
    await createNewDraft();
  } catch (error) {
    showError(error);
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    if (ui.library.open) await refreshLibrary();
  }
});

ui.library.addEventListener("toggle", () => { if (ui.library.open) void refreshLibrary(); });
ui.drop.addEventListener("click", (event) => {
  if (!event.isTrusted) return;
  fileSelectionPurpose = "document";
  ui.file.accept = DOCUMENT_FILE_ACCEPT;
});
ui.chooseSourceFile.addEventListener("click", () => {
  const previewPdf = ui.chooseSourceFile.dataset.previewPdf === "true";
  fileSelectionPurpose = previewPdf ? "local-pdf-preview" : "document";
  ui.file.accept = previewPdf ? ".pdf,application/pdf" : DOCUMENT_FILE_ACCEPT;
  ui.file.click();
});
ui.retryFileAccess.addEventListener("click", () => { void runTabImport(false); });
ui.retryAuthenticatedPdf.addEventListener("click", () => {
  const expectedContext = pendingAuthenticatedPdfContext;
  if (!expectedContext) return;
  void runTabImport(false, { authenticatedPdf: true, expectedContext });
});

function handlePendingSelection(selection) {
  if (!selection?.id || selection.id === lastPendingSelectionId) return;
  lastPendingSelectionId = selection.id;
  const text = String(selection.text || "");
  if (!text.trim()) {
    setImportStatus("El menú contextual no recibió texto seleccionado. Selecciona texto y vuelve a usar ‘Enviar selección al lector local’.", "error");
    return;
  }
  showTabImportPreview({
    ok: true, title: selection.title || "Selección de pestaña", sourceUrl: selection.sourceUrl || "",
    type: "selection", coverage: "selection", text, characters: text.length,
    truncated: Boolean(selection.truncated), message: "Selección recibida mediante el menú contextual. Revisa el texto antes de importarlo."
  });
}

let lastPendingSelectionId = null;
chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === "panel" && message.type === "active-tab-context") {
    applyActiveTabContext(message.context, message.context?.following);
  }
  if (message?.target === "panel" && message.type === "tab-selection") handlePendingSelection(message.selection);
});

ui.followActiveTab.addEventListener("change", () => {
  const enabled = ui.followActiveTab.checked;
  const changeSequence = ++followChangeSequence;
  // Request the optional tabs permission before any await so Edge can associate it with this click.
  const permissionRequest = enabled ? requestTabsPermissionFromClick(currentTabContext, chrome.permissions) : null;
  void (async () => {
    if (permissionRequest) {
      let granted = false;
      try { granted = await permissionRequest; } catch { granted = false; }
      if (changeSequence !== followChangeSequence) return;
      if (!granted) {
        ui.followActiveTab.checked = false;
        ui.activeTabStatus.textContent = "No se concedió el permiso para identificar la pestaña. Puedes abrir el lector desde la página deseada para importarla.";
        return;
      }
    }
    const response = await chrome.runtime.sendMessage({ target: "background", command: "set-follow-active-tab", enabled }).catch(() => null);
    if (changeSequence !== followChangeSequence) return;
    if (!response?.ok) {
      ui.followActiveTab.checked = false;
      ui.activeTabStatus.textContent = response?.state === "tabs-permission-required"
        ? "Activa el permiso de seguimiento para identificar la página actual. El resto del lector sigue disponible."
        : "No se pudo actualizar el seguimiento. Vuelve a intentarlo.";
      return;
    }
    applyActiveTabContext(response.context, response.following);
    if (response.following) {
      ui.activeTabStatus.textContent = "Seguimiento activo · Edge usa el título y la dirección solo para identificar la pestaña actual.";
    }
  })();
});

ui.file.addEventListener("change", async () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  const selectionPurpose = fileSelectionPurpose;
  fileSelectionPurpose = "document";
  ui.file.accept = DOCUMENT_FILE_ACCEPT;
  if (libraryMutationBusy) { ui.file.value = ""; return; }
  libraryMutationBusy = true;
  setContentBusy(true);
  const currentReadId = ++fileReadId;
  ui.fileStatus.textContent = selectionPurpose === "local-pdf-preview" ? `Leyendo ${file.name} para la vista previa…` : `Procesando ${file.name}…`;
  try {
    if (selectionPurpose === "local-pdf-preview" && !/\.pdf$/i.test(file.name)) {
      throw new Error("Selecciona el archivo PDF original para obtener una vista previa.");
    }
    const { extractDocument } = await import("./documents.js");
    const text = await extractDocument(file);
    if (currentReadId !== fileReadId) return;
    if (!text.trim()) {
      throw new Error(selectionPurpose === "local-pdf-preview"
        ? "El PDF no contiene texto extraíble. Si es un escaneo, esta extensión no incluye OCR."
        : "El documento está vacío o no contiene texto.");
    }
    if (selectionPurpose === "local-pdf-preview") {
      const { createLocalPdfPreview } = await import("./tab-import.js");
      showTabImportPreview(createLocalPdfPreview(file, text, Number(ui.text.maxLength) || 200_000));
      ui.fileStatus.textContent = `${file.name} · texto extraído localmente · pendiente de confirmación.`;
      return;
    }
    await flushPersistence();
    await suspendCurrentReadForSwitch();
    selectionEpoch++;
    currentDocument = await repository.saveDocument({ id: makeId("document"), name: file.name, type: file.name.split(".").at(-1).toLowerCase(), text, extractionStatus: "ready" });
    currentSession = await repository.saveSession({
      id: makeId("session"), documentId: currentDocument.id, sourceDocumentName: currentDocument.name, sourceText: text, chunks: splitText(text),
      selectedIndex: 0, position: 0, status: "text-ready", voice: ui.voice.value,
      speed: Number(ui.speed.value), audioKeys: [], queuePrepared: false
    });
    editingForked = false;
    ui.text.value = text;
    ui.fileStatus.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · texto guardado localmente.`;
    player.setSession(null);
    await chrome.storage.local.set({ lastDocumentId: currentDocument.id, lastSessionId: currentSession.id });
    hydrationComplete = true;
    updateTextInfo();
    if (ui.library.open) await refreshLibrary();
    await refreshStorageUsage();
  } catch (error) {
    if (currentReadId === fileReadId) {
      const message = showError(error, "file");
      ui.fileStatus.textContent = message;
      if (selectionPurpose === "local-pdf-preview") setImportStatus(`${message} El editor y la sesión actual no cambiaron.`, "error");
    }
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    if (ui.library.open) await refreshLibrary();
    ui.file.value = "";
  }
});

ui.importTab.addEventListener("click", () => { void runTabImport(false); });
ui.importSelection.addEventListener("click", () => { void runTabImport(true); });
ui.replaceImport.addEventListener("click", () => { void acceptTabImport("replace"); });
ui.appendImport.addEventListener("click", () => { void acceptTabImport("append"); });
ui.cancelImport.addEventListener("click", () => {
  pendingTabImport = null;
  ui.importPreview.hidden = true;
  ui.importText.value = "";
  setImportStatus("Importación cancelada. El contenido del editor sigue intacto.", "cancelled");
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
  fileSelectionPurpose = "document";
  ui.file.accept = DOCUMENT_FILE_ACCEPT;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  ui.file.files = transfer.files;
  ui.file.dispatchEvent(new Event("change"));
});

ui.speed.addEventListener("input", () => {
  if (currentQueueMatchesEditor()) void player.setSpeed(Number(ui.speed.value)).catch(showError);
});
ui.speed.addEventListener("change", () => {
  if (currentSession) currentSession = { ...currentSession, speed: Number(ui.speed.value) };
  void chrome.storage.local.set({ speed: Number(ui.speed.value) });
  queuePersistence(false);
});
ui.voice.addEventListener("change", () => {
  void chrome.storage.local.set({ lastVoice: ui.voice.value });
  updateTextInfo();
  updateVoiceProviderUI();
  modelManagementDisclosure.onVoiceSelection(ui.voice.value);
  renderPlayer(player.snapshot());
  queuePersistence(false);
});

ui.loadPlayer.addEventListener("click", () => { void loadEditorToPlayer(); });
ui.install.addEventListener("click", () => { void handleInstallAction(); });
ui.resetPiperEngine?.addEventListener("click", () => { void resetPiperEngine(ui.voice.value); });
ui.test.addEventListener("click", () => {
  const voiceId = ui.voice.value;
  const provider = getVoiceProvider(voiceId);
  const controls = readerControls();
  if (!controls.canRequestVoiceTest) return;
  void prepareAndRunVoiceTest({
    provider,
    modelState: controlsModelState(voiceId),
    initialize: () => provider === "piper" ? initializePiperVoice(voiceId) : initializeModel(voiceId),
    runTest: () => player.preview(voiceId)
  }).catch(showError);
});
ui.play.addEventListener("click", () => {
  void startCurrentPlayback().catch(showError);
});
ui.pause.addEventListener("click", () => { void player.pause().catch(showError); });
ui.stop.addEventListener("click", async () => {
  try {
    const wasPreview = player.snapshot().activeKind === "preview";
    await player.stop();
    const snapshot = player.snapshot();
    if (player.session && !wasPreview) {
      const stoppedSession = await repository.saveSession({
        ...player.session, selectedIndex: snapshot.selectedIndex, position: 0, status: "stopped"
      });
      player.session = stoppedSession;
      if (currentSession?.id === stoppedSession.id) currentSession = stoppedSession;
    }
  } catch (error) { showError(error); }
});
ui.previous.addEventListener("click", () => { void player.previous().catch(showError); });
ui.next.addEventListener("click", () => { void player.next().catch(showError); });
ui.seek.addEventListener("input", () => { void player.seek(Number(ui.seek.value)).catch(showError); });

ui.deleteAudioCache.addEventListener("click", async () => {
  try {
    await confirmDestructiveAction({
      ...savedAudioDeleteConfirmation(),
      busyLabel: "Eliminando audios…",
      failureMessage: "No se pudieron eliminar los audios guardados. Puedes reintentar.",
      onConfirm: async () => {
        assertAudioCacheCanBeCleared();
        await player.clearAudioCache();
        const clearAudioReferences = (session) => {
          if (!session) return null;
          const chunkStates = (session.chunks || []).map((_, index) => session.chunkStates?.[index] === "error" ? "error" : "pending");
          return { ...session, audioKeys: [], chunkStates, lastError: chunkStates.includes("error") ? session.lastError || "" : "" };
        };
        if (player.session) player.session = clearAudioReferences(player.session);
        if (currentSession) currentSession = clearAudioReferences(currentSession);
        await refreshDownloadLink(null);
        try { await refreshStorageUsage(); } catch (error) { showError(error, "library"); }
        if (ui.library.open) {
          try { await refreshLibrary(); } catch (error) { ui.libraryStatus.textContent = showError(error, "library"); }
        }
        ui.fileStatus.textContent = "Audios generados eliminados; documentos, sesiones y modelos conservados.";
        return true;
      },
      onError: (error) => storageConfirmationError(error, "library", "No se pudo completar la eliminación de los audios. Puedes reintentar.")
    });
  } catch (error) { showError(error, "library"); }
});

ui.deleteModel.addEventListener("click", async () => {
  try {
    await confirmDestructiveAction({
      ...kokoroModelDeleteConfirmation(),
      busyLabel: "Eliminando Kokoro…",
      failureMessage: "No se pudo completar la eliminación de Kokoro. Puedes reintentar.",
      onConfirm: async () => {
        assertProviderCanBeRemoved("kokoro");
        await player.deleteModel();
        setKokoroModelState("idle");
        ui.modelStatus.textContent = "Modelo y recursos locales de Kokoro eliminados. Los modelos Piper, audios, documentos y sesiones se conservaron.";
        updateVoiceProviderUI();
        renderPlayer(player.snapshot());
        try { await refreshStorageUsage(); } catch (error) { showError(error, "library"); }
        return true;
      },
      onError: (error) => {
        if (!storageOperationBusyMessage(error)) {
          setKokoroModelState("error");
          ui.modelStatus.textContent = "No se pudo confirmar la eliminación de Kokoro. Puedes reintentar.";
          updateVoiceProviderUI();
          renderPlayer(player.snapshot());
        }
        return storageConfirmationError(error, "model", "No se pudo completar la eliminación de Kokoro. El estado del modelo se conserva para que puedas reintentar.");
      }
    });
  } catch (error) { showError(error, "model"); }
});

ui.deletePiperModel?.addEventListener("click", async () => {
  const voiceId = ui.voice.value;
  const voice = getVoiceRecord(voiceId);
  if (voice.provider !== "piper") return;
  try {
    await confirmDestructiveAction({
      ...piperModelDeleteConfirmation(voice.label),
      busyLabel: "Eliminando modelo…",
      failureMessage: `No se pudo eliminar el modelo ${voice.label}. Puedes reintentar.`,
      onConfirm: async () => {
        assertProviderCanBeRemoved("piper", voiceId);
        if (!piperStates.get(voiceId)?.installed) {
          throw new Error(`El modelo ${voice.label} ya no figura como instalado. Actualiza su estado e inténtalo de nuevo.`);
        }
        await player.deletePiperModel(voiceId);
        setPiperVoiceState(voiceId, { state: "idle", phase: "download", installed: false, error: "" });
        ui.modelStatus.textContent = `Modelo ${voice.label} eliminado. Los audios WAV, documentos y sesiones se conservaron.`;
        updateVoiceProviderUI();
        renderPlayer(player.snapshot());
        try { await refreshStorageUsage(); } catch (error) { showError(error, "library"); }
        return true;
      },
      onError: (error) => storageConfirmationError(error, "model", `No se pudo completar la eliminación de ${voice.label}. El estado se mantiene para que puedas reintentar.`)
    });
  } catch (error) { showError(error, "model"); }
});

function showError(error, action = "general") {
  const message = userFacingErrorMessage(error, action);
  const detail = String(error?.message || error || "");
  ui.appAlertMessage.textContent = message;
  ui.appAlert.hidden = false;
  ui.errorDetails.hidden = !detail;
  ui.errorTechnical.textContent = formatErrorDiagnostics(error);
  return message;
}

ui.dismissAppAlert.addEventListener("click", () => { ui.appAlert.hidden = true; });

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing = target instanceof Element && (target.isContentEditable || target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='slider']"));
  if (event.defaultPrevented || event.repeat || editing) return;
  if (!readerControls().canPlay) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (player.snapshot().status === "playing") void player.pause().catch(showError);
    else void startCurrentPlayback().catch(showError);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    void player.previous().catch(showError);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    void player.next().catch(showError);
  }
});

window.addEventListener("pagehide", () => {
  void flushPersistence();
  if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
  player.dispose();
});

ui.engineState.textContent = modelLabel();
ui.engineState.dataset.state = modelState;
ui.downloadProgress.hidden = true;
void boot().catch((error) => {
  ui.fileStatus.textContent = showError(error, "library");
  setKokoroModelState("error");
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
});
