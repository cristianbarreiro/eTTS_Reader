export function resolveKokoroAssetUrls(moduleUrl) {
  const wasmBaseUrl = new URL("../ort/", moduleUrl).href;
  return {
    wasmBaseUrl,
    moduleUrl: new URL("ort-wasm-simd-threaded.jsep.mjs", wasmBaseUrl).href,
    wasmUrl: new URL("ort-wasm-simd-threaded.jsep.wasm", wasmBaseUrl).href,
    voiceUrl: (voice) => new URL(`../voices/${voice}.bin`, moduleUrl).href
  };
}

export async function verifyWasmAssets(urls, fetchImpl = fetch) {
  const moduleResponse = await fetchImpl(urls.moduleUrl, { cache: "no-store" });
  if (!moduleResponse.ok) {
    throw new Error(`No se pudo cargar el módulo ONNX local (HTTP ${moduleResponse.status}): ${urls.moduleUrl}`);
  }
  const moduleMime = moduleResponse.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (moduleMime && !["application/javascript", "text/javascript", "application/ecmascript", "text/ecmascript"].includes(moduleMime)) {
    throw new Error(`El módulo ONNX local tiene un tipo MIME incompatible (${moduleMime}): ${urls.moduleUrl}`);
  }
  const moduleText = await moduleResponse.text();
  if (!moduleText.trim() || /<\s*!doctype html/i.test(moduleText)) {
    throw new Error(`El módulo ONNX local está vacío o no es JavaScript: ${urls.moduleUrl}`);
  }

  const wasmResponse = await fetchImpl(urls.wasmUrl, { method: "HEAD", cache: "no-store" });
  if (!wasmResponse.ok) {
    throw new Error(`No se pudo localizar el binario WASM local (HTTP ${wasmResponse.status}): ${urls.wasmUrl}`);
  }
  const wasmMime = wasmResponse.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (wasmMime && wasmMime !== "application/wasm") {
    throw new Error(`El binario WASM local tiene un tipo MIME incompatible (${wasmMime}): ${urls.wasmUrl}`);
  }
}
