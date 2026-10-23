import { defineConfig } from "vite";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const runtimeFiles = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
const voiceFiles = ["af_heart.bin", "am_michael.bin"];
const readPackage = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));

export default defineConfig({
  base: "./",
  publicDir: "public",
  resolve: { dedupe: ["@huggingface/transformers", "onnxruntime-web"] },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        assetFileNames(asset) {
          const names = [asset.name, ...(asset.names || []), ...(asset.originalFileNames || [])].filter(Boolean);
          if (names.some((name) => name.startsWith("ort-wasm-simd-threaded.jsep"))) return "ort/ort-wasm-simd-threaded.jsep.wasm";
          return "assets/[name]-[hash][extname]";
        }
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: {
        sidepanel: resolve("sidepanel.html"),
        offscreen: resolve("offscreen.html"),
        background: resolve("src/background.js")
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames(asset) {
          const names = [asset.name, ...(asset.names || []), ...(asset.originalFileNames || [])].filter(Boolean);
          if (names.some((name) => name.startsWith("ort-wasm-simd-threaded.jsep"))) return "ort/ort-wasm-simd-threaded.jsep.wasm";
          return "assets/[name]-[hash][extname]";
        }
      }
    }
  },
  plugins: [{
    name: "copy-version-matched-onnx-assets",
    closeBundle() {
      const transformers = readPackage("node_modules/@huggingface/transformers/package.json");
      const onnx = readPackage("node_modules/onnxruntime-web/package.json");
      const expected = transformers.dependencies?.["onnxruntime-web"];
      if (expected !== onnx.version) {
        throw new Error(`ONNX Runtime version mismatch: Transformers.js requests ${expected}, installed ${onnx.version}`);
      }
      const runtimeFrom = resolve("node_modules/onnxruntime-web/dist");
      const runtimeTo = resolve("dist/ort");
      mkdirSync(runtimeTo, { recursive: true });
      for (const file of runtimeFiles) {
        const source = resolve(runtimeFrom, file);
        if (!readFileSync(source).length) throw new Error(`ONNX Runtime asset is empty: ${source}`);
        copyFileSync(source, resolve(runtimeTo, file));
      }
      const voicesFrom = resolve("node_modules/kokoro-js/voices");
      const voicesTo = resolve("dist/voices");
      mkdirSync(voicesTo, { recursive: true });
      for (const file of voiceFiles) copyFileSync(resolve(voicesFrom, file), resolve(voicesTo, file));
    }
  }]
});
