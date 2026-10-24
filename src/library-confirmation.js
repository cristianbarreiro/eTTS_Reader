const displayName = (value, fallback) => String(value || fallback).trim() || fallback;

export function documentDeleteConfirmation(document, sessions = []) {
  const name = displayName(document?.name, "Documento sin título");
  const count = sessions.length;
  const sessionMessage = count === 0
    ? "No hay sesiones asociadas."
    : count === 1
      ? "La única sesión asociada conservará su copia de texto, progreso y audios como una lectura independiente."
      : `Sus ${count} sesiones conservarán sus copias de texto, progreso y audios como lecturas independientes.`;
  return {
    title: "¿Eliminar este documento?",
    message: `Se eliminará la copia guardada de “${name}”. ${sessionMessage} Los modelos locales no se eliminarán.`,
    confirmLabel: "Eliminar documento",
    cancelLabel: "Cancelar"
  };
}

export function sessionDeleteConfirmation(session) {
  const name = displayName(session?.sourceDocumentName || session?.sourceText?.trim().slice(0, 48), "Texto pegado");
  return {
    title: "¿Eliminar esta sesión?",
    message: `Se eliminará la sesión de “${name}”, incluido su progreso y los WAV que no use otra sesión. El documento y los modelos locales se conservarán.`,
    confirmLabel: "Eliminar sesión",
    cancelLabel: "Cancelar"
  };
}

export function recoveredSessionsDeleteConfirmation(sessions = []) {
  const title = displayName(sessions[0]?.sourceDocumentName, "Lectura recuperada");
  const count = sessions.length;
  const subject = count === 1 ? `la sesión recuperada de “${title}”` : `las ${count} sesiones recuperadas de “${title}”`;
  const label = count === 1 ? "Eliminar sesión" : "Eliminar sesiones";
  const progress = count === 1 ? "su progreso" : "sus progresos";
  return {
    title: count === 1 ? "¿Eliminar esta sesión recuperada?" : "¿Eliminar estas sesiones recuperadas?",
    message: `Se eliminarán ${subject}, incluidos ${progress} y los WAV que no use otra sesión. Los documentos y modelos locales se conservarán.`,
    confirmLabel: label,
    cancelLabel: "Cancelar"
  };
}

export function savedAudioDeleteConfirmation() {
  return {
    title: "¿Eliminar los audios guardados?",
    message: "Se eliminarán los audios generados y almacenados localmente. Los documentos, las sesiones de lectura y los modelos de voz instalados se conservarán.",
    confirmLabel: "Eliminar audios",
    cancelLabel: "Cancelar"
  };
}

export function piperModelDeleteConfirmation(voiceLabel) {
  const name = displayName(voiceLabel, "la voz Piper seleccionada");
  return {
    title: "¿Eliminar el modelo Piper?",
    message: `Se eliminarán los archivos locales del modelo Piper “${name}”. Los documentos, las sesiones y los modelos de otros proveedores se conservarán. Para volver a usar esta voz será necesario descargar el modelo de nuevo.`,
    confirmLabel: "Eliminar modelo",
    cancelLabel: "Cancelar"
  };
}

export function kokoroModelDeleteConfirmation() {
  return {
    title: "¿Eliminar el modelo Kokoro?",
    message: "Se eliminarán el modelo y los recursos locales de voz de Kokoro. Los modelos Piper, los audios guardados, los documentos y las sesiones se conservarán. Para volver a usar Kokoro será necesario preparar sus recursos otra vez.",
    confirmLabel: "Eliminar modelo",
    cancelLabel: "Cancelar"
  };
}
