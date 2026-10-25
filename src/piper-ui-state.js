export function shouldAcceptPiperOperationMessage(message, previous = {}, retiredOperationIds = new Set()) {
  const operationId = message?.operationId;
  if (!message?.voiceId || !operationId) return true;
  if (retiredOperationIds.has(operationId)) return false;
  if (previous.operationId === operationId) return true;
  const startsOperation = message.type === "reader:model-progress" || message.state === "loading";
  return startsOperation && !(previous.state === "loading" && previous.operationId);
}

export function isSelectedPiperVoiceMessage(voiceId, selectedVoiceId) {
  return Boolean(voiceId && voiceId === selectedVoiceId);
}
