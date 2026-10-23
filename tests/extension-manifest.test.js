import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = new URL("../manifest.json", import.meta.url);
const builtSource = new URL("../public/manifest.json", import.meta.url);

test("source and production manifests use one Side Panel, an event worker, and minimal extension API permissions", async () => {
  const root = JSON.parse(await readFile(source, "utf8"));
  const built = JSON.parse(await readFile(builtSource, "utf8"));
  for (const [manifest, panelPath, workerPath] of [[root, "dist/sidepanel.html", "dist/background.js"], [built, "sidepanel.html", "background.js"]]) {
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.side_panel.default_path, panelPath);
    assert.equal(manifest.background.service_worker, workerPath);
    assert.equal(manifest.background.type, "module");
    assert.equal(manifest.action.default_popup, undefined);
    assert.deepEqual(new Set(manifest.permissions), new Set(["storage", "sidePanel", "offscreen", "activeTab", "scripting"]));
    assert.ok(!manifest.permissions.includes("tabs"));
    assert.ok(!manifest.host_permissions.includes("<all_urls>"));
    assert.match(manifest.content_security_policy.extension_pages, /wasm-unsafe-eval/);
  }
});
