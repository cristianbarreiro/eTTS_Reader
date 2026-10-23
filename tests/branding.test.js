import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconSizes = [16, 32, 48, 128];
const expectedBars = [
  { x: 4, y: 22, width: 8, height: 20, rx: 4 },
  { x: 16, y: 16, width: 8, height: 32, rx: 4 },
  { x: 28, y: 8, width: 8, height: 48, rx: 4 },
  { x: 40, y: 16, width: 8, height: 32, rx: 4 },
  { x: 52, y: 22, width: 8, height: 20, rx: 4 }
];

function readBars(svg) {
  return [...svg.matchAll(/<rect\s+([^>]+)\/>/g)].map(([, attributes]) =>
    Object.fromEntries([...attributes.matchAll(/(x|y|width|height|rx)="(\d+)"/g)].map(([, key, value]) => [key, Number(value)])
    )
  );
}

function readPngSize(filePath) {
  const png = readFileSync(filePath);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${filePath} must be a PNG`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("eTTS SVG variants use the same symmetric five-bar silhouette", () => {
  const branding = path.join(root, "public", "assets", "branding");
  const variants = ["etts-symbol.svg", "etts-symbol-compact.svg", "etts-symbol-mono.svg"];

  for (const variant of variants) {
    const svg = readFileSync(path.join(branding, variant), "utf8");
    assert.match(svg, /viewBox="0 0 64 64"/);
    assert.deepEqual(readBars(svg), expectedBars, `${variant} must preserve the brand silhouette`);
    assert.doesNotMatch(svg, /<script|<image|href="https?:/i, `${variant} must not load executable or remote content`);
  }

  const primary = readFileSync(path.join(branding, variants[0]), "utf8");
  const compact = readFileSync(path.join(branding, variants[1]), "utf8");
  const mono = readFileSync(path.join(branding, variants[2]), "utf8");
  assert.match(primary, /linearGradient/);
  assert.match(primary, /feGaussianBlur/);
  assert.match(compact, /linearGradient/);
  assert.doesNotMatch(compact, /feGaussianBlur/);
  assert.match(mono, /fill="#1767D2"/);
});

test("development and production manifests declare real extension icons at every required size", () => {
  const manifests = [
    { file: path.join(root, "manifest.json"), assetRoot: root, prefix: "public/icons" },
    { file: path.join(root, "public", "manifest.json"), assetRoot: path.join(root, "public"), prefix: "icons" }
  ];

  for (const { file, assetRoot, prefix } of manifests) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    for (const size of iconSizes) {
      const relativePath = `${prefix}/etts-${size}.png`;
      assert.equal(manifest.icons?.[size], relativePath, `${path.relative(root, file)} top-level icon ${size}`);
      assert.equal(manifest.action?.default_icon?.[size], relativePath, `${path.relative(root, file)} toolbar icon ${size}`);
      const iconPath = path.resolve(assetRoot, relativePath);
      assert.ok(existsSync(iconPath), `missing ${iconPath}`);
      assert.deepEqual(readPngSize(iconPath), { width: size, height: size }, `incorrect dimensions for ${iconPath}`);
    }
  }
});

test("Side Panel uses a single accessible vector mark beside real HTML wordmark text", () => {
  const html = readFileSync(path.join(root, "sidepanel.html"), "utf8");
  assert.match(html, /<img class="brand-mark" src="\.\/assets\/branding\/etts-symbol\.svg" alt="" aria-hidden="true">/);
  assert.match(html, /<h1>eTTS<\/h1>\s*<p>Lector local<\/p>/);
  assert.equal((html.match(/class="brand-mark"/g) || []).length, 1);
  assert.equal((html.match(/<h1>eTTS<\/h1>/g) || []).length, 1);
});
