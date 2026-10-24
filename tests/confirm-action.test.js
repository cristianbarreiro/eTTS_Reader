import test from "node:test";
import assert from "node:assert/strict";
import { createConfirmAction } from "../src/confirm-action.js";
import { kokoroModelDeleteConfirmation, piperModelDeleteConfirmation, savedAudioDeleteConfirmation } from "../src/library-confirmation.js";

class FakeElement {
  constructor(documentRef) {
    this.documentRef = documentRef;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.isConnected = true;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, event = {}) {
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }

  click() { this.dispatch("click"); }
  focus() { this.documentRef.activeElement = this; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

class FakeDialog extends FakeElement {
  constructor(documentRef, descendants) {
    super(documentRef);
    this.descendants = descendants;
    this.open = false;
    this.showCount = 0;
  }

  showModal() {
    if (this.open) throw new Error("dialog already open");
    this.open = true;
    this.showCount++;
  }

  close() {
    this.open = false;
    this.dispatch("close");
  }

  contains(element) { return this.descendants.includes(element); }
}

function createHarness() {
  const document = { activeElement: null };
  const opener = new FakeElement(document);
  const fallback = new FakeElement(document);
  const title = new FakeElement(document);
  const message = new FakeElement(document);
  const status = new FakeElement(document);
  const cancel = new FakeElement(document);
  const accept = new FakeElement(document);
  const dialog = new FakeDialog(document, [title, message, status, cancel, accept]);
  document.activeElement = opener;
  const confirmAction = createConfirmAction({
    dialog, titleElement: title, messageElement: message, statusElement: status,
    cancelButton: cancel, confirmButton: accept, document,
    fallbackFocus: fallback
  });
  return { document, opener, fallback, title, message, status, cancel, accept, dialog, confirmAction };
}

const request = (onConfirm, extra = {}) => ({
  title: "¿Eliminar este documento?",
  message: "Se eliminará la copia guardada de «Apuntes».",
  confirmLabel: "Eliminar documento",
  cancelLabel: "Cancelar",
  onConfirm,
  ...extra
});

test("confirmation opens the internal dialog with dynamic copy and focuses the safe action", async () => {
  const ui = createHarness();
  const operation = async () => true;
  const result = ui.confirmAction(request(operation));

  assert.equal(ui.dialog.open, true);
  assert.equal(ui.dialog.showCount, 1);
  assert.equal(ui.title.textContent, "¿Eliminar este documento?");
  assert.match(ui.message.textContent, /Apuntes/);
  assert.equal(ui.cancel.textContent, "Cancelar");
  assert.equal(ui.accept.textContent, "Eliminar documento");
  assert.equal(ui.document.activeElement, ui.cancel);
  ui.cancel.click();
  assert.equal(await result, false);
  assert.equal(ui.document.activeElement, ui.opener);
});

test("Escape cancels without running the destructive operation", async () => {
  const ui = createHarness();
  let calls = 0;
  const result = ui.confirmAction(request(async () => { calls++; return true; }));
  const event = ui.dialog.dispatch("cancel");

  assert.equal(event.defaultPrevented, true);
  assert.equal(ui.dialog.open, false);
  assert.equal(await result, false);
  assert.equal(calls, 0);
});

test("Escape cancels audio, Piper, and Kokoro deletion without touching storage", async () => {
  const ui = createHarness();
  let deletions = 0;
  const prompts = [
    savedAudioDeleteConfirmation(),
    piperModelDeleteConfirmation("Español · Daniela"),
    kokoroModelDeleteConfirmation()
  ];

  for (const prompt of prompts) {
    const result = ui.confirmAction(request(async () => { deletions++; return true; }, prompt));
    ui.dialog.dispatch("cancel");
    assert.equal(await result, false);
    assert.equal(ui.dialog.open, false);
  }
  assert.equal(deletions, 0);
});

test("Tab remains inside the dialog and wraps between its buttons", () => {
  const ui = createHarness();
  void ui.confirmAction(request(async () => true));

  ui.document.activeElement = ui.cancel;
  const backwards = ui.dialog.dispatch("keydown", { key: "Tab", shiftKey: true });
  assert.equal(backwards.defaultPrevented, true);
  assert.equal(ui.document.activeElement, ui.accept);

  const forwards = ui.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.equal(forwards.defaultPrevented, true);
  assert.equal(ui.document.activeElement, ui.cancel);

  ui.document.activeElement = ui.opener;
  ui.dialog.dispatch("keydown", { key: "Tab", shiftKey: false });
  assert.equal(ui.document.activeElement, ui.cancel);
  ui.cancel.click();
});

test("confirmation waits for one operation and ignores rapid duplicate activation", async () => {
  const ui = createHarness();
  let calls = 0;
  let complete;
  const result = ui.confirmAction(request(() => {
    calls++;
    return new Promise((resolve) => { complete = resolve; });
  }));

  ui.accept.click();
  ui.accept.click();
  assert.equal(calls, 1);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.cancel.disabled, true);
  assert.equal(ui.accept.disabled, true);
  assert.equal(ui.dialog.attributes.get("aria-busy"), "true");
  assert.equal(ui.document.activeElement, ui.status);

  complete(true);
  ui.opener.isConnected = false;
  assert.equal(await result, true);
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.document.activeElement, ui.fallback);
});

test("a failed result keeps the confirmation open without resolving as success", async () => {
  const ui = createHarness();
  let calls = 0;
  const result = ui.confirmAction(request(async () => { calls++; return false; }));

  ui.accept.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.status.hidden, false);
  assert.match(ui.status.textContent, /No se pudo completar la eliminación/);
  ui.cancel.click();
  assert.equal(await result, false);
});

test("failed operations keep context open, report an error, and can be cancelled", async () => {
  const ui = createHarness();
  let reported = 0;
  const result = ui.confirmAction(request(async () => { throw new Error("IndexedDB failed"); }, {
    failureMessage: "No se pudo eliminar. Inténtalo de nuevo.",
    onError: () => { reported++; return "La biblioteca no pudo guardar el cambio."; }
  }));

  ui.accept.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reported, 1);
  assert.equal(ui.dialog.open, true);
  assert.equal(ui.status.hidden, false);
  assert.equal(ui.status.textContent, "La biblioteca no pudo guardar el cambio.");
  assert.equal(ui.cancel.disabled, false);
  assert.equal(ui.accept.disabled, false);
  ui.cancel.click();
  assert.equal(await result, false);
});

test("only one confirmation can be active at a time", async () => {
  const ui = createHarness();
  const first = ui.confirmAction(request(async () => true));
  const second = await ui.confirmAction(request(async () => true, { title: "Otro documento" }));

  assert.equal(second, false);
  assert.equal(ui.dialog.showCount, 1);
  assert.equal(ui.title.textContent, "¿Eliminar este documento?");
  ui.cancel.click();
  assert.equal(await first, false);
});

test("modal initialization errors reject instead of bypassing confirmation", async () => {
  const ui = createHarness();
  ui.dialog.showModal = undefined;
  await assert.rejects(ui.confirmAction(request(async () => true)), /confirmación interna/);
});
