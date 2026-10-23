import test from "node:test";
import assert from "node:assert/strict";
import { makeAudioCacheKey, ReaderRepository } from "../src/persistence.js";

class FakeRequest {}

class FakeObjectStore {
  constructor(transaction, records, keyPath) {
    this.transaction = transaction;
    this.records = records;
    this.keyPath = keyPath;
  }
  createIndex() { return {}; }
  get(key) { return this.transaction.request(() => this.records.get(key)); }
  getAll() { return this.transaction.request(() => [...this.records.values()]); }
  put(value) { return this.transaction.request(() => { this.records.set(value[this.keyPath], value); return value[this.keyPath]; }); }
  delete(key) { return this.transaction.request(() => this.records.delete(key)); }
  clear() { return this.transaction.request(() => this.records.clear()); }
}

class FakeTransaction {
  constructor(database, names) {
    this.database = database;
    this.names = names;
    this.pending = 0;
    this.completionScheduled = false;
    this.completed = false;
  }
  objectStore(name) {
    const definition = this.database.stores.get(name);
    if (!this.names.includes(name) || !definition) throw new Error(`Unknown store ${name}`);
    return new FakeObjectStore(this, definition.records, definition.keyPath);
  }
  request(operation) {
    const request = new FakeRequest();
    this.pending++;
    queueMicrotask(() => {
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request });
        this.error = error;
      } finally {
        this.pending--;
        this.scheduleComplete();
      }
    });
    return request;
  }
  scheduleComplete() {
    if (this.pending || this.completionScheduled || this.completed) return;
    this.completionScheduled = true;
    setTimeout(() => {
      this.completionScheduled = false;
      if (this.pending || this.completed) return;
      this.completed = true;
      if (this.error) this.onerror?.({ target: this });
      else this.oncomplete?.({ target: this });
    }, 0);
  }
}

class FakeDatabase {
  constructor(name) {
    this.name = name;
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
  }
  createObjectStore(name, { keyPath }) {
    const definition = { keyPath, records: new Map() };
    this.stores.set(name, definition);
    return new FakeObjectStore(new FakeTransaction(this, [name]), definition.records, keyPath);
  }
  transaction(names) { return new FakeTransaction(this, Array.isArray(names) ? names : [names]); }
  close() {}
}

class FakeIndexedDB {
  constructor() { this.databases = new Map(); }
  open(name) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const fresh = !database;
      if (!database) {
        database = new FakeDatabase(name);
        this.databases.set(name, database);
      }
      request.result = database;
      if (fresh) request.onupgradeneeded?.({ target: { result: database } });
      request.onsuccess?.({ target: request });
    });
    return request;
  }
}

function makeRepository() { return new ReaderRepository({ indexedDB: new FakeIndexedDB() }); }

test("IndexedDB repository saves and restores pasted or extracted document text and reading state", async () => {
  const repository = makeRepository();
  const pasted = await repository.saveDocument({ name: "Texto pegado", type: "text", text: "Hola mundo." });
  const extracted = await repository.saveDocument({ name: "articulo.pdf", type: "pdf", text: "Contenido extraído." });
  const session = await repository.saveSession({
    documentId: extracted.id, sourceText: extracted.text, chunks: ["Contenido", "extraído."],
    selectedIndex: 1, position: 2.25, status: "paused", voice: "am_michael", speed: 1.25,
    audioKeys: ["audio-a", "audio-b"]
  });

  assert.equal((await repository.getDocument(pasted.id)).text, "Hola mundo.");
  assert.equal((await repository.getDocument(extracted.id)).text, "Contenido extraído.");
  assert.deepEqual(await repository.listDocuments().then((items) => items.map((item) => item.id).sort()), [pasted.id, extracted.id].sort());
  assert.deepEqual(await repository.getSession(session.id).then(({ selectedIndex, position, status, voice, speed, chunks }) => ({ selectedIndex, position, status, voice, speed, chunks })), {
    selectedIndex: 1, position: 2.25, status: "paused", voice: "am_michael", speed: 1.25, chunks: ["Contenido", "extraído."]
  });
  assert.deepEqual(session.chunkStates, ["ready", "ready"]);
  assert.equal(session.lastError, "");
});

test("session persistence retains failed chunk state and its retryable error", async () => {
  const repository = makeRepository();
  const saved = await repository.saveSession({
    id: "failed-session", sourceText: "No disponible.", chunks: ["No disponible."],
    selectedIndex: 0, status: "error", chunkStates: ["error"], lastError: "Kokoro no pudo iniciar."
  });

  assert.equal(saved.status, "error");
  assert.deepEqual(saved.chunkStates, ["error"]);
  assert.equal(saved.lastError, "Kokoro no pudo iniciar.");
});

test("audio chunks are stored as local Blobs and reusable by stable synthesis keys", async () => {
  const repository = makeRepository();
  const blob = new Blob(["wav"], { type: "audio/wav" });
  const key = await makeAudioCacheKey("Read me.", "af_heart");
  const changedTextKey = await makeAudioCacheKey("Read me again.", "af_heart");
  const changedVoiceKey = await makeAudioCacheKey("Read me.", "am_michael");
  await repository.saveAudioChunk({ id: key, blob, voice: "af_heart", format: "wav", sampleRate: 24000, duration: 1.1 });
  const stored = await repository.getAudioChunk(key);
  assert.equal(stored.blob.size, blob.size);
  assert.equal(stored.sampleRate, 24000);
  assert.notEqual(key, changedTextKey);
  assert.notEqual(key, changedVoiceKey);
  await assert.rejects(repository.saveAudioChunk({ id: "invalid", blob: new Blob() }), /identificador y un Blob WAV válido/);
});

test("deleting a session preserves shared audio, and deleting a document cascades only its sessions", async () => {
  const repository = makeRepository();
  const firstDocument = await repository.saveDocument({ name: "uno.txt", text: "uno" });
  const secondDocument = await repository.saveDocument({ name: "dos.txt", text: "dos" });
  const shared = new Blob(["audio"], { type: "audio/wav" });
  await repository.saveAudioChunk({ id: "shared-audio", blob: shared });
  const firstSession = await repository.saveSession({ documentId: firstDocument.id, sourceText: "uno", chunks: ["uno"], audioKeys: ["shared-audio"] });
  const secondSession = await repository.saveSession({ documentId: secondDocument.id, sourceText: "dos", chunks: ["dos"], audioKeys: ["shared-audio"] });

  assert.equal(await repository.deleteSession(firstSession.id), true);
  assert.ok(await repository.getAudioChunk("shared-audio"));
  assert.ok(await repository.getDocument(firstDocument.id));
  assert.equal(await repository.deleteDocument(secondDocument.id), true);
  assert.equal(await repository.getDocument(secondDocument.id), undefined);
  assert.equal(await repository.getSession(secondSession.id), undefined);
  assert.equal(await repository.getAudioChunk("shared-audio"), undefined);
  assert.ok(await repository.getDocument(firstDocument.id));
});

test("clearing the audio cache keeps documents and sessions but clears audio references", async () => {
  const repository = makeRepository();
  const document = await repository.saveDocument({ name: "lectura.txt", text: "Persistir." });
  const session = await repository.saveSession({ documentId: document.id, sourceText: document.text, chunks: [document.text], audioKeys: ["saved-audio"] });
  await repository.saveAudioChunk({ id: "saved-audio", blob: new Blob(["audio"]) });

  await repository.clearAudioCache();
  assert.equal((await repository.getDocument(document.id)).text, "Persistir.");
  assert.deepEqual((await repository.getSession(session.id)).audioKeys, []);
  assert.deepEqual((await repository.getSession(session.id)).chunkStates, ["pending"]);
  assert.equal(await repository.getAudioChunk("saved-audio"), undefined);
});
