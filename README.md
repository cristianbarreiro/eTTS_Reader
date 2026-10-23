# Lector local para Edge

Extensión Manifest V3 para pegar texto o extraer localmente texto de PDF, DOCX, TXT y Markdown, y escucharlo con Kokoro TTS en WASM/CPU.

## Estado actual y límites verificados

- El motor neural integrado es `kokoro-js` 1.2.1 con Transformers.js/ONNX Runtime Web. El ejecutable y el WebAssembly se empaquetan en la extensión; los pesos se descargan desde Hugging Face solo al pulsar **Descargar modelo local**.
- Kokoro se ejecuta en WASM/CPU. Tras completar la descarga y cargar los recursos requeridos, puede generar audio sin conexión. Esta versión no depende de WebGPU.
- La distribución de `kokoro-js` instalada expone 28 voces en inglés (estadounidense y británico) y su fonemizador integrado solo procesa inglés. Por eso solo se activan las dos voces pedidas verificables: `af_heart` y `am_michael`. `ef_dora` y `em_alex` aparecen desactivadas; no se simulan como voces disponibles. Las voces españolas y el proveedor API con consentimiento siguen pendientes.
- La extracción de PDF no incluye OCR. PDF escaneados sin capa de texto se informan al usuario.
- La inferencia del modelo aún debe probarse manualmente en Edge con el dispositivo destino. La compilación no confirma que una voz haya generado audio.
- El reproductor genera un WAV a la vez y permite descargar el fragmento actual. No ofrece todavía una exportación WAV de la lectura completa.
- El progreso de tiempo total aparece cuando se conocen las duraciones de todos los fragmentos. Antes de ese punto, la barra indica el avance por fragmentos y la interfaz señala que la duración total está pendiente.
- Detener devuelve la selección al primer fragmento y libera el WAV cargado. Una síntesis de Kokoro ya iniciada no puede cancelarse internamente; su resultado se descarta si el texto o la selección cambiaron.

## Arquitectura

- `src/documents.js`: extracción local con PDF.js y Mammoth; TXT y Markdown se leen directamente.
- `src/text.js`: prepara y segmenta el texto preservando el original para editarlo.
- `src/tts.js`: abstracción `TTSProvider` e implementación `LocalKokoroProvider`.
- `src/main.js`: interfaz del popup, preferencias y estado del modelo.
- `src/player-controller.js`: fuente única de estado del reproductor, cola secuencial, navegación y ciclo de vida del WAV actual.
- `src/audio-utils.js`: formato temporal y validación de la cabecera WAV generada por Transformers.js.
- Los modelos se guardan en Cache Storage por el caché del runtime Transformers.js. Las preferencias pequeñas (voz y velocidad) usan `chrome.storage.local`. **Eliminar datos locales** borra cachés y preferencias.

## Reproducción

- La pausa conserva la posición; reproducir reanuda el fragmento actual. Al terminar un fragmento, el siguiente se sintetiza y se reproduce automáticamente.
- La velocidad usa `HTMLAudioElement.playbackRate`, mantiene el tono cuando el navegador lo admite y se aplica de inmediato al WAV activo y a los siguientes fragmentos, sin regenerar audio.
- La barra de búsqueda controla la posición real del fragmento activo cuando el navegador informa su duración. Los tiempos se leen de los metadatos del WAV.
- El reproductor conserva una sola URL Blob activa. Al sustituir texto, navegar, detener o desechar el audio, primero desconecta el recurso del elemento de audio y después revoca la URL.
- Las teclas Espacio y flechas izquierda/derecha controlan la lectura cuando el foco no está en un campo editable, un selector, un botón, un enlace o el control de búsqueda.

## Instalación y desarrollo

1. Requiere Node.js 22.13+ (por `pdfjs-dist` 6) y npm.
2. Instala dependencias: `npm install`.
3. Compila: `npm run build`.
4. Abre `edge://extensions`, activa **Modo de desarrollador** y pulsa **Cargar desempaquetado**.
5. Selecciona la carpeta `dist`.
6. Abre el popup, carga un documento o pega texto, y pulsa **Descargar modelo local**. La descarga inicial del modelo cuantizado ocupa alrededor de 95 MB, más el tokenizador y metadatos. El runtime WASM (aprox. 21.6 MB) y los dos embeddings de voz (aprox. 1 MB) están incluidos en la extensión. El uso de memoria es adicional y depende del navegador y del equipo.

Para recargar cambios, vuelve a ejecutar la compilación y pulsa **Recargar** en `edge://extensions`.

## Formatos y privacidad

PDF, DOCX, TXT y Markdown de hasta 25 MB se procesan en el dispositivo. PDFs de más de 500 páginas se rechazan para limitar memoria. PDF.js no hace OCR. El texto se envía al motor de inferencia local dentro de la extensión; no hay modo API en esta versión ni fallback externo silencioso. Los recursos de modelo se obtienen de Hugging Face al descargar bajo demanda.

## Dependencias y licencias

- `kokoro-js` y pesos `onnx-community/Kokoro-82M-v1.0-ONNX`: Apache-2.0 según la ficha del modelo; la versión usada y sus voces disponibles deben comprobarse antes de redistribuir modelos.
- `@huggingface/transformers` y ONNX Runtime Web: Apache-2.0; revisar los avisos incluidos en `node_modules` al distribuir.
- `pdfjs-dist`: Apache-2.0.
- `mammoth`: BSD-2-Clause.

Este repositorio incluye los avisos de dependencias instaladas en `node_modules`; publica también el archivo `package-lock.json` para fijar versiones.

## Errores frecuentes

- **Modelo sin descargar:** pulsa el botón de descarga y permite que Edge conecte a Hugging Face.
- **Error de memoria o WebAssembly:** cierra pestañas pesadas y vuelve a intentar; esta versión usa WASM/CPU y no ofrece perfil de poca memoria.
- **Voz española deshabilitada:** la versión actual del paquete JS no ofrece una ruta verificada de fonemización en español.
- **PDF sin texto:** si es un escaneo, requiere OCR; OCR no está implementado.

