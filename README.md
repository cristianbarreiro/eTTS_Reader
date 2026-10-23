# Lector local para Edge

Extensión Manifest V3 para leer texto y documentos localmente con Kokoro TTS en WASM/CPU. La experiencia principal vive en el Side Panel de Edge, no en un popup que se destruye al perder el foco.

## Arquitectura

- `sidepanel.html` y `src/main.js`: interfaz principal, edición del texto, biblioteca y controles.
- `src/background.js`: service worker basado en eventos; configura el Side Panel, abre el contexto offscreen cuando se solicita audio y enruta mensajes. No usa bucles para mantener el worker vivo.
- `offscreen.html` y `src/offscreen.js`: única autoridad de reproducción y cola activa. Puede mantener audio y preparar un fragmento siguiente mientras el panel está oculto.
- `src/tts-worker.js`: ejecuta Kokoro fuera de la interfaz. Se crea solo al descargar/preparar el modelo o al iniciar una lectura.
- `src/persistence.js`: IndexedDB para documentos, sesiones y WAV generados. El esquema se amplía con migraciones aditivas; nunca vacía las tiendas durante una actualización.
- `src/reader-client.js`: reconecta la interfaz a una sesión que ya se está reproduciendo, sin iniciar un segundo reproductor.
- `src/documents.js`: TXT y Markdown se leen directamente; PDF.js y Mammoth se importan dinámicamente cuando se solicita ese formato.
- `src/tab-import.js`: se descarga del bundle inicial y solo se carga al pedir una importación; detecta la pestaña activa, extrae el DOM visible o recupera un PDF permitido y devuelve texto revisable.
- `src/player-controller.js`: estado, cola secuencial, navegación, reanudación por posición y ciclo de vida del WAV activo.

## Persistencia y eliminación

- El texto pegado o extraído se guarda en IndexedDB con un debounce breve. Cada sesión conserva una instantánea de su texto, fragmentos, voz, velocidad, índice, posición y estado para poder recuperarla aunque el documento activo cambie.
- Cada WAV se guarda una vez por hash de texto, voz y versión del modelo. Se reutiliza en lecturas siguientes y se precarga como máximo un fragmento siguiente.
- Voz, velocidad e identificadores recientes usan `chrome.storage.local`; el texto, las sesiones y los WAV grandes no.
- Cerrar u ocultar el panel no elimina nada. Al reabrir, una reproducción activa se reconecta; si Edge ya terminó el contexto, la interfaz muestra una sesión interrumpida y espera a que el usuario la reanude. Nunca se reanuda audio inesperadamente.
- **Vaciar editor** crea un borrador vacío y conserva el documento guardado. **Eliminar documento** elimina ese documento y sus sesiones asociadas; los audios compartidos se conservan mientras otra sesión los use. **Eliminar sesión** mantiene el documento. **Eliminar audios guardados** mantiene documentos y sesiones. **Eliminar modelo local** elimina solo las cachés del modelo y las voces.
- El panel muestra el consumo de almacenamiento disponible mediante `navigator.storage.estimate()`. Si IndexedDB o la cuota fallan, se informa del error; no se purgan datos automáticamente.

## Importar una pestaña de Edge

- Pulsa el icono de la extensión desde la pestaña que quieres leer y, en el panel, elige **Importar pestaña actual** o **Importar selección**. La pestaña activa se consulta en el momento del clic; no se fija a la pestaña que abrió originalmente el panel.
- La extracción se ejecuta solo por esa acción. En páginas web prioriza `article`, `main` y `role="main"`; elimina scripts, navegación, formularios, controles y elementos ocultos. Si no encuentra una región principal, limpia el texto del cuerpo. No modifica la página ni lee valores de formularios.
- Los visores de texto se importan desde el texto que exponen en su DOM (`pre` cuando está disponible), conservando JSON, CSV, Markdown y texto plano sin convertirlos en HTML. El contenido se limita a 200.000 caracteres, igual que el editor.
- Para un PDF remoto accesible, la extensión descarga los bytes solo después del clic, sin cookies ni `Referer`, y reutiliza el extractor PDF.js local ya instalado. El archivo tiene un límite de 25 MB y el PDF debe provenir del mismo origen autorizado temporalmente. Un escaneo sin capa de texto no se puede leer porque esta extensión no incluye OCR.
- PDFs locales, enlaces que requieren cookies, redirecciones a otro origen, páginas `edge://`, tiendas, visores protegidos y aplicaciones que dibujan el contenido en canvas pueden impedir la extracción. En esos casos el panel informa la causa y ofrece el selector de archivos o pegar el texto.
- Antes de cambiar el editor se presenta título, origen, tipo, cantidad y texto extraído. **Reemplazar texto actual** y **Añadir al texto actual** crean un documento y una sesión nuevos; el documento y las sesiones previas quedan guardados. Si el texto parece repetido al final, se pide confirmación y el usuario puede añadirlo de todos modos.
- El permiso nuevo `activeTab` da acceso temporal después de que el usuario invoque la extensión sobre la pestaña. `scripting` permite ejecutar la extracción puntual en el marco principal. No se solicita `tabs`, permiso global de sitios, ni `<all_urls>`. Si Edge indica que falta acceso, vuelve a pulsar el icono de la extensión desde la pestaña que deseas importar.
- El texto extraído no se transmite a servidores. El único acceso de red de esta función es la descarga GET del PDF seleccionado, desde su mismo origen y sin credenciales; el texto se extrae en el dispositivo.

## Lectura en segundo plano y límites

- Hacer clic en el icono abre el Side Panel. Este permanece junto a las pestañas cuando se navega; la lectura también se conserva si el usuario cierra el panel.
- El audio y la generación viven en el documento offscreen y un Web Worker dedicado. El buffer contiene como máximo un fragmento siguiente; el modelo se conserva en memoria mientras el contexto siga vivo y los WAV se guardan en disco local.
- Edge puede terminar el documento offscreen. Con el motivo `AUDIO_PLAYBACK`, el navegador cierra ese documento tras 30 segundos sin audio. Si una carga o generación supera ese límite, el estado se guarda y la sesión puede reanudarse; la extensión no intenta mantener vivo el navegador de forma artificial.
- Cerrar Edge, apagar el equipo, deshabilitar o recargar la extensión puede interrumpir la reproducción. Los documentos, sesiones y WAV ya escritos siguen en IndexedDB cuando Edge conserva el almacenamiento. La continuidad de audio no se promete en esos casos.

## Modelo y privacidad

- Kokoro (`kokoro-js` 1.2.1), Transformers.js y ONNX Runtime Web se ejecutan localmente en WASM/CPU; no se requiere WebGPU ni un proveedor de voz remoto.
- El runtime WASM y dos embeddings están empaquetados. Los pesos del modelo se obtienen de Hugging Face solo al pedir su preparación o comenzar una lectura que los necesite. Una vez almacenados, pueden reutilizarse sin volver a descargarlos.
- El texto y los documentos no se envían a terceros. El acceso de red solo se usa para descargar los pesos solicitados por el usuario.
- PDF, DOCX, TXT y Markdown de hasta 25 MB se procesan en el dispositivo. PDF.js no hace OCR; los escaneos sin capa de texto se informan.
- Este paquete activa `af_heart` y `am_michael` (inglés). Los perfiles españoles se muestran deshabilitados porque no hay una ruta de fonemización española verificada.
- Se genera y descarga el WAV del fragmento actual; todavía no se ofrece exportación de un documento completo como un único WAV.

## Instalación y desarrollo

1. Requiere Node.js 22.13+ y npm.
2. Instala dependencias con `npm install`.
3. Ejecuta `npm run build`.
4. Abre `edge://extensions`, activa **Modo de desarrollador** y elige **Cargar desempaquetado**.
5. Selecciona `dist`.
6. Pulsa el icono de la extensión para abrir el Side Panel. Prepara el modelo local cuando quieras; abrir el panel no inicializa Kokoro ni descarga pesos.

Para actualizar, vuelve a compilar y pulsa **Recargar** en `edge://extensions`.

## Validación

`npm test` cubre segmentación, reproducción simulada, reanudación, persistencia IndexedDB (con un adaptador de prueba), recuperación sin autoplay, caché de audio, permisos mínimos, clasificación de pestañas, extracción DOM simulada, selección, errores de acceso, descarga PDF acotada y combinación explícita del texto. Estas pruebas no sustituyen una prueba real en Edge con una página web y un PDF abiertos; esas verificaciones deben hacerse en la versión de Edge y el equipo de destino.

## Dependencias y licencias

- `kokoro-js` y el modelo ONNX de Kokoro: revisar licencias y condiciones de redistribución antes de publicar pesos.
- `@huggingface/transformers` y ONNX Runtime Web: Apache-2.0.
- `pdfjs-dist`: Apache-2.0.
- `mammoth`: BSD-2-Clause.

`package-lock.json` fija las versiones resueltas y debe incluirse en la distribución del código.
