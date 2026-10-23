// Alterna un contorno visible en el contenido de la página actual.
// Este archivo se ejecuta solo cuando el usuario pulsa el botón del popup.
(() => {
  const marker = "data-edge-scaffold-highlight";
  const existing = document.querySelector(`[${marker}]`);

  if (existing) {
    existing.remove();
    return;
  }

  const overlay = document.createElement("div");
  overlay.setAttribute(marker, "");
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    border: "4px solid #086ada",
    boxSizing: "border-box"
  });
  document.documentElement.appendChild(overlay);
})();
