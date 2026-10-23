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

export function splitText(text, maxChars = 430) {
  const normalized = cleanForSpeech(text);
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const flush = () => { if (current.trim()) chunks.push(current.trim()); current = ""; };

  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?。！？]+[.!?。！？]?/g) || [paragraph];
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        flush();
        for (let start = 0; start < sentence.length; start += maxChars) chunks.push(sentence.slice(start, start + maxChars));
      } else if (!current) current = sentence;
      else if (current.length + sentence.length + 1 <= maxChars) current += ` ${sentence}`;
      else { flush(); current = sentence; }
    }
    flush();
  }
  return chunks;
}
