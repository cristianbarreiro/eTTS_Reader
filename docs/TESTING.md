# Desarrollo y validación

Esta guía define el mínimo de verificación antes de cerrar una tarea o preparar una distribución de eTTS_Reader. Los comandos se basan en los scripts actuales del proyecto. Si un script cambia, actualiza esta guía en el mismo cambio.

## 1. Requisitos y comandos

Requisito indicado por el proyecto: Node.js 22.13 o superior y npm.

Desde la raíz del repositorio:

- Instalar dependencias reproducibles: npm ci
- Ejecutar la suite: npm test
- Crear el paquete de producción: npm run build
- Comprobar sintaxis puntual cuando sea útil: node --check path/to/file.js

npm ci instala las versiones de package-lock.json. npm test ejecuta la suite basada en node:test. npm run build genera el paquete desempaquetado de producción en dist/.

En el estado documentado, package.json no define scripts de lint ni de comprobación de tipos. No informes de que se ejecutaron esos análisis mientras no se configuren.

Los tests y el build deben ejecutarse después de cambios funcionales. Para cambios limitados a documentación, revisa enlaces, estructura y consistencia; no afirmes que se ejecutaron tests si no se ejecutaron.

## 2. Capas de validación

| Capa | Qué demuestra | Qué no demuestra |
|---|---|---|
| Tests unitarios con mocks | Contratos, estados, errores, rutas de código y comportamiento de módulos bajo escenarios controlados | Compatibilidad real de Edge, calidad audible, recursos WASM completos o disponibilidad de red |
| Build de producción | Vite puede empaquetar las entradas y los assets configurados; los checks de vite.config.js pasan | Que los modelos se instalen, que ONNX inicialice en Edge o que el audio real suene correctamente |
| Prueba manual en Edge | Comportamiento integrado de la extensión y reproducción audible con los modelos probados | Compatibilidad con todos los equipos o variantes de Edge |
| Revisión de distribución | Manifest, permisos, recursos, versiones, avisos y licencias se revisaron | No sustituye una revisión legal cuando se distribuyen modelos o componentes con obligaciones específicas |

Nunca describas una prueba simulada como una prueba real de síntesis.

## 3. Clasificación de tests

Ejecuta toda la suite con npm test. Para investigar un área, localiza los archivos concretos de tests/ en el estado actual. Entre las áreas cubiertas por la suite se encuentran:

- Segmentación de texto.
- Enrutamiento de voces Kokoro/Piper.
- Catálogos y migración de IDs heredados.
- Worker y errores de síntesis.
- Plazos del worker Piper, terminación de workers bloqueados, reintento con worker nuevo y propagación del error al panel.
- Descarga, validación y almacenamiento OPFS de modelos Piper, incluidos timeouts de red/flujo, recuperación de temporales y preservación de modelos válidos.
- Claves de caché y persistencia IndexedDB.
- Colas de reproducción, pausa, reanudación, progreso y restauración de sesiones.
- Eliminación segura de documentos, sesiones, audios y modelos.
- Confirmación interna de acciones destructivas.
- UI, estados de presentación y manifiesto de extensión.
- Importación de pestañas y tratamiento de permisos.

Los nombres y la cantidad de tests pueden cambiar; consulta tests/ en el commit actual en vez de depender de una cifra fija.

## 4. Prueba manual de la extensión en Microsoft Edge

### Preparar la build

1. Ejecuta npm ci, npm test y npm run build.
2. Abre edge://extensions.
3. Activa Modo de desarrollador.
4. Usa Cargar desempaquetado y selecciona la carpeta dist.
5. Comprueba que la extensión se habilita sin errores. Tras cambios, vuelve a compilar y usa Recargar en esa página.

No cargues la raíz del repositorio si el manifiesto de desarrollo indica que la extensión distribuible está en dist/.

### Piper: descarga, instalación y síntesis

Por cada voz Piper soportada en el catálogo:

1. Selecciona la voz y despliega «Modelo y almacenamiento» si todavía no está preparada.
2. Inicia la descarga explícitamente y revisa el progreso.
3. Confirma que la voz cambia a estado preparado solo después de validar e instalar los recursos.
4. Pulsa «Probar voz» con una muestra breve.
5. Introduce texto español de prueba, carga la cola, inicia la lectura y comprueba pronunciación, continuidad entre fragmentos y ausencia de cortes evidentes.
6. Comprueba pausa, reanudación, detención, fragmento anterior/siguiente, velocidad, barra de progreso y búsqueda temporal cuando haya duración disponible.
7. Descarga el WAV y ábrelo en un reproductor independiente.
8. Cierra y vuelve a abrir el Side Panel. Comprueba que el modelo sigue instalado y que una sesión puede recuperarse sin autoplay inesperado.
9. Si está disponible un entorno controlado, desconecta la red después de completar la descarga y vuelve a sintetizar texto nuevo. La prueba debe demostrar que el flujo de inferencia usa recursos locales; no basta con reproducir un WAV que estaba en caché.
10. Si se cancela o falla una descarga, verifica que se muestre el error y que el siguiente intento pueda recuperarse sin tratar un archivo incompleto como instalado.
11. Si la inicialización de Piper deja de avanzar, confirma que la UI abandona «Preparando Piper…», permite reintentar y conserva el modelo verificado. La acción «Restablecer motor Piper» reconstruye el worker, pero debe permanecer bloqueada durante reproducción o una muestra activa.

### Kokoro: no regresión

1. Prepara el modelo desde la acción explícita de la interfaz.
2. Prueba af_heart y am_michael.
3. Verifica que generan WAV reproducibles y descargables.
4. Confirma que cambiar una voz o proveedor no reutiliza audio incompatible.
5. Revisa que eliminar recursos de Piper no elimine Kokoro y viceversa.

### Persistencia, biblioteca y acciones destructivas

1. Importa un TXT o Markdown y crea una sesión de lectura.
2. Avanza varios fragmentos, pausa y reanuda. Cierra el panel y vuelve a abrirlo.
3. Confirma que se conservan texto, posición, velocidad, voz, fragmentos y WAV asociados.
4. Prueba Abrir y Reanudar por separado: abrir no debe iniciar la lectura; reanudar debe obedecer al comportamiento definido por la aplicación.
5. Abre el modal de eliminar documento, sesión, audios y modelo. Cancela cada uno y confirma que los datos permanecen.
6. Confirma cada eliminación de forma individual y comprueba que solo se elimina el recurso indicado. Verifica en especial que eliminar audios no borre modelos, documentos o sesiones y que eliminar un modelo no afecte a proveedores distintos.
7. Cuando la operación se haya ejecutado, comprueba que el estado visual y la estimación de almacenamiento se actualicen.

### Importación y permisos

1. Intenta importar una página HTML accesible después de conceder el permiso solicitado.
2. Comprueba la importación de una selección y confirma que no se extrae contenido solo por cambiar de pestaña.
3. Verifica que cambiar de pestaña no sobrescribe el editor ni reinicia una sesión.
4. Prueba archivos locales solo después de activar el permiso de acceso a URLs de archivo si Edge lo requiere.
5. Comprueba estados de permiso denegado, pestañas restringidas y errores de extracción, asegurando que el texto actual no se pierde.
6. En Google Docs y Word en línea, comprueba que la vista previa marque el texto visible como parcial y que, cuando solo se exponga una selección, indique que no representa el documento entero. Si Google Docs no expone la selección del lienzo, el mensaje debe recomendar copiarla y pegarla en el editor, ofrecer Importar pestaña como extracción posiblemente parcial y recomendar DOCX/PDF para el documento completo; no debe insistir en el menú contextual para esa selección vacía.

### UI y accesibilidad

1. Prueba el panel a su ancho habitual y a un ancho menor.
2. Comprueba el botón Cargar al reproductor, Pestaña actual, el selector y la gestión de modelos.
3. Abre/cierra Biblioteca local y verifica que el chevron mantiene el centro y solo cambia la orientación.
4. Comprueba el modal mediante ratón y teclado, incluyendo Escape, foco inicial, restauración del foco, estado ocupado y errores.
5. Inspecciona hover, focus-visible, estados deshabilitados, títulos largos y desbordamiento horizontal.
6. Confirma que los componentes compactos conservan sus acciones, instrucciones relevantes y accesibilidad.

## 5. Seguridad, privacidad y recursos

Antes de cerrar un cambio que afecta a modelos o runtime:

- Revisa manifest.json, public/manifest.json y el manifiesto generado en dist/.
- Comprueba que vite.config.js copia todos los WASM, JS, datos de fonemización y archivos necesarios a las rutas esperadas.
- No añadas código ejecutable cargado remotamente.
- No envíes texto de lectura a herramientas de telemetría o proveedores TTS remotos.
- No almacenes textos/documentos en registros de diagnóstico.
- Los modelos Piper deben respetar la revisión, el tamaño y SHA-256 que defina el catálogo.
- Revisa cambios de dependencias y los avisos en THIRD_PARTY_NOTICES.md, especialmente eSpeak NG, el fonemizador y condiciones asociadas a los modelos de voz.
- No confundas la licencia del paquete de runtime con la licencia de los datos de entrenamiento o los modelos descargables.
- La conexión puede ser necesaria para descargar un modelo, pero la síntesis debe utilizar los recursos locales que la documentación declare como offline.

## 6. Criterios para informar de resultados

En el resumen de cada tarea, reporta:

- Comandos ejecutados y su resultado real.
- Pruebas específicas añadidas o modificadas.
- Si el build produjo dist/ correctamente.
- Si se realizó una prueba manual en Edge y qué voz/modelo se probó.
- Qué queda pendiente y cualquier limitación observada.

Usa formulaciones precisas:

- «Los tests unitarios pasan» si npm test terminó con éxito.
- «El build termina correctamente» si npm run build terminó con éxito.
- «Probado en Edge con Piper Daniela» solo si se realizó una prueba manual audible con ese modelo.
- «Offline verificado» solo si, con el modelo y los recursos necesarios previamente descargados, se generó audio nuevo sin conexión.

No infieras validación audible, rendimiento, compatibilidad universal ni ausencia de errores de un build exitoso.
