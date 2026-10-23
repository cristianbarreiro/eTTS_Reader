// Inyecta content.js en la pestaña activa cuando se pulsa el botón.
const button = document.querySelector("#highlight-button");
const status = document.querySelector("#status");

button.addEventListener("click", async () => {
  button.disabled = true;
  status.textContent = "Aplicando…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No se encontró una pestaña activa.");

    // activeTab concede acceso temporal a la pestaña tras la acción del usuario.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    status.textContent = "Resaltado alternado en esta página.";
  } catch (error) {
    // Páginas internas del navegador y algunas páginas protegidas no admiten scripts.
    status.textContent = error.message || "No se pudo modificar esta página.";
  } finally {
    button.disabled = false;
  }
});
