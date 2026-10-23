import test from "node:test";
import assert from "node:assert/strict";

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    fire(...args) { return listeners.at(-1)?.(...args); }
  };
}

async function loadBackground({ initialTab = { id: 7, windowId: 2, url: "https://example.test/article", title: "Article" }, scriptResult = { title: "Article", contentType: "text/html", type: "article", text: "Local page text", truncated: false }, fileAccessAllowed = false } = {}) {
  const values = new Map();
  const calls = { panel: [], scripts: [], contextMenu: [], messages: [] };
  const api = {
    runtime: {
      getManifest: () => ({ side_panel: { default_path: "sidepanel.html" } }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onInstalled: event(), onMessage: event(),
      async sendMessage(message) { calls.messages.push(message); return { ok: true }; }
    },
    extension: { async isAllowedFileSchemeAccess() { return fileAccessAllowed; } },
    storage: { session: {
      async set(record) { for (const [key, value] of Object.entries(record)) values.set(key, value); },
      async get(key) { return { [key]: values.get(key) }; },
      async remove(key) { values.delete(key); }
    } },
    sidePanel: {
      async open(options) { calls.panel.push(options); },
      async setPanelBehavior() {}
    },
    tabs: {
      onUpdated: event(), onRemoved: event(), activeTab: initialTab,
      async query() { return [this.activeTab]; },
      async get(id) { return this.activeTab?.id === id ? this.activeTab : null; }
    },
    action: { onClicked: event() },
    contextMenus: { onClicked: event(), async removeAll() {}, create(item) { calls.contextMenu.push(item); } },
    scripting: { async executeScript(options) { calls.scripts.push(options); return [{ result: scriptResult }]; } },
    offscreen: { async hasDocument() { return true; }, async closeDocument() {} }
  };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = api;
  await import(`../src/background.js?test=${Date.now()}-${Math.random()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const send = (message) => new Promise((resolve) => {
    const handled = api.runtime.onMessage.fire(message, { url: "chrome-extension://test/sidepanel.html" }, resolve);
    if (handled !== true) resolve(undefined);
  });
  return {
    api, calls, values, send,
    restore() { globalThis.chrome = previousChrome; }
  };
}

test("toolbar invocation captures the source tab and extracts only from that authorized tab", async () => {
  const harness = await loadBackground();
  try {
    harness.api.action.onClicked.fire(harness.api.tabs.activeTab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(harness.calls.panel, [{ tabId: 7 }]);
    assert.equal(harness.values.get("tabImportTarget").tabId, 7);

    const result = await harness.send({ target: "background", command: "extract-tab", selectionOnly: false });
    assert.equal(result.ok, true);
    assert.equal(result.text, "Local page text");
    assert.equal(harness.calls.scripts[0].target.tabId, 7);
    assert.deepEqual(harness.calls.scripts[0].target.frameIds, [0]);
  } finally { harness.restore(); }
});

test("a changed active tab or navigated source is rejected before importing its content", async () => {
  const harness = await loadBackground();
  try {
    harness.api.action.onClicked.fire(harness.api.tabs.activeTab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    harness.api.tabs.activeTab = { id: 8, windowId: 2, url: "https://other.test/", title: "Other" };
    const mismatch = await harness.send({ target: "background", command: "extract-tab" });
    assert.equal(mismatch.state, "target-mismatch");
    assert.equal(harness.calls.scripts.length, 0);

    harness.api.tabs.activeTab = { id: 7, windowId: 2, url: "https://example.test/changed", title: "Changed" };
    const stale = await harness.send({ target: "background", command: "extract-tab" });
    assert.equal(stale.state, "stale-target");
    assert.equal(harness.calls.scripts.length, 0);
  } finally { harness.restore(); }
});

test("remote PDF handoff includes a token and rejects navigation before extraction completes", async () => {
  const pdfTab = { id: 12, windowId: 2, url: "https://example.test/report.pdf", title: "report.pdf" };
  const harness = await loadBackground({ initialTab: pdfTab });
  try {
    harness.api.action.onClicked.fire(pdfTab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const target = await harness.send({ target: "background", command: "extract-tab" });
    assert.equal(target.state, "pdf-target");
    assert.ok(target.targetToken);

    harness.api.tabs.activeTab = { ...pdfTab, url: "https://example.test/changed" };
    const validation = await harness.send({
      target: "background", command: "validate-import-target", expectedToken: target.targetToken
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.state, "stale-target");
  } finally { harness.restore(); }
});

test("local PDF handoff respects Edge file access permission and does not inject into the viewer", async () => {
  const pdfTab = { id: 21, windowId: 2, url: "file:///C:/docs/report.pdf", title: "report.pdf" };
  const denied = await loadBackground({ initialTab: pdfTab, fileAccessAllowed: false });
  try {
    denied.api.action.onClicked.fire(pdfTab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await denied.send({ target: "background", command: "extract-tab" });
    assert.equal(result.ok, false);
    assert.equal(result.state, "file-access-disabled");
    assert.equal(result.type, "local-pdf");
    assert.match(result.message, /Permitir el acceso a direcciones URL de archivo/);
    assert.equal(denied.calls.scripts.length, 0);
  } finally { denied.restore(); }

  const allowed = await loadBackground({ initialTab: pdfTab, fileAccessAllowed: true });
  try {
    allowed.api.action.onClicked.fire(pdfTab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await allowed.send({ target: "background", command: "extract-tab" });
    assert.equal(result.ok, true);
    assert.equal(result.state, "local-pdf-target");
    assert.equal(result.fileAccessAllowed, true);
    assert.equal(result.targetTab.url, pdfTab.url);
    assert.ok(result.targetToken);
    assert.equal(allowed.calls.scripts.length, 0);

    allowed.api.tabs.activeTab = { ...pdfTab, url: "file:///C:/docs/other.pdf" };
    const validation = await allowed.send({
      target: "background", command: "validate-import-target", expectedToken: result.targetToken
    });
    assert.equal(validation.ok, false);
    assert.equal(validation.state, "stale-target");
  } finally { allowed.restore(); }
});

test("local PDF permission status is reported conservatively when Edge cannot confirm it", async () => {
  const hiddenUrlPdf = { id: 22, windowId: 2, url: "", title: "Hidden.pdf" };
  const unknown = await loadBackground({ initialTab: hiddenUrlPdf, fileAccessAllowed: null });
  try {
    unknown.api.action.onClicked.fire(hiddenUrlPdf);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = await unknown.send({ target: "background", command: "extract-tab" });
    assert.equal(result.ok, false);
    assert.equal(result.state, "local-pdf-unavailable");
    assert.equal(result.type, "local-pdf");
  } finally { unknown.restore(); }
});

test("context-menu selection is captured before focus changes and delivered as selection text", async () => {
  const harness = await loadBackground();
  try {
    const menu = harness.calls.contextMenu.find((item) => item.contexts.includes("selection"));
    assert.equal(menu.title, "Enviar selección al lector local");
    harness.api.contextMenus.onClicked.fire({ menuItemId: menu.id, selectionText: "Only selected words" }, harness.api.tabs.activeTab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(harness.calls.panel.at(-1), { tabId: 7 });
    const result = await harness.send({ target: "background", command: "take-pending-selection" });
    assert.equal(result.selection.text, "Only selected words");
    assert.equal(result.selection.sourceUrl, "https://example.test/article");
  } finally { harness.restore(); }
});

