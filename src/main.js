import "./style.css";
import { extractDocument } from "./documents.js";
import { LocalKokoroProvider } from "./tts.js";
import { splitText } from "./text.js";
import { PlaybackController } from "./player-controller.js";
import { attemptInitialization, deriveReaderControls } from "./reader-state.js";
import { formatTime } from "./audio-utils.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  text: $("#text-input"), count: $("#count"), chunks: $("#chunk-count"), file: $("#document-file"),
  fileStatus: $("#file-status"), drop: $("#dropzone"), voice: $("#voice-select"), speed: $("#speed"),
  install: $("#install-model"), test: $("#test-voice"), engineState: $("#engine-state"),
  modelStatus: $("#model-status"), downloadProgress: $("#download-progress"), audio: $("#audio"),
  play: $("#play"), pause: $("#pause"), stop: $("#stop"), previous: $("#previous"), next: $("#next"),
  position: $("#position"), playerState: $("#player-state"), playbackStatus: $("#playback-status"),
  progress: $("#read-progress"), progressFill: $("#read-progress-fill"), progressCaption: $("#progress-caption"),
  elapsed: $("#elapsed"), duration: $("#duration"), durationSummary: $("#duration-summary"), seek: $("#seek"),
  downloadAudio: $("#download-audio"), clearText: $("#clear-text"), clearData: $("#clear-data")
};
const provider = new LocalKokoroProvider();
let modelState = "idle";
let initializationPromise = null;
let fileReadId = 0;

const player = new PlaybackController({
  audio: ui.audio,
  synthesize: (text, { voice }) => provider.synthesize(text, { voice, speed: 1 }),
  getVoice: () => ui.voice.value,
  onState: renderPlayer
});

function readerControls(snapshot = player.snapshot()) {
  return deriveReaderControls(modelState, snapshot.chunks.length, snapshot.status === "playing");
}

function modelLabel() {
  return ({ idle: "Modelo sin descargar", loading: "Cargando modelo local", ready: "Modelo local listo", error: "Error del modelo" })[modelState];
}

function playerLabel(snapshot) {
  if (!snapshot.chunks.length && snapshot.activeKind !== "preview") return "Sin texto";
  if (["text-ready", "stopped"].includes(snapshot.status) && modelState !== "ready") return modelLabel();
  return ({
    "text-ready": "Texto preparado",
    generating: "Generando audio",
    "audio-ready": "Audio preparado",
    playing: "Reproduciendo",
    paused: "Pausado",
    stopped: "Detenido",
    completed: snapshot.activeKind === "preview" ? "Muestra completada" : "Lectura completada",
    error: "Error recuperable"
  })[snapshot.status] || "Sin texto";
}

function describePlayer(snapshot) {
  if (snapshot.status === "playing") {
    return snapshot.activeKind === "preview"
      ? "Reproduciendo la muestra de voz local."
      : `Reproduciendo fragmento ${snapshot.playingIndex + 1} de ${snapshot.chunks.length}.`;
  }
  if (snapshot.status === "paused") {
    return snapshot.activeKind === "preview"
      ? `Muestra pausada en ${formatTime(snapshot.currentTime)}.`
      : `Lectura pausada en ${formatTime(snapshot.currentTime)} del fragmento ${snapshot.selectedIndex + 1}.`;
  }
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

  ui.progressFill.style.width = `${Math.round(snapshot.totalProgress * 100)}%`;
  ui.progress.setAttribute("aria-valuenow", String(Math.round(snapshot.totalProgress * 100)));
  const progressText = snapshot.totalDuration !== null
    ? snapshot.activeKind === "preview" ? "Muestra de voz · la lectura no cambia" : `Progreso temporal · ${Math.round(snapshot.totalProgress * 100)}%`
    : hasText
      ? snapshot.activeKind === "preview" ? "Muestra de voz · la lectura no cambia" : `${selected} de ${chunkCount} fragmentos · duración total pendiente`
      : "Sin progreso";
  ui.progress.setAttribute("aria-valuetext", progressText);
  ui.progressCaption.textContent = progressText;

  ui.elapsed.textContent = formatTime(snapshot.currentTime);
  ui.duration.textContent = formatTime(snapshot.duration ?? Number.NaN);
  ui.seek.min = "0";
  ui.seek.max = String(snapshot.duration || 0);
  ui.seek.step = "0.1";
  ui.seek.value = String(Math.min(snapshot.currentTime, snapshot.duration || 0));
  ui.seek.disabled = !snapshot.downloadUrl || !Number.isFinite(snapshot.duration) || snapshot.duration <= 0;
  ui.seek.setAttribute("aria-valuetext", `Fragmento ${selected}, ${formatTime(snapshot.currentTime)} de ${formatTime(snapshot.duration ?? Number.NaN)}`);

  const knownSeconds = snapshot.durations.reduce((sum, duration) => sum + (Number.isFinite(duration) ? duration : 0), 0);
  ui.durationSummary.textContent = snapshot.activeKind === "preview"
    ? `Duración de la muestra ${formatTime(snapshot.duration)}`
    : snapshot.totalDuration !== null
      ? `Duración total ${formatTime(snapshot.totalDuration)} · ${snapshot.knownDurationCount} fragmentos medidos`
      : hasText
        ? `Duración conocida ${formatTime(knownSeconds)} · total pendiente (${snapshot.knownDurationCount}/${chunkCount} fragmentos medidos)`
        : "La duración aparecerá cuando se genere audio.";

  ui.play.hidden = isPlaying;
  ui.pause.hidden = !isPlaying;
  const canResumePreview = snapshot.activeKind === "preview" && Boolean(snapshot.downloadUrl)
    && (snapshot.status === "paused" || !hasText && snapshot.status === "completed");
  ui.play.disabled = (!controls.canPlay && !canResumePreview) || isGenerating;
  ui.pause.disabled = !controls.canPause;
  const playLabel = snapshot.status === "paused" ? "Reanudar" : snapshot.status === "completed" ? "Reproducir de nuevo" : "Reproducir";
  ui.play.querySelector("span").textContent = playLabel;
  ui.play.setAttribute("aria-label", snapshot.status === "paused"
    ? snapshot.activeKind === "preview" ? "Reanudar muestra de voz" : "Reanudar lectura"
    : snapshot.status === "completed" && snapshot.activeKind === "preview" ? "Reproducir la muestra de nuevo"
      : snapshot.status === "completed" ? "Reproducir lectura desde el principio" : "Reproducir lectura");
  const hasPreview = snapshot.activeKind === "preview";
  ui.stop.disabled = !(hasText || hasPreview) || !["playing", "paused", "generating", "audio-ready", "completed", "error"].includes(snapshot.status);
  ui.previous.disabled = !controls.canPlay || snapshot.selectedIndex <= 0;
  ui.next.disabled = !controls.canPlay || snapshot.selectedIndex >= chunkCount - 1;
  const canStartSample = ["empty", "text-ready", "stopped"].includes(snapshot.status)
    || snapshot.activeKind === "preview" && ["completed", "error"].includes(snapshot.status);
  ui.test.disabled = !controls.canTestVoice || !canStartSample;

  const message = describePlayer(snapshot) || (hasText ? "El texto está listo para reproducirse." : "Pega o carga texto para empezar.");
  if (ui.playbackStatus.textContent !== message) ui.playbackStatus.textContent = message;

  const downloadable = Boolean(snapshot.downloadUrl && snapshot.downloadFilename);
  ui.downloadAudio.hidden = !downloadable;
  if (downloadable) {
    ui.downloadAudio.href = snapshot.downloadUrl;
    ui.downloadAudio.download = snapshot.downloadFilename;
    ui.downloadAudio.setAttribute("aria-label", `Descargar ${snapshot.downloadFilename}`);
  } else {
    ui.downloadAudio.removeAttribute("href");
  }
}

function updateTextInfo() {
  const text = ui.text.value;
  const segments = splitText(text);
  ui.count.textContent = `${text.length.toLocaleString()} caracteres`;
  ui.chunks.textContent = `${segments.length} ${segments.length === 1 ? "fragmento" : "fragmentos"}`;
  player.setChunks(segments);
  renderPlayer(player.snapshot());
}

async function initializeModel() {
  if (modelState === "ready") return true;
  if (initializationPromise) return initializationPromise;
  modelState = "loading";
  ui.install.disabled = true;
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
  ui.modelStatus.textContent = "Cargando Kokoro y sus recursos locales. Los pesos se descargan desde Hugging Face si aún no están en caché.";
  ui.downloadProgress.hidden = false;
  ui.downloadProgress.removeAttribute("value");
  renderPlayer(player.snapshot());

  initializationPromise = (async () => {
    try {
      const result = await attemptInitialization(() => provider.initialize((event) => {
        if (event?.status === "progress" && Number.isFinite(event.progress)) {
          ui.downloadProgress.value = event.progress;
          ui.modelStatus.textContent = `Descargando ${event.file || "modelo"}: ${Math.round(event.progress)}%`;
        } else if (event?.status === "done") {
          ui.modelStatus.textContent = `Recurso local listo: ${event.file || "modelo"}`;
        }
      }), (state) => { modelState = state; });
      if (!result.ok) throw result.error;
      ui.engineState.textContent = modelLabel();
      ui.engineState.dataset.state = modelState;
      ui.modelStatus.textContent = "Motor Kokoro local listo. La síntesis se ejecuta en este dispositivo.";
      ui.install.textContent = "Modelo descargado";
      ui.install.disabled = true;
      ui.downloadProgress.hidden = true;
      renderPlayer(player.snapshot());
      ui.test.disabled = false;
      return true;
    } catch (error) {
      modelState = "error";
      ui.engineState.textContent = modelLabel();
      ui.engineState.dataset.state = modelState;
      ui.modelStatus.textContent = `${error.message || "No se pudo inicializar Kokoro."} Puedes reintentar. No se enviará el texto a otro servicio.`;
      ui.install.textContent = "Reintentar carga local";
      ui.install.disabled = false;
      ui.downloadProgress.hidden = true;
      renderPlayer(player.snapshot());
      ui.test.disabled = true;
      return false;
    } finally {
      initializationPromise = null;
    }
  })();
  return initializationPromise;
}

async function playVoiceSample() {
  const snapshot = player.snapshot();
  const canStartSample = ["empty", "text-ready", "stopped"].includes(snapshot.status)
    || snapshot.activeKind === "preview" && ["completed", "error"].includes(snapshot.status);
  if (modelState !== "ready" || !canStartSample) return;
  await player.preview("Hello. This is a local voice sample.", { voice: ui.voice.value });
}

ui.text.addEventListener("input", () => {
  fileReadId++;
  updateTextInfo();
});
ui.clearText.addEventListener("click", () => {
  fileReadId++;
  ui.text.value = "";
  ui.fileStatus.textContent = "Texto vacío.";
  updateTextInfo();
});
ui.file.addEventListener("change", async () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  const currentReadId = ++fileReadId;
  ui.fileStatus.textContent = `Procesando ${file.name}…`;
  try {
    const text = await extractDocument(file);
    if (currentReadId !== fileReadId) return;
    if (!text.trim()) throw new Error("El documento está vacío o no contiene texto.");
    ui.text.value = text;
    ui.fileStatus.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB · texto listo para revisar.`;
    updateTextInfo();
  } catch (error) {
    if (currentReadId === fileReadId) ui.fileStatus.textContent = error.message || "No se pudo leer el archivo.";
  }
  ui.file.value = "";
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
ui.speed.addEventListener("input", () => {
  const speed = Number(ui.speed.value);
  player.setSpeed(speed);
});
ui.voice.addEventListener("change", () => { void chrome.storage.local.set({ lastVoice: ui.voice.value }); });
ui.speed.addEventListener("change", () => { void chrome.storage.local.set({ speed: Number(ui.speed.value) }); });
ui.install.addEventListener("click", () => { void initializeModel(); });
ui.test.addEventListener("click", () => { void playVoiceSample(); });
ui.play.addEventListener("click", () => {
  if (modelState === "ready") void player.play();
});
ui.pause.addEventListener("click", () => { player.pause(); });
ui.stop.addEventListener("click", () => { player.stop(); });
ui.previous.addEventListener("click", () => { void player.previous(); });
ui.next.addEventListener("click", () => { void player.next(); });
ui.seek.addEventListener("input", () => { player.seek(Number(ui.seek.value)); });
document.addEventListener("keydown", (event) => {
  const target = event.target;
  const editing = target instanceof Element && (target.isContentEditable || target.closest("input, textarea, select, button, a, [contenteditable='true'], [role='slider']"));
  if (event.defaultPrevented || event.repeat || editing) return;
  if (modelState !== "ready" || !player.snapshot().chunks.length) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (player.snapshot().status === "playing") player.pause();
    else void player.play();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    void player.previous();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    void player.next();
  }
});
ui.clearData.addEventListener("click", async () => {
  if (!confirm("Esto eliminará los modelos y preferencias de lectura guardados localmente. ¿Continuar?")) return;
  fileReadId++;
  player.stop();
  modelState = "idle";
  await provider.dispose();
  await caches.delete("edge-local-reader-kokoro-v1");
  await caches.delete("kokoro-voices");
  await chrome.storage.local.clear();
  ui.engineState.textContent = modelLabel();
  ui.engineState.dataset.state = modelState;
  ui.modelStatus.textContent = "Datos locales eliminados. Descarga de nuevo el modelo cuando quieras.";
  ui.install.disabled = false;
  ui.install.textContent = "Descargar modelo local";
  ui.test.disabled = true;
  renderPlayer(player.snapshot());
});

chrome.storage.local.get(["lastVoice", "speed"]).then((prefs) => {
  if (prefs.lastVoice && [...ui.voice.options].some((option) => option.value === prefs.lastVoice && !option.disabled)) ui.voice.value = prefs.lastVoice;
  if (prefs.speed && [...ui.speed.options].some((option) => Number(option.value) === Number(prefs.speed))) ui.speed.value = String(prefs.speed);
  player.setSpeed(Number(ui.speed.value));
});

ui.engineState.textContent = modelLabel();
ui.engineState.dataset.state = modelState;
ui.downloadProgress.hidden = true;
updateTextInfo();
ui.test.disabled = true;
