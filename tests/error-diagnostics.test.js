import test from "node:test";
import assert from "node:assert/strict";
import { formatErrorDiagnostics, serializeErrorDiagnostics } from "../src/error-diagnostics.js";

test("technical details include worker stack, phase, and nested cause", () => {
  const error = new TypeError("Illegal invocation", { cause: new TypeError("fetch receiver is invalid") });
  error.code = "PIPER_ONNX_RUNTIME_FAILED";
  error.phase = "initializing-onnx";
  const workerDetails = serializeErrorDiagnostics(error);
  const backgroundError = Object.assign(new Error(error.message), { diagnostics: workerDetails, code: error.code, phase: error.phase });
  const displayed = formatErrorDiagnostics({
    diagnostics: serializeErrorDiagnostics(backgroundError), code: error.code, phase: error.phase
  });

  assert.match(displayed, /Fase: initializing-onnx/);
  assert.match(displayed, /Traza del worker/);
  assert.match(displayed, /Pila completa:/);
  assert.match(displayed, /Causa: TypeError: fetch receiver is invalid/);
});

test("stack serialization is bounded and plain errors remain readable", () => {
  const error = new Error("failure");
  error.stack = "Error: failure\\n" + "frame\\n".repeat(2_000);
  const serialized = serializeErrorDiagnostics(error);
  assert.ok(serialized.stack.length < 12_100);
  assert.match(serialized.stack, /truncado/);
  assert.equal(formatErrorDiagnostics(new Error("plain failure")), "plain failure");
});

test("synthesis diagnostics keep safe request metadata without including user text", () => {
  const error = Object.assign(new Error("Synthesis timed out"), {
    code: "KOKORO_SYNTHESIS_TIMEOUT",
    phase: "model-generate",
    requestId: 12,
    voiceId: "af_heart",
    textLength: 180,
    elapsedMs: 301_200,
    timeoutKind: "inactivity"
  });
  const serialized = serializeErrorDiagnostics(error);
  const displayed = formatErrorDiagnostics({ diagnostics: serialized });
  assert.equal(serialized.requestId, "12");
  assert.equal(serialized.voiceId, "af_heart");
  assert.equal(serialized.textLength, 180);
  assert.match(displayed, /model-generate/);
  assert.match(displayed, /solicitud 12 · voz af_heart · 180 caracteres · 301 s transcurridos · límite inactivity/);
  assert.doesNotMatch(displayed, /Synthesis timed out.*Hello/);
});
