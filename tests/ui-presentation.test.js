import test from "node:test";
import assert from "node:assert/strict";
import { createPanelStatusState, describeTabContext, userFacingErrorMessage } from "../src/ui-presentation.js";

test("tab context is shown as unavailable until a real tab identity and URL exist", () => {
  assert.equal(describeTabContext({ title: "Looks importable" }).canImport, false);
  const waiting = describeTabContext(null);
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.canImport, false);
});

test("restricted and local documents are not presented as importable", () => {
  const base = { tabId: 4, url: "edge://settings", title: "Settings", location: "edge://settings" };
  assert.equal(describeTabContext({ ...base, state: "restricted" }).canImport, false);
  assert.equal(describeTabContext({ ...base, state: "local-document" }).canImport, false);
});

test("normal pages keep an import action so a click can request their site permission", () => {
  const view = describeTabContext({
    tabId: 4, url: "https://example.test/article", title: "Article", location: "example.test",
    contentType: "Página web", state: "web-page", accessState: "Permiso de sitio requerido",
    availability: "Se solicitará autorización al pulsar Importar pestaña actual.", importable: false
  });
  assert.equal(view.canImport, true);
  assert.equal(view.domain, "example.test");
  assert.match(view.status, /Permiso de sitio requerido/);
});

test("import feedback and tab access status remain independent when preview is cancelled", () => {
  const state = createPanelStatusState();
  const tab = { tabId: 9, url: "https://example.test/", title: "Article", location: "example.test", state: "web-page", contentType: "Página web", accessState: "Permiso concedido", availability: "Listo para importar" };
  const before = state.setTabContext(tab);
  assert.match(before.tab.status, /Listo para importar/);
  state.setImportStatus("Vista previa extraída · pendiente de confirmación", "preview");
  const cancelled = state.setImportStatus("Importación cancelada. El contenido del editor sigue intacto.", "cancelled");
  assert.equal(cancelled.tab.status, before.tab.status);
  assert.equal(cancelled.tab.title, "Article");
  assert.match(cancelled.import.message, /editor sigue intacto/);
  assert.equal(cancelled.import.state, "cancelled");
});

test("user-facing errors hide raw runtime diagnostics while retaining useful guidance", () => {
  const wasm = userFacingErrorMessage(new Error("no available backend found: ort-wasm module error"), "model");
  assert.match(wasm, /motor de voz local/);
  assert.doesNotMatch(wasm, /ort-wasm/);
  const storage = userFacingErrorMessage(new Error("QuotaExceededError: transaction aborted"));
  assert.match(storage, /espacio disponible/);
});