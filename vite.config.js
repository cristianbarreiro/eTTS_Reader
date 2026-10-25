import { defineConfig } from "vite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const kokoroRuntimeFiles = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
const voiceFiles = ["af_heart.bin", "am_michael.bin"];
const readPackage = (path) => JSON.parse(readFileSync(resolve(path), "utf8"));

export default defineConfig({
  base: "./",
  publicDir: "public",
  // Kokoro must resolve the ONNX Runtime version nested under Transformers.js;
  // Piper imports the separately pinned root runtime directly.
  resolve: { dedupe: ["@huggingface/transformers"] },
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
      const kokoroOnnxPath = "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/package.json";
      const kokoroOnnx = readPackage(kokoroOnnxPath);
      const expectedKokoro = transformers.dependencies?.["onnxruntime-web"];
      if (expectedKokoro !== kokoroOnnx.version) {
        throw new Error(`Kokoro ONNX Runtime mismatch: Transformers.js requests ${expectedKokoro}, installed ${kokoroOnnx.version}`);
      }
      const kokoroRuntimeFrom = resolve("node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist");
      const kokoroRuntimeTo = resolve("dist/ort");
      mkdirSync(kokoroRuntimeTo, { recursive: true });
      for (const file of kokoroRuntimeFiles) {
        const source = resolve(kokoroRuntimeFrom, file);
        const sourceBytes = readFileSync(source);
        if (!sourceBytes.length) throw new Error(`Kokoro ONNX Runtime asset is empty: ${source}`);
        const destination = resolve(kokoroRuntimeTo, file);
        if (!existsSync(destination) || !readFileSync(destination).equals(sourceBytes)) copyFileSync(source, destination);
      }

      const piperOnnx = readPackage("node_modules/onnxruntime-web/package.json");
      if (piperOnnx.version !== "1.22.0") throw new Error(`Piper expects onnxruntime-web@1.22.0, installed ${piperOnnx.version}`);
      const piperRuntimeFrom = resolve("node_modules/onnxruntime-web/dist");
      const piperRuntimeTo = resolve("dist/ort/piper");
      mkdirSync(piperRuntimeTo, { recursive: true });
      const piperRuntimeFiles = readdirSync(piperRuntimeFrom).filter((file) => /^ort-wasm-.*\.(?:mjs|wasm)$/.test(file));
      if (!piperRuntimeFiles.some((file) => file === "ort-wasm-simd-threaded.mjs")
          || !piperRuntimeFiles.some((file) => file === "ort-wasm-simd-threaded.wasm")) {
        throw new Error("Piper ONNX Runtime WASM/CPU assets are missing from the installed dependency.");
      }
      for (const file of piperRuntimeFiles) {
        const source = resolve(piperRuntimeFrom, file);
        const sourceBytes = readFileSync(source);
        if (!sourceBytes.length) throw new Error(`Piper ONNX Runtime asset is empty: ${source}`);
        const destination = resolve(piperRuntimeTo, file);
        if (!existsSync(destination) || !readFileSync(destination).equals(sourceBytes)) copyFileSync(source, destination);
      }

      const voicesFrom = resolve("node_modules/kokoro-js/voices");
      const voicesTo = resolve("dist/voices");
      mkdirSync(voicesTo, { recursive: true });
      for (const file of voiceFiles) {
        const source = resolve(voicesFrom, file);
        const destination = resolve(voicesTo, file);
        if (!existsSync(destination) || !readFileSync(destination).equals(readFileSync(source))) copyFileSync(source, destination);
      }

      const phonemizerFrom = resolve("node_modules/@diffusionstudio/piper-wasm/build");
      const phonemizerTo = resolve("dist/piper");
      mkdirSync(phonemizerTo, { recursive: true });
      for (const file of ["piper_phonemize.wasm", "piper_phonemize.data"]) {
        const source = resolve(phonemizerFrom, file);
        if (!readFileSync(source).length) throw new Error(`Piper phonemizer asset is empty: ${source}`);
        const destination = resolve(phonemizerTo, file);
        if (!existsSync(destination) || !readFileSync(destination).equals(readFileSync(source))) copyFileSync(source, destination);
      }
    }
  }]
});
