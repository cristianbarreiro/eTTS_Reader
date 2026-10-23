const DB_NAME = "edge-local-reader";
const DB_VERSION = 1;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo acceder al almacenamiento local."));
  });
}

function transactionResult(transaction, request) {
  return new Promise((resolve, reject) => {
    let result;
    if (request) {
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error("Falló una operación de almacenamiento local."));
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar en el almacenamiento local."));
    transaction.onabort = () => reject(transaction.error || new Error("Se canceló la operación de almacenamiento local."));
  });
}

export function makeId(prefix = "reader") {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${value}`;
}

export class ReaderRepository {
  constructor({ indexedDB = globalThis.indexedDB, storage = globalThis.navigator?.storage } = {}) {
    if (!indexedDB) throw new Error("Este navegador no ofrece IndexedDB para guardar la biblioteca local.");
    this.indexedDB = indexedDB;
    this.storage = storage;
    this.databasePromise = null;
  }

  open() {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains("documents")) {
          const documents = db.createObjectStore("documents", { keyPath: "id" });
          documents.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("sessions")) {
          const sessions = db.createObjectStore("sessions", { keyPath: "id" });
          sessions.createIndex("documentId", "documentId");
          sessions.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("audioChunks")) {
          const audio = db.createObjectStore("audioChunks", { keyPath: "id" });
          audio.createIndex("createdAt", "createdAt");
        }
        // Future schema changes must add stores or indexes here; existing records are never cleared.
        void event;
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.databasePromise = null; };
        resolve(db);
      };
      request.onerror = () => {
        this.databasePromise = null;
        reject(request.error || new Error("No se pudo abrir la biblioteca local."));
      };
      request.onblocked = () => reject(new Error("Cierra otra ventana del lector para actualizar la biblioteca local."));
    });
    return this.databasePromise;
  }

  async _read(storeName, operation) {
    const db = await this.open();
    const transaction = db.transaction(storeName, "readonly");
    const request = operation(transaction.objectStore(storeName));
    return requestResult(request);
  }

  async _write(storeName, operation) {
    const db = await this.open();
    const transaction = db.transaction(storeName, "readwrite");
    const request = operation(transaction.objectStore(storeName));
    return transactionResult(transaction, request);
  }

  async getDocument(id) { return this._read("documents", (store) => store.get(id)); }

  async listDocuments() {
    const records = await this._read("documents", (store) => store.getAll());
    return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async saveDocument(document) {
    const previous = document.id ? await this.getDocument(document.id) : null;
    const now = Date.now();
    const record = {
      ...document,
      id: document.id || makeId("document"),
      name: document.name || "Texto pegado",
      type: document.type || "text",
      text: String(document.text ?? ""),
      createdAt: previous?.createdAt || document.createdAt || now,
      updatedAt: now,
      extractionStatus: document.extractionStatus || "ready"
    };
    await this._write("documents", (store) => store.put(record));
    return record;
  }

  async getSession(id) { return this._read("sessions", (store) => store.get(id)); }

  async listSessions(documentId) {
    const records = await this._read("sessions", (store) => store.getAll());
    return records
      .filter((session) => !documentId || session.documentId === documentId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async saveSession(session) {
    const previous = session.id ? await this.getSession(session.id) : null;
    const now = Date.now();
    const chunks = Array.isArray(session.chunks) ? [...session.chunks] : [];
    const audioKeys = Array.isArray(session.audioKeys) ? [...session.audioKeys] : [];
    const validChunkStates = new Set(["pending", "generating", "ready", "error"]);
    const suppliedChunkStates = Array.isArray(session.chunkStates) ? session.chunkStates : [];
    const record = {
      ...session,
      id: session.id || makeId("session"),
      documentId: session.documentId || null,
      sourceText: String(session.sourceText ?? ""),
      chunks,
      audioKeys,
      chunkStates: chunks.map((_, index) => audioKeys[index] ? "ready" : validChunkStates.has(suppliedChunkStates[index]) ? suppliedChunkStates[index] : "pending"),
      selectedIndex: Math.max(0, Number(session.selectedIndex) || 0),
      position: Math.max(0, Number(session.position) || 0),
      status: session.status || "text-ready",
      lastError: String(session.lastError || (session.status === "error" ? session.message : "") || ""),
      voice: session.voice || "af_heart",
      speed: Number(session.speed) || 1,
      createdAt: previous?.createdAt || session.createdAt || now,
      updatedAt: now
    };
    await this._write("sessions", (store) => store.put(record));
    return record;
  }

  async getAudioChunk(id) { return this._read("audioChunks", (store) => store.get(id)); }

  async saveAudioChunk(audio) {
    if (!audio?.id || !(audio.blob instanceof Blob) || audio.blob.size === 0) {
      throw new TypeError("El audio local debe incluir un identificador y un Blob WAV válido.");
    }
    const record = { ...audio, createdAt: audio.createdAt || Date.now() };
    await this._write("audioChunks", (store) => store.put(record));
    return record;
  }

  async deleteSession(id) {
    const target = await this.getSession(id);
    if (!target) return false;
    const sessions = await this.listSessions();
    const retainedAudio = new Set(sessions.filter((item) => item.id !== id).flatMap((item) => item.audioKeys || []));
    const db = await this.open();
    const transaction = db.transaction(["sessions", "audioChunks"], "readwrite");
    const sessionStore = transaction.objectStore("sessions");
    const audioStore = transaction.objectStore("audioChunks");
    sessionStore.delete(id);
    for (const audioKey of target.audioKeys || []) if (!retainedAudio.has(audioKey)) audioStore.delete(audioKey);
    await transactionResult(transaction);
    return true;
  }

  async deleteDocument(id) {
    const document = await this.getDocument(id);
    if (!document) return false;
    const sessions = await this.listSessions(id);
    for (const session of sessions) await this.deleteSession(session.id);
    await this._write("documents", (store) => store.delete(id));
    return true;
  }

  async clearAudioCache() {
    const db = await this.open();
    const transaction = db.transaction(["audioChunks", "sessions"], "readwrite");
    transaction.objectStore("audioChunks").clear();
    const sessionsRequest = transaction.objectStore("sessions").getAll();
    sessionsRequest.onsuccess = () => {
      for (const session of sessionsRequest.result) {
        session.audioKeys = [];
        session.chunkStates = (session.chunks || []).map((_, index) => {
          const state = session.chunkStates?.[index];
          return state === "error" ? "error" : "pending";
        });
        transaction.objectStore("sessions").put(session);
      }
    };
    await transactionResult(transaction);
  }

  async estimateStorage() {
    if (!this.storage?.estimate) return null;
    try { return await this.storage.estimate(); } catch { return null; }
  }
}

export async function makeAudioCacheKey(text, voice, modelId = "onnx-community/Kokoro-82M-v1.0-ONNX") {
  const value = `${modelId}\nkokoro-js@1.2.1\n@huggingface/transformers@3.8.1\nonnxruntime-web@1.22.0-dev.20250409-89f8206ba4\n${voice}\n${String(text)}`;
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return `kokoro-v1-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `kokoro-v1-${(hash >>> 0).toString(16)}`;
}

export const READER_DATABASE = Object.freeze({ name: DB_NAME, version: DB_VERSION });
