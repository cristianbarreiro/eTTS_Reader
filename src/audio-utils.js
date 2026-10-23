export function formatTime(value) {
  if (!Number.isFinite(value) || value < 0) return "--:--";
  const seconds = Math.floor(value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export async function validateWavBlob(blob) {
  if (!blob || typeof blob.slice !== "function" || blob.size < 44) {
    throw new Error("Kokoro devolvió un audio WAV vacío o incompleto.");
  }

  const header = await blob.slice(0, 44).arrayBuffer();
  const bytes = new Uint8Array(header);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new Error("El audio generado no tiene una cabecera WAV válida.");
  }

  const view = new DataView(header);
  const riffLength = view.getUint32(4, true) + 8;
  if (riffLength < 44 || riffLength > blob.size || ascii(12, 4) !== "fmt " || ascii(36, 4) !== "data") {
    throw new Error("La cabecera WAV del audio generado está incompleta o dañada.");
  }
  const format = view.getUint16(20, true);
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const dataLength = view.getUint32(40, true);
  if (![1, 3].includes(format) || channels < 1 || sampleRate < 1 || dataLength < 1 || dataLength + 44 > riffLength) {
    throw new Error("El audio WAV generado no contiene muestras reproducibles.");
  }
  return true;
}
