export function deriveReaderControls(modelState, chunkCount, audioPlaying = false, { provider = "kokoro", systemVoiceAvailable = false, audioAvailable = false } = {}) {
  const modelReady = modelState === "ready";
  const systemProvider = provider === "speechSynthesis";
  return {
    canInitialize: !systemProvider && modelState !== "loading" && !modelReady,
    canPlay: (systemProvider ? systemVoiceAvailable : modelReady || audioAvailable) && chunkCount > 0,
    canTestVoice: systemProvider ? systemVoiceAvailable : modelReady,
    canPause: audioPlaying
  };
}

export async function attemptInitialization(initialize, onState = () => {}) {
  onState("loading");
  try {
    await initialize();
    onState("ready");
    return { ok: true };
  } catch (error) {
    onState("error");
    return { ok: false, error };
  }
}
