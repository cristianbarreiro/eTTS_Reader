export function isVoicePreparedForQueue(status, voiceId) {
  if (!status || status.voiceId !== voiceId || status.state !== "ready") return false;
  if (status.provider === "kokoro") return true;
  return status.provider === "piper" && status.installed === true;
}

/**
 * Requires a fresh provider status before replacing the active queue. An
 * unprepared voice gets one explicit preparation pass; text loading is a
 * separate user action after that pass has been verified.
 */
export async function runVoiceGatedQueueLoad({
  voiceId,
  getPreparationStatus,
  prepareVoice,
  loadQueue,
  isCurrent = () => true
}) {
  if (typeof voiceId !== "string" || !voiceId) throw new TypeError("La carga necesita una voz seleccionada.");
  if (typeof getPreparationStatus !== "function" || typeof prepareVoice !== "function" || typeof loadQueue !== "function") {
    throw new TypeError("La carga necesita consultar, preparar y cargar la voz explícitamente.");
  }

  const initialStatus = await getPreparationStatus(voiceId);
  if (!isCurrent()) return { action: "stale" };
  if (!isVoicePreparedForQueue(initialStatus, voiceId)) {
    const prepared = await prepareVoice(voiceId, initialStatus);
    if (!isCurrent()) return { action: "stale" };
    if (prepared === false) {
      const error = new Error("No se pudo preparar la voz local. Puedes volver a intentarlo.");
      error.code = "VOICE_PREPARATION_FAILED";
      error.phase = "initialize";
      throw error;
    }
    const verifiedStatus = await getPreparationStatus(voiceId);
    if (!isCurrent()) return { action: "stale" };
    if (!isVoicePreparedForQueue(verifiedStatus, voiceId)) {
      const error = new Error("La voz terminó de prepararse, pero el motor no confirmó que estuviera listo. Vuelve a intentarlo.");
      error.code = "VOICE_NOT_READY_AFTER_PREPARATION";
      error.phase = "verify-preparation";
      throw error;
    }
    return { action: "voice-prepared", status: verifiedStatus };
  }

  const result = await loadQueue(voiceId);
  if (!isCurrent()) return { action: "stale" };
  return { action: "queue-loaded", result, status: initialStatus };
}
