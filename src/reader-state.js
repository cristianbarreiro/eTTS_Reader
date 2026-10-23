export function deriveReaderControls(modelState, chunkCount, audioPlaying = false) {
  const modelReady = modelState === "ready";
  return {
    canInitialize: modelState !== "loading" && !modelReady,
    canPlay: modelReady && chunkCount > 0,
    canTestVoice: modelReady,
    canPause: modelReady && audioPlaying
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
