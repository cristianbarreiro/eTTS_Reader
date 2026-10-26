import { LocalKokoroProvider } from "./tts.js";
import { serializeErrorDiagnostics } from "./error-diagnostics.js";

const provider = new LocalKokoroProvider();
let initializePromise = null;

self.addEventListener("message", async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "initialize") {
      initializePromise ||= provider.initialize((event) => self.postMessage({ id, type: "progress", event: { ...event, phase: event?.phase || "initialize" } }));
      await initializePromise;
      self.postMessage({ id, type: "result", value: { voices: provider.voices() } });
    } else if (type === "synthesize") {
      if (!initializePromise) throw new Error("El modelo local todavía no está listo.");
      await initializePromise;
      self.postMessage({ id, type: "progress", event: {
        phase: "synthesis", stage: "request-started", requestId: id,
        voiceId: data.voice, textLength: String(data.text || "").length
      } });
      const blob = await provider.synthesize(data.text, {
        voice: data.voice,
        speed: 1,
        onProgress: (event) => self.postMessage({ id, type: "progress", event: {
          ...event, phase: "synthesis", requestId: id,
          voiceId: data.voice, textLength: String(data.text || "").length
        } })
      });
      self.postMessage({ id, type: "progress", event: {
        phase: "synthesis", stage: "synthesis-complete", requestId: id,
        voiceId: data.voice, textLength: String(data.text || "").length
      } });
      self.postMessage({ id, type: "result", value: blob });
    } else if (type === "dispose") {
      await provider.dispose();
      initializePromise = null;
      self.postMessage({ id, type: "result", value: true });
    } else {
      throw new Error(`Comando de inferencia desconocido: ${type}`);
    }
  } catch (error) {
    if (type === "initialize") initializePromise = null;
    const diagnostics = {
      ...serializeErrorDiagnostics(error),
      requestId: id,
      ...(type === "synthesize" ? { voiceId: String(data.voice || ""), textLength: String(data.text || "").length } : {})
    };
    self.postMessage({
      id, type: "error",
      code: diagnostics.code || "KOKORO_WORKER_OPERATION_FAILED",
      phase: diagnostics.phase || (type === "synthesize" ? "synthesis" : "initialize"),
      message: diagnostics.message || "Falló Kokoro local.",
      diagnostics
    });
  }
});
