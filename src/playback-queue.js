import { voiceSessionFields } from "./voice-catalog.js";

export function playbackQueueMatchesEditor(session, { text, voice } = {}) {
  if (!session?.id || !Array.isArray(session.chunks) || !session.chunks.length) return false;
  if (session.queuePrepared === false) return false;
  return session.sourceText === String(text ?? "") && (session.voice || session.voiceId) === voice;
}

export function preparePlaybackQueue({
  editorSession = null,
  loadedSession = null,
  text = "",
  chunks = [],
  voice = "af_heart",
  speed = 1,
  makeId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  now = () => Date.now()
} = {}) {
  const sourceText = String(text ?? "");
  const orderedChunks = Array.isArray(chunks) ? [...chunks] : [];
  if (!sourceText.trim() || !orderedChunks.length) {
    throw new TypeError("Escribe o importa texto antes de cargarlo al reproductor.");
  }

  const sameEditorSnapshot = editorSession?.sourceText === sourceText
    && (editorSession.voice || editorSession.voiceId) === voice
    && Array.isArray(editorSession.chunks)
    && editorSession.chunks.length === orderedChunks.length
    && editorSession.chunks.every((chunk, index) => chunk === orderedChunks[index]);
  const retainAudio = sameEditorSnapshot;
  const loadedSnapshot = playbackQueueMatchesEditor(loadedSession, { text: sourceText, voice })
    && loadedSession.chunks.length === orderedChunks.length
    && loadedSession.chunks.every((chunk, index) => chunk === orderedChunks[index]);

  if (loadedSnapshot && Number(loadedSession.speed) === Number(speed)) {
    return {
      ...loadedSession,
      status: "text-ready",
      queuePrepared: true,
      queueVersion: loadedSession.queueVersion || makeId("queue"),
      lastError: "",
      preparedAt: now()
    };
  }

  const id = editorSession?.id && editorSession.id !== loadedSession?.id
    ? editorSession.id
    : makeId("session");
  const voiceFields = voiceSessionFields(voice);
  const audioKeys = retainAudio && Array.isArray(editorSession.audioKeys)
    ? [...editorSession.audioKeys]
    : orderedChunks.map(() => null);

  return {
    ...(editorSession || {}),
    id,
    documentId: editorSession?.documentId || null,
    sourceDocumentName: editorSession?.sourceDocumentName || "Texto pegado",
    sourceText,
    chunks: orderedChunks,
    selectedIndex: retainAudio && Number.isInteger(editorSession?.selectedIndex)
      ? Math.max(0, Math.min(editorSession.selectedIndex, orderedChunks.length - 1))
      : 0,
    position: retainAudio ? Math.max(0, Number(editorSession?.position) || 0) : 0,
    status: "text-ready",
    voice,
    ...voiceFields,
    speed: Number(speed) || 1,
    audioKeys,
    chunkStates: orderedChunks.map((_, index) => audioKeys[index] ? "ready" : "pending"),
    durations: retainAudio && Array.isArray(editorSession.durations)
      ? orderedChunks.map((_, index) => Number.isFinite(editorSession.durations[index]) ? editorSession.durations[index] : null)
      : orderedChunks.map(() => null),
    queuePrepared: true,
    queueVersion: makeId("queue"),
    preparedAt: now(),
    lastError: ""
  };
}
