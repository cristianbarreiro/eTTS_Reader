import { LocalKokoroProvider } from "./tts.js";

const provider = new LocalKokoroProvider();
let initializePromise = null;

self.addEventListener("message", async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === "initialize") {
      initializePromise ||= provider.initialize((event) => self.postMessage({ id, type: "progress", event }));
      await initializePromise;
      self.postMessage({ id, type: "result", value: { voices: provider.voices() } });
    } else if (type === "synthesize") {
      if (!initializePromise) throw new Error("El modelo local todavía no está listo.");
      await initializePromise;
      const blob = await provider.synthesize(data.text, { voice: data.voice, speed: 1 });
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
    self.postMessage({ id, type: "error", message: error?.message || "Falló Kokoro local." });
  }
});
