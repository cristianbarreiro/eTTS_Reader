import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createTabFaviconPresenter,
  localTabFileName,
  safeTabFaviconUrl,
  safeTabTitle,
  tabFaviconFallbackKind
} from "../src/tab-card-presentation.js";

const sidepanel = await readFile(fileURLToPath(new URL("../sidepanel.html", import.meta.url)), "utf8");
const styles = await readFile(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");

test("favicon URLs accept browser-provided web and image data URLs without executable schemes", () => {
  assert.equal(safeTabFaviconUrl("https://cdn.example.test/icons/site.svg?size=64"), "https://cdn.example.test/icons/site.svg?size=64");
  assert.equal(safeTabFaviconUrl("http://example.test/favicon.ico"), "http://example.test/favicon.ico");
  assert.equal(safeTabFaviconUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(safeTabFaviconUrl("javascript:alert(1)"), "");
  assert.equal(safeTabFaviconUrl("chrome://favicon/https://example.test"), "");
  assert.equal(safeTabFaviconUrl(`https://example.test/${"x".repeat(131_073)}`), "");
});

test("favicon fallbacks distinguish web pages from local documents", () => {
  assert.equal(tabFaviconFallbackKind("web-page"), "web");
  assert.equal(tabFaviconFallbackKind("restricted"), "web");
  assert.equal(tabFaviconFallbackKind("pdf"), "document");
  assert.equal(tabFaviconFallbackKind("local-pdf"), "document");
  assert.equal(tabFaviconFallbackKind("text-document"), "document");
});

test("local files display only their decoded basename and not the local path", () => {
  const fileUrl = "file:///C:/Users/crist/Documents/Reading/Annual%20Report.pdf";
  assert.equal(localTabFileName(fileUrl), "Annual Report.pdf");
  assert.equal(safeTabTitle("file:///C:/Users/crist/Documents/Reading/Annual%20Report.pdf", fileUrl), "Annual Report.pdf");
  assert.equal(safeTabTitle("C:\\Users\\crist\\Documents\\Reading\\Annual Report.pdf", fileUrl), "Annual Report.pdf");
  assert.equal(safeTabTitle("Report overview", fileUrl), "Report overview");
});

test("favicon presentation shows the real icon after load and falls back on missing or failed resources", () => {
  const image = {
    hidden: true,
    dataset: {},
    naturalWidth: 32,
    onload: null,
    onerror: null,
    src: "",
    removeAttribute(name) { if (name === "src") this.src = ""; }
  };
  const fallback = { hidden: true, dataset: {} };
  const present = createTabFaviconPresenter(image, fallback);

  present({ state: "waiting" });
  assert.equal(fallback.hidden, false);
  assert.equal(fallback.dataset.kind, "web");
  assert.equal(image.dataset.state, "missing");

  present({ tabId: 1, state: "web-page", favIconUrl: "https://example.test/icon.svg" });
  assert.equal(image.dataset.state, "loading");
  assert.equal(fallback.hidden, false);
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(fallback.hidden, true);

  present({ tabId: 2, state: "local-pdf", favIconUrl: "https://example.test/broken.ico" });
  assert.equal(image.hidden, true);
  assert.equal(fallback.hidden, false);
  assert.equal(fallback.dataset.kind, "document");
  image.onerror();
  assert.equal(image.dataset.state, "error");
  assert.equal(fallback.hidden, false);
});

test("stale favicon load failures cannot replace the latest tab icon", () => {
  const image = {
    hidden: true,
    dataset: {},
    naturalWidth: 32,
    onload: null,
    onerror: null,
    src: "",
    removeAttribute(name) { if (name === "src") this.src = ""; }
  };
  const fallback = { hidden: true, dataset: {} };
  const present = createTabFaviconPresenter(image, fallback);

  present({ tabId: 1, state: "web-page", favIconUrl: "https://first.test/icon.png" });
  const staleError = image.onerror;
  present({ tabId: 2, state: "web-page", favIconUrl: "https://second.test/icon.png" });
  staleError();
  assert.equal(image.dataset.state, "loading");
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(fallback.hidden, true);
});

test("active-tab card leads with its title and reserves an accessible featured favicon slot", () => {
  const sourceStart = sidepanel.indexOf('<section id="source-card"');
  const sourceEnd = sidepanel.indexOf("</section>", sourceStart);
  const source = sidepanel.slice(sourceStart, sourceEnd);
  assert.match(source, /<h2 id="active-tab-heading">Pestaña actual<\/h2>/);
  assert.doesNotMatch(source, /ORIGEN/);
  assert.match(source, /id="active-tab-favicon" alt="" hidden/);
  assert.match(source, /id="active-tab-favicon-fallback"/);
  assert.match(source, /id="active-tab-title"/);
  assert.match(source, /id="active-tab-domain"/);
  assert.ok(source.indexOf('id="active-tab-heading"') < source.indexOf('id="active-tab-favicon-frame"'));
  assert.ok(source.indexOf('id="active-tab-favicon-frame"') < source.indexOf('id="active-tab-title"'));
  assert.match(styles, /\.source-favicon-frame\s*\{[^}]*width:\s*52px[^}]*height:\s*52px/s);
  assert.match(styles, /\.source-favicon-frame img\s*\{[^}]*object-fit:\s*contain/s);
  assert.match(styles, /-webkit-line-clamp:\s*2/);
});
