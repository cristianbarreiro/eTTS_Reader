import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTab,
  combineImportedText,
  createLocalPdfPreview,
  extractReadablePage,
  importCurrentTab,
  localPdfRecoveryActions,
  remotePdfRecoveryActions,
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
  assert.equal(result.sourceUrl, "https://example.test");
  assert.equal(fetchOptions.credentials, "omit");
  assert.equal(fetchOptions.referrerPolicy, "no-referrer");
  assert.equal(extractedFile.name, "study.pdf");
  assert.equal(extractedFile.type, "application/pdf");
});

test("remote PDF HTTP failures, scan-only files, and oversized PDFs never report a successful extraction", async () => {
  const tab = { id: 13, url: "https://example.test/scanned.pdf", title: "Scanned.pdf" };
  const unavailable = await importCurrentTab({
    tabsApi: { async query() { return [tab]; } },
    scriptingApi: { async executeScript() { throw new Error("should not inject into PDF viewer"); } },
    fetchImpl: async () => new Response("denied", { status: 403 }),
    extractPdf: async () => { assert.fail("403 must stop before PDF extraction"); }
  });
  assert.equal(unavailable.state, "http-error");
  assert.match(unavailable.message, /HTTP 403/);
  assert.equal(remotePdfRecoveryActions(unavailable).retryWithSiteSession, true);

  const scanOnly = await importCurrentTab({
    tabsApi: { async query() { return [tab]; } },
    scriptingApi: { async executeScript() { return []; } },
    fetchImpl: async () => new Response(new Blob(["%PDF-1.4 scan"]), { headers: { "content-type": "application/pdf" } }),
    extractPdf: async () => { throw new Error("Este PDF no contiene texto extraíble. Puede ser un escaneo."); }
  });
  assert.equal(scanOnly.state, "no-text");
  assert.equal(remotePdfRecoveryActions(scanOnly).retryWithSiteSession, false);

  const oversized = await importCurrentTab({
    tabsApi: { async query() { return [tab]; } },
    scriptingApi: { async executeScript() { return []; } },
    fetchImpl: async () => new Response(null, { headers: { "content-length": String(25 * 1024 * 1024 + 1) } }),
    extractPdf: async () => { assert.fail("oversized PDF must stop before PDF extraction"); }
  });
  assert.equal(oversized.state, "too-large");
  assert.equal(remotePdfRecoveryActions(oversized).retryWithSiteSession, false);

  const networkFailure = await importCurrentTab({
    targetTab: tab, scriptingApi: null,
    fetchImpl: async () => { throw new Error("temporary request URL with signature=secret"); },
    extractPdf: async () => { assert.fail("network errors must stop before PDF.js"); }
  });
  assert.equal(networkFailure.state, "network-error");
  assert.equal(remotePdfRecoveryActions(networkFailure).retryWithSiteSession, true);
  assert.doesNotMatch(networkFailure.message, /signature=secret/);
});

test("authenticated PDF retry is explicit, permission-checked, context-validated, and blocks redirects", async () => {
  const tab = { id: 40, url: "https://campus.example.test/files/report.pdf?signature=private", title: "https://campus.example.test/files/report.pdf?token=private" };
  const validatedContext = { tabId: tab.id, url: tab.url, documentToken: "document-40" };
  let options;
  let validationCalls = 0;
  let extracted = false;
  const result = await importCurrentTab({
    targetTab: tab, authenticatedPdf: true, scriptingApi: null,
    permissionsApi: { async contains(details) { assert.deepEqual(details, { origins: ["https://campus.example.test/*"] }); return true; } },
    validateTarget: async () => { validationCalls++; return { ok: true, context: validatedContext }; },
    fetchImpl: async (_url, fetchOptions) => {
      options = fetchOptions;
      return new Response(new Blob(["%PDF-1.7 private bytes"]), { headers: { "content-type": "application/pdf" } });
    },
    extractPdf: async () => { extracted = true; return "Authenticated PDF text"; }
  });
  assert.equal(validationCalls, 1);
  assert.equal(options.credentials, "include");
  assert.equal(options.redirect, "manual");
  assert.equal(options.referrerPolicy, "no-referrer");
  assert.equal(options.cache, "no-store");
  assert.equal(result.ok, true);
  assert.equal(result.text, "Authenticated PDF text");
  assert.equal(result.title, "PDF");
  assert.equal(result.sourceUrl, "https://campus.example.test");
  assert.equal(extracted, true);

  let redirectedBodyRead = false;
  const redirect = await importCurrentTab({
    targetTab: tab, authenticatedPdf: true, scriptingApi: null,
    permissionsApi: { async contains() { return true; } },
    validateTarget: async () => ({ ok: true, context: validatedContext }),
    fetchImpl: async (_url, fetchOptions) => {
      assert.equal(fetchOptions.redirect, "manual");
      return { ok: false, status: 0, type: "opaqueredirect", redirected: false, url: "", headers: { get: () => null }, get body() { redirectedBodyRead = true; return null; } };
    },
    extractPdf: async () => { assert.fail("redirect response must not reach PDF.js"); }
  });
  assert.equal(redirect.state, "redirect-not-allowed");
  assert.equal(redirect.authenticatedAttempted, true);
  assert.equal(remotePdfRecoveryActions(redirect).retryWithSiteSession, false);
  assert.equal(redirectedBodyRead, false);

  const crossOriginResponse = new Response(new Blob(["%PDF-1.7 bytes"]), { headers: { "content-type": "application/pdf" } });
  Object.defineProperty(crossOriginResponse, "url", { value: "https://cdn.other.test/report.pdf?signature=private" });
  const crossOriginRedirect = await importCurrentTab({
    targetTab: tab, scriptingApi: null,
    fetchImpl: async () => crossOriginResponse,
    extractPdf: async () => { assert.fail("cross-origin redirect must not reach PDF.js"); }
  });
  assert.equal(crossOriginRedirect.state, "redirect-not-allowed");
  assert.equal(remotePdfRecoveryActions(crossOriginRedirect).retryWithSiteSession, false);
  assert.equal(crossOriginRedirect.sourceUrl, "https://campus.example.test");
  assert.doesNotMatch(JSON.stringify(crossOriginRedirect), /signature=private/);
});

test("authenticated PDF fetch refuses to start without current context and host permission", async () => {
  const tab = { id: 41, url: "https://campus.example.test/files/report.pdf?token=secret", title: "Report.pdf" };
  const validatedContext = { tabId: tab.id, url: tab.url, documentToken: "document-41" };
  let fetchCalls = 0;
  const stale = await importCurrentTab({
    targetTab: tab, authenticatedPdf: true,
    permissionsApi: { async contains() { return true; } },
    validateTarget: async () => ({ ok: false, state: "stale-context", message: "La pestaña cambió." }),
    fetchImpl: async () => { fetchCalls++; }
  });
  assert.equal(stale.state, "stale-context");
  assert.equal(fetchCalls, 0);

  const denied = await importCurrentTab({
    targetTab: tab, authenticatedPdf: true,
    permissionsApi: { async contains() { return false; } },
    validateTarget: async () => ({ ok: true, context: validatedContext }),
    fetchImpl: async () => { fetchCalls++; }
  });
  assert.equal(denied.state, "site-permission-required");
  assert.equal(fetchCalls, 0);
});

test("remote PDF diagnostics detect HTML and keep manual recovery without exposing URL tokens", async () => {
  const tab = { id: 42, url: "https://campus.example.test/file.pdf?token=secret", title: "https://campus.example.test/file.pdf?token=secret" };
  let extractionCalls = 0;
  const html = await importCurrentTab({
    targetTab: tab, scriptingApi: null,
    fetchImpl: async () => new Response("<!doctype html><title>Sign in</title>", { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }),
    extractPdf: async () => { extractionCalls++; return "should not run"; }
  });
  assert.equal(html.state, "html-response");
  assert.match(html.message, /HTML, no con el PDF/);
  assert.equal(remotePdfRecoveryActions(html).retryWithSiteSession, true);
  assert.equal(html.sourceUrl, "https://campus.example.test");
  assert.equal(html.title, "PDF");
  assert.doesNotMatch(JSON.stringify(html), /token=secret/);
  assert.equal(extractionCalls, 0);

  const sniffedHtml = await importCurrentTab({
    targetTab: { ...tab, title: "File" }, scriptingApi: null,
    fetchImpl: async () => new Response("<html><body>Sign in</body></html>"),
    extractPdf: async () => { extractionCalls++; return "should not run"; }
  });
  assert.equal(sniffedHtml.state, "html-response");
  assert.equal(extractionCalls, 0);

  const wrongMime = await importCurrentTab({
    targetTab: tab, scriptingApi: null,
    fetchImpl: async () => new Response("%PDF-1.7 bytes", { headers: { "content-type": "text/plain" } }),
    extractPdf: async () => { extractionCalls++; return "should not run"; }
  });
  assert.equal(wrongMime.state, "unsupported-content-type");
  assert.equal(remotePdfRecoveryActions(wrongMime).retryWithSiteSession, true);
  assert.equal(extractionCalls, 0);

  const authenticatedHtml = await importCurrentTab({
    targetTab: tab, authenticatedPdf: true, scriptingApi: null,
    permissionsApi: { async contains() { return true; } },
    validateTarget: async () => ({ ok: true, context: { tabId: tab.id, url: tab.url, documentToken: "document-42" } }),
    fetchImpl: async () => new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
    extractPdf: async () => { extractionCalls++; return "should not run"; }
  });
  assert.equal(authenticatedHtml.state, "html-response");
  assert.equal(authenticatedHtml.authenticatedAttempted, true);
  assert.equal(remotePdfRecoveryActions(authenticatedHtml).retryWithSiteSession, false);
  assert.equal(extractionCalls, 0);
});

test("remote PDF selection explains copy and paste without fetching or requesting files", async () => {
  let fetchCalls = 0;
  const result = await importCurrentTab({
    targetTab: { id: 43, url: "https://campus.example.test/reader.pdf", title: "Reader.pdf" },
    selectionOnly: true,
    fetchImpl: async () => { fetchCalls++; }
  });
  assert.equal(result.state, "selection-unavailable");
  assert.match(result.message, /Ctrl\+C.*Ctrl\+V/);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(localPdfRecoveryActions(result), { selectPdf: false, previewSelectedPdf: false, retryFileAccess: false });
});

test("local PDF fetching requires Edge file access and never injects into the PDF viewer", async () => {
  const tab = { id: 31, url: "file:///C:/docs/report.pdf#page=2", title: "Report.pdf" };
  let fetchCalls = 0;
  const denied = await importCurrentTab({
    targetTab: tab,
    fileAccessAllowed: false,
    scriptingApi: null,
    fetchImpl: async () => { fetchCalls++; throw new Error("must not fetch without permission"); }
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.state, "file-access-disabled");
  assert.equal(denied.type, "local-pdf");
  assert.equal(fetchCalls, 0);
  assert.deepEqual(localPdfRecoveryActions(denied), { selectPdf: true, previewSelectedPdf: true, retryFileAccess: true });

  let fetchOptions;
  let extractedFile;
  const statuses = [];
  const success = await importCurrentTab({
    targetTab: tab,
    fileAccessAllowed: true,
    scriptingApi: null,
    fetchImpl: async (url, options) => {
      fetchCalls++;
      assert.equal(url, tab.url);
      fetchOptions = options;
      return new Response(new Blob(["%PDF-1.7 local bytes"]), { headers: { "content-type": "application/pdf" } });
    },
    onStatus: ({ state }) => statuses.push(state),
    extractPdf: async (file) => { extractedFile = file; return "Local PDF text."; }
  });
  assert.equal(success.ok, true);
  assert.equal(success.type, "local-pdf");
  assert.equal(success.text, "Local PDF text.");
  assert.equal(success.sourceUrl, "");
  assert.equal(fetchOptions.credentials, "omit");
  assert.equal(fetchOptions.referrerPolicy, "no-referrer");
  assert.equal(fetchOptions.cache, "no-store");
  assert.equal(extractedFile.name, "report.pdf");
  assert.equal(extractedFile.type, "application/pdf");
  assert.deepEqual(statuses, ["detecting", "retrieving-local-pdf", "extracting-pdf"]);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(localPdfRecoveryActions({ state: "file-access-disabled", type: "local-pdf" }), {
    selectPdf: true, previewSelectedPdf: true, retryFileAccess: true
  });
});

test("manual local PDF selection produces a bounded preview without exposing a local path", () => {
  const file = { name: "Selected.pdf" };
  const preview = createLocalPdfPreview(file, "Extracted text", 8);
  assert.deepEqual(preview, {
    ok: true,
    state: "complete",
    title: "Selected.pdf",
    sourceUrl: "",
    type: "local-pdf",
    text: "Extracte",
    characters: 8,
    truncated: true,
    message: "PDF leído localmente desde el archivo seleccionado. Revisa el texto y elige Reemplazar o Añadir para aplicarlo."
  });
});

test("local PDF errors preserve manual recovery and never accept unrelated bytes or redirects", async () => {
  const tab = { id: 32, url: "file:///C:/docs/report.pdf", title: "Report.pdf" };
  const invalid = await importCurrentTab({
    targetTab: tab, fileAccessAllowed: true, scriptingApi: null,
    fetchImpl: async () => new Response("not a PDF"),
    extractPdf: async () => { assert.fail("invalid signature must stop before extraction"); }
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.state, "local-pdf-unavailable");
  assert.equal(localPdfRecoveryActions(invalid).previewSelectedPdf, true);

  const redirectedResponse = new Response(new Blob(["%PDF-1.7 bytes"]), { headers: { "content-type": "application/pdf" } });
  Object.defineProperty(redirectedResponse, "url", { value: "file:///C:/docs/other.pdf" });
  const redirected = await importCurrentTab({
    targetTab: tab, fileAccessAllowed: true, scriptingApi: null,
    fetchImpl: async () => redirectedResponse,
    extractPdf: async () => { assert.fail("a redirected local file must not be extracted"); }
  });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.state, "local-pdf-unavailable");

  const failed = await importCurrentTab({
    targetTab: tab, fileAccessAllowed: true, scriptingApi: null,
    fetchImpl: async () => { throw new Error("Failed to fetch"); },
    extractPdf: async () => { assert.fail("failed fetch must stop before extraction"); }
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.state, "local-pdf-unavailable");
  assert.match(failed.message, /selecciona el archivo PDF original manualmente/i);
});

test("local PDF size limit and empty text remain explicit errors", async () => {
  const tab = { id: 33, url: "file:///C:/docs/report.pdf", title: "Report.pdf" };
  const oversized = await importCurrentTab({
    targetTab: tab, fileAccessAllowed: true, scriptingApi: null, maxBytes: 3,
    fetchImpl: async () => new Response(null, { headers: { "content-length": "4" } }),
    extractPdf: async () => { assert.fail("oversized files must stop before extraction"); }
  });
  assert.equal(oversized.state, "too-large");
  assert.equal(oversized.type, "local-pdf");

  const scan = await importCurrentTab({
    targetTab: tab, fileAccessAllowed: true, scriptingApi: null,
    fetchImpl: async () => new Response(new Blob(["%PDF-1.7 scanned"])),
    extractPdf: async () => { throw new Error("Este PDF no contiene texto extraíble. Puede ser un escaneo."); }
  });
  assert.equal(scan.state, "no-text");
  assert.equal(scan.type, "local-pdf");
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
