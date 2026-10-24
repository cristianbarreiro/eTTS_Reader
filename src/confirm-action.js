const DEFAULT_FAILURE_MESSAGE = "No se pudo completar la eliminación. Revisa el estado de la biblioteca e inténtalo de nuevo.";

export function createConfirmAction({
  dialog,
  titleElement,
  messageElement,
  statusElement,
  cancelButton,
  confirmButton,
  document: documentRef = globalThis.document,
  fallbackFocus
}) {
  let pending = null;

  const resetDialog = (request) => {
    dialog.removeAttribute("aria-busy");
    dialog.dataset.variant = request.variant;
    cancelButton.disabled = false;
    confirmButton.disabled = false;
    confirmButton.textContent = request.confirmLabel;
    statusElement.hidden = true;
    statusElement.textContent = "";
  };

  const setStatus = (message) => {
    statusElement.textContent = message;
    statusElement.hidden = !message;
  };

  const restoreFocus = (opener) => {
    if (opener?.isConnected && !opener.disabled && typeof opener.focus === "function") {
      opener.focus({ preventScroll: true });
      return;
    }
    const fallback = typeof fallbackFocus === "function" ? fallbackFocus() : fallbackFocus;
    if (fallback?.isConnected && !fallback.disabled && typeof fallback.focus === "function") {
      fallback.focus({ preventScroll: true });
    }
  };

  const finish = (result, closeDialog = true) => {
    const request = pending;
    if (!request) return;
    pending = null;
    resetDialog(request);
    if (closeDialog && dialog.open) dialog.close();
    restoreFocus(request.opener);
    request.resolve(result);
  };

  const keepOpenAfterFailure = (request, message) => {
    request.busy = false;
    dialog.removeAttribute("aria-busy");
    cancelButton.disabled = false;
    confirmButton.disabled = false;
    confirmButton.textContent = request.confirmLabel;
    setStatus(message || request.failureMessage || DEFAULT_FAILURE_MESSAGE);
    cancelButton.focus({ preventScroll: true });
  };

  const runConfirmedAction = async () => {
    const request = pending;
    if (!request || request.busy) return;
    request.busy = true;
    dialog.setAttribute("aria-busy", "true");
    cancelButton.disabled = true;
    confirmButton.disabled = true;
    confirmButton.textContent = request.busyLabel;
    setStatus(request.busyLabel);
    statusElement.focus({ preventScroll: true });

    try {
      const result = await request.onConfirm();
      if (result === false) {
        keepOpenAfterFailure(request);
        return;
      }
      finish(true);
    } catch (error) {
      let message = "";
      try { message = request.onError?.(error) || ""; } catch { /* Keep the dialog usable if error reporting fails. */ }
      keepOpenAfterFailure(request, message);
    }
  };

  cancelButton.addEventListener("click", () => {
    if (pending && !pending.busy) finish(false);
  });
  confirmButton.addEventListener("click", () => { void runConfirmedAction(); });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (pending && !pending.busy) finish(false);
  });
  dialog.addEventListener("close", () => {
    if (pending && !pending.busy) finish(false, false);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !pending) return;
    const enabledControls = [cancelButton, confirmButton].filter((control) => !control.disabled);
    if (!enabledControls.length) {
      event.preventDefault();
      statusElement.focus({ preventScroll: true });
      return;
    }
    const first = enabledControls[0];
    const last = enabledControls.at(-1);
    if (event.shiftKey && documentRef.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && documentRef.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    } else if (!dialog.contains(documentRef.activeElement)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });

  return function confirmAction({
    title,
    message,
    confirmLabel = "Confirmar",
    cancelLabel = "Cancelar",
    busyLabel = "Procesando…",
    failureMessage = DEFAULT_FAILURE_MESSAGE,
    variant = "danger",
    onConfirm,
    onError
  }) {
    if (pending || dialog?.open) return Promise.resolve(false);
    if (!dialog || typeof dialog.showModal !== "function" || !titleElement || !messageElement
      || !statusElement || !cancelButton || !confirmButton || !documentRef || typeof onConfirm !== "function") {
      return Promise.reject(new Error("No se pudo preparar la confirmación interna."));
    }

    return new Promise((resolve, reject) => {
      const request = {
        resolve,
        opener: documentRef.activeElement,
        confirmLabel,
        cancelLabel,
        busyLabel,
        failureMessage,
        variant: variant === "danger" ? "danger" : "default",
        onConfirm,
        onError,
        busy: false
      };
      pending = request;
      titleElement.textContent = title;
      messageElement.textContent = message;
      cancelButton.textContent = cancelLabel;
      resetDialog(request);
      try {
        dialog.showModal();
        cancelButton.focus({ preventScroll: true });
      } catch (error) {
        pending = null;
        resetDialog(request);
        if (dialog.open) dialog.close();
        reject(error);
      }
    });
  };
}
