const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_ERROR_STACK_LENGTH = 12_000;
const MAX_CAUSE_DEPTH = 2;

function boundedString(value, limit) {
  if (value == null) return "";
  const text = String(value);
  return text.length > limit ? text.slice(0, limit) + "… [truncado]" : text;
}

export function serializeErrorDiagnostics(error, depth = 0) {
  const source = error && typeof error === "object" ? error : { message: String(error || "Error desconocido") };
  const details = {
    name: boundedString(source.name || "Error", 160),
    message: boundedString(source.message || String(error || "Error desconocido"), MAX_ERROR_MESSAGE_LENGTH),
    stack: boundedString(source.stack, MAX_ERROR_STACK_LENGTH)
  };
  for (const key of ["code", "phase"]) {
    if (source[key] != null) details[key] = boundedString(source[key], 160);
  }
  for (const key of ["requestId", "resetByRequestId", "voiceId", "timeoutKind", "operation"]) {
    if (source[key] != null) details[key] = boundedString(source[key], 160);
  }
  for (const key of ["textLength", "elapsedMs"]) {
    if (Number.isFinite(source[key]) && source[key] >= 0) details[key] = source[key];
  }
  if (source.filename) details.filename = boundedString(source.filename, 500);
  if (Number.isFinite(source.lineno)) details.lineno = source.lineno;
  if (Number.isFinite(source.colno)) details.colno = source.colno;
  if (depth < MAX_CAUSE_DEPTH && source.cause) details.cause = serializeErrorDiagnostics(source.cause, depth + 1);
  if (depth < MAX_CAUSE_DEPTH && source.diagnostics && typeof source.diagnostics === "object") {
    details.worker = serializeErrorDiagnostics(source.diagnostics, depth + 1);
  }
  return details;
}

function appendDiagnostic(lines, details, label = "") {
  if (!details || typeof details !== "object") return;
  const prefix = label ? label + ": " : "";
  if (details.name || details.message) lines.push(prefix + [details.name, details.message].filter(Boolean).join(": "));
  if (details.code) lines.push("Código: " + details.code);
  if (details.phase) lines.push("Fase: " + details.phase);
  const context = [
    details.requestId && `solicitud ${details.requestId}`,
    details.resetByRequestId && `worker reiniciado por solicitud ${details.resetByRequestId}`,
    details.voiceId && `voz ${details.voiceId}`,
    Number.isFinite(details.textLength) && `${details.textLength} caracteres`,
    Number.isFinite(details.elapsedMs) && `${Math.round(details.elapsedMs / 1000)} s transcurridos`,
    details.timeoutKind && `límite ${details.timeoutKind}`
  ].filter(Boolean);
  if (context.length) lines.push("Contexto: " + context.join(" · "));
  if (details.filename) {
    const location = [details.filename, details.lineno, details.colno].filter((part) => part != null && part !== "").join(":");
    lines.push("Ubicación: " + location);
  }
  if (details.stack && !details.worker) lines.push("Pila completa:\n" + details.stack);
  if (details.worker) appendDiagnostic(lines, details.worker, "Traza del worker");
  if (details.cause) appendDiagnostic(lines, details.cause, "Causa");
}

export function formatErrorDiagnostics(error) {
  const diagnostics = error?.diagnostics || error?.remoteDiagnostics;
  const lines = [];
  if (diagnostics) appendDiagnostic(lines, diagnostics);
  else {
    if (error?.code) lines.push("Código: " + error.code);
    if (error?.phase) lines.push("Fase: " + error.phase);
    const detail = boundedString(error?.message || error || "", MAX_ERROR_MESSAGE_LENGTH);
    if (detail) lines.push(detail);
  }
  return lines.join("\n");
}
