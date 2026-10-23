export function deriveReaderControls(modelState, chunkCount, audioPlaying = false, { provider = "kokoro", systemVoiceAvailable = false } = {}) {
  const modelReady = modelState === "ready";
  const providerReady = provider === "speechSynthesis" ? systemVoiceAvailable : modelReady;
  return {
    canInitialize: provider === "kokoro" && modelState !== "loading" && !modelReady,
    canPlay: providerReady && chunkCount > 0,
    canTestVoice: providerReady,
    canPause: providerReady && audioPlaying
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
