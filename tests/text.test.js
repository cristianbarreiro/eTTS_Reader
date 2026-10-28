import test from "node:test";
import assert from "node:assert/strict";
import { cleanForSpeech, splitText } from "../src/text.js";

test("cleanForSpeech removes markdown syntax while preserving readable text", () => {
  assert.equal(cleanForSpeech("# Title\n\nA [link](https://example.test) and `code`."), "Title\n\nA link and code.");
});

test("pasted plain text Hola mundo immediately becomes one readable chunk", () => {
  const text = "Hola mundo";
  assert.equal(text.length, 10);
  assert.deepEqual(splitText(text), ["Hola mundo"]);
});

test("short imported content keeps its paragraphs together as one playback chunk", () => {
  const text = "Latest commit\n\ncristianbarreiro\n\nfeat: importar contenido de la pestaña actual\n\n6394aad · Oct 23, 2026";
  assert.deepEqual(splitText(text), ["Latest commit\n\ncristianbarreiro\n\nfeat: importar contenido de la pestaña actual\n\n6394aad · Oct 23, 2026"]);
});

test("splitText preserves order and keeps chunks within the requested limit", () => {
  const source = "First sentence. Second sentence.\n\nThird sentence.";
  const chunks = splitText(source, 20);
  assert.deepEqual(chunks, ["First sentence.", "Second sentence.", "Third sentence."]);
  assert.ok(chunks.every((chunk) => chunk.length <= 20));
});

test("splitText returns no chunks for empty content", () => {
  assert.deepEqual(splitText(" \n  "), []);
});

test("default playback chunks are larger while long sentences still split at word boundaries", () => {
  const chunks = splitText("palabra ".repeat(400));
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 1200));
  assert.equal(chunks.join(" "), "palabra ".repeat(400).trim());
});
