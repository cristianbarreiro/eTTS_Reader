import { splitText } from "./text.js";
import { getVoiceProvider, migrateLegacyVoiceSession } from "./voice-catalog.js";

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
    this.emptyDocumentCleanupPromise = null;
    this.deletedDocumentIds = new Set();
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
    await this.cleanEmptyDocuments();
    const records = await this._read("documents", (store) => store.getAll());
    return records.filter((record) => String(record.text ?? "").trim()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async cleanEmptyDocuments() {
    if (this.emptyDocumentCleanupPromise) return this.emptyDocumentCleanupPromise;
    this.emptyDocumentCleanupPromise = (async () => {
      const db = await this.open();
      const transaction = db.transaction(["documents", "sessions"], "readwrite");
      const documents = transaction.objectStore("documents");
      const sessions = transaction.objectStore("sessions");
      const completion = transactionResult(transaction);
      let documentRecords;
      let sessionRecords;
      let documentsRead = false;
      let sessionsRead = false;
      const cleanup = () => {
        if (!documentsRead || !sessionsRead) return;
        const records = documentRecords.filter((document) => !String(document.text ?? "").trim());
        for (const document of records) {
          const now = Date.now();
          for (const session of sessionRecords) {
            if (session.documentId !== document.id) continue;
            sessions.put({
              ...session,
              documentId: null,
              sourceDocumentName: session.sourceDocumentName || document.name || "Documento eliminado",
              sourceText: String(session.sourceText ?? "") || String(document.text ?? ""),
              documentDeletedAt: now,
              updatedAt: session.updatedAt || now
            });
          }
          this.deletedDocumentIds.add(document.id);
          documents.delete(document.id);
        }
      };
      const documentRequest = documents.getAll();
      documentRequest.onsuccess = () => { documentRecords = documentRequest.result || []; documentsRead = true; cleanup(); };
      const sessionRequest = sessions.getAll();
      sessionRequest.onsuccess = () => { sessionRecords = sessionRequest.result || []; sessionsRead = true; cleanup(); };
      await completion;
    })().catch((error) => {
      this.emptyDocumentCleanupPromise = null;
      throw error;
    });
    return this.emptyDocumentCleanupPromise;
  }

  async saveDocument(document) {
    const documentId = document.id || makeId("document");
    if (this.deletedDocumentIds.has(documentId)) throw new Error("Este documento fue eliminado y no puede volver a guardarse con el mismo identificador.");
    const previous = document.id ? await this.getDocument(document.id) : null;
    const text = String(document.text ?? "");
    if (!text.trim()) {
      if (previous && String(previous.text ?? "").trim()) return previous;
      throw new TypeError("No se puede guardar un documento vacío o compuesto solo por espacios.");
    }
    const now = Date.now();
    const record = {
      ...document,
      id: documentId,
      name: document.name || "Texto pegado",
      type: document.type || "text",
      text,
      createdAt: previous?.createdAt || document.createdAt || now,
      updatedAt: now,
      extractionStatus: document.extractionStatus || "ready"
    };
    if (this.deletedDocumentIds.has(record.id)) throw new Error("Este documento fue eliminado y no puede volver a guardarse con el mismo identificador.");
    await this._write("documents", (store) => store.put(record));
    return record;
  }

  async _migrateSessionRecord(record) {
    if (!record) return record;
    const result = migrateLegacyVoiceSession(record);
    if (!result.migrated) return result.session;
    await this._write("sessions", (store) => store.put(result.session));
    return result.session;
  }

  async getSession(id) {
    return this._migrateSessionRecord(await this._read("sessions", (store) => store.get(id)));
  }

  async listSessions(documentId) {
    const records = await this._read("sessions", (store) => store.getAll());
    const migrated = await Promise.all(records.map((record) => this._migrateSessionRecord(record)));
    return migrated
      .filter((session) => !documentId || session.documentId === documentId)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async saveSession(session) {
    const previousRaw = session.id ? await this._read("sessions", (store) => store.get(session.id)) : null;
    const previous = previousRaw ? migrateLegacyVoiceSession(previousRaw).session : null;
    const normalizedSession = migrateLegacyVoiceSession(session).session;
    const now = Date.now();
    const chunks = Array.isArray(normalizedSession.chunks) ? [...normalizedSession.chunks] : [];
    const audioKeys = Array.isArray(normalizedSession.audioKeys) ? [...normalizedSession.audioKeys] : [];
    const validChunkStates = new Set(["pending", "generating", "ready", "error"]);
    const suppliedChunkStates = Array.isArray(normalizedSession.chunkStates) ? normalizedSession.chunkStates : [];
    const voiceId = normalizedSession.voice || normalizedSession.voiceId || previous?.voice || previous?.voiceId || "af_heart";
    const record = {
      ...normalizedSession,
      id: normalizedSession.id || makeId("session"),
      documentId: normalizedSession.documentId || null,
      sourceDocumentName: String(normalizedSession.sourceDocumentName || previous?.sourceDocumentName || ""),
      sourceText: String(normalizedSession.sourceText ?? ""),
      chunks,
      audioKeys,
      chunkStates: chunks.map((_, index) => audioKeys[index] ? "ready" : validChunkStates.has(suppliedChunkStates[index]) ? suppliedChunkStates[index] : "pending"),
      selectedIndex: Math.max(0, Number(normalizedSession.selectedIndex) || 0),
      position: Math.max(0, Number(normalizedSession.position) || 0),
      status: normalizedSession.status || "text-ready",
      lastError: String(normalizedSession.lastError || (normalizedSession.status === "error" ? normalizedSession.message : "") || ""),
      voice: voiceId,
      voiceId,
      voiceProvider: getVoiceProvider(voiceId),
      speed: Number(normalizedSession.speed) || 1,
      createdAt: previous?.createdAt || normalizedSession.createdAt || now,
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
    const db = await this.open();
    const transaction = db.transaction(["sessions", "audioChunks"], "readwrite");
    const sessionStore = transaction.objectStore("sessions");
    const audioStore = transaction.objectStore("audioChunks");
    let deleted = false;
    const completion = transactionResult(transaction);
    const request = sessionStore.getAll();
    request.onsuccess = () => {
      const records = request.result || [];
      const target = records.find((item) => item.id === id);
      if (!target) return;
      deleted = true;
      const retainedAudio = new Set(records.filter((item) => item.id !== id).flatMap((item) => item.audioKeys || []));
      sessionStore.delete(id);
      for (const audioKey of target.audioKeys || []) if (!retainedAudio.has(audioKey)) audioStore.delete(audioKey);
    };
    await completion;
    return deleted;
  }

  async deleteDocument(id) {
    this.deletedDocumentIds.add(id);
    const db = await this.open();
    const transaction = db.transaction(["documents", "sessions"], "readwrite");
    const documents = transaction.objectStore("documents");
    const sessions = transaction.objectStore("sessions");
    const completion = transactionResult(transaction);
    let document = null;
    let records = null;
    let documentRead = false;
    let sessionsRead = false;
    let deleted = false;
    const detachAndDelete = () => {
      if (!documentRead || !sessionsRead || !document) return;
      deleted = true;
      const now = Date.now();
      for (const session of records) {
        if (session.documentId !== id) continue;
        const sourceText = String(session.sourceText || document.text || "");
        const chunks = Array.isArray(session.chunks) && session.chunks.length ? session.chunks : splitText(sourceText);
        sessions.put({
          ...session,
          documentId: null,
          sourceDocumentName: session.sourceDocumentName || document.name || "Documento eliminado",
          sourceText,
          chunks,
          audioKeys: Array.isArray(session.audioKeys) ? session.audioKeys : [],
          documentDeletedAt: now,
          updatedAt: now
        });
      }
      documents.delete(id);
    };
    const documentRequest = documents.get(id);
    documentRequest.onsuccess = () => { document = documentRequest.result || null; documentRead = true; detachAndDelete(); };
    const sessionsRequest = sessions.getAll();
    sessionsRequest.onsuccess = () => { records = sessionsRequest.result || []; sessionsRead = true; detachAndDelete(); };
    await completion;
    return deleted;
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

export async function makeAudioCacheKey(text, voice, modelId = "onnx-community/Kokoro-82M-v1.0-ONNX", provider = "kokoro", providerVersion = "kokoro-js@1.2.1;transformers@3.8.1;onnxruntime-web@1.22.0-dev.20250409-89f8206ba4") {
  const value = provider === "kokoro"
    ? `${provider}\n${modelId}\nkokoro-js@1.2.1\n@huggingface/transformers@3.8.1\nonnxruntime-web@1.22.0-dev.20250409-89f8206ba4\n${voice}\n${String(text)}`
    : `${provider}\n${modelId}\n${providerVersion}\n${voice}\n${String(text)}`;
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return `${provider}-v1-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return `${provider}-v1-${(hash >>> 0).toString(16)}`;
}

export const READER_DATABASE = Object.freeze({ name: DB_NAME, version: DB_VERSION });
