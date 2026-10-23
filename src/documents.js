const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 500;

export async function extractDocument(file) {
  if (!file) throw new Error("Selecciona un archivo.");
  if (file.size > MAX_FILE_BYTES) throw new Error("El archivo supera el límite de 25 MB.");
  const ext = file.name.toLowerCase().split(".").pop();
  if (!["pdf", "docx", "txt", "md", "markdown"].includes(ext)) {
    throw new Error("Formato no compatible. Usa PDF, DOCX, TXT o Markdown.");
  }
  if (ext === "txt" || ext === "md" || ext === "markdown") return await file.text();
  if (ext === "docx") {
    const imported = await import("mammoth");
    const mammoth = imported.default || imported;
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  return await extractPdf(file);
}

async function extractPdf(file) {
  const [pdfjsLib, workerAsset] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerAsset.default;
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  if (pdf.numPages > MAX_PDF_PAGES) throw new Error("El PDF tiene más de 500 páginas; divídelo en archivos más pequeños.");
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" "));
    page.cleanup();
  }
  const text = pages.join("\n\n").trim();
  if (!text) throw new Error("Este PDF no contiene texto extraíble. Puede ser un escaneo; OCR no está incluido.");
  return text;
}
