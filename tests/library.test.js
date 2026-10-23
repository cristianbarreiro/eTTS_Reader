import test from "node:test";
import assert from "node:assert/strict";
import { buildLibraryEntries, libraryActionFor, openLibraryEntry, resumeLibrarySession } from "../src/library.js";

test("library groups linked sessions under one document and filters empty legacy documents", () => {
  const entries = buildLibraryEntries(
    [
      { id: "doc-1", name: "Artículo", type: "article", text: "Contenido", updatedAt: 10 },
      { id: "empty", name: "Vacío", text: "   " }
    ],
    [
      { id: "old", documentId: "doc-1", sourceText: "Contenido", updatedAt: 20 },
      { id: "new", documentId: "doc-1", sourceText: "Contenido", updatedAt: 30 }
    ]
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].document.id, "doc-1");
  assert.deepEqual(entries[0].sessions.map(({ id }) => id), ["new", "old"]);
  assert.equal(libraryActionFor(entries[0], "Contenido"), "resume");
  assert.equal(libraryActionFor(entries[0], "Texto nuevo"), "read");
});

test("detached sessions remain visible together as a single recoverable entry", () => {
  const entries = buildLibraryEntries([], [
    { id: "s1", documentId: null, sourceDocumentName: "Libro", sourceText: "Texto", updatedAt: 2 },
    { id: "s2", documentId: null, sourceDocumentName: "Libro", sourceText: "Texto", updatedAt: 3 }
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "recovered-session");
  assert.deepEqual(entries[0].sessions.map(({ id }) => id), ["s2", "s1"]);
});

test("opening a library document does not trigger audio while resuming explicitly does", async () => {
  const calls = [];
  const entry = { document: { id: "doc", text: "Read." }, sessions: [{ id: "session" }] };
  await openLibraryEntry(entry, async (document) => calls.push(["open", document.id]));
  assert.deepEqual(calls, [["open", "doc"]]);

  await resumeLibrarySession(entry.sessions[0], async (session) => calls.push(["activate", session.id]), async () => calls.push(["play"]));
  assert.deepEqual(calls, [["open", "doc"], ["activate", "session"], ["play"]]);
});
