import { getVoiceProvider } from "./voice-catalog.js";

const ACTIVE_READER_STATES = new Set(["starting", "generating", "playing"]);
const BUSY_PREFIX = "STORAGE_OPERATION_BUSY:";

export function isAudioStorageBusy(snapshot, hasPendingSynthesis = false) {
  return ACTIVE_READER_STATES.has(snapshot?.status) || hasPendingSynthesis;
}

export function isProviderVoiceInUse({ snapshot, session, selectedVoiceId, provider, voiceId = null }) {
  if (!ACTIVE_READER_STATES.has(snapshot?.status)) return false;

  const activeVoiceId = snapshot.activeVoiceId
    || (snapshot.activeKind === "preview" ? selectedVoiceId : session?.voice || session?.voiceId);
  if (!activeVoiceId) return true;

  try {
    return getVoiceProvider(activeVoiceId) === provider && (!voiceId || activeVoiceId === voiceId);
  } catch {
    return true;
  }
}

export function storageOperationBusyError(message) {
  const error = new Error(`${BUSY_PREFIX} ${message}`);
  error.code = "STORAGE_OPERATION_BUSY";
  return error;
}

export function storageOperationBusyMessage(error) {
  if (error?.code === "STORAGE_OPERATION_BUSY") return error.message.replace(/^STORAGE_OPERATION_BUSY:\s*/, "");
  const message = String(error?.message || error || "");
  return message.startsWith(BUSY_PREFIX) ? message.slice(BUSY_PREFIX.length).trim() : "";
}
