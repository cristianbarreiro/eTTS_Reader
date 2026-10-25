import { PiperTTSProvider } from "./piper-tts.js";
import { serializeErrorDiagnostics } from "./error-diagnostics.js";

export function attachPiperWorker(scope, provider = new PiperTTSProvider()) {
  let wasmPaths = null;

  const onMessage = async ({ data }) => {
    const { id, type } = data;
    const reportProgress = (event) => scope.postMessage({ id, type: "progress", event });
    try {
      let value;
      if (type === "catalog") value = provider.catalog();
      else if (type === "status") value = await provider.modelStatus(data.voiceId);
      else if (type === "list-installed") value = await provider.modelStore.listInstalled();
      else if (type === "install") value = await provider.installModel(data.voiceId, reportProgress);
      else if (type === "initialize") {
        wasmPaths = data.wasmPaths;
        value = await provider.initialize(data.voiceId, wasmPaths, reportProgress);
      } else if (type === "synthesize") {
        value = await provider.synthesize(data.text, data.voiceId, wasmPaths, reportProgress);
      } else if (type === "remove") value = await provider.removeModel(data.voiceId);
      else if (type === "dispose") {
        await provider.dispose();
        value = true;
      } else throw new Error(`Comando Piper desconocido: ${type}`);
      scope.postMessage({ id, type: "result", value });
    } catch (error) {
      const diagnostics = serializeErrorDiagnostics(error);
      scope.postMessage({
        id,
        type: "error",
        code: diagnostics.code || "PIPER_WORKER_OPERATION_FAILED",
        phase: diagnostics.phase || null,
        message: diagnostics.message || "Falló el motor Piper local.",
        diagnostics
      });
    }
  };

  scope.addEventListener("message", onMessage);
  return () => scope.removeEventListener?.("message", onMessage);
}

if (typeof self !== "undefined" && self.addEventListener) attachPiperWorker(self);
