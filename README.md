# Lector local para Edge

Extensión Manifest V3 para leer texto y documentos localmente con Kokoro TTS en WASM/CPU. La experiencia principal vive en el Side Panel de Edge, no en un popup que se destruye al perder el foco.

## Arquitectura

- `sidepanel.html` y `src/main.js`: interfaz principal, edición del texto, biblioteca y controles.
- `src/background.js`: captura la pestaña invocadora antes de abrir el Side Panel, conserva una referencia temporal en `storage.session`, valida que siga activa y sin navegación, crea el menú contextual de selección y enruta mensajes. También administra el contexto offscreen; no mantiene el worker vivo con bucles.
- `offscreen.html` y `src/offscreen.js`: única autoridad de reproducción y cola activa. Puede mantener audio y preparar un fragmento siguiente mientras el panel está oculto.
- `src/tts-worker.js`: ejecuta Kokoro fuera de la interfaz. Se crea solo al descargar/preparar el modelo o al iniciar una lectura.
- `src/persistence.js`: IndexedDB para documentos, sesiones y WAV generados. El esquema se amplía con migraciones aditivas; nunca vacía las tiendas durante una actualización.
- `src/reader-client.js`: reconecta la interfaz a una sesión que ya se está reproduciendo, sin iniciar un segundo reproductor.
- `src/documents.js`: TXT y Markdown se leen directamente; PDF.js y Mammoth se importan dinámicamente cuando se solicita ese formato.
- `src/tab-import.js`: extracción local de DOM, selección y PDF. El service worker inyecta el extractor en el `tabId` capturado y devuelve el resultado al panel por mensajería; el extractor PDF.js sigue cargándose solo cuando se necesita.
- `src/player-controller.js`: estado, cola secuencial, navegación, reanudación por posición y ciclo de vida del WAV activo.

## Persistencia y eliminación

- La **Biblioteca local** separa documentos (contenido para conservar) y sesiones (copia recuperable del texto, fragmento, posición, voz, velocidad, estado y audios asociados). Se carga al desplegar la sección, no al abrir el panel; sus filas no leen los blobs WAV.
- El texto pegado o extraído se guarda en IndexedDB con un debounce breve. La edición actualiza el mismo documento; importar un archivo o confirmar una importación de pestaña crea un documento nuevo.
- Cada WAV se guarda una vez por hash de texto, voz y versión del modelo. Se reutiliza en lecturas siguientes y se precarga como máximo un fragmento siguiente.
- Voz, velocidad e identificadores recientes usan `chrome.storage.local`; el texto, las sesiones y los WAV grandes no.
- Cerrar u ocultar el panel no elimina nada. Al reabrir, una reproducción activa se reconecta; si Edge ya terminó el contexto, la interfaz muestra una sesión interrumpida y espera a que el usuario la reanude. Nunca se reanuda audio inesperadamente.
- **Vaciar editor** crea un borrador nuevo y conserva los anteriores. Cada documento y sesión tiene su propio botón `X` y confirmación. Borrar un documento desvincula sus sesiones, que conservan su copia de texto, progreso y audio; al retomarlas se crea un documento recuperado. Borrar una sesión borra su progreso y solo los WAV que ninguna otra sesión use. Borrar documentos o sesiones nunca borra el modelo. **Eliminar audios guardados** mantiene documentos y sesiones. **Eliminar modelo local** elimina solo las cachés del modelo y las voces.
- El panel muestra el consumo de almacenamiento disponible mediante `navigator.storage.estimate()`. Si IndexedDB o la cuota fallan, se informa del error; no se purgan datos automáticamente.

## Importar una pestaña de Edge

- Pulsa el icono de la extensión desde la pestaña que quieres leer y, en el panel, elige **Importar pestaña actual** o **Importar selección**. El worker captura el `tabId` antes de abrir el panel. La importación exige que siga siendo la pestaña activa y que no haya navegado; si cambias de pestaña, vuelve a invocar la extensión desde la deseada.
- La extracción se ejecuta solo por esa acción. En páginas web prioriza `article`, `main` y `role="main"`; elimina scripts, navegación, formularios, controles y elementos ocultos. Si no encuentra una región principal, limpia el texto del cuerpo. No modifica la página ni lee valores de formularios.
- Los visores de texto se importan desde el texto que exponen en su DOM (`pre` cuando está disponible), conservando JSON, CSV, Markdown y texto plano sin convertirlos en HTML. El contenido se limita a 200.000 caracteres, igual que el editor.
- También puedes seleccionar texto en la página y usar el menú contextual **Enviar selección al lector local**. El texto seleccionado se captura en el evento contextual, se guarda solo en `storage.session` y llega al panel sin depender de que el panel conserve el foco. La acción del panel `Importar selección` intenta obtener `window.getSelection()` solo del `tabId` autorizado; si no hay selección, no importa la página completa.
- Para páginas HTML HTTP/HTTPS se prioriza `article`, `main` y `role="main"`, en el marco principal autorizado, sin modificar la página ni leer valores de formulario. No se hace `fetch` de páginas web.
- Google Docs tiene tratamiento específico para texto expuesto por su DOM de edición (`.kix-lineview-text-block` / `.kix-wordhtmlgenerator-word-node`) y páginas visibles. La vista previa se etiqueta como parcial; no se afirma que sea el documento completo. La capa canvas, frames inaccesibles, contenido fuera de las páginas visibles y la selección propia de Google Docs pueden no estar disponibles. Para el documento completo, descarga DOCX/PDF y usa el selector o copia y pega; el menú contextual puede importar la selección que Edge exponga.
- Para un PDF remoto accesible, la extensión descarga los bytes solo después del clic, sin cookies ni `Referer`, y reutiliza PDF.js local. El archivo tiene un límite de 25 MB y debe provenir del origen autorizado. Para un PDF `file://`, primero consulta el permiso **Permitir el acceso a direcciones URL de archivo** de Edge; solo intenta recuperar los bytes locales si el permiso está activo. No inyecta código en el visor ni inspecciona su DOM. Si Edge no entrega el archivo, **Seleccionar este PDF** abre el selector existente y presenta el texto extraído para revisión; el editor solo cambia después de confirmar **Reemplazar** o **Añadir**. El acceso local se declara como `file:///*` y sigue sujeto al interruptor que controla el usuario en Edge. Un escaneo sin capa de texto requiere OCR fuera de la extensión.
- Enlaces que requieren cookies, redirecciones a otro origen, páginas `edge://`, tiendas, visores protegidos y aplicaciones que dibujan en canvas pueden impedir la extracción. El error conserva el texto actual y ofrece alternativas manuales.
- Antes de cambiar el editor se presenta título, origen, tipo, cantidad y texto extraído. **Reemplazar texto actual** y **Añadir al texto actual** crean un documento y una sesión nuevos; el documento y las sesiones previas quedan guardados. Si el texto parece repetido al final, se pide confirmación y el usuario puede añadirlo de todos modos.
- `activeTab` y `scripting` dan acceso temporal después de invocar la acción desde la pestaña. `contextMenus` habilita la acción explícita de selección. No se solicita el permiso `tabs`, acceso global a sitios ni `<all_urls>`. El manifiesto declara el esquema local `file:///*` para que Edge pueda autorizar la lectura cuando el usuario activa el acceso a direcciones URL de archivo. `storage.session` guarda temporalmente la pestaña de origen y la selección pendiente; no se almacena en sincronización ni se transmite a servidores.
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

`npm test` cubre segmentación, reproducción simulada, reanudación, persistencia IndexedDB (con un adaptador de prueba), recuperación sin autoplay, caché de audio, permisos mínimos, captura del tabId, validación ante cambio/navegación, menú de selección, clasificación, extracción DOM simulada (incluida salida parcial de Google Docs), borrado con sesiones recuperables, limpieza de audios compartidos y descarga de PDF remotos/locales con límites, firma, permiso y fallos de lectura. Estas pruebas no sustituyen una prueba real en Edge.

Prueba manual pendiente en Edge: carga `dist` como extensión desempaquetada; abre un PDF local con permiso de archivos desactivado y confirma que solo aparecen el aviso y las opciones de recuperación; activa el permiso en `edge://extensions` y vuelve a comprobar; verifica que un PDF con texto produce una vista previa y que cancelar deja intacto el documento/sesión; confirma Reemplazar/Añadir; y repite seleccionando manualmente el archivo cuando la lectura automática no esté disponible. Para un PDF escaneado, la extensión debe avisar que no hay texto extraíble y no afirmar que hizo OCR.

El proyecto no define scripts de lint ni de comprobación de tipos. `node --check` se puede usar para revisar sintaxis JavaScript; `npm run build` valida el empaquetado de producción.

## Dependencias y licencias

- `kokoro-js` y el modelo ONNX de Kokoro: revisar licencias y condiciones de redistribución antes de publicar pesos.
- `@huggingface/transformers` y ONNX Runtime Web: Apache-2.0.
- `pdfjs-dist`: Apache-2.0.
- `mammoth`: BSD-2-Clause.

`package-lock.json` fija las versiones resueltas y debe incluirse en la distribución del código.
