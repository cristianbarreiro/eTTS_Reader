import { sha256 } from "@noble/hashes/sha2.js";
import { PIPER_VOICE_CATALOG, getVoiceRecord } from "./voice-catalog.js";

export const PIPER_OPFS_DIRECTORY = "etts-piper-models";
export const PIPER_MANIFEST_FILE = "installed-models.json";
export const PIPER_DOWNLOAD_TIMEOUTS = Object.freeze({
  config: Object.freeze({ totalMs: 60_000, inactivityMs: 20_000 }),
  model: Object.freeze({ totalMs: 10 * 60_000, inactivityMs: 45_000 })
});
const PIPER_REPOSITORY = "https://huggingface.co/rhasspy/piper-voices/resolve";
const MAX_CONFIG_BYTES = 32 * 1024;
const MANIFEST_TRUSTED = Symbol("manifest-trusted");

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function piperError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "PiperModelError";
  error.code = code;
  Object.assign(error, details);
  return error;
}

function markManifest(manifest, trusted) {
  Object.defineProperty(manifest, MANIFEST_TRUSTED, { value: trusted, configurable: true });
  return manifest;
}

function emptyManifest(trusted = false) { return markManifest({ version: 1, models: {} }, trusted); }

function isSafeManifestFileName(value, suffix) {
  return typeof value === "string" && value.length <= 160
    && /^[a-zA-Z0-9_.-]+$/.test(value) && !value.startsWith(".") && value.endsWith(suffix);
}

function isValidManifestRecord(record, voiceId) {
  return Boolean(record && typeof record === "object"
    && record.voiceId === voiceId
    && /^[a-f0-9]{40}$/i.test(record.modelRevision || "")
    && /^[a-f0-9]{64}$/i.test(record.sha256 || "")
    && isSafeManifestFileName(record.modelFile, ".onnx")
    && isSafeManifestFileName(record.configFile, ".onnx.json")
    && Number.isSafeInteger(record.modelSizeBytes) && record.modelSizeBytes > 0
    && Number.isInteger(record.configSizeBytes) && record.configSizeBytes > 0 && record.configSizeBytes <= MAX_CONFIG_BYTES
    && Number.isFinite(record.installedAt));
}

function validateConfig(config, voice) {
  const languageCode = config?.language?.code;
  const sampleRate = Number(config?.audio?.sample_rate);
  const ids = config?.phoneme_id_map;
  const inference = config?.inference;
  // Older pinned Piper v1 configs may omit `language` entirely. The catalog
  // remains the source of truth for the voice locale; if the config includes
  // a language code, still verify that it agrees with the selected voice.
  if ((languageCode != null && languageCode !== voice.languageCode) || sampleRate !== voice.sampleRate
      || config?.phoneme_type !== "espeak" || !config?.espeak?.voice
      || !ids || typeof ids !== "object" || !Object.keys(ids).length
      || !Number.isFinite(Number(inference?.noise_scale))
      || !Number.isFinite(Number(inference?.length_scale))
      || !Number.isFinite(Number(inference?.noise_w))) {
    throw new Error(`La configuración de ${voice.label} no coincide con los metadatos del catálogo.`);
  }
  return config;
}

function createTransferGuard({ controller, totalMs, inactivityMs, label }) {
  let finished = false;
  let idleTimer = null;
  let totalTimer = null;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const expire = (kind) => {
    if (finished) return;
    finished = true;
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    const code = "PIPER_DOWNLOAD_TIMEOUT";
    const message = kind === "total"
      ? `La descarga Piper de ${label} superó el límite máximo de tiempo.`
      : `La descarga Piper de ${label} dejó de avanzar durante ${Math.round(inactivityMs / 1000)} segundos.`;
    const error = piperError(code, message, { phase: "download", timeoutKind: kind });
    rejectTimeout(error);
    try { controller?.abort(error); } catch { controller?.abort(); }
  };
  totalTimer = setTimeout(() => expire("total"), totalMs);
  const touch = () => {
    if (finished || !inactivityMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => expire("inactivity"), inactivityMs);
  };
  touch();
  return {
    signal: controller?.signal,
    timeout,
    race: (promise) => Promise.race([Promise.resolve(promise), timeout]),
    touch,
    finish() {
      if (finished) return;
      finished = true;
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
    }
  };
}

async function readResponseText(response, url, guard, maxBytes = MAX_CONFIG_BYTES, onProgress = () => {}) {
  if (!response?.ok) throw piperError("PIPER_HTTP_ERROR", `No se pudo descargar el archivo Piper (HTTP ${response?.status || 0}): ${url}`, { phase: "download", httpStatus: response?.status || 0 });
  const declared = Number(response.headers?.get?.("content-length")) || 0;
  if (declared > maxBytes) throw new Error(`La configuración Piper supera el tamaño permitido (${declared} bytes).`);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await guard.race(response.text());
    if (!text || new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("La configuración Piper está vacía o supera el tamaño permitido.");
    try { onProgress({ loaded: new TextEncoder().encode(text).byteLength, total: declared || undefined, indeterminate: !declared }); } catch { /* Progress is advisory. */ }
    return text;
  }
  const chunks = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await guard.race(reader.read());
      if (done) break;
      loaded += value?.byteLength || 0;
      if (!value || loaded > maxBytes) throw new Error("La configuración Piper está vacía o supera el tamaño permitido.");
      guard.touch();
      chunks.push(value);
      try { onProgress({ loaded, total: declared || undefined, indeterminate: !declared, ...(declared ? { progress: Math.min(100, loaded / declared * 100) } : {}) }); } catch { /* Progress is advisory. */ }
    }
  } catch (error) {
    await reader.cancel?.().catch?.(() => {});
    throw error;
  }
  if (!loaded) throw new Error("La configuración Piper está vacía o supera el tamaño permitido.");
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export class PiperModelStore {
  constructor({ storage = globalThis.navigator?.storage, fetchImpl = globalThis.fetch, now = () => Date.now(), catalog = PIPER_VOICE_CATALOG, downloadTimeouts = PIPER_DOWNLOAD_TIMEOUTS } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Piper necesita una función fetch para descargar los modelos.");
    this.storage = storage;
    // fetch is a Web IDL method. Calling it as this.fetchImpl(...) would bind
    // `this` to the store, not to WorkerGlobalScope, and Edge throws
    // "Illegal invocation". Keep the browser global as its receiver.
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.now = now;
    this.catalog = catalog;
    this.downloadTimeouts = downloadTimeouts;
    this.installs = new Map();
    this.recoveryPromise = null;
  }

  async _directory() {
    if (typeof this.storage?.getDirectory !== "function") {
      throw new Error("Este contexto de Edge no ofrece almacenamiento OPFS para modelos Piper.");
    }
    return (await this.storage.getDirectory()).getDirectoryHandle(PIPER_OPFS_DIRECTORY, { create: true });
  }

  _modelUrl(voice) {
    return `${PIPER_REPOSITORY}/${voice.modelRevision}/${voice.modelPath}`;
  }

  _configUrl(voice) {
    return `${PIPER_REPOSITORY}/${voice.modelRevision}/${voice.modelPath}.json`;
  }

  _modelFileName(voice) {
    return `${voice.providerVoiceId}-${voice.modelRevision.slice(0, 12)}.onnx`;
  }

  _configFileName(voice) {
    return `${voice.providerVoiceId}-${voice.modelRevision.slice(0, 12)}.onnx.json`;
  }

  async _readManifest(directory) {
    let file;
    try { file = await (await directory.getFileHandle(PIPER_MANIFEST_FILE)).getFile(); }
    catch (error) {
      if (error?.name === "NotFoundError") return emptyManifest(true);
      throw error;
    }
    try {
      const manifest = JSON.parse(await file.text());
      if (manifest?.version !== 1 || !manifest.models || typeof manifest.models !== "object" || Array.isArray(manifest.models)) return emptyManifest(false);
      for (const [voiceId, record] of Object.entries(manifest.models)) {
        if (!isValidManifestRecord(record, voiceId)) return emptyManifest(false);
      }
      return markManifest(manifest, true);
    } catch {
      return emptyManifest(false);
    }
  }

  async _writeManifest(directory, manifest) {
    if (!manifest?.[MANIFEST_TRUSTED]) {
      throw piperError("PIPER_MANIFEST_INVALID", "El registro local de modelos Piper no es válido; se protegieron los archivos existentes y no se sobrescribió.", { phase: "manifest" });
    }
    const handle = await directory.getFileHandle(PIPER_MANIFEST_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest));
    await writable.close();
  }

  async _recoverArtifacts(directory) {
    if (this.recoveryPromise) return this.recoveryPromise;
    const recovery = (async () => {
      const manifest = await this._readManifest(directory);
      const referenced = new Set();
      if (manifest[MANIFEST_TRUSTED]) {
        for (const record of Object.values(manifest.models)) {
          referenced.add(record.modelFile);
          referenced.add(record.configFile);
        }
      }
      for (const voice of this.catalog) {
        if (this.installs.has(voice.id)) continue;
        const modelFile = this._modelFileName(voice);
        const configFile = this._configFileName(voice);
        await directory.removeEntry(`${modelFile}.partial`).catch(() => {});
        await directory.removeEntry(`${configFile}.partial`).catch(() => {});
        // If the manifest cannot be trusted, only disposable staging files are
        // removed. Final files remain untouched until their ownership is known.
        if (manifest[MANIFEST_TRUSTED]) {
          if (!referenced.has(modelFile)) await directory.removeEntry(modelFile).catch(() => {});
          if (!referenced.has(configFile)) await directory.removeEntry(configFile).catch(() => {});
        }
      }
      return manifest;
    })();
    this.recoveryPromise = recovery;
    try { return await recovery; }
    finally { if (this.recoveryPromise === recovery) this.recoveryPromise = null; }
  }

  async _readConfig(directory, fileName, voice) {
    const file = await (await directory.getFileHandle(fileName)).getFile();
    if (file.size > MAX_CONFIG_BYTES) throw new Error("La configuración Piper guardada supera el tamaño permitido.");
    return validateConfig(JSON.parse(await file.text()), voice);
  }

  async status(voiceId) {
    const voice = this.catalog.find((item) => item.id === voiceId);
    if (!voice) throw new TypeError(`Identificador de voz Piper desconocido: ${String(voiceId)}.`);
    const directory = await this._directory();
    const manifest = await this._recoverArtifacts(directory);
    if (!manifest[MANIFEST_TRUSTED]) return { voiceId, installed: false, modelSizeBytes: voice.modelSizeBytes, reason: "manifest-invalid" };
    const record = manifest.models[voice.id];
    if (!record || record.modelRevision !== voice.modelRevision || record.sha256 !== voice.modelSha256) {
      return { voiceId, installed: false, modelSizeBytes: voice.modelSizeBytes };
    }
    try {
      const model = await (await directory.getFileHandle(record.modelFile)).getFile();
      const config = await this._readConfig(directory, record.configFile, voice);
      if (model.size !== voice.modelSizeBytes) return { voiceId, installed: false, modelSizeBytes: voice.modelSizeBytes, reason: "size-mismatch" };
      return {
        voiceId,
        installed: true,
        modelSizeBytes: model.size,
        configSizeBytes: (await (await directory.getFileHandle(record.configFile)).getFile()).size,
        modelRevision: voice.modelRevision,
        config
      };
    } catch (error) {
      if (error?.name === "NotFoundError") return { voiceId, installed: false, modelSizeBytes: voice.modelSizeBytes };
      return { voiceId, installed: false, modelSizeBytes: voice.modelSizeBytes, reason: error?.message || "invalid-model" };
    }
  }

  async listInstalled() {
    return Promise.all(this.catalog.map((voice) => this.status(voice.id)));
  }

  install(voiceId, onProgress = () => {}) {
    const voice = this.catalog.find((item) => item.id === voiceId);
    if (!voice) return Promise.reject(new TypeError(`Identificador de voz Piper desconocido: ${String(voiceId)}.`));
    const pending = this.installs.get(voiceId);
    if (pending) return pending;
    const task = this._install(voice, onProgress).finally(() => this.installs.delete(voiceId));
    this.installs.set(voiceId, task);
    return task;
  }

  async _fetchConfig(voice, onProgress) {
    const url = this._configUrl(voice);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const guard = createTransferGuard({ controller, ...this.downloadTimeouts.config, label: "la configuración" });
    try {
      const response = await guard.race(this.fetchImpl(url, { cache: "no-store", ...(guard.signal ? { signal: guard.signal } : {}) }));
      const text = await readResponseText(response, url, guard, MAX_CONFIG_BYTES, (event) => onProgress({ phase: "download", stage: "downloading-config", voiceId: voice.id, file: "config", ...event }));
      onProgress({ phase: "download", stage: "config-ready", voiceId: voice.id, file: "config", loaded: new TextEncoder().encode(text).byteLength, total: new TextEncoder().encode(text).byteLength, progress: 100 });
      return text;
    } catch (error) {
      try { controller?.abort(error); } catch { controller?.abort(); }
      if (error?.code) throw error;
      if (error?.name === "TypeError" || error?.name === "NetworkError") {
        throw piperError("PIPER_NETWORK_ERROR", `Falló la descarga de la configuración Piper. Comprueba la conexión e inténtalo de nuevo. ${error.message || ""}`.trim(), { phase: "download" });
      }
      throw error;
    } finally { guard.finish(); }
  }

  async _downloadModel(voice, directory, temporaryName, onProgress) {
    const url = this._modelUrl(voice);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const guard = createTransferGuard({ controller, ...this.downloadTimeouts.model, label: "el modelo" });
    let reader = null;
    let writer = null;
    let loaded = 0;
    const digest = sha256.create();
    const declaredTotalFallback = voice.modelSizeBytes;
    const temporaryHandle = await directory.getFileHandle(temporaryName, { create: true });
    try {
      const response = await guard.race(this.fetchImpl(url, { cache: "no-store", ...(guard.signal ? { signal: guard.signal } : {}) }));
      if (!response?.ok) throw piperError("PIPER_HTTP_ERROR", `No se pudo descargar el modelo Piper (HTTP ${response?.status || 0}).`, { phase: "download", httpStatus: response?.status || 0 });
      reader = response.body?.getReader?.();
      if (!reader) throw piperError("PIPER_UNVERIFIABLE_RESPONSE", "La descarga del modelo Piper no ofrece un flujo verificable.", { phase: "download" });
      writer = await temporaryHandle.createWritable();
      const declaredTotal = Number(response.headers?.get?.("content-length")) || declaredTotalFallback;
      onProgress({ phase: "download", stage: "downloading-model", voiceId: voice.id, file: "model", loaded: 0, total: declaredTotal, indeterminate: true });
      while (true) {
        const { done, value } = await guard.race(reader.read());
        if (done) break;
        if (!value?.byteLength) continue;
        guard.touch();
        loaded += value.byteLength;
        if (loaded > voice.modelSizeBytes) throw new Error("La descarga Piper excede el tamaño verificado del modelo.");
        digest.update(value);
        await guard.race(writer.write(value));
        try { onProgress({ phase: "download", stage: "downloading-model", voiceId: voice.id, file: "model", loaded, total: declaredTotal, progress: Math.min(100, loaded / declaredTotal * 100) }); } catch { /* Progress is advisory. */ }
      }
      await guard.race(writer.close());
      writer = null;
      return { temporaryHandle, loaded, actualHash: toHex(digest.digest()) };
    } catch (error) {
      try { controller?.abort(error); } catch { controller?.abort(); }
      await reader?.cancel?.().catch?.(() => {});
      await writer?.abort?.().catch?.(() => {});
      await directory.removeEntry(temporaryName).catch(() => {});
      if (!error?.code && (error?.name === "TypeError" || error?.name === "NetworkError")) {
        throw piperError("PIPER_NETWORK_ERROR", `Falló la descarga del modelo Piper. Comprueba la conexión e inténtalo de nuevo. ${error.message || ""}`.trim(), { phase: "download" });
      }
      throw error;
    } finally { guard.finish(); }
  }

  async _copyFile(directory, sourceHandle, targetName, onProgress = () => {}, stage = "saving-model", voiceId = null) {
    const source = await sourceHandle.getFile();
    const reader = source.stream().getReader();
    const writer = await (await directory.getFileHandle(targetName, { create: true })).createWritable();
    let loaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        loaded += value?.byteLength || 0;
        try { onProgress({ phase: "download", stage, voiceId, file: targetName, loaded, total: source.size, progress: source.size ? Math.min(100, loaded / source.size * 100) : 100 }); } catch { /* Progress is advisory. */ }
      }
      await writer.close();
    } catch (error) {
      await reader.cancel?.().catch?.(() => {});
      await writer.abort?.().catch?.(() => {});
      throw error;
    }
  }

  async _install(voice, onProgress) {
    const existing = await this.status(voice.id);
    if (existing.installed) return existing;
    if (existing.reason === "manifest-invalid") throw piperError("PIPER_MANIFEST_INVALID", "El registro local de modelos Piper no es válido. Se conservaron los archivos; no es seguro sobrescribirlo automáticamente.", { phase: "manifest" });
    const directory = await this._directory();
    const manifest = await this._readManifest(directory);
    if (!manifest[MANIFEST_TRUSTED]) throw piperError("PIPER_MANIFEST_INVALID", "El registro local de modelos Piper no es válido. Se conservaron los archivos; no es seguro sobrescribirlo automáticamente.", { phase: "manifest" });
    const previous = manifest.models[voice.id];
    const modelFile = this._modelFileName(voice);
    const configFile = this._configFileName(voice);
    const temporaryName = `${modelFile}.partial`;
    const temporaryConfigName = `${configFile}.partial`;
    const preserveExistingModel = previous?.modelFile === modelFile;
    const preserveExistingConfig = previous?.configFile === configFile;
    let modelCommitted = false;
    let configCommitted = false;

    try {
      try { onProgress({ phase: "download", stage: "downloading-config", voiceId: voice.id, file: "config", indeterminate: true }); } catch { /* Progress is advisory. */ }
      const configText = await this._fetchConfig(voice, onProgress);
      let config;
      try { config = validateConfig(JSON.parse(configText), voice); }
      catch (error) { throw piperError("PIPER_CONFIG_INVALID", `No se pudo validar la configuración Piper descargada: ${error.message}`, { phase: "config" }); }

      const staged = await this._downloadModel(voice, directory, temporaryName, onProgress);
      if (staged.loaded !== voice.modelSizeBytes || staged.actualHash !== voice.modelSha256) {
        throw piperError("PIPER_MODEL_INTEGRITY", `El modelo Piper no superó la verificación de integridad (tamaño ${staged.loaded}/${voice.modelSizeBytes}, SHA-256 ${staged.actualHash}).`, { phase: "verify" });
      }

      const configTemp = await directory.getFileHandle(temporaryConfigName, { create: true });
      const configWriter = await configTemp.createWritable();
      try { await configWriter.write(configText); await configWriter.close(); }
      catch (error) { await configWriter.abort?.().catch?.(() => {}); throw error; }

      await this._copyFile(directory, configTemp, configFile, onProgress, "saving-config", voice.id);
      configCommitted = true;
      await this._copyFile(directory, staged.temporaryHandle, modelFile, onProgress, "saving-model", voice.id);
      modelCommitted = true;

      const finalModelSize = (await (await directory.getFileHandle(modelFile)).getFile()).size;
      const finalConfigSize = (await (await directory.getFileHandle(configFile)).getFile()).size;
      const expectedConfigSize = new TextEncoder().encode(configText).byteLength;
      if (finalModelSize !== voice.modelSizeBytes || finalConfigSize !== expectedConfigSize) {
        throw piperError("PIPER_MODEL_INTEGRITY", "Los archivos Piper guardados no coinciden con los tamaños que se verificaron.", { phase: "verify" });
      }

      manifest.models[voice.id] = {
        voiceId: voice.id,
        modelRevision: voice.modelRevision,
        sha256: voice.modelSha256,
        modelFile,
        configFile,
        modelSizeBytes: staged.loaded,
        configSizeBytes: expectedConfigSize,
        installedAt: this.now()
      };
      await this._writeManifest(directory, manifest);
      await directory.removeEntry(temporaryName).catch(() => {});
      await directory.removeEntry(temporaryConfigName).catch(() => {});
      if (previous && previous.modelFile !== modelFile) await directory.removeEntry(previous.modelFile).catch(() => {});
      if (previous && previous.configFile !== configFile) await directory.removeEntry(previous.configFile).catch(() => {});
      try { onProgress({ phase: "download", stage: "model-ready", voiceId: voice.id, file: "model", loaded: staged.loaded, total: staged.loaded, progress: 100 }); } catch { /* Progress is advisory. */ }
      return { voiceId: voice.id, installed: true, modelSizeBytes: staged.loaded, configSizeBytes: expectedConfigSize, modelRevision: voice.modelRevision, config };
    } catch (error) {
      await directory.removeEntry(temporaryName).catch(() => {});
      await directory.removeEntry(temporaryConfigName).catch(() => {});
      if (modelCommitted && !preserveExistingModel) await directory.removeEntry(modelFile).catch(() => {});
      if (configCommitted && !preserveExistingConfig) await directory.removeEntry(configFile).catch(() => {});
      throw error;
    }
  }

  async readInstalled(voiceId, onProgress = () => {}) {
    try { onProgress({ phase: "initialize", stage: "checking-model", voiceId, indeterminate: true }); } catch { /* Progress is advisory. */ }
    const status = await this.status(voiceId);
    if (!status.installed) throw piperError(status.reason === "manifest-invalid" ? "PIPER_MANIFEST_INVALID" : "PIPER_MODEL_MISSING", status.reason === "manifest-invalid" ? "El registro local de modelos Piper no es válido; los archivos se conservaron." : "Instala primero este modelo Piper.", { phase: "checking-model" });
    const directory = await this._directory();
    const manifest = await this._readManifest(directory);
    if (!manifest[MANIFEST_TRUSTED]) throw piperError("PIPER_MANIFEST_INVALID", "El registro local de modelos Piper no es válido; los archivos se conservaron.", { phase: "reading-model" });
    const record = manifest.models[voiceId];
    try { onProgress({ phase: "initialize", stage: "reading-model", voiceId, indeterminate: true }); } catch { /* Progress is advisory. */ }
    const modelFile = await (await directory.getFileHandle(record.modelFile)).getFile();
    return { voice: getVoiceRecord(voiceId), config: status.config, model: modelFile };
  }

  async remove(voiceId) {
    const voice = this.catalog.find((item) => item.id === voiceId);
    if (!voice) throw new TypeError(`Identificador de voz Piper desconocido: ${String(voiceId)}.`);
    const directory = await this._directory();
    const manifest = await this._readManifest(directory);
    if (!manifest[MANIFEST_TRUSTED]) throw piperError("PIPER_MANIFEST_INVALID", "El registro local de modelos Piper no es válido; se protegieron los archivos existentes.", { phase: "manifest" });
    const record = manifest.models[voiceId];
    if (record) {
      await directory.removeEntry(record.modelFile).catch(() => {});
      await directory.removeEntry(record.configFile).catch(() => {});
    }
    delete manifest.models[voiceId];
    await this._writeManifest(directory, manifest);
    await directory.removeEntry(`${this._modelFileName(voice)}.partial`).catch(() => {});
    await directory.removeEntry(`${this._configFileName(voice)}.partial`).catch(() => {});
    return { voiceId, installed: false };
  }
}

export { validateConfig as validatePiperConfig };
