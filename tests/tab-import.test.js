import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTab,
  combineImportedText,
  extractReadablePage,
  importCurrentTab,
  safeSourceUrl
} from "../src/tab-import.js";

test("tab classification separates web, text files, PDFs, local files, and restricted URLs", () => {
  assert.equal(classifyTab({ url: "https://example.test/article", title: "An article" }).kind, "web-page");
  assert.equal(classifyTab({ url: "https://example.test/feed.json?token=secret" }).kind, "text-document");
  assert.equal(classifyTab({ url: "https://example.test/feed.csv" }).kind, "text-document");
  assert.equal(classifyTab({ url: "https://example.test/readme.md" }).kind, "text-document");
  assert.equal(classifyTab({ url: "https://example.test/report.pdf?download=1" }).kind, "pdf");
  assert.equal(classifyTab({ url: "https://docs.google.com/document/d/123/edit" }).kind, "google-docs");
  assert.equal(classifyTab({ url: "file:///C:/docs/report.pdf" }).kind, "local-pdf");
  assert.equal(classifyTab({ url: "file:///C:/docs/readme.txt" }).kind, "local-text-document");
  assert.equal(classifyTab({ url: "file:///C:/docs/index.html" }).kind, "local-text-document");
  assert.equal(classifyTab({ url: "edge://extensions" }).kind, "restricted");
  assert.equal(classifyTab({ title: "Some tab" }).kind, "permission-required");
});

test("source metadata strips URL credentials, query parameters, and fragments", () => {
  assert.equal(safeSourceUrl("https://user:password@example.test/read?token=secret#section"), "https://example.test/read");
  assert.equal(safeSourceUrl("file:///C:/private/report.pdf"), "");
});

test("page extractor prefers article, excludes navigation, hidden nodes, scripts, and form values", () => {
  const body = element("body", {}, [
    element("nav", {}, [text("Repeated site navigation")]),
    element("main", {}, [element("p", {}, [text("Short main wrapper that should not replace the article.")])]),
    element("article", {}, [
      element("h1", {}, [text("Article heading")]),
      element("p", {}, [text("This is the primary article paragraph. ".repeat(6))]),
      element("script", {}, [text("secret script data")]),
      element("div", { hidden: "" }, [text("hidden content")]),
      element("form", {}, [element("input", { value: "private value" })])
    ])
  ]);
  const result = withFakePage({ title: "Example article", contentType: "text/html", body }, () => extractReadablePage());
  assert.equal(result.type, "article");
  assert.match(result.text, /Article heading/);
  assert.match(result.text, /primary article paragraph/);
  assert.doesNotMatch(result.text, /Repeated site navigation|secret script data|hidden content|private value/);
});

test("page extractor falls back to main and captures the current visible selection only", () => {
  const body = element("body", {}, [element("main", { role: "main" }, [element("p", {}, [text("Visible paragraph. ".repeat(8))])])]);
  const mainResult = withFakePage({ title: "Main page", contentType: "text/html", body }, () => extractReadablePage());
  assert.equal(mainResult.type, "main-content");
  assert.match(mainResult.text, /Visible paragraph/);

  const selected = withFakePage({ title: "Main page", contentType: "text/html", body, selection: "Only selected text" }, () => extractReadablePage({ selectionOnly: true }));
  assert.equal(selected.type, "selection");
  assert.equal(selected.text, "Only selected text");
});

test("text viewer extraction preserves preformatted JSON and respects the character limit", () => {
  const source = '{\n  "name": "Ada",\n  "enabled": true\n}';
  const body = element("body", {}, [element("pre", {}, [text(source)])]);
  const output = withFakePage({ title: "data.json", contentType: "application/json", body }, () => extractReadablePage({ maxCharacters: 18 }));
  assert.equal(output.type, "text-document");
  assert.equal(output.text, source.slice(0, 18));
  assert.equal(output.truncated, true);
});

test("CSV text and XML markup retain their source representation", () => {
  const csv = "name,score\r\nAda,10  \r\n";
  const csvBody = element("body", {}, [element("pre", {}, [text(csv)])]);
  const csvResult = withFakePage({ title: "scores.csv", contentType: "text/csv", body: csvBody }, () => extractReadablePage());
  assert.equal(csvResult.text, "name,score\nAda,10  \n");

  const xml = "<feed><item>Keep tags</item></feed>";
  const xmlRoot = element("feed", {}, [element("item", {}, [text("Keep tags")])]);
  xmlRoot.namespaceURI = "urn:feed";
  const xmlBody = element("body", {}, [element("p", {}, [text("Browser-rendered tree")])]);
  const xmlResult = withFakePage({ title: "feed.xml", contentType: "application/xml", body: xmlBody, documentElement: xmlRoot, xmlText: xml }, () => extractReadablePage());
  assert.equal(xmlResult.text, xml);
});

test("Google Docs returns only visible accessible page text and marks it partial", () => {
  const body = element("body", {}, [
    element("div", { class: "kix-lineview-text-block" }, [text("Visible document line.")]),
    element("div", { class: "kix-lineview-text-block", "aria-hidden": "true" }, [text("Hidden duplicate.")])
  ]);
  const output = withFakePage({ title: "Project notes", contentType: "text/html", body, hostname: "docs.google.com" }, () => extractReadablePage());
  assert.equal(output.type, "google-docs-visible");
  assert.equal(output.coverage, "visible-pages");
  assert.equal(output.text, "Visible document line.");
  assert.doesNotMatch(output.text, /Hidden duplicate|Google Docs/);
});

test("web page extraction uses the active tab on demand and does not fetch the site", async () => {
  let scriptCall;
  let fetchCalls = 0;
  const result = await importCurrentTab({
    tabsApi: { async query(options) { assert.deepEqual(options, { active: true, lastFocusedWindow: true }); return [{ id: 17, url: "https://example.test/read?secret=one", title: "Read me" }]; } },
    scriptingApi: { async executeScript(options) { scriptCall = options; return [{ result: { title: "Read me", contentType: "text/html", type: "article", text: "Local article body", truncated: false } }]; } },
    fetchImpl: async () => { fetchCalls++; throw new Error("web pages must not be fetched"); }
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, "complete");
  assert.equal(result.characters, 18);
  assert.equal(result.sourceUrl, "https://example.test/read");
  assert.equal(scriptCall.target.tabId, 17);
  assert.equal(scriptCall.args[0].selectionOnly, false);
  assert.equal(fetchCalls, 0);
});

test("selection import asks the injected page only for selected text", async () => {
  let scriptCall;
  const result = await importCurrentTab({
    selectionOnly: true,
    tabsApi: { async query() { return [{ id: 3, url: "https://example.test", title: "Page" }]; } },
    scriptingApi: { async executeScript(options) { scriptCall = options; return [{ result: { title: "Page", contentType: "text/html", type: "selection", text: "Selected", truncated: false } }]; } }
  });
  assert.equal(scriptCall.args[0].selectionOnly, true);
  assert.equal(result.type, "selection");
  assert.equal(result.text, "Selected");
});

test("missing temporary access, protected tabs, empty pages, and injection failures are reported", async () => {
  let injected = false;
  const inaccessible = await importCurrentTab({
    tabsApi: { async query() { return [{ id: 8, title: "Tab without granted URL" }]; } },
    scriptingApi: { async executeScript() { injected = true; return []; } }
  });
  assert.equal(inaccessible.state, "permission-required");
  assert.equal(injected, false);

  const restricted = await importCurrentTab({
    tabsApi: { async query() { return [{ id: 9, url: "edge://settings", title: "Settings" }]; } },
    scriptingApi: { async executeScript() { injected = true; return []; } }
  });
  assert.equal(restricted.state, "restricted");
  assert.equal(injected, false);

  const empty = await importCurrentTab({
    tabsApi: { async query() { return [{ id: 10, url: "https://example.test/blank", title: "Blank" }]; } },
    scriptingApi: { async executeScript() { return [{ result: { title: "Blank", contentType: "text/html", type: "web-page", text: "" } }]; } }
  });
  assert.equal(empty.state, "no-text");

  const noSelection = await importCurrentTab({
    selectionOnly: true,
    tabsApi: { async query() { return [{ id: 10, url: "https://example.test/blank", title: "Blank" }]; } },
    scriptingApi: { async executeScript() { return [{ result: { title: "Blank", contentType: "text/html", type: "selection", text: "" } }]; } }
  });
  assert.equal(noSelection.state, "no-selection");

  const denied = await importCurrentTab({
    tabsApi: { async query() { return [{ id: 11, url: "https://example.test/private", title: "Private" }]; } },
    scriptingApi: { async executeScript() { throw new Error("Cannot access contents of url"); } }
  });
  assert.equal(denied.state, "restricted");
  assert.match(denied.message, /acceso temporal/);
});

test("remote PDF bytes are bounded, fetched without cookies, and passed to the existing local extractor", async () => {
  let fetchOptions;
  let extractedFile;
  const response = new Response(new Blob(["%PDF-1.7 test bytes"]), {
    headers: { "content-type": "application/pdf" }
  });
  const result = await importCurrentTab({
    tabsApi: { async query() { return [{ id: 12, url: "https://example.test/papers/study.pdf?sig=secret", title: "Study.pdf" }]; } },
    scriptingApi: { async executeScript() { throw new Error("PDF viewers are not injected"); } },
    fetchImpl: async (_url, options) => { fetchOptions = options; return response; },
    extractPdf: async (file) => { extractedFile = file; return "Extracted PDF text."; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.type, "pdf");
  assert.equal(result.text, "Extracted PDF text.");
  assert.equal(result.sourceUrl, "https://example.test/papers/study.pdf");
  assert.equal(fetchOptions.credentials, "omit");
  assert.equal(fetchOptions.referrerPolicy, "no-referrer");
  assert.equal(extractedFile.name, "study.pdf");
  assert.equal(extractedFile.type, "application/pdf");
});

test("PDF fetch failures, scan-only files, and oversized PDFs never report a successful extraction", async () => {
  const tab = { id: 13, url: "https://example.test/scanned.pdf", title: "Scanned.pdf" };
  const unavailable = await importCurrentTab({
    tabsApi: { async query() { return [tab]; } },
    scriptingApi: { async executeScript() { throw new Error("should not inject into PDF viewer"); } },
    fetchImpl: async () => new Response("denied", { status: 403 }),
    extractPdf: async () => { assert.fail("403 must stop before PDF extraction"); }
  });
  assert.equal(unavailable.state, "file-unavailable");

  const scanOnly = await importCurrentTab({
    tabsApi: { async query() { return [tab]; } },
    scriptingApi: { async executeScript() { return []; } },
    fetchImpl: async () => new Response(new Blob(["%PDF-1.4 scan"]), { headers: { "content-type": "application/pdf" } }),
    extractPdf: async () => { throw new Error("Este PDF no contiene texto extraíble. Puede ser un escaneo."); }
  });
  assert.equal(scanOnly.state, "no-text");

  const oversized = await importCurrentTab({
    tabsApi: { async query() { return [tab]; } },
    scriptingApi: { async executeScript() { return []; } },
    fetchImpl: async () => new Response(null, { headers: { "content-length": String(25 * 1024 * 1024 + 1) } }),
    extractPdf: async () => { assert.fail("oversized PDF must stop before PDF extraction"); }
  });
  assert.equal(oversized.state, "too-large");
});

test("replace, append, duplicate confirmation, and editor-size limits are explicit", () => {
  assert.deepEqual(combineImportedText("old", "new", "replace"), { ok: true, text: "new" });
  assert.deepEqual(combineImportedText("old", "new", "append"), { ok: true, text: "old\n\nnew" });
  assert.equal(combineImportedText("old\n\nnew", "new", "append").confirmationRequired, true);
  assert.deepEqual(combineImportedText("old\n\nnew", "new", "append", { allowDuplicate: true }), { ok: true, text: "old\n\nnew\n\nnew" });
  assert.equal(combineImportedText("long", "12345", "append", { maxCharacters: 8 }).ok, false);
  assert.equal(combineImportedText("old", " ", "replace").ok, false);
});

function text(value) { return { nodeType: 3, nodeValue: value, textContent: value }; }

function element(tagName, attributes = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attributes,
    childNodes: children,
    parentElement: null,
    get textContent() { return this.childNodes.map((child) => child.textContent || "").join(""); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    closest(selector) {
      let current = this;
      while (current) {
        if (selector === "article" && current.tagName?.toLowerCase() === "article") return current;
        current = current.parentElement;
      }
      return null;
    },
    querySelectorAll(selector) {
      const selectors = selector.split(",").map((item) => item.trim());
      const descendants = [];
      const visit = (parent) => {
        for (const child of parent.childNodes || []) {
          if (child.nodeType === 1) {
            descendants.push(child);
            visit(child);
          }
        }
      };
      visit(this);
      return descendants.filter((child) => selectors.some((item) => {
        const roleMatch = item.match(/^\[role=['"]([^'"]+)['"]\]$/);
        const classMatch = item.match(/^\.([\w-]+)$/);
        return roleMatch ? child.getAttribute("role") === roleMatch[1]
          : classMatch ? String(child.getAttribute("class") || "").split(/\s+/).includes(classMatch[1])
            : child.tagName.toLowerCase() === item;
      }));
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  };
  for (const child of children) if (child.nodeType === 1) child.parentElement = node;
  node.children = children.filter((child) => child.nodeType === 1);
  node.firstElementChild = node.children[0] || null;
  return node;
}

function withFakePage({ title, contentType, body, selection = "", documentElement = null, xmlText = "", hostname = "example.test" }, run) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  body.ownerDocument = null;
  const doc = {
    title, contentType, body, documentElement,
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    createTextNode: (value) => text(value)
  };
  globalThis.document = doc;
  globalThis.window = {
    location: { hostname },
    getSelection: () => ({ toString: () => selection }),
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    XMLSerializer: class { serializeToString() { return xmlText; } }
  };
  try { return run(); } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
}
