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
  const piperPhase = ({
    "checking-model": "la comprobación del modelo instalado",
    "reading-model": "la lectura del modelo local",
    "initializing-onnx": "la inicialización de ONNX Runtime",
    "creating-session": "la creación de la sesión de inferencia",
    download: "la descarga del modelo",
    synthesis: "la generación de audio"
  })[error?.phase];
  if (error?.code === "PIPER_DOWNLOAD_TIMEOUT") {
    return "La descarga de Piper dejó de avanzar o alcanzó su límite de tiempo. Los modelos verificados se conservaron; puedes reintentar.";
  }
  if (error?.code === "PIPER_INITIALIZATION_TIMEOUT") {
    return `La preparación de Piper agotó el tiempo${piperPhase ? ` durante ${piperPhase}` : ""}. El worker se restableció y el modelo local se conservó; puedes reintentar.`;
  }
  if (error?.code === "PIPER_SYNTHESIS_TIMEOUT") {
    return "La generación de audio Piper agotó el tiempo. El worker se restableció y puedes volver a intentar la lectura.";
  }
  if (error?.code === "PIPER_WORKER_RESET") {
    return "El motor Piper se restableció. El modelo y tus documentos siguen guardados; puedes volver a preparar la voz.";
  }
  if (error?.code === "PIPER_HTTP_ERROR" || error?.code === "PIPER_NETWORK_ERROR") {
    return "No se pudo descargar el recurso Piper. Comprueba la conexión e inténtalo de nuevo.";
  }
  if (error?.code === "PIPER_MODEL_MISSING") {
    return "El modelo Piper no está instalado. Descárgalo desde Modelo y almacenamiento y vuelve a intentarlo.";
  }
  if (error?.code === "PIPER_CONFIG_INVALID" || error?.code === "PIPER_MANIFEST_INVALID") {
    return "No se pudo validar la configuración local de Piper. Se conservaron los archivos existentes; revisa el estado del modelo e inténtalo de nuevo.";
  }
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
