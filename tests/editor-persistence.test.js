import test from "node:test";
import assert from "node:assert/strict";
import { persistEditorSnapshot } from "../src/editor-persistence.js";
import { ReaderRepository } from "../src/persistence.js";

class Request {}
class Store {
  constructor(tx, rows, keyPath) { Object.assign(this, { tx, rows, keyPath }); }
  createIndex() { return {}; }
  get(key) { return this.tx.request(() => this.rows.get(key)); }
  getAll() { return this.tx.request(() => [...this.rows.values()]); }
  put(value) { return this.tx.request(() => { this.rows.set(value[this.keyPath], value); return value[this.keyPath]; }); }
  delete(key) { return this.tx.request(() => this.rows.delete(key)); }
}
class Transaction {
  constructor(db, names) { Object.assign(this, { db, names, pending: 0, scheduled: false, completed: false }); }
  objectStore(name) {
    const definition = this.db.stores.get(name);
    if (!this.names.includes(name) || !definition) throw new Error(`Unknown store ${name}`);
    return new Store(this, definition.rows, definition.keyPath);
  }
  request(operation) {
    const request = new Request();
    this.pending++;
    queueMicrotask(() => {
      try { request.result = operation(); request.onsuccess?.(); }
      catch (error) { request.error = error; request.onerror?.(); this.error = error; }
      this.pending--;
      this.schedule();
    });
    return request;
  }
  schedule() {
    if (this.pending || this.scheduled || this.completed) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      if (this.pending || this.completed) return;
      this.completed = true;
      if (this.error) this.onerror?.(); else this.oncomplete?.();
    }, 0);
  }
}
class Database {
  constructor() { this.stores = new Map(); this.objectStoreNames = { contains: (name) => this.stores.has(name) }; }
  createObjectStore(name, { keyPath }) { const store = { keyPath, rows: new Map() }; this.stores.set(name, store); return new Store(new Transaction(this, [name]), store.rows, keyPath); }
  transaction(names) { return new Transaction(this, Array.isArray(names) ? names : [names]); }
}
class IndexedDB {
  constructor() { this.db = null; }
  open() {
    const request = new Request();
    queueMicrotask(() => {
      const fresh = !this.db;
      this.db ||= new Database();
      request.result = this.db;
      if (fresh) request.onupgradeneeded?.({ target: { result: this.db } });
      request.onsuccess?.();
    });
    return request;
  }
}

test("editor autosave skips empty and whitespace drafts and persists valid text verbatim", async () => {
  const repository = new ReaderRepository({ indexedDB: new IndexedDB() });
  let writes = 0;
  const originalSaveDocument = repository.saveDocument.bind(repository);
  repository.saveDocument = async (value) => { writes++; return originalSaveDocument(value); };

  const empty = await persistEditorSnapshot(repository, { text: "", voice: "af_heart", speed: 1 });
  const whitespace = await persistEditorSnapshot(repository, { text: " \t ", voice: "af_heart", speed: 1 });
  assert.equal(empty.saved, false);
  assert.equal(whitespace.saved, false);
  assert.equal(writes, 0);
  assert.deepEqual(await repository.listDocuments(), []);

  const valid = await persistEditorSnapshot(repository, { text: "  Texto válido  ", voice: "af_heart", speed: 1 });
  assert.equal(valid.saved, true);
  assert.equal((await repository.getDocument(valid.document.id)).text, "  Texto válido  ");
  assert.equal((await repository.getSession(valid.session.id)).sourceText, "  Texto válido  ");
});
