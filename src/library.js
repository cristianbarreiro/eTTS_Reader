const isValidText = (value) => String(value ?? "").trim().length > 0;

function compareUpdated(left, right) {
  return (Number(right.updatedAt || right.createdAt) || 0) - (Number(left.updatedAt || left.createdAt) || 0);
}

function orphanKey(session) {
  return `${String(session.sourceDocumentName || "Lectura recuperada").trim()}\u0000${String(session.sourceText || "").trim()}`;
}

/**
 * Builds the library presentation without merging document and session records.
 * Saved documents appear once, with their sessions attached as presentation data.
 * Detached sessions remain recoverable as grouped entries of their own.
 */
export function buildLibraryEntries(documents = [], sessions = []) {
  const validDocuments = documents.filter((document) => isValidText(document.text));
  const documentsById = new Map(validDocuments.map((document) => [document.id, document]));
  const linkedSessions = new Map(validDocuments.map((document) => [document.id, []]));
  const orphanSessions = new Map();

  for (const session of [...sessions].sort(compareUpdated)) {
    if (session.documentId && documentsById.has(session.documentId)) {
      linkedSessions.get(session.documentId).push(session);
      continue;
    }
    if (!isValidText(session.sourceText) && !(session.audioKeys || []).some(Boolean)) continue;
    const key = orphanKey(session);
    if (!orphanSessions.has(key)) orphanSessions.set(key, []);
    orphanSessions.get(key).push(session);
  }

  const entries = validDocuments.map((document) => ({
    kind: "document",
    id: document.id,
    document,
    sessions: linkedSessions.get(document.id).sort(compareUpdated),
    updatedAt: Number(document.updatedAt || document.importedAt || document.createdAt) || 0
  }));

  for (const [key, grouped] of orphanSessions) {
    const ordered = grouped.sort(compareUpdated);
    const latest = ordered[0];
    entries.push({
      kind: "recovered-session",
      id: `recovered:${key}`,
      document: null,
      sessions: ordered,
      updatedAt: Number(latest.updatedAt || latest.createdAt) || 0
    });
  }

  return entries.sort(compareUpdated);
}

export function libraryActionFor(entry, documentText = entry?.document?.text) {
  const latestSession = entry?.sessions?.[0];
  return latestSession && latestSession.sourceText === documentText ? "resume" : "read";
}

export async function openLibraryEntry(entry, activate) {
  if (!entry?.document || typeof activate !== "function") return false;
  await activate(entry.document);
  return true;
}

export async function resumeLibrarySession(session, activate, play) {
  if (!session || typeof activate !== "function" || typeof play !== "function") return false;
  await activate(session);
  await play();
  return true;
}
