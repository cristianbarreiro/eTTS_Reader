import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  documentDeleteConfirmation,
  recoveredSessionsDeleteConfirmation,
  sessionDeleteConfirmation
} from "../src/library-confirmation.js";

const sidepanel = await readFile(fileURLToPath(new URL("../sidepanel.html", import.meta.url)), "utf8");
const styles = await readFile(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");
const main = await readFile(fileURLToPath(new URL("../src/main.js", import.meta.url)), "utf8");

function functionSource(name, nextName) {
  const start = main.indexOf(`async function ${name}(`);
  const end = main.indexOf(`async function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing boundary after ${name}`);
  return main.slice(start, end);
}

test("document confirmation describes the stored copy and the actual number of retained sessions", () => {
  const prompt = documentDeleteConfirmation({ name: "Texto pegado" }, [{}, {}]);
  assert.equal(prompt.title, "¿Eliminar este documento?");
  assert.equal(prompt.confirmLabel, "Eliminar documento");
  assert.equal(prompt.cancelLabel, "Cancelar");
  assert.match(prompt.message, /copia guardada de “Texto pegado”/);
  assert.match(prompt.message, /2 sesiones conservarán sus copias de texto, progreso y audios/);
  assert.match(prompt.message, /modelos locales no se eliminarán/);

  const noSessions = documentDeleteConfirmation({ name: "Nota" }, []);
  assert.match(noSessions.message, /No hay sesiones asociadas/);
});

test("session and recovered-session prompts match the persistence behavior", () => {
  const session = sessionDeleteConfirmation({ sourceDocumentName: "Libro", audioKeys: ["shared"] });
  assert.equal(session.title, "¿Eliminar esta sesión?");
  assert.match(session.message, /progreso y los WAV que no use otra sesión/);
  assert.match(session.message, /documento y los modelos locales se conservarán/);

  const recovered = recoveredSessionsDeleteConfirmation([
    { sourceDocumentName: "Lectura recuperada" },
    { sourceDocumentName: "Lectura recuperada" }
  ]);
  assert.equal(recovered.confirmLabel, "Eliminar sesiones");
  assert.match(recovered.title, /sesiones recuperadas/);
  assert.match(recovered.message, /2 sesiones recuperadas/);
  assert.match(recovered.message, /documentos y modelos locales se conservarán/);
});

test("library deletion flows use the shared internal modal and never native confirm", () => {
  for (const [name, next] of [
    ["deleteLibraryDocument", "performLibraryDocumentDelete"],
    ["deleteLibrarySession", "performLibrarySessionDelete"],
    ["deleteRecoveredLibraryEntry", "performRecoveredLibrarySessionsDelete"]
  ]) {
    const source = functionSource(name, next);
    assert.match(source, /confirmDestructiveAction\(/);
    assert.doesNotMatch(source, /\b(?:window\.)?confirm\s*\(/);
    assert.match(source, /onConfirm:/);
    assert.match(source, /onError:/);
  }

  assert.match(main, /onConfirm: \(\) => performLibraryDocumentDelete/);
  assert.match(main, /onConfirm: \(\) => performLibrarySessionDelete/);
  assert.match(main, /onConfirm: \(\) => performRecoveredLibrarySessionsDelete/);
});

test("the internal dialog has accessible labels, a safe default action, and a compact responsive style", () => {
  assert.match(sidepanel, /<dialog id="library-confirm-dialog"[^>]*role="dialog" aria-modal="true" aria-labelledby="library-confirm-title" aria-describedby="library-confirm-message"/);
  assert.match(sidepanel, /id="library-confirm-cancel"[^>]*>Cancelar<\/button>/);
  assert.match(sidepanel, /id="library-confirm-accept"[^>]*class="confirm-dialog-danger"/);
  assert.match(sidepanel, /id="library-confirm-status"[^>]*role="alert"[^>]*aria-live="assertive"/);
  assert.match(styles, /\.confirm-dialog\s*\{[^}]*width:\s*min\(380px, calc\(100vw - 24px\)\)/s);
  assert.match(styles, /\.confirm-dialog::backdrop\s*\{[^}]*rgb\(3 8 16 \/ 68%\)/s);
  assert.match(styles, /\.confirm-dialog-danger:hover:not\(:disabled\)\s*\{[^}]*#991b1b/s);
  assert.match(styles, /\.confirm-dialog-danger:focus-visible/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});
