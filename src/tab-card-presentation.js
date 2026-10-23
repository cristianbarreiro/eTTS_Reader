const DATA_IMAGE_URL = /^data:image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:;[a-z0-9=+._-]+)*,/i;
const MAX_FAVICON_URL_LENGTH = 131_072;
const DOCUMENT_TAB_STATES = new Set(["pdf", "local-pdf", "text-document", "local-document"]);

export function safeTabFaviconUrl(value) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source || source.length > MAX_FAVICON_URL_LENGTH) return "";
  if (DATA_IMAGE_URL.test(source)) return source;
  try {
    const url = new URL(source);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function tabFaviconFallbackKind(state) {
  return DOCUMENT_TAB_STATES.has(String(state || "")) ? "document" : "web";
}

export function localTabFileName(value, fallback = "Documento local") {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return fallback;
    const encodedName = url.pathname.split("/").filter(Boolean).at(-1) || "";
    const name = decodeURIComponent(encodedName)
      .replace(/[\\/\u0000-\u001f\u007f]/g, " ")
      .trim();
    return name && name !== "." && name !== ".." ? name.slice(0, 240) : fallback;
  } catch {
    return fallback;
  }
}

export function safeTabTitle(value, url = "") {
  const title = String(value || "").trim().slice(0, 500);
  if (/^file:/i.test(title)) return localTabFileName(title, "Documento local");
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(title)) return localTabFileName(url, "Documento local");
  if (title) return title;
  return localTabFileName(url, "Pestaña sin título");
}

export function createTabFaviconPresenter(image, fallback) {
  let requestId = 0;
  let currentKey = null;

  return (context) => {
    fallback.dataset.kind = tabFaviconFallbackKind(context?.state);
    const source = safeTabFaviconUrl(context?.favIconUrl);
    const revision = Number.isFinite(context?.faviconRevision) ? context.faviconRevision : 0;
    const key = source ? `${context?.tabId ?? "unknown"}:${revision}:${source}` : "";
    if (key === currentKey) return;

    currentKey = key;
    const currentRequest = ++requestId;
    image.hidden = true;
    fallback.hidden = false;
    image.onload = null;
    image.onerror = null;

    if (!source) {
      image.removeAttribute("src");
      image.dataset.state = "missing";
      return;
    }

    image.dataset.state = "loading";
    image.onload = () => {
      if (currentRequest !== requestId) return;
      if (image.naturalWidth > 0) {
        image.dataset.state = "loaded";
        image.hidden = false;
        fallback.hidden = true;
      } else {
        image.dataset.state = "error";
        image.hidden = true;
        fallback.hidden = false;
      }
    };
    image.onerror = () => {
      if (currentRequest !== requestId) return;
      image.dataset.state = "error";
      image.hidden = true;
      fallback.hidden = false;
    };
    image.removeAttribute("src");
    image.src = source;
  };
}
