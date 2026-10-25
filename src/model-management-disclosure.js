// Sit just beyond PiperWorkerClient's 15 second status request deadline so the
// worker can reject and clean up the request before the panel reports failure.
export const MODEL_STATUS_CHECK_TIMEOUT_MS = 16_000;

export function getVoicePreparationState(voiceId, { getVoiceProvider, piperStates, kokoroState }) {
  const provider = getVoiceProvider(voiceId);
  return provider === "piper" ? piperStates.get(voiceId)?.state || "checking" : kokoroState;
}

export function createModelManagementDisclosure({ details, getSelectedVoiceId, getPreparationState }) {
  if (!details || typeof getSelectedVoiceId !== "function" || typeof getPreparationState !== "function") {
    throw new TypeError("La gestión del modelo necesita el desplegable y el estado de la voz seleccionada.");
  }

  const openIfPreparationNeeded = (state) => {
    if (state === "checking" || state === "ready" || details.open) return false;
    details.open = true;
    return true;
  };

  return {
    onVoiceSelection(voiceId = getSelectedVoiceId()) {
      if (!voiceId) return false;
      return openIfPreparationNeeded(getPreparationState(voiceId));
    },
    onProviderStateChange(voiceId, previousState, nextState) {
      if (voiceId !== getSelectedVoiceId() || previousState === nextState) return false;
      return openIfPreparationNeeded(nextState);
    }
  };
}

export function withBoundedWait(operation, timeoutMs, timeoutMessage) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("El límite de espera debe ser mayor que cero.");
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => clearTimeout(timeoutId));
}
