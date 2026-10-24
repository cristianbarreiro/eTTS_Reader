import { sha256 } from "@noble/hashes/sha2.js";
import { PIPER_VOICE_CATALOG, getVoiceRecord } from "./voice-catalog.js";

export const PIPER_OPFS_DIRECTORY = "etts-piper-models";
export const PIPER_MANIFEST_FILE = "installed-models.json";
const PIPER_REPOSITORY = "https://huggingface.co/rhasspy/piper-voices/resolve";
const MAX_CONFIG_BYTES = 32 * 1024;

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

async function readResponseText(response, url, maxBytes = MAX_CONFIG_BYTES) {
  if (!response?.ok) throw new Error(`No se pudo descargar el archivo Piper (HTTP ${response?.status || 0}): ${url}`);
  const declared = Number(response.headers?.get?.("content-length")) || 0;
  if (declared > maxBytes) throw new Error(`La configuración Piper supera el tamaño permitido (${declared} bytes).`);
  const text = await response.text();
  if (!text || new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error("La configuración Piper está vacía o supera el tamaño permitido.");
  }
  return text;
}

export class PiperModelStore {
  constructor({ storage = globalThis.navigator?.storage, fetchImpl = globalThis.fetch, now = () => Date.now(), catalog = PIPER_VOICE_CATALOG } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("Piper necesita una función fetch para descargar los modelos.");
    this.storage = storage;
    // fetch is a Web IDL method. Calling it as this.fetchImpl(...) would bind
    // `this` to the store, not to WorkerGlobalScope, and Edge throws
    // "Illegal invocation". Keep the browser global as its receiver.
    this.fetchImpl = fetchImpl.bind(globalThis);
    this.now = now;
    this.catalog = catalog;
    this.installs = new Map();
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
    try {
      const file = await (await directory.getFileHandle(PIPER_MANIFEST_FILE)).getFile();
      const manifest = JSON.parse(await file.text());
      if (manifest?.version !== 1 || !manifest.models || typeof manifest.models !== "object") return { version: 1, models: {} };
      return manifest;
    } catch {
      return { version: 1, models: {} };
    }
  }

  async _writeManifest(directory, manifest) {
    const handle = await directory.getFileHandle(PIPER_MANIFEST_FILE, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(manifest));
    await writable.close();
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
    const manifest = await this._readManifest(directory);
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

  async _install(voice, onProgress) {
    const existing = await this.status(voice.id);
    if (existing.installed) return existing;
    const directory = await this._directory();
    const manifest = await this._readManifest(directory);
    const previous = manifest.models[voice.id];

    const configUrl = this._configUrl(voice);
    const configResponse = await this.fetchImpl(configUrl, { cache: "no-store" });
    const configText = await readResponseText(configResponse, configUrl);
    let config;
    try { config = validateConfig(JSON.parse(configText), voice); }
    catch (error) { throw new Error(`No se pudo validar la configuración Piper descargada: ${error.message}`); }

    const modelUrl = this._modelUrl(voice);
    const response = await this.fetchImpl(modelUrl, { cache: "no-store" });
    if (!response?.ok) throw new Error(`No se pudo descargar el modelo Piper (HTTP ${response?.status || 0}).`);
    const modelFile = this._modelFileName(voice);
    const configFile = this._configFileName(voice);
    const temporaryName = `${modelFile}.partial`;
    const temporaryHandle = await directory.getFileHandle(temporaryName, { create: true });
    const writer = await temporaryHandle.createWritable();
    const digest = sha256.create();
    const reader = response.body?.getReader?.();
    let loaded = 0;
    const declaredTotal = Number(response.headers?.get?.("content-length")) || voice.modelSizeBytes;
    if (!reader) {
      await writer.abort?.();
      await directory.removeEntry(temporaryName).catch(() => {});
      throw new Error("La descarga del modelo Piper no ofrece un flujo verificable.");
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        loaded += value.byteLength;
        if (loaded > voice.modelSizeBytes) throw new Error("La descarga Piper excede el tamaño verificado del modelo.");
        digest.update(value);
        await writer.write(value);
        onProgress({ phase: "download", voiceId: voice.id, file: "model", loaded, total: declaredTotal, progress: Math.min(100, loaded / declaredTotal * 100) });
      }
      await writer.close();
    } catch (error) {
      await reader.cancel?.().catch?.(() => {});
      await writer.abort?.().catch?.(() => {});
      await directory.removeEntry(temporaryName).catch(() => {});
      throw error;
    }

    const actualHash = toHex(digest.digest());
    if (loaded !== voice.modelSizeBytes || actualHash !== voice.modelSha256) {
      await directory.removeEntry(temporaryName).catch(() => {});
      throw new Error(`El modelo Piper no superó la verificación de integridad (tamaño ${loaded}/${voice.modelSizeBytes}, SHA-256 ${actualHash}).`);
    }

    const configHandle = await directory.getFileHandle(configFile, { create: true });
    const configWriter = await configHandle.createWritable();
    await configWriter.write(configText);
    await configWriter.close();

    const finalHandle = await directory.getFileHandle(modelFile, { create: true });
    const finalWriter = await finalHandle.createWritable();
    const stagedFile = await temporaryHandle.getFile();
    const stagedReader = stagedFile.stream().getReader();
    try {
      while (true) {
        const { done, value } = await stagedReader.read();
        if (done) break;
        await finalWriter.write(value);
      }
      await finalWriter.close();
    } catch (error) {
      await stagedReader.cancel?.().catch?.(() => {});
      await finalWriter.abort?.().catch?.(() => {});
      await directory.removeEntry(modelFile).catch(() => {});
      await directory.removeEntry(temporaryName).catch(() => {});
      await directory.removeEntry(configFile).catch(() => {});
      throw error;
    }
    await directory.removeEntry(temporaryName).catch(() => {});

    manifest.models[voice.id] = {
      voiceId: voice.id,
      modelRevision: voice.modelRevision,
      sha256: voice.modelSha256,
      modelFile,
      configFile,
      modelSizeBytes: loaded,
      configSizeBytes: new TextEncoder().encode(configText).byteLength,
      installedAt: this.now()
    };
    await this._writeManifest(directory, manifest);

    if (previous && previous.modelFile !== modelFile) await directory.removeEntry(previous.modelFile).catch(() => {});
    if (previous && previous.configFile !== configFile) await directory.removeEntry(previous.configFile).catch(() => {});
    onProgress({ phase: "download", voiceId: voice.id, file: "model", loaded, total: loaded, progress: 100 });
    return { voiceId: voice.id, installed: true, modelSizeBytes: loaded, configSizeBytes: manifest.models[voice.id].configSizeBytes, modelRevision: voice.modelRevision, config };
  }

  async readInstalled(voiceId) {
    const status = await this.status(voiceId);
    if (!status.installed) throw new Error("Instala primero este modelo Piper.");
    const directory = await this._directory();
    const manifest = await this._readManifest(directory);
    const record = manifest.models[voiceId];
    const modelFile = await (await directory.getFileHandle(record.modelFile)).getFile();
    return { voice: getVoiceRecord(voiceId), config: status.config, model: modelFile };
  }

  async remove(voiceId) {
    const voice = this.catalog.find((item) => item.id === voiceId);
    if (!voice) throw new TypeError(`Identificador de voz Piper desconocido: ${String(voiceId)}.`);
    const directory = await this._directory();
    const manifest = await this._readManifest(directory);
    const record = manifest.models[voiceId];
    if (record) {
      await directory.removeEntry(record.modelFile).catch(() => {});
      await directory.removeEntry(record.configFile).catch(() => {});
    }
    delete manifest.models[voiceId];
    await this._writeManifest(directory, manifest);
    await directory.removeEntry(`${this._modelFileName(voice)}.partial`).catch(() => {});
    return { voiceId, installed: false };
  }
}

export { validateConfig as validatePiperConfig };
