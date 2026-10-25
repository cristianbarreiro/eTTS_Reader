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
