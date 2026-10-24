const TAB_STATE_LABELS = Object.freeze({
  waiting: "Sin pestaña",
  "web-page": "Página web",
  article: "Artículo web",
  pdf: "PDF detectado",
  "local-pdf": "PDF local",
  restricted: "Página restringida",
  "tabs-permission-required": "Permiso de pestaña requerido",
  "permission-required": "Permiso temporal requerido",
  "local-document": "Archivo local",
  "text-document": "Documento de texto",
  "google-docs": "Google Docs",
  "selection": "Selección de texto"
});

export function describeTabContext(context) {
  if (!context || context.state === "waiting") {
    return {
      title: "Abre el lector desde la pestaña que quieras importar.",
      domain: "",
      contentType: "Esperando una página",
      state: "waiting",
      status: "El texto solo se lee al pulsar Importar.",
      canImport: false
    };
  }

  const state = String(context.state || "waiting");
  const title = String(context.title || "Pestaña sin título");
  const contentType = String(context.contentType || TAB_STATE_LABELS[state] || "Página detectada");
  const status = [context.accessState, context.availability].filter(Boolean).map(String).join(" · ")
    || "La disponibilidad de lectura todavía no está confirmada.";
  const blocked = ["restricted", "local-document"].includes(state);
  return {
    title,
    domain: String(context.location || ""),
    contentType,
    state,
    status,
    canImport: Boolean(Number.isInteger(context.tabId) && context.url && !blocked)
  };
}

export function userFacingErrorMessage(error, action = "general") {
  const detail = String(error?.message || error || "");
  if (/quota|indexeddb|storage|transaction/i.test(detail)) {
    return "No se pudieron guardar los cambios locales. Comprueba el espacio disponible e inténtalo de nuevo.";
  }
  if (/wasm|onnx|backend|dynamically imported module|module.*load/i.test(detail)) {
    return "El motor de voz local no pudo iniciarse. Puedes volver a intentarlo desde la gestión del modelo.";
  }
  if (/failed to fetch|network|download|http\s?\d{3}|offline/i.test(detail)) {
    return action === "model"
      ? "No se pudo preparar el modelo local. Comprueba la conexión e inténtalo de nuevo."
      : "No se pudo completar la descarga. Comprueba la conexión e inténtalo de nuevo.";
  }
  if (/permission|denied|not allowed/i.test(detail)) {
    return "Edge no concedió el acceso necesario. Revisa el permiso e inténtalo de nuevo.";
  }
  if (action === "model") return "No se pudo preparar el motor de voz local. Tus documentos y sesiones siguen guardados; puedes reintentar.";
  if (action === "file") return "No se pudo procesar el documento. Comprueba que el archivo sea válido e inténtalo de nuevo.";
  if (action === "playback") return "No se pudo iniciar la reproducción. Comprueba la voz seleccionada e inténtalo de nuevo.";
  if (action === "voice") return "No se pudo consultar la voz local. Puedes reintentar desde la gestión del modelo.";
  if (action === "import") return "No se pudo completar la importación. El contenido del editor sigue intacto.";
  if (action === "library") return "No se pudo actualizar la biblioteca local. Tus documentos y el modelo siguen guardados.";
  return "No se pudo completar esta acción local. Inténtalo de nuevo.";
}

export function createPanelStatusState() {
  let tab = describeTabContext(null);
  let importStatus = { state: "info", message: "Selecciona una página o usa el menú contextual para enviar una selección." };
  const snapshot = () => ({ tab: { ...tab }, import: { ...importStatus } });
  return {
    setTabContext(context) {
      tab = describeTabContext(context);
      return snapshot();
    },
    setImportStatus(message, state = "info") {
      importStatus = { state: String(state), message: String(message || "") };
      return snapshot();
    },
    snapshot
  };
}
