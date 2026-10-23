import { makeId } from "./persistence.js";
import { splitText } from "./text.js";

/** Persists an editor snapshot only when it contains non-whitespace text. */
export async function persistEditorSnapshot(repository, { document, session, text, voice, speed }) {
  const originalText = String(text ?? "");
  if (!originalText.trim()) return { saved: false, document, session };

  const documentDraft = {
    ...(document || {}),
    id: document?.id || makeId("document"),
    name: document?.name || "Texto pegado",
    type: document?.type || "text",
    text: originalText,
    extractionStatus: "ready"
  };
  const sessionDraft = {
    ...(session || {}),
    id: session?.id || makeId("session"),
    documentId: documentDraft.id,
    sourceText: originalText,
    sourceDocumentName: documentDraft.name,
    chunks: splitText(originalText),
    voice,
    speed: Number(speed) || 1
  };
  const savedDocument = await repository.saveDocument(documentDraft);
  const savedSession = await repository.saveSession(sessionDraft);
  return { saved: true, document: savedDocument, session: savedSession };
}
