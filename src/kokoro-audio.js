const DEFAULT_MAX_INFERENCE_CHARS = 180;
const INTER_PART_SILENCE_MS = 80;

export function splitKokoroInferenceText(text, maxChars = DEFAULT_MAX_INFERENCE_CHARS) {
  const remainingText = String(text ?? "").trim();
  if (!remainingText) return [];
  if (!Number.isInteger(maxChars) || maxChars < 32) throw new RangeError("El tamaño de inferencia Kokoro debe ser de al menos 32 caracteres.");

  const parts = [];
  let remaining = remainingText;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars + 1);
    const sentenceEnds = [...window.matchAll(/[.!?。！？;:](?=\s|$)/gu)];
    const sentenceEnd = sentenceEnds.at(-1);
    let boundary = sentenceEnd && sentenceEnd.index >= Math.floor(maxChars * 0.55)
      ? sentenceEnd.index + sentenceEnd[0].length
      : 0;

    if (!boundary) {
      const spaces = [...window.matchAll(/\s+/gu)].filter((match) => match.index > 0 && match.index <= maxChars);
      const lastSpace = spaces.at(-1);
      if (lastSpace) boundary = lastSpace.index;
      else {
        const nextSpace = remaining.search(/\s/u);
        boundary = nextSpace > 0 ? nextSpace : maxChars;
      }
    }

    const part = remaining.slice(0, boundary).trim();
    if (!part) throw new Error("No se pudo dividir el texto para la inferencia Kokoro.");
    parts.push(part);
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function concatenateKokoroAudio(parts, { silenceMs = INTER_PART_SILENCE_MS } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error("Kokoro no generó segmentos de audio.");
  const sampleRate = parts[0]?.sampling_rate;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error("Kokoro devolvió una frecuencia de muestreo no válida.");
  if (parts.some((part) => part?.sampling_rate !== sampleRate || !(part.audio instanceof Float32Array))) {
    throw new Error("Los segmentos de audio Kokoro no comparten un formato compatible.");
  }
  const silenceSamples = Math.max(0, Math.round(sampleRate * silenceMs / 1000));
  const totalSamples = parts.reduce((total, part) => total + part.audio.length, 0)
    + silenceSamples * Math.max(0, parts.length - 1);
  const audio = new Float32Array(totalSamples);
  let offset = 0;
  parts.forEach((part, index) => {
    audio.set(part.audio, offset);
    offset += part.audio.length;
    if (index < parts.length - 1) offset += silenceSamples;
  });
  return { audio, sampleRate };
}

export async function synthesizeKokoroText(model, text, {
  voice,
  speed = 1,
  onProgress = () => {},
  RawAudio,
  maxChars = DEFAULT_MAX_INFERENCE_CHARS
} = {}) {
  if (!model || typeof model.generate !== "function") throw new TypeError("El modelo Kokoro no está disponible.");
  if (typeof RawAudio !== "function") throw new TypeError("No se puede ensamblar el WAV Kokoro.");
  const chunks = splitKokoroInferenceText(text, maxChars);
  if (!chunks.length) throw new Error("No hay texto para sintetizar con Kokoro.");
  const generated = [];

  for (let index = 0; index < chunks.length; index++) {
    try {
      onProgress({
        phase: "synthesis",
        stage: "synthesizing-part",
        completedParts: index,
        totalParts: chunks.length,
        progress: Math.round(index / chunks.length * 100)
      });
    } catch { /* Progress is advisory. */ }
    generated.push(await model.generate(chunks[index], { voice, speed }));
    try {
      onProgress({
        phase: "synthesis",
        stage: "synthesizing-part",
        completedParts: index + 1,
        totalParts: chunks.length,
        progress: Math.round((index + 1) / chunks.length * 100)
      });
    } catch { /* Progress is advisory. */ }
  }

  const merged = concatenateKokoroAudio(generated);
  return new RawAudio(merged.audio, merged.sampleRate).toBlob();
}
