# Lector local para Edge

Extensión Manifest V3 para leer texto y documentos con Kokoro TTS en inglés y Piper TTS en español, ambos locales y ejecutados en WASM/CPU. La experiencia principal vive en el Side Panel de Edge, no en un popup que se destruye al perder el foco.

## Arquitectura

- `sidepanel.html` y `src/main.js`: interfaz principal, edición del texto, biblioteca y controles.
- `src/background.js`: captura la pestaña invocadora antes de abrir el Side Panel, sigue los cambios de pestaña mediante eventos cuando el usuario lo activa, valida que el documento de origen siga siendo el mismo, crea el menú contextual de selección y enruta mensajes. También administra el contexto offscreen; no mantiene el worker vivo con bucles.
- `offscreen.html` y `src/offscreen.js`: única autoridad de reproducción y cola activa. Puede mantener audio y preparar un fragmento siguiente mientras el panel está oculto.
- `src/tts-worker.js`: ejecuta Kokoro fuera de la interfaz. Se crea solo al descargar/preparar el modelo o al iniciar una lectura.
- `src/piper-worker-client.js`, `src/piper-tts-worker.js` y `src/piper-tts.js`: instalan modelos Piper oficiales, verifican tamaño/SHA-256 y ejecutan la fonemización y el modelo ONNX local en un Worker dedicado.
- `src/piper-model-store.js`: conserva los modelos Piper en OPFS, por voz y revisión, sin borrarlos al actualizar la extensión.
- `src/persistence.js`: IndexedDB para documentos, sesiones y WAV generados. El esquema se amplía con migraciones aditivas; nunca vacía las tiendas durante una actualización.
- `src/reader-client.js`: reconecta la interfaz a una sesión que ya se está reproduciendo, sin iniciar un segundo reproductor.
- `src/documents.js`: TXT y Markdown se leen directamente; PDF.js y Mammoth se importan dinámicamente cuando se solicita ese formato.
- `src/tab-import.js`: extracción local de DOM, selección y PDF. El service worker inyecta el extractor en el `tabId` capturado y devuelve el resultado al panel por mensajería; el extractor PDF.js sigue cargándose solo cuando se necesita.
- `src/player-controller.js`: estado, cola secuencial, navegación, reanudación por posición y ciclo de vida del WAV activo.

## Persistencia y eliminación

- La **Biblioteca local** muestra una sola entrada por documento y adjunta sus sesiones en los detalles. Las sesiones conservan texto recuperable, fragmento, posición, voz, velocidad, estado y audios asociados. Las lecturas sin documento original siguen apareciendo como recuperables. La biblioteca se carga al desplegar la sección y no lee los blobs WAV.
- El texto pegado o extraído se guarda en IndexedDB con un debounce breve solo si contiene caracteres distintos de espacios. Vaciar el editor deja un borrador en memoria: no crea documentos ni sobrescribe el contenido guardado. La edición válida actualiza el mismo documento; importar un archivo o confirmar una importación de pestaña crea un documento nuevo.
- Cada WAV se guarda una vez por hash de texto, voz, modelo y runtime. Se reutiliza en lecturas siguientes y se precarga como máximo un fragmento siguiente.
- Voz, velocidad e identificadores recientes usan `chrome.storage.local`; el texto, las sesiones y los WAV grandes no.
- Cerrar u ocultar el panel no elimina nada. Al reabrir, una reproducción activa se reconecta; si Edge ya terminó el contexto, la interfaz muestra una sesión interrumpida y espera a que el usuario la reanude. Nunca se reanuda audio inesperadamente.
- **Vaciar editor** crea un borrador no persistido y conserva los anteriores. `Abrir` carga el texto sin iniciar audio; `Reanudar` recupera una sesión y continúa la lectura; `Leer` inicia una sesión para el texto del documento. Cada documento y sesión tiene una acción `X` con confirmación. Borrar un documento desvincula sus sesiones, que conservan su copia de texto, progreso y audio; al abrirlas se recupera el documento. Borrar una sesión elimina su progreso y solo los WAV que ninguna otra sesión use. Los registros antiguos de documentos vacíos se limpian de forma idempotente al iniciar; sus sesiones se desvinculan y sus datos y audios permanecen. Borrar documentos o sesiones nunca borra el modelo. **Eliminar audios guardados** mantiene documentos y sesiones. **Eliminar modelo local** elimina solo las cachés del modelo y las voces.
- El panel muestra el consumo de almacenamiento disponible mediante `navigator.storage.estimate()`, incluidos los modelos Piper guardados en OPFS. Si IndexedDB u OPFS fallan, se informa del error; no se purgan datos automáticamente.

## Importar una pestaña de Edge

- En **Pestaña actual**, activa **Seguir pestaña activa** para mantener actualizado el origen mientras el Side Panel permanece abierto. Edge solicita el permiso opcional `tabs` en respuesta a ese clic; se utiliza para identificar el título, la dirección y la ventana actual. Si lo rechazas, la extensión sigue funcionando y puedes abrir el lector desde la pestaña que quieras importar.
- Al pulsar **Importar pestaña actual** o **Importar selección**, la extensión consulta el origen más reciente. Si hace falta, Edge solicita únicamente el permiso de host del sitio actual, por ejemplo `https://example.com/*`. Los permisos HTTP/HTTPS son opcionales y no se conceden al instalar la extensión.
- El Side Panel muestra el título, dominio o tipo de archivo, tipo de contenido y estado del permiso. Cambiar de pestaña solo actualiza estos datos; no extrae contenido, cambia el editor, altera la sesión ni reinicia el reproductor.
- Cada importación queda asociada a una pestaña y un identificador de documento. Si la pestaña se cierra, navega o cambia durante la extracción, la extensión descarta el resultado y pide volver a intentarlo. El editor solo cambia tras revisar la vista previa y confirmar **Reemplazar texto actual** o **Añadir al texto actual**.
- La extracción se ejecuta solo por esa acción. En páginas web prioriza `article`, `main` y `role="main"`; elimina scripts, navegación, formularios, controles y elementos ocultos. Si no encuentra una región principal, limpia el texto del cuerpo. No modifica la página ni lee valores de formularios.
- Los visores de texto se importan desde el texto que exponen en su DOM (`pre` cuando está disponible), conservando JSON, CSV, Markdown y texto plano sin convertirlos en HTML. El contenido se limita a 200.000 caracteres, igual que el editor.
- También puedes seleccionar texto en la página y usar el menú contextual **Enviar selección al lector local**. El texto seleccionado se captura en el evento contextual, se guarda solo en `storage.session` y llega al panel sin depender de que el panel conserve el foco. La acción del panel `Importar selección` intenta obtener `window.getSelection()` solo del `tabId` autorizado; si no hay selección, no importa la página completa.
- Para páginas HTML HTTP/HTTPS se prioriza `article`, `main` y `role="main"`, en el marco principal autorizado, sin modificar la página ni leer valores de formulario. No se hace `fetch` de páginas web.
- Google Docs tiene tratamiento específico para texto expuesto por su DOM de edición (`.kix-lineview-text-block` / `.kix-wordhtmlgenerator-word-node`) y páginas visibles. La vista previa se etiqueta como parcial; no se afirma que sea el documento completo. La capa canvas, frames inaccesibles, contenido fuera de las páginas visibles y la selección propia de Google Docs pueden no estar disponibles. Para el documento completo, descarga DOCX/PDF y usa el selector o copia y pega; el menú contextual puede importar la selección que Edge exponga.
- Para un PDF remoto accesible, la extensión descarga los bytes solo después del clic, sin cookies ni `Referer`, y reutiliza PDF.js local. El archivo tiene un límite de 25 MB y debe provenir del origen autorizado. Para un PDF `file://`, primero consulta el permiso **Permitir el acceso a direcciones URL de archivo** de Edge; solo intenta recuperar los bytes locales si el permiso está activo. No inyecta código en el visor ni inspecciona su DOM. Si Edge no entrega el archivo, **Seleccionar este PDF** abre el selector existente y presenta el texto extraído para revisión; el editor solo cambia después de confirmar **Reemplazar** o **Añadir**. El acceso local se declara como `file:///*` y sigue sujeto al interruptor que controla el usuario en Edge. Un escaneo sin capa de texto requiere OCR fuera de la extensión.
- Enlaces que requieren cookies, redirecciones a otro origen, páginas `edge://`, tiendas, visores protegidos y aplicaciones que dibujan en canvas pueden impedir la extracción. El error conserva el texto actual y ofrece alternativas manuales.
- Antes de cambiar el editor se presenta título, origen, tipo, cantidad y texto extraído. **Reemplazar texto actual** y **Añadir al texto actual** crean un documento y una sesión nuevos; el documento y las sesiones previas quedan guardados. Si el texto parece repetido al final, se pide confirmación y el usuario puede añadirlo de todos modos.
- `activeTab` y `scripting` conservan el flujo contextual al abrir el lector desde la pestaña. `tabs` es opcional y solo se solicita al activar **Seguir pestaña activa**. `http://*/*` y `https://*/*` son patrones opcionales que permiten pedir autorización limitada al sitio actual; no se solicitan durante la instalación. No se usa `<all_urls>`. El manifiesto declara el esquema local `file:///*` para que Edge pueda autorizar la lectura cuando el usuario activa el acceso a direcciones URL de archivo. `storage.session` guarda temporalmente la pestaña de origen y la selección pendiente; no se almacena en sincronización ni se transmite a servidores.
- El texto extraído no se transmite a servidores. El único acceso de red de esta función es la descarga GET del PDF seleccionado, desde su mismo origen y sin credenciales; el texto se extrae en el dispositivo.

## Lectura en segundo plano y límites

- Hacer clic en el icono abre el Side Panel. Este permanece junto a las pestañas cuando se navega; la lectura también se conserva si el usuario cierra el panel.
- El audio y la generación viven en el documento offscreen y un Web Worker dedicado. El buffer contiene como máximo un fragmento siguiente; el modelo se conserva en memoria mientras el contexto siga vivo y los WAV se guardan en disco local.
- Edge puede terminar el documento offscreen. Con el motivo `AUDIO_PLAYBACK`, el navegador cierra ese documento tras 30 segundos sin audio. Si una carga o generación supera ese límite, el estado se guarda y la sesión puede reanudarse; la extensión no intenta mantener vivo el navegador de forma artificial.
- Cerrar Edge, apagar el equipo, deshabilitar o recargar la extensión puede interrumpir la reproducción. Los documentos, sesiones y WAV ya escritos siguen en IndexedDB cuando Edge conserva el almacenamiento. La continuidad de audio no se promete en esos casos.

## Modelo y privacidad

- Kokoro (`kokoro-js` 1.2.1), Transformers.js, Piper, el fonemizador eSpeak y dos versiones aisladas de ONNX Runtime Web se ejecutan en Workers locales con WASM/CPU. No se requiere WebGPU ni un proveedor de voz remoto.
- Los runtimes WASM, el fonemizador y dos embeddings están empaquetados. Los modelos de Kokoro y Piper se descargan únicamente cuando el usuario pulsa la acción de preparación/descarga; los modelos Piper se guardan en OPFS y se verifican por tamaño y SHA-256.
- El texto se sintetiza localmente. La red solo se usa para descargar los pesos del modelo que el usuario solicita; no se envía el texto a un servicio remoto.
- PDF, DOCX, TXT y Markdown de hasta 25 MB se procesan en el dispositivo. PDF.js no hace OCR; los escaneos sin capa de texto se informan.
- Kokoro ofrece `af_heart` y `am_michael` en inglés. Piper ofrece Daniela (`es_AR`, alta) y DaveFX (`es_ES`, media), con WAV descargable y controles de reproducción habituales. Las voces, revisiones, pesos y licencias de datos se documentan en [`docs/VOICE-PROVIDERS.md`](docs/VOICE-PROVIDERS.md).
- Las sesiones que guardaban una voz de Edge/Windows migran a Daniela sin autoplay; se conservan texto y progreso, y se invalidan solo las claves de audio de aquel proveedor.
- Los avisos de componentes y voces de terceros están en [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- Se genera y descarga el WAV del fragmento actual; todavía no se ofrece exportación de un documento completo como un único WAV.

## Instalación y desarrollo

1. Requiere Node.js 22.13+ y npm.
2. Instala dependencias con `npm install`.
3. Ejecuta `npm run build`.
4. Abre `edge://extensions`, activa **Modo de desarrollador** y elige **Cargar desempaquetado**.
5. Selecciona `dist`.
6. Pulsa el icono de la extensión para abrir el Side Panel. Elige **Descargar voz** para obtener el modelo Piper seleccionado o prepara Kokoro cuando quieras; abrir el panel no inicializa motores ni descarga pesos.

Para actualizar, vuelve a compilar y pulsa **Recargar** en `edge://extensions`.

## Flujo de desarrollo asistido por IA

- Las reglas compartidas para agentes están en [AGENTS.md](AGENTS.md).
- Los límites de módulos, workers, proveedores y almacenamiento están en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Los comandos, pruebas automatizadas y procedimientos manuales en Edge están en [docs/TESTING.md](docs/TESTING.md).
- Los procedimientos reutilizables están en .agents/skills/; .github/skills/ contiene entradas compatibles con GitHub Copilot que apuntan a esas fuentes canónicas.
- Para cambios de proveedores, almacenamiento/sesiones, UI o validación de release, consulta la skill que corresponda. No informes de pruebas audibles o validación offline que no se hayan realizado.
- La plantilla de pull request pide describir validación, impactos sobre datos, modelos, permisos y licencias.

## Validación

`npm test` cubre segmentación, reproducción simulada, reanudación, persistencia IndexedDB, migración de sesiones, cachés separadas por voz/modelo, catálogo Piper/Kokoro, preparación y errores, carga OPFS simulada y extracción/importación de documentos. Estas pruebas no sustituyen una prueba real en Edge ni validan el audio audible con los modelos completos.

Prueba manual del motor: carga `dist` en Edge; descarga e inicializa cada modelo Piper, prueba una muestra, genera/reproduce/descarga WAV, reinicia el panel para comprobar el almacenamiento local y simula ausencia de red/recurso para verificar el estado de error y reintento. La síntesis audible debe probarse en Edge: el build y las pruebas unitarias por sí solos no la demuestran.

El proyecto no define scripts de lint ni de comprobación de tipos. `node --check` se puede usar para revisar sintaxis JavaScript; `npm run build` valida el empaquetado de producción.

## Dependencias y licencias

- `kokoro-js` y el modelo ONNX de Kokoro: revisar licencias y condiciones de redistribución antes de publicar pesos.
- `@huggingface/transformers`: Apache-2.0; `onnxruntime-web`: MIT.
- `@diffusionstudio/piper-wasm` declara MIT, pero su artefacto empaquetado incorpora eSpeak NG, cuyo upstream declara GPL-3.0-or-later. Revisa los avisos y obligaciones aplicables antes de redistribuir.
- `pdfjs-dist`: Apache-2.0.
- `mammoth`: BSD-2-Clause.

`package-lock.json` fija las versiones resueltas y debe incluirse en la distribución del código.
