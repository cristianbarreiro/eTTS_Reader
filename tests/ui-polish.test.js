import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sidepanel = await readFile(fileURLToPath(new URL("../sidepanel.html", import.meta.url)), "utf8");
const styles = await readFile(fileURLToPath(new URL("../src/style.css", import.meta.url)), "utf8");
const main = await readFile(fileURLToPath(new URL("../src/main.js", import.meta.url)), "utf8");

test("editor actions stay grouped while the chunk count remains separate", () => {
  const actions = sidepanel.match(/<div class="text-actions">([\s\S]*?)<\/div>\s*<p id="queue-sync-status"/);
  assert.ok(actions);
  assert.match(actions[1], /id="chunk-count"/);
  assert.match(actions[1], /<div class="text-action-buttons">[\s\S]*id="load-player"[\s\S]*id="clear-text"[\s\S]*<\/div>/);
  assert.match(actions[1], /id="load-player"[^>]*disabled/);
  assert.match(styles, /\.text-action-buttons\s*\{[^}]*flex-wrap:\s*wrap/s);
});

test("current-tab card keeps every import and recovery action available in a compact layout", () => {
  const start = sidepanel.indexOf('<section id="source-card"');
  const end = sidepanel.indexOf("</section>", start);
  const source = sidepanel.slice(start, end);
  for (const id of ["follow-active-tab", "active-tab-favicon", "active-tab-title", "active-tab-domain", "active-tab-kind", "active-tab-status", "import-tab", "import-selection", "choose-source-file", "retry-file-access", "tab-import-status", "tab-import-preview"]) {
    assert.ok(source.includes(`id="${id}"`), `missing current-tab element ${id}`);
  }
  assert.match(main, /ui\.activeTabTitle\.title\s*=\s*safeTabTitle/);
  assert.match(styles, /\.source-header\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(styles, /\.active-tab-title\s*\{[^}]*-webkit-line-clamp:\s*2/s);
});

test("document and session resume actions share the highlighted resume style", () => {
  assert.match(main, /proceed\.className\s*=\s*"library-open library-resume"/);
  assert.match(main, /resume\.className\s*=\s*"library-open library-resume"/);
  assert.match(styles, /\.library-resume\s*\{[^}]*background:\s*#173653/s);
  assert.match(styles, /\.library-resume:hover:not\(:disabled\)\s*\{[^}]*#20517b/s);
  assert.match(styles, /\.library-entry-title\s*\{[^}]*-webkit-line-clamp:\s*2/s);
  assert.match(main, /heading\.title\s*=\s*title/);
});

test("library delete has its own destructive hover and visible keyboard focus", () => {
  assert.match(styles, /\.library-delete:hover:not\(:disabled\)\s*\{[^}]*border-color:\s*#ef4444[^}]*background:\s*#7f1d1d[^}]*color:\s*#fecaca/s);
  assert.match(styles, /\.library-resume:focus-visible, \.library-delete:focus-visible/);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/);
});
