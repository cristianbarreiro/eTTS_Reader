export function playerHeaderState(status) {
  return ({
    generating: "Preparando audio",
    "audio-ready": "Audio preparado",
    playing: "Reproduciendo",
    paused: "Pausado",
    interrupted: "Lectura interrumpida",
    completed: "Completada",
    error: "Error"
  })[status] || "";
}

export function readingProgressCaption(snapshot) {
  if (!snapshot.chunks?.length && snapshot.activeKind !== "preview") return "Sin progreso";
  if (snapshot.activeKind === "preview") return "Muestra independiente";

  const progress = Number.isFinite(snapshot.totalProgress) ? snapshot.totalProgress : 0;
  const percent = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  if (snapshot.activeProvider === "speechSynthesis") return `Aprox. ${percent}% por texto`;
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
