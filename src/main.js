import "./style.css";
import { splitText } from "./text.js";
import { formatTime } from "./audio-utils.js";
import { attemptInitialization, deriveReaderControls } from "./reader-state.js";
import { makeId, ReaderRepository } from "./persistence.js";
import { persistEditorSnapshot } from "./editor-persistence.js";
import { buildLibraryEntries, libraryActionFor, openLibraryEntry, resumeLibrarySession } from "./library.js";
import { ReaderClient } from "./reader-client.js";
import { getVoiceProvider, isSystemVoiceId, voiceSessionFields } from "./voice-catalog.js";
import { SystemSpeechProvider } from "./system-speech.js";
import { requestSitePermissionFromClick, requestTabsPermissionFromClick } from "./tab-permissions.js";
import { createPanelStatusState, userFacingErrorMessage } from "./ui-presentation.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  text: $("#text-input"), count: $("#count"), chunks: $("#chunk-count"), file: $("#document-file"),
  fileStatus: $("#file-status"), drop: $("#dropzone"), chooseSourceFile: $("#choose-source-file"), retryFileAccess: $("#retry-file-access"),
  library: $("#library-details"), librarySummary: $("#library-summary-count"), libraryList: $("#library-list"),
  libraryStatus: $("#library-status"),
  appAlert: $("#app-alert"), appAlertMessage: $("#app-alert-message"), errorDetails: $("#app-error-details"), errorTechnical: $("#app-error-technical"), dismissAppAlert: $("#dismiss-app-alert"),
  sourceCard: $("#source-card"), activeTabKind: $("#active-tab-kind"), activeTabDomain: $("#active-tab-domain"),
  importTab: $("#import-tab"), importSelection: $("#import-selection"), importStatus: $("#tab-import-status"),
  followActiveTab: $("#follow-active-tab"), activeTabTitle: $("#active-tab-title"), activeTabStatus: $("#active-tab-status"),
  importPreview: $("#tab-import-preview"), importMeta: $("#tab-import-meta"), importText: $("#tab-import-text"),
  replaceImport: $("#replace-with-import"), appendImport: $("#append-import"), cancelImport: $("#cancel-import"),
  voice: $("#voice-select"), speed: $("#speed"), install: $("#install-model"), test: $("#test-voice"), refreshVoices: $("#refresh-system-voices"), voiceNote: $("#voice-note"), privacyNote: $("#privacy-note"),
  engineState: $("#engine-state"), modelStatus: $("#model-status"), downloadProgress: $("#download-progress"),
  play: $("#play"), pause: $("#pause"), stop: $("#stop"), previous: $("#previous"), next: $("#next"),
  position: $("#position"), playerState: $("#player-state"), playbackStatus: $("#playback-status"),
  progress: $("#read-progress"), progressFill: $("#read-progress-fill"), progressCaption: $("#progress-caption"),
  elapsed: $("#elapsed"), duration: $("#duration"), durationSummary: $("#duration-summary"), seek: $("#seek"),
  downloadAudio: $("#download-audio"), clearText: $("#clear-text"), deleteAudioCache: $("#delete-audio-cache"), deleteModel: $("#delete-model"),
  storageUsage: $("#storage-usage")
};

const repository = new ReaderRepository();
let modelState = "idle";
let initializationPromise = null;
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
let pendingQueueReplacement = false;
let pendingTabImport = null;
let tabImportBusy = false;
let currentTabContext = null;
let activeImportOperation = 0;
let followChangeSequence = 0;
let fileSelectionPurpose = "document";
let systemVoices = [];
const systemVoiceCatalog = new SystemSpeechProvider();
const DOCUMENT_FILE_ACCEPT = ".pdf,.docx,.txt,.md,.markdown,application/pdf,text/plain,text/markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const panelStatus = createPanelStatusState();

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
    if (snapshot.status === "error" && snapshot.message) showError(snapshot.message, "playback");
    void refreshDownloadLink(snapshot.currentAudioKey);
  },
  onModel: handleModelMessage
});

function syncImportButtons() {
  const canImport = panelStatus.snapshot().tab.canImport;
  const unavailable = libraryMutationBusy || tabImportBusy || !canImport;
  ui.importTab.disabled = unavailable;
  ui.importSelection.disabled = unavailable;
}

function setContentBusy(busy) {
  ui.library.setAttribute("aria-busy", String(busy));
  for (const control of [ui.text, ui.file, ui.chooseSourceFile, ui.retryFileAccess, ui.clearText, ui.replaceImport, ui.appendImport, ui.cancelImport, ui.voice, ui.speed]) {
    if (control) control.disabled = busy;
  }
  syncImportButtons();
  for (const button of ui.library.querySelectorAll("button")) button.disabled = busy;
}

function controlsModelState() { return modelState; }
function readerControls(snapshot = player.snapshot()) {
  const isCurrentSpeech = snapshot.activeProvider === "speechSynthesis" && ["playing", "paused", "audio-ready"].includes(snapshot.status);
  const voiceId = isCurrentSpeech ? snapshot.activeVoiceId : ui.voice.value;
  const provider = getVoiceProvider(voiceId);
  return deriveReaderControls(controlsModelState(), snapshot.chunks.length, snapshot.status === "playing", {
    provider,
    systemVoiceAvailable: provider === "speechSynthesis" && (isCurrentSpeech || systemVoices.some((voice) => voice.id === voiceId)),
    audioAvailable: provider === "kokoro" && Boolean(snapshot.currentAudioKey || currentSession?.audioKeys?.[snapshot.selectedIndex])
  });
}

function updateVoiceProviderUI() {
  const selected = ui.voice.value;
  const systemVoice = systemVoices.find((voice) => voice.id === selected);
  const isSystem = isSystemVoiceId(selected);
  if (isSystem) {
    ui.engineState.textContent = systemVoice ? "Voz del sistema" : "Voz del sistema no disponible";
    ui.engineState.dataset.state = systemVoice ? "system" : "error";
    ui.voiceNote.textContent = systemVoice
      ? `${systemVoice.label} · gestionada por Edge/Windows. El sistema podría procesar texto mediante sus servicios. Usa Kokoro para síntesis local; SpeechSynthesis no exporta WAV.`
      : "Esta voz guardada ya no aparece en Edge/Windows. Actualiza la lista o selecciona otra voz.";
    ui.privacyNote.textContent = "Voz del sistema: el texto se entrega a Edge/Windows y podría procesarse mediante sus servicios. Usa Kokoro si necesitas síntesis local.";
    ui.modelStatus.textContent = systemVoice
      ? "Sin descarga de modelo. El modo sin conexión depende de la voz y la configuración del sistema; no se puede garantizar."
      : "Voz del sistema no encontrada. No se seleccionará otra voz automáticamente.";
    ui.install.textContent = "Kokoro · voces inglesas";
    ui.install.disabled = true;
    return;
  }
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
  ui.voiceNote.textContent = "Kokoro local genera audio WAV descargable para Heart y Michael. La primera preparación requiere descargar el modelo.";
  ui.privacyNote.textContent = "Con Kokoro, el texto se sintetiza localmente; la red solo se usa para descargar los pesos solicitados.";
  ui.install.disabled = ["loading", "ready"].includes(modelState);
  ui.install.textContent = ({
    idle: "Preparar Kokoro local",
    cached: "Cargar modelo local",
    loading: "Preparando Kokoro…",
    ready: "Modelo preparado",
    error: "Reintentar carga local"
  })[modelState] || "Preparar Kokoro local";
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
  if (["text-ready", "stopped"].includes(snapshot.status) && !readerControls(snapshot).canPlay) {
    return isSystemVoiceId(ui.voice.value) ? "Voz del sistema no disponible" : modelLabel();
  }
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
    if (snapshot.activeProvider === "speechSynthesis") return snapshot.activeKind === "preview"
      ? "Reproduciendo una muestra con Edge/Windows. El sistema puede procesar el texto; esta voz no genera un WAV descargable."
      : `Reproduciendo con Edge/Windows, fragmento ${(snapshot.playingIndex ?? snapshot.selectedIndex) + 1} de ${snapshot.chunks.length}. El sistema puede procesar el texto.`;
    if (snapshot.activeKind === "preview") return "Reproduciendo la muestra de voz local.";
    return `Reproduciendo fragmento ${(snapshot.playingIndex ?? snapshot.selectedIndex) + 1} de ${snapshot.chunks.length}.`;
  }
  if (snapshot.status === "paused" && snapshot.activeProvider === "speechSynthesis") return "Voz del sistema pausada; la posición temporal exacta no está disponible.";
  if (snapshot.status === "paused") return snapshot.activeKind === "preview"
    ? `Muestra pausada en ${formatTime(snapshot.currentTime)}.`
    : `Lectura pausada en ${formatTime(snapshot.currentTime)} del fragmento ${snapshot.selectedIndex + 1}.`;
  if (snapshot.status === "interrupted") return snapshot.message || "La sesión se guardó. Pulsa Reanudar para continuar.";
  if (snapshot.status === "error") return userFacingErrorMessage(snapshot.message, "playback");
  return snapshot.message;
}

function renderPlayer(snapshot) {
  updateVoiceProviderUI();
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
  const progressText = snapshot.activeProvider === "speechSynthesis" && snapshot.activeKind !== "preview"
    ? `Progreso aproximado por texto · ${Math.round(progress * 100)}% · sin búsqueda temporal`
    : snapshot.activeKind === "preview" ? "Muestra de voz · la lectura no cambia"
    : snapshot.totalDuration !== null
    ? `Progreso temporal · ${Math.round(progress * 100)}%`
    : hasText ? `${selected} de ${chunkCount} fragmentos · duración total pendiente` : "Sin progreso";
  ui.progress.setAttribute("aria-valuetext", progressText);
  ui.progressCaption.textContent = progressText;

  ui.elapsed.textContent = snapshot.activeProvider === "speechSynthesis" ? "—" : formatTime(snapshot.currentTime);
  ui.duration.textContent = snapshot.activeProvider === "speechSynthesis" ? "—" : formatTime(snapshot.duration ?? Number.NaN);
  ui.seek.min = "0";
  ui.seek.max = String(snapshot.duration || 0);
  ui.seek.step = "0.1";
  ui.seek.value = String(Math.min(snapshot.currentTime, snapshot.duration || 0));
  ui.seek.disabled = !Number.isFinite(snapshot.duration) || snapshot.duration <= 0 || !["playing", "paused"].includes(snapshot.status);
  ui.seek.setAttribute("aria-valuetext", snapshot.activeProvider === "speechSynthesis"
    ? "La voz del sistema no informa posición temporal para buscar."
    : `Fragmento ${selected}, ${formatTime(snapshot.currentTime)} de ${formatTime(snapshot.duration ?? Number.NaN)}`);

  const knownSeconds = snapshot.durations.reduce((sum, duration) => sum + (Number.isFinite(duration) ? duration : 0), 0);
  ui.durationSummary.textContent = snapshot.activeProvider === "speechSynthesis"
    ? "La duración y la búsqueda temporal no están disponibles para voces del sistema."
    : snapshot.activeKind === "preview" ? `Duración de la muestra ${formatTime(snapshot.duration)}`
    : snapshot.totalDuration !== null
    ? `Duración total ${formatTime(snapshot.totalDuration)} · ${snapshot.knownDurationCount} fragmentos medidos`
    : hasText ? `Duración conocida ${formatTime(knownSeconds)} · total pendiente (${snapshot.knownDurationCount}/${chunkCount} fragmentos medidos)`
      : "La duración aparecerá cuando se genere audio.";

  ui.play.hidden = isPlaying;
  ui.pause.hidden = !isPlaying;
  const canResumePreview = snapshot.activeKind === "preview" && ["paused", "completed"].includes(snapshot.status) && controls.canTestVoice;
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
    ui.fileStatus.textContent = showError(error, "playback");
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
    ui.modelStatus.textContent = showError(message.message || "Kokoro no pudo iniciarse.", "model");
    ui.downloadProgress.hidden = true;
  }
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
  updateVoiceProviderUI();
  renderPlayer(player.snapshot());
}

function ensureStoredVoiceOption(voiceId) {
  if (!isSystemVoiceId(voiceId) || [...ui.voice.options].some((option) => option.value === voiceId)) return;
  const group = ui.voice.querySelector("#system-voice-options");
  if (!group) return;
  const option = document.createElement("option");
  option.value = voiceId;
  option.disabled = true;
  option.textContent = "Voz del sistema guardada · no disponible";
  group.append(option);
}

function selectVoice(voiceId) {
  if (!voiceId) return;
  ensureStoredVoiceOption(voiceId);
  if ([...ui.voice.options].some((option) => option.value === voiceId)) ui.voice.value = voiceId;
  updateVoiceProviderUI();
}

async function refreshSystemVoices() {
  const group = ui.voice.querySelector("#system-voice-options");
  try {
    systemVoices = await systemVoiceCatalog.listVoices();
    const selectedBeforeRefresh = ui.voice.value;
    if (group) {
      group.replaceChildren();
      for (const voice of systemVoices) {
        const option = document.createElement("option");
        option.value = voice.id;
        option.textContent = `Español · ${voice.label} · voz del sistema`;
        group.append(option);
      }
      if (!systemVoices.length && !isSystemVoiceId(selectedBeforeRefresh)) {
        const option = document.createElement("option");
        option.value = "system-voices-unavailable";
        option.disabled = true;
        option.textContent = "No se encontraron voces españolas";
        group.append(option);
      }
    }
    ensureStoredVoiceOption(selectedBeforeRefresh);
    if (selectedBeforeRefresh && [...ui.voice.options].some((option) => option.value === selectedBeforeRefresh)) {
      ui.voice.value = selectedBeforeRefresh;
    }
  } catch (error) {
    const selectedBeforeRefresh = ui.voice.value;
    systemVoices = [];
    ensureStoredVoiceOption(selectedBeforeRefresh);
    ui.modelStatus.textContent = showError(error, "voice");
  }
  updateVoiceProviderUI();
  renderPlayer(player.snapshot());
}

function updateTextInfo() {
  const text = ui.text.value;
  const segments = splitText(text);
  ui.count.textContent = `${text.length.toLocaleString()} caracteres`;
  ui.chunks.textContent = `${segments.length} ${segments.length === 1 ? "fragmento" : "fragmentos"}`;
  if (!currentSession || currentSession.sourceText !== text) {
    const liveStatus = player.snapshot().status;
    const stopEmptyingRead = !segments.length && ["playing", "generating", "audio-ready"].includes(liveStatus);
    if (currentSession && !editingForked
        && (currentSession.status !== "text-ready" || currentSession.audioKeys?.some(Boolean)
          || ["playing", "paused", "interrupted", "completed", "error"].includes(liveStatus)
          || Boolean(player.snapshot().currentAudioKey))) {
      currentSession = {
        id: makeId("session"), documentId: currentDocument?.id,
        sourceDocumentName: currentDocument?.name || "Texto pegado",
        sourceText: text, chunks: segments, selectedIndex: 0, position: 0,
        status: "text-ready", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: []
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
        voice: ui.voice.value,
        speed: Number(ui.speed.value),
        audioKeys: []
      };
    }
    player.setSession(currentSession);
    if (stopEmptyingRead) void player.stop().catch(showError);
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
    speed: Number(ui.speed.value)
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
    if (replaceQueue) {
      await player.replace(currentSession).catch((error) => {
        const message = showError(error, "playback");
        ui.playbackStatus.textContent = `El texto quedó guardado, pero la cola no se actualizó. ${message}`;
      });
      pendingQueueReplacement = false;
    }
    if (ui.library.open) await refreshLibrary();
    await refreshStorageUsage();
  }).catch((error) => {
    ui.fileStatus.textContent = showError(error, "storage");
  });
  return persistenceChain;
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
    proceed.className = "library-open library-continue";
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
        resume.className = "library-open";
        resume.textContent = "Reanudar";
        resume.addEventListener("click", () => { if (!libraryMutationBusy) void resumeLibrarySession(session, activateSession, () => player.play()).catch(showError); });
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
        if (matchingSession) void resumeLibrarySession(matchingSession, activateSession, () => player.play()).catch(showError);
        else void (async () => {
          if (document) await activateDocument(document, null, false, { restoreSession: false });
          else if (latestSession) await activateSession(latestSession);
          await flushPersistence();
          await player.play();
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
  ui.activeTabDomain.textContent = presentation.domain;
  ui.activeTabDomain.hidden = !presentation.domain;
  ui.activeTabKind.textContent = presentation.contentType;
  ui.activeTabKind.dataset.state = presentation.state;
  ui.activeTabStatus.textContent = presentation.status;
  syncImportButtons();

  if (changed) {
    const discardedPreview = Boolean(pendingTabImport);
    const interruptedImport = tabImportBusy;
    activeImportOperation++;
    tabImportBusy = false;
    pendingTabImport = null;
    ui.importPreview.hidden = true;
    ui.importText.value = "";
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



async function runTabImport(selectionOnly = false) {
  if (tabImportBusy || libraryMutationBusy) return;
  const operationId = ++activeImportOperation;
  const initialContext = currentTabContext;
  // Keep the optional permission prompt inside the direct user click handler.
  const permissionRequest = requestSitePermissionFromClick(initialContext, chrome.permissions);
  tabImportBusy = true;
  pendingTabImport = null;
  ui.importPreview.hidden = true;
  setImportStatus("Extracción en curso…", "loading");
  syncImportButtons();
  ui.chooseSourceFile.hidden = true;
  ui.retryFileAccess.hidden = true;
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
        onStatus: ({ message }) => { if (message && operationId === activeImportOperation) setImportStatus(message); }
      });
      if (operationId !== activeImportOperation) return;
      if (result.ok) {
        const validation = await chrome.runtime.sendMessage({
          target: "background", command: "validate-current-import",
          context: pdfTarget.documentContext, operationId
        });
        if (operationId !== activeImportOperation) return;
        if (!validation?.ok) result = { ...validation, type: localPdf ? "local-pdf" : "pdf", title: pdfTarget.targetTab.title };
      }
    }
    if (operationId !== activeImportOperation) return;
    if (!result.ok) {
      const details = [result.title, result.type ? tabImportTypeLabel(result.type) : "", result.sourceUrl].filter(Boolean);
      const message = `${details.length ? `${details.join(" · ")}\n` : ""}${result.message || "No se pudo extraer el contenido."}`;
      setImportStatus(message, "error");
      const { localPdfRecoveryActions } = await import("./tab-import.js");
      const actions = localPdfRecoveryActions(result);
      ui.chooseSourceFile.hidden = !actions.selectPdf;
      ui.chooseSourceFile.textContent = actions.previewSelectedPdf ? "Seleccionar este PDF" : "Elegir archivo para importar";
      ui.chooseSourceFile.dataset.previewPdf = String(actions.previewSelectedPdf);
      ui.retryFileAccess.hidden = !actions.retryFileAccess;
      return;
    }
    showTabImportPreview(result);
    setImportStatus(`Vista previa extraída · ${result.characters.toLocaleString()} caracteres · pendiente de confirmación.`, "preview");
  } catch (error) {
    if (operationId !== activeImportOperation) return;
    setImportStatus(showError(error, "import"), "error");
    ui.chooseSourceFile.hidden = false;
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
        speed: Number(ui.speed.value), audioKeys: []
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
    player.setSession(currentSession);
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
  if (isSystemVoiceId(ui.voice.value)) return false;
  if (initializationPromise) return initializationPromise;
  modelState = "loading";
  ui.modelStatus.textContent = "Cargando Kokoro y sus recursos locales bajo demanda.";
  ui.downloadProgress.hidden = false;
  ui.downloadProgress.removeAttribute("value");
  updateVoiceProviderUI();
  renderPlayer(player.snapshot());

  initializationPromise = (async () => {
    const result = await attemptInitialization(
      () => player.initialize(ui.voice.value),
      (state) => {
        if (state === "loading" || state === "error") modelState = state;
        updateVoiceProviderUI();
      }
    );
    if (!result.ok) throw result.error;
    modelState = "ready";
    await chrome.storage.local.set({ modelCached: true });
    ui.modelStatus.textContent = "Modelo Kokoro preparado. Los WAV ingleses se guardan y exportan desde este dispositivo.";
    ui.downloadProgress.hidden = true;
    updateVoiceProviderUI();
    renderPlayer(player.snapshot());
    return true;
  })().catch((error) => {
    modelState = "error";
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
  if (status === "playing") await player.pause().catch(() => {});
  else if (["generating", "audio-ready"].includes(status)) await player.stop().catch(() => {});
}

async function createNewDraft() {
  await flushPersistence();
  await suspendCurrentReadForSwitch();
  selectionEpoch++;
  currentDocument = null;
  currentSession = {
    id: null, documentId: null, sourceDocumentName: "Texto pegado", sourceText: "", chunks: [], selectedIndex: 0,
    position: 0, status: "empty", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: []
  };
  editingForked = false;
  ui.text.value = "";
  ui.fileStatus.textContent = "Editor vacío; los documentos anteriores siguen guardados.";
  player.setSession(currentSession);
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
  const savedSession = sessions.find((item) => item.id === preferredSessionId) || sessions[0] || null;
  const editorText = restoreSession ? (savedSession?.sourceText ?? document.text) : document.text;
  const canUseSavedSession = savedSession && savedSession.sourceText === editorText;
  currentSession = canUseSavedSession ? savedSession : {
    id: null, documentId: document.id, sourceDocumentName: document.name, sourceText: editorText, chunks: splitText(editorText),
    selectedIndex: 0, position: 0, status: editorText.trim() ? "text-ready" : "empty",
    voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: []
  };
  editingForked = false;
  ui.text.value = editorText;
  selectVoice(currentSession.voiceId || currentSession.voice);
  if (currentSession.speed && [...ui.speed.options].some((option) => Number(option.value) === Number(currentSession.speed))) ui.speed.value = String(currentSession.speed);
  ui.fileStatus.textContent = document.name ? `Documento guardado · ${document.name}` : "Texto local recuperado.";
  player.setSession(currentSession);
  const preference = { lastDocumentId: document.id };
  if (currentSession.id) preference.lastSessionId = currentSession.id;
  else await chrome.storage.local.remove("lastSessionId");
  await chrome.storage.local.set(preference);
  hydrationComplete = true;
  updateTextInfo();
  await player.connect(currentSession);
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
  currentDocument = document;
  currentSession = selected;
  editingForked = false;
  ui.text.value = selected.sourceText || document?.text || "";
  selectVoice(selected.voiceId || selected.voice);
  if ([...ui.speed.options].some((option) => Number(option.value) === Number(selected.speed))) ui.speed.value = String(selected.speed);
  ui.fileStatus.textContent = `Sesión recuperada · ${selected.sourceDocumentName || document?.name || "lectura guardada"}`;
  player.setSession(currentSession);
  if (document) await chrome.storage.local.set({ lastDocumentId: document.id, lastSessionId: currentSession.id });
  else {
    await chrome.storage.local.remove("lastDocumentId");
    await chrome.storage.local.set({ lastSessionId: currentSession.id });
  }
  hydrationComplete = true;
  updateTextInfo();
  await player.connect(currentSession);
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
  const document = await repository.getDocument(documentId);
  if (!document) { if (ui.library.open) await refreshLibrary(); return; }
  const dependentSessions = await repository.listSessions(documentId);
  const warning = dependentSessions.length
    ? ` Sus ${dependentSessions.length} sesiones conservarán su copia de texto, progreso y audios como lecturas independientes.`
    : " No hay sesiones asociadas.";
  if (!confirm(`¿Eliminar el documento “${document.name}”?${warning} El modelo local no se eliminará.`)) return;
  if (libraryMutationBusy) return;

  libraryMutationBusy = true;
  setContentBusy(true);
  libraryRefreshEpoch++;
  const wasActive = currentDocument?.id === documentId;
  if (wasActive) selectionEpoch++;
  const previousDocument = currentDocument;
  const previousSession = currentSession;
  let documentDeleted = false;
  if (wasActive) {
    fileReadId++;
    ui.text.disabled = true;
    ui.file.disabled = true;
    ui.chooseSourceFile.disabled = true;
    await flushPersistence();
    clearTimeout(persistTimer);
    pendingQueueReplacement = false;
    currentDocument = null;
    currentSession = null;
    ui.text.value = "";
    player.setSession(null);
  }
  try {
    await Promise.all(dependentSessions.map((session) => player.forgetSession(session.id, true)));
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
  } catch (error) {
    if (wasActive && !documentDeleted) {
      currentDocument = previousDocument;
      currentSession = previousSession;
      player.setSession(currentSession);
      if (currentSession) await player.connect(currentSession).catch(() => {});
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
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    ui.text.disabled = false;
    ui.file.disabled = false;
    ui.chooseSourceFile.disabled = false;
    if (ui.library.open) await refreshLibrary();
  }
}

async function deleteLibrarySession(sessionId) {
  if (libraryMutationBusy) return;
  const session = await repository.getSession(sessionId);
  if (!session) { if (ui.library.open) await refreshLibrary(); return; }
  const name = session.sourceDocumentName || session.sourceText?.trim().slice(0, 48) || "Texto pegado";
  if (!confirm(`¿Eliminar la sesión de lectura “${name}”? Se borrarán su progreso y los WAV que no use otra sesión. El documento y el modelo local se conservarán.`)) return;
  if (libraryMutationBusy) return;

  libraryMutationBusy = true;
  setContentBusy(true);
  libraryRefreshEpoch++;
  const wasActive = currentSession?.id === sessionId;
  if (wasActive) selectionEpoch++;
  const document = currentDocument;
  const editorText = ui.text.value;
  if (wasActive) {
    ui.text.disabled = true;
    await flushPersistence();
    clearTimeout(persistTimer);
    pendingQueueReplacement = false;
    currentSession = null;
    player.setSession(null);
  }
  try {
    await player.forgetSession(sessionId, false);
    await repository.deleteSession(sessionId);
    if (wasActive && document) {
      const nextSession = (await repository.listSessions(document.id))[0];
      if (nextSession) await activateSession(nextSession, true, { skipFlush: true });
      else if (editorText.trim()) {
        currentSession = {
          id: null, documentId: document.id, sourceDocumentName: document.name,
          sourceText: editorText, chunks: splitText(editorText), selectedIndex: 0, position: 0,
          status: "text-ready", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: []
        };
        player.setSession(currentSession);
        await chrome.storage.local.remove("lastSessionId");
      } else {
        currentSession = { id: null, documentId: document.id, sourceDocumentName: document.name, sourceText: "", chunks: [], selectedIndex: 0, position: 0, status: "empty", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: [] };
        player.setSession(currentSession);
        await chrome.storage.local.remove("lastSessionId");
      }
    } else if (wasActive) {
      currentSession = null;
      await chrome.storage.local.remove("lastSessionId");
    }
    ui.libraryStatus.textContent = `Sesión “${name}” eliminada. Los audios compartidos y el modelo se conservaron.`;
    await refreshStorageUsage();
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
    if (wasActive) {
      currentSession = await repository.getSession(sessionId).catch(() => null);
      if (currentSession) {
        player.setSession(currentSession);
        await player.connect(currentSession).catch(() => {});
      }
    }
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    ui.text.disabled = false;
    if (ui.library.open) await refreshLibrary();
  }
}

async function deleteRecoveredLibraryEntry(entry) {
  if (libraryMutationBusy || !entry?.sessions?.length) return;
  const sessions = [...entry.sessions];
  const title = sessions[0].sourceDocumentName || "Lectura recuperada";
  const message = sessions.length === 1
    ? `¿Eliminar la sesión recuperada “${title}”? Se borrará su progreso y los WAV exclusivos; los audios compartidos y el modelo se conservarán.`
    : `¿Eliminar las ${sessions.length} sesiones recuperadas de “${title}”? Se borrarán sus progresos y los WAV exclusivos; los audios compartidos y el modelo se conservarán.`;
  if (!confirm(message)) return;

  libraryMutationBusy = true;
  setContentBusy(true);
  libraryRefreshEpoch++;
  const deletedIds = new Set(sessions.map((session) => session.id));
  const wasActive = deletedIds.has(currentSession?.id);
  const editorText = ui.text.value;
  if (wasActive) {
    selectionEpoch++;
    ui.text.disabled = true;
    await flushPersistence();
    clearTimeout(persistTimer);
    pendingQueueReplacement = false;
    currentSession = null;
    player.setSession(null);
  }
  try {
    for (const session of sessions) {
      await player.forgetSession(session.id, false);
      await repository.deleteSession(session.id);
    }
    if (wasActive) {
      if (currentDocument && editorText.trim()) {
        currentSession = { id: null, documentId: currentDocument.id, sourceDocumentName: currentDocument.name, sourceText: editorText, chunks: splitText(editorText), selectedIndex: 0, position: 0, status: "text-ready", voice: ui.voice.value, speed: Number(ui.speed.value), audioKeys: [] };
        player.setSession(currentSession);
        await chrome.storage.local.remove("lastSessionId");
      } else {
        currentSession = null;
        player.setSession(null);
        await chrome.storage.local.remove("lastSessionId");
      }
    }
    ui.libraryStatus.textContent = `${sessions.length === 1 ? "Sesión recuperada eliminada" : `${sessions.length} sesiones recuperadas eliminadas`}. Los audios compartidos y el modelo se conservaron.`;
    await refreshStorageUsage();
  } catch (error) {
    ui.libraryStatus.textContent = showError(error, "library");
  } finally {
    libraryMutationBusy = false;
    setContentBusy(false);
    ui.text.disabled = false;
    if (ui.library.open) await refreshLibrary();
  }
}

async function boot() {
  await repository.cleanEmptyDocuments();
  void refreshSystemVoices();
  const preferences = await chrome.storage.local.get(["lastDocumentId", "lastSessionId", "lastVoice", "speed"]);
  if (preferences.lastVoice) selectVoice(preferences.lastVoice);
  if (preferences.speed && [...ui.speed.options].some((option) => Number(option.value) === Number(preferences.speed))) ui.speed.value = String(preferences.speed);
  const preferredSession = preferences.lastSessionId ? await repository.getSession(preferences.lastSessionId) : null;
  currentDocument = preferences.lastDocumentId ? await repository.getDocument(preferences.lastDocumentId) : null;
  if (!currentDocument && preferredSession) {
    await activateSession(preferredSession);
    await refreshModelCacheState();
    await refreshActiveTabContext();
    const pending = await chrome.runtime.sendMessage({ target: "background", command: "take-pending-selection" }).catch(() => null);
    if (pending?.selection) handlePendingSelection(pending.selection);
    return;
  }
  if (!currentDocument) currentDocument = (await repository.listDocuments())[0] || null;
  if (!currentDocument) await createNewDraft();
  else await activateDocument(currentDocument, preferences.lastSessionId, false, { restoreSession: true });
  await refreshModelCacheState();
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
      speed: Number(ui.speed.value), audioKeys: []
    });
    editingForked = false;
    ui.text.value = text;
    ui.fileStatus.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · texto guardado localmente.`;
    player.setSession(currentSession);
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

ui.speed.addEventListener("input", () => { void player.setSpeed(Number(ui.speed.value)).catch(showError); });
ui.speed.addEventListener("change", () => {
  if (currentSession) currentSession = { ...currentSession, speed: Number(ui.speed.value) };
  void chrome.storage.local.set({ speed: Number(ui.speed.value) });
  queuePersistence(false);
});
ui.voice.addEventListener("change", () => {
  if (currentSession) currentSession = { ...currentSession, ...voiceSessionFields(ui.voice.value), audioKeys: [], durations: currentSession.chunks.map(() => null) };
  void chrome.storage.local.set({ lastVoice: ui.voice.value });
  if (currentSession) void player.setVoice(ui.voice.value).catch(showError);
  updateVoiceProviderUI();
  renderPlayer(player.snapshot());
  queuePersistence(false);
});

ui.install.addEventListener("click", () => { void initializeModel(); });
ui.refreshVoices.addEventListener("click", () => { void refreshSystemVoices(); });
ui.test.addEventListener("click", () => {
  if (!readerControls().canTestVoice) return;
  void player.preview(ui.voice.value).catch(showError);
});
ui.play.addEventListener("click", () => {
  if (!readerControls().canPlay) return;
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
    await player.deleteModel().catch(() => {});
    await caches.delete("edge-local-reader-kokoro-v1");
    await caches.delete("kokoro-voices");
    await chrome.storage.local.remove("modelCached");
    modelState = "idle";
    ui.modelStatus.textContent = "Modelo local eliminado. Los documentos y la lectura guardada permanecen.";
    updateVoiceProviderUI();
    renderPlayer(player.snapshot());
    await refreshStorageUsage();
  } catch (error) { showError(error); }
});

function showError(error, action = "general") {
  const message = userFacingErrorMessage(error, action);
  const detail = String(error?.message || error || "");
  ui.appAlertMessage.textContent = message;
  ui.appAlert.hidden = false;
  ui.errorDetails.hidden = !detail;
  ui.errorTechnical.textContent = detail;
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
    else void flushPersistence().then(() => player.play()).catch(showError);
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
  ui.fileStatus.textContent = showError(error, "library");
  modelState = "error";
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
});
