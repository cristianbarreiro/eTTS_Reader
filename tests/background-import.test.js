import test from "node:test";
import assert from "node:assert/strict";

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    fire(...args) { return listeners.at(-1)?.(...args); }
  };
}

async function loadBackground({
  initialTab = { id: 7, windowId: 2, url: "https://example.test/article", title: "Article" },
  scriptResult = { title: "Article", contentType: "text/html", type: "article", text: "Local page text", truncated: false },
  scriptResponse = null, fileAccessAllowed = false, tabsPermissionGranted = false,
  hostPermissions = [], permissionDecision = true
} = {}) {
  const values = new Map();
  const localValues = new Map();
  const grantedHosts = new Set(hostPermissions);
  const calls = { panel: [], scripts: [], contextMenu: [], messages: [], permissionRequests: [] };
  const api = {
    runtime: {
      getManifest: () => ({ side_panel: { default_path: "sidepanel.html" } }),
      getURL: (path) => `chrome-extension://test/${path}`,
      onInstalled: event(), onMessage: event(),
      async sendMessage(message) { calls.messages.push(message); return { ok: true }; }
    },
    extension: { async isAllowedFileSchemeAccess() { return fileAccessAllowed; } },
    storage: {
      session: {
        async set(record) { for (const [key, value] of Object.entries(record)) values.set(key, value); },
        async get(key) { return { [key]: values.get(key) }; },
        async remove(key) { values.delete(key); }
      },
      local: {
        async set(record) { for (const [key, value] of Object.entries(record)) localValues.set(key, value); },
        async get(key) { return { [key]: localValues.get(key) }; }
      }
    },
    sidePanel: {
      async open(options) { calls.panel.push(options); },
      async setPanelBehavior() {}
    },
    tabs: {
      onActivated: event(), onUpdated: event(), onRemoved: event(), activeTab: initialTab,
      async query(query = {}) { return this.activeTab && (!Number.isInteger(query.windowId) || this.activeTab.windowId === query.windowId) ? [this.activeTab] : []; },
      async get(id) { return this.activeTab?.id === id ? this.activeTab : null; }
    },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: event() },
    permissions: {
      onAdded: event(), onRemoved: event(),
      async contains(details) {
        if (details.permissions?.includes("tabs") && !tabsPermissionGranted) return false;
        return (details.origins || []).every((origin) => grantedHosts.has(origin));
      },
      async request(details) {
        calls.permissionRequests.push(details);
        if (!permissionDecision) return false;
        if (details.permissions?.includes("tabs")) tabsPermissionGranted = true;
        for (const origin of details.origins || []) grantedHosts.add(origin);
        return true;
      }
    },
    action: { onClicked: event() },
    contextMenus: { onClicked: event(), async removeAll() {}, create(item) { calls.contextMenu.push(item); } },
    scripting: { async executeScript(options) { calls.scripts.push(options); return scriptResponse ? scriptResponse(options) : [{ result: scriptResult }]; } },
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
    api, calls, values, localValues, send,
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

test("optional follow mode reports the newly active tab and extraction uses that tab id", async () => {
  const harness = await loadBackground({
    tabsPermissionGranted: true,
    hostPermissions: ["https://example.test/*", "https://other.test/*"]
  });
  try {
    const enabled = await harness.send({ target: "background", command: "set-follow-active-tab", enabled: true });
    assert.equal(enabled.ok, true);
    assert.equal(enabled.context.tabId, 7);

    const tabB = { id: 8, windowId: 2, url: "https://other.test/story", title: "Other page", active: true };
    harness.api.tabs.activeTab = tabB;
    harness.api.tabs.onActivated.fire({ tabId: tabB.id, windowId: tabB.windowId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(harness.calls.scripts.length, 0, "tab changes must not start extraction");
    assert.equal(harness.calls.permissionRequests.length, 0, "tab changes must not request permissions");
    const latest = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(latest.context.tabId, tabB.id);
    assert.equal(latest.context.url, tabB.url);

    const result = await harness.send({
      target: "background", command: "extract-current-tab", context: latest.context, operationId: 19
    });
    assert.equal(result.ok, true);
    assert.equal(result.operationId, 19);
    assert.equal(harness.calls.scripts.at(-1).target.tabId, tabB.id);
    assert.equal(harness.calls.messages.some((message) => message.target === "offscreen"), false);
    assert.ok(harness.calls.messages.some((message) => message.type === "active-tab-context" && message.context.tabId === tabB.id));
  } finally { harness.restore(); }
});

test("the active-tab context includes an authorized browser favicon without triggering extraction or extra permissions", async () => {
  const faviconUrl = "https://cdn.example.test/site-icon.svg";
  const harness = await loadBackground({
    initialTab: { id: 7, windowId: 2, url: "https://example.test/article", title: "Article", favIconUrl: faviconUrl, active: true }
  });
  try {
    const result = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(result.context.favIconUrl, faviconUrl);
    assert.equal(result.context.title, "Article");
    assert.equal(harness.calls.scripts.length, 0);
    assert.equal(harness.calls.permissionRequests.length, 0);
  } finally { harness.restore(); }
});

test("a local PDF keeps a readable filename and no stale favicon when the browser has no icon", async () => {
  const fileUrl = "file:///C:/Users/crist/Documents/Reading/Annual%20Report.pdf";
  const harness = await loadBackground({
    initialTab: { id: 7, windowId: 2, url: fileUrl, title: fileUrl, active: true },
    fileAccessAllowed: false,
    tabsPermissionGranted: true
  });
  try {
    const result = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(result.context.state, "local-pdf");
    assert.equal(result.context.title, "Annual Report.pdf");
    assert.equal(result.context.location, "Annual Report.pdf");
    assert.equal(result.context.favIconUrl, "");
    assert.equal(result.context.tabsPermissionGranted, true);
  } finally { harness.restore(); }
});

test("a favicon update refreshes the active-tab presentation without starting an import", async () => {
  const harness = await loadBackground({
    initialTab: { id: 7, windowId: 2, url: "https://example.test/article", title: "Article", favIconUrl: "https://example.test/old.ico", active: true },
    tabsPermissionGranted: true
  });
  try {
    const enabled = await harness.send({ target: "background", command: "set-follow-active-tab", enabled: true });
    const previousRevision = enabled.context.faviconRevision;
    harness.api.tabs.activeTab = { ...harness.api.tabs.activeTab, favIconUrl: "https://cdn.example.test/new.svg" };
    harness.api.tabs.onUpdated.fire(7, { favIconUrl: "https://cdn.example.test/new.svg" }, harness.api.tabs.activeTab);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const latest = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(latest.context.favIconUrl, "https://cdn.example.test/new.svg");
    assert.ok(latest.context.faviconRevision > previousRevision);
    assert.equal(harness.calls.scripts.length, 0);
    assert.equal(harness.calls.permissionRequests.length, 0);
  } finally { harness.restore(); }
});

test("a title update refreshes visible tab metadata without changing the document or importing text", async () => {
  const harness = await loadBackground({
    initialTab: { id: 7, windowId: 2, url: "https://example.test/article", title: "Original title", favIconUrl: "https://example.test/icon.svg", active: true },
    tabsPermissionGranted: true
  });
  try {
    const enabled = await harness.send({ target: "background", command: "set-follow-active-tab", enabled: true });
    harness.api.tabs.activeTab = { ...harness.api.tabs.activeTab, title: "Updated title" };
    harness.api.tabs.onUpdated.fire(7, { title: "Updated title" }, harness.api.tabs.activeTab);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const latest = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(latest.context.title, "Updated title");
    assert.equal(latest.context.documentToken, enabled.context.documentToken);
    assert.equal(latest.context.favIconUrl, enabled.context.favIconUrl);
    assert.equal(harness.calls.scripts.length, 0);
  } finally { harness.restore(); }
});

test("navigation changes the document token and rejects the previous document context", async () => {
  const harness = await loadBackground({
    tabsPermissionGranted: true,
    hostPermissions: ["https://example.test/*"],
    initialTab: { id: 7, windowId: 2, url: "https://example.test/article", title: "Article", favIconUrl: "https://example.test/old.svg", active: true }
  });
  try {
    const enabled = await harness.send({ target: "background", command: "set-follow-active-tab", enabled: true });
    const previous = enabled.context;
    harness.api.tabs.activeTab = { ...harness.api.tabs.activeTab, url: "https://example.test/next", title: "Next page" };
    harness.api.tabs.onUpdated.fire(7, { url: "https://example.test/next" }, harness.api.tabs.activeTab);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await harness.send({ target: "background", command: "extract-current-tab", context: previous, operationId: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.state, "stale-context");
    assert.equal(harness.calls.scripts.length, 0);
    const latest = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(latest.context.favIconUrl, "", "navigation must not keep showing the previous page icon while the new one loads");
    assert.ok(latest.context.faviconRevision > previous.faviconRevision);
  } finally { harness.restore(); }
});

test("site access is checked before scripting and restricted browser pages remain unavailable", async () => {
  const harness = await loadBackground({ tabsPermissionGranted: true, hostPermissions: [] });
  try {
    const enabled = await harness.send({ target: "background", command: "set-follow-active-tab", enabled: true });
    const denied = await harness.send({ target: "background", command: "extract-current-tab", context: enabled.context, operationId: 21 });
    assert.equal(denied.state, "site-permission-required");
    assert.equal(denied.hostPattern, "https://example.test/*");
    assert.equal(harness.calls.scripts.length, 0);
    assert.equal(harness.calls.permissionRequests.length, 0, "the background must wait for an import click before requesting site access");

    harness.api.tabs.activeTab = { id: 9, windowId: 2, url: "edge://settings", title: "Settings", active: true };
    harness.api.tabs.onActivated.fire({ tabId: 9, windowId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const restricted = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(restricted.context.state, "restricted");
    const blocked = await harness.send({ target: "background", command: "extract-current-tab", context: restricted.context, operationId: 22 });
    assert.equal(blocked.state, "restricted");
    assert.equal(harness.calls.scripts.length, 0);
  } finally { harness.restore(); }
});

test("a removed active tab resolves to the remaining tab without retaining the closed id", async () => {
  const harness = await loadBackground({
    tabsPermissionGranted: true,
    hostPermissions: ["https://example.test/*", "https://other.test/*"]
  });
  try {
    const enabled = await harness.send({ target: "background", command: "set-follow-active-tab", enabled: true });
    const remaining = { id: 8, windowId: 2, url: "https://other.test/", title: "Remaining", active: true };
    harness.api.tabs.activeTab = remaining;
    harness.api.tabs.onRemoved.fire(7, { windowId: 2, isWindowClosing: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latest = await harness.send({ target: "background", command: "get-active-tab-context" });
    assert.equal(latest.context.tabId, remaining.id);
    assert.notEqual(latest.context.tabId, enabled.context.tabId);
  } finally { harness.restore(); }
});

test("an extraction result is discarded when navigation happens while the script is running", async () => {
  let resolveScript;
  const scriptResponse = () => new Promise((resolve) => { resolveScript = resolve; });
  const harness = await loadBackground({
    tabsPermissionGranted: true,
    hostPermissions: ["https://example.test/*"],
    scriptResponse
  });
  try {
    const enabled = await harness.send({ target: "background", command: "set-follow-active-tab", enabled: true });
    const pending = harness.send({ target: "background", command: "extract-current-tab", context: enabled.context, operationId: 23 });
    while (!resolveScript) await new Promise((resolve) => setTimeout(resolve, 0));
    harness.api.tabs.activeTab = { ...harness.api.tabs.activeTab, url: "https://example.test/changed" };
    harness.api.tabs.onUpdated.fire(7, { url: "https://example.test/changed" }, harness.api.tabs.activeTab);
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveScript([{ result: { title: "Old page", text: "must be discarded" } }]);
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.state, "stale-context");
    assert.equal(result.text, undefined);
  } finally { harness.restore(); }
});

