import { formatTime } from "./audio-utils.js";

export function playerHeaderState(status) {
  return ({
    "text-ready": "Cola lista",
    starting: "Iniciando voz",
    generating: "Preparando audio",
    "audio-ready": "Fragmento listo",
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
  if (snapshot.status === "generating" && snapshot.chunks?.length && known.length === 0) {
    return `Preparando el primer WAV · duración disponible al terminar el fragmento ${snapshot.selectedIndex + 1}/${snapshot.chunks.length}`;
  }
  if (snapshot.status === "generating" && known.length > 0) {
    return `Audio en preparación · duración medida ${formatTime(knownSeconds)} (${known.length}/${snapshot.chunks.length} fragmentos)`;
  }
  const knownCaption = known.length ? formatTime(knownSeconds) : "—";
  return snapshot.chunks?.length
    ? `Duración conocida ${knownCaption} · total pendiente (${known.length}/${snapshot.chunks.length} fragmentos medidos)`
    : "La duración aparecerá cuando se genere audio.";
}

export function readingProgressCaption(snapshot) {
  if (snapshot.status === "generating") {
    const elapsed = Number.isFinite(snapshot.generationElapsedMs)
      ? formatTime(Math.floor(snapshot.generationElapsedMs / 1000)) : "";
    const elapsedSuffix = elapsed ? ` · ${elapsed} transcurridos` : "";
    const fragment = Number.isInteger(snapshot.generationFragmentIndex)
      && Number.isInteger(snapshot.generationFragmentTotal)
      ? ` · fragmento ${snapshot.generationFragmentIndex}/${snapshot.generationFragmentTotal}` : "";
    if (snapshot.generationStage === "model-generate") {
      const part = Number.isInteger(snapshot.generationTotalParts) && snapshot.generationTotalParts > 1
        ? ` · parte ${Math.max(1, Number(snapshot.generationCompletedParts) + 1)}/${snapshot.generationTotalParts}` : "";
      return `Inferencia local${fragment}${part}${elapsedSuffix}`;
    }
    if (snapshot.generationStage === "part-complete") {
      const completed = Math.max(0, Number(snapshot.generationCompletedParts) || 0);
      const total = Math.max(1, Number(snapshot.generationTotalParts) || 1);
      const progress = Number.isFinite(snapshot.generationProgress)
        ? Math.round(Math.max(0, Math.min(1, snapshot.generationProgress)) * 100) : Math.round(completed / total * 100);
      return `Partes procesadas · ${completed}/${total} · ${progress}%${elapsedSuffix}`;
    }
    if (["assemble-audio", "wav-conversion", "wav-created", "validating-wav", "saving-cache", "audio-cached", "invalid-cached-wav", "fragment-ready", "document-audio-ready"].includes(snapshot.generationStage)) {
      const labels = {
        "assemble-audio": "Ensamblando audio",
        "wav-conversion": "Convirtiendo a WAV",
        "wav-created": "WAV generado · validando",
        "validating-wav": "Validando WAV",
        "saving-cache": "Guardando audio local",
        "audio-cached": "Audio guardado localmente",
        "invalid-cached-wav": "Audio guardado inválido · regenerando",
        "fragment-ready": "Fragmento validado y guardado",
        "document-audio-ready": "Documento completo preparado"
      };
      return `${labels[snapshot.generationStage]}${fragment}${elapsedSuffix}`;
    }
    if (Number.isInteger(snapshot.generationTotalParts) && snapshot.generationTotalParts > 1) {
      const completed = Math.max(0, Math.min(snapshot.generationTotalParts, Number(snapshot.generationCompletedParts) || 0));
      if (Number.isFinite(snapshot.generationProgress)) {
        const progress = Math.round(Math.max(0, Math.min(1, snapshot.generationProgress)) * 100);
        return completed >= snapshot.generationTotalParts
          ? `Ensamblando el WAV · ${progress}%${elapsedSuffix}`
          : `Partes procesadas · ${completed}/${snapshot.generationTotalParts} · ${progress}%${elapsedSuffix}`;
      }
      return `Generando audio${fragment} · parte ${completed + 1}/${snapshot.generationTotalParts}${elapsedSuffix}`;
    }
    if (Number.isFinite(snapshot.generationProgress)) {
      const phase = snapshot.generationPhase === "initialize" ? "Preparando voz" : "Generando audio";
      return `${phase}${fragment} · ${Math.round(Math.max(0, Math.min(1, snapshot.generationProgress)) * 100)}%${elapsedSuffix}`;
    }
    const phase = snapshot.generationPhase === "initialize" ? "Preparando voz local" : "Generando audio local";
    return `${phase}${fragment}${elapsedSuffix}`;
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
