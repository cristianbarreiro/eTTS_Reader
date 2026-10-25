import { formatTime } from "./audio-utils.js";

export function playerHeaderState(status) {
  return ({
    "text-ready": "Cola lista",
    starting: "Iniciando voz",
    generating: "Preparando audio",
    "audio-ready": "Audio preparado",
    playing: "Reproduciendo",
    paused: "Pausado",
    interrupted: "Lectura interrumpida",
    completed: "Completada",
    error: "Error"
  })[status] || "";
}

export function readingDurationSummary(snapshot, activeProvider = snapshot.activeProvider) {
  if (snapshot.activeKind === "preview") return `Duración de la muestra ${formatTime(snapshot.duration)}`;
  if (Number.isFinite(snapshot.totalDuration)) return `Duración total ${formatTime(snapshot.totalDuration)} · ${snapshot.knownDurationCount} fragmentos medidos`;
  const durations = Array.isArray(snapshot.durations) ? snapshot.durations : [];
  const known = durations.filter(Number.isFinite);
  const knownSeconds = known.reduce((sum, duration) => sum + duration, 0);
  const knownCaption = known.length ? formatTime(knownSeconds) : "—";
  return snapshot.chunks?.length
    ? `Duración conocida ${knownCaption} · total pendiente (${known.length}/${snapshot.chunks.length} fragmentos medidos)`
    : "La duración aparecerá cuando se genere audio.";
}

export function readingProgressCaption(snapshot) {
  if (snapshot.status === "generating") {
    if (Number.isFinite(snapshot.generationProgress)) {
      const phase = snapshot.generationPhase === "initialize" ? "Preparando voz" : "Generando audio";
      return `${phase} · ${Math.round(Math.max(0, Math.min(1, snapshot.generationProgress)) * 100)}%`;
    }
    return snapshot.generationPhase === "initialize" ? "Preparando voz local…" : "Generando audio local…";
  }
  if (!snapshot.chunks?.length && snapshot.activeKind !== "preview") return "Sin progreso";
  if (snapshot.activeKind === "preview") return "Muestra independiente";

  const progress = Number.isFinite(snapshot.totalProgress) ? snapshot.totalProgress : 0;
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  if (Number.isFinite(snapshot.totalDuration)) return `Tiempo total · ${percent}%`;
  return `Aprox. ${percent}% por fragmentos`;
}

export function kokoroEngineLabel(modelState) {
  return ({
    idle: "Kokoro local",
    cached: "Kokoro guardado",
    loading: "Cargando Kokoro",
    ready: "Kokoro listo",
    error: "Error de Kokoro"
  })[modelState] || "Kokoro local";
}
