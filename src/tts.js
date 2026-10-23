import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";
import { resolveKokoroAssetUrls, verifyWasmAssets } from "./onnx-assets.js";

export class TTSProvider {
  async initialize() { throw new Error("initialize() no implementado"); }
  async synthesize() { throw new Error("synthesize() no implementado"); }
  async dispose() {}
}

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICES = ["af_heart", "am_michael"];
const CACHE_KEY = "edge-local-reader-kokoro-v1";

// El runtime y los embeddings están empaquetados. Solo se descargan bajo demanda los pesos del modelo.
export class LocalKokoroProvider extends TTSProvider {
  model = null;
  assetUrls = resolveKokoroAssetUrls(import.meta.url);

  async initialize(onProgress = () => {}) {
    await verifyWasmAssets(this.assetUrls);
    if (!this.model) {
      env.useBrowserCache = true;
      env.cacheKey = CACHE_KEY;
      env.backends.onnx.wasm.wasmPaths = this.assetUrls.wasmBaseUrl;
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      this.model = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (event) => onProgress(event)
      });
    }

    // Retry missing packaged voice resources without discarding the successfully loaded model or model cache.
    const cache = await caches.open("kokoro-voices");
    for (const voice of VOICES) {
      const remoteUrl = `https://huggingface.co/${MODEL_ID}/resolve/main/voices/${voice}.bin`;
      if (await cache.match(remoteUrl)) continue;
      const response = await fetch(this.assetUrls.voiceUrl(voice));
      if (!response.ok) throw new Error(`No se pudo cargar el recurso local de voz ${voice} (HTTP ${response.status}).`);
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength) throw new Error(`El recurso local de voz ${voice} está vacío.`);
      await cache.put(remoteUrl, new Response(bytes, {
        headers: { "content-type": "application/octet-stream" }
      }));
    }
  }

  voices() { return this.model ? VOICES.filter((voice) => this.model.voices[voice]) : []; }

  async synthesize(text, { voice, speed }) {
    if (!this.model) throw new Error("El modelo local no está listo.");
    if (!this.voices().includes(voice)) throw new Error("El paquete local no incluye esa voz.");
    const audio = await this.model.generate(text, { voice, speed });
    return audio.toBlob();
  }

  async dispose() { this.model = null; }
}
