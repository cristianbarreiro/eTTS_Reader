export function cleanForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " bloque de código. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?(\[([^\]]*)\])\([^)]*\)/g, "$2")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitText(text, maxChars = 1200) {
  const normalized = cleanForSpeech(text);
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  let currentParagraphIndex = -1;
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
    currentParagraphIndex = -1;
  };

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const paragraph = paragraphs[paragraphIndex];
    const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]?/g) || [paragraph];
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        flush();
        let remaining = sentence;
        while (remaining.length > maxChars) {
          const window = remaining.slice(0, maxChars + 1);
          const boundary = window.lastIndexOf(" ", maxChars);
          const splitAt = boundary > 0 ? boundary : maxChars;
          chunks.push(remaining.slice(0, splitAt).trim());
          remaining = remaining.slice(splitAt).trim();
        }
        if (remaining) chunks.push(remaining);
      } else if (!current) {
        current = sentence;
        currentParagraphIndex = paragraphIndex;
      } else {
        const separator = currentParagraphIndex === paragraphIndex ? " " : "\n\n";
        if (current.length + separator.length + sentence.length <= maxChars) {
          current += `${separator}${sentence}`;
          currentParagraphIndex = paragraphIndex;
        } else {
          flush();
          current = sentence;
          currentParagraphIndex = paragraphIndex;
        }
      }
    }
  }
  flush();
  return chunks;
}
