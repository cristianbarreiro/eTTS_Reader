export function deriveReaderControls(modelState, chunkCount, audioPlaying = false, {
  provider = "kokoro", audioAvailable = false, allowLazyVoiceTest = false
} = {}) {
  const modelReady = modelState === "ready";
  const piperProvider = provider === "piper";
  const lazyVoiceTestAvailable = allowLazyVoiceTest && (piperProvider
    ? modelState === "cached"
    : ["idle", "cached"].includes(modelState));
  return {
    canInitialize: modelState !== "loading" && !modelReady,
    canPlay: audioAvailable && chunkCount > 0,
    canTestVoice: modelReady,
    canRequestVoiceTest: modelReady || lazyVoiceTestAvailable,
    canPause: audioPlaying
  };
}

export async function prepareAndRunVoiceTest({ provider, modelState, initialize, runTest }) {
  if (["piper", "kokoro"].includes(provider) && modelState !== "ready") {
    const initialized = await initialize();
    if (!initialized) return false;
  }
  await runTest();
  return true;
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
