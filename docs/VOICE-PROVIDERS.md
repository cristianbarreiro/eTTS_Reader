# Proveedores de voz locales

## Kokoro · inglés

`af_heart` y `am_michael` usan Kokoro, Transformers.js y la versión de ONNX Runtime que resuelve Transformers.js. El motor se ejecuta en WASM/CPU y conserva su caché/modelos de acuerdo con la configuración existente.

## Piper · español

Las voces españolas usan Piper con ONNX Runtime Web `1.22.0` y el fonemizador WASM empaquetado. Piper se ejecuta en un Worker local; el texto no se envía a un servicio de voz. Los modelos se descargan solo al pulsar **Descargar voz**, se guardan en OPFS y se verifican con el tamaño y SHA-256 fijados en `src/voice-catalog.js`.

### Evaluación de `@mintplex-labs/piper-tts-web`

Se evaluó la versión `1.0.5`. Su API documentada descarga, consulta y predice por `voiceId` de su catálogo integrado, pero no expone una interfaz documentada para registrar los modelos Daniela y DaveFX con sus rutas de Hugging Face fijadas, revisiones concretas y validación de SHA-256 antes de guardar. Para mantener esa verificación y el almacenamiento por voz sin modificar internamente un catálogo ajeno, la extensión integra ONNX Runtime Web y el fonemizador Piper WASM directamente. La API de la biblioteca y su ejemplo de Web Worker están descritos en su [README upstream](https://github.com/Mintplex-Labs/piper-tts-web/blob/main/README.md).

| Voz | Variante | Tamaño | Revisión del repositorio |
|---|---|---:|---|
| Daniela | `es_AR`, calidad alta | 114,199,011 bytes | `375a0fe641dea077c2a47b4e9a056d6da521eed3` |
| DaveFX | `es_ES`, calidad media | 63,201,294 bytes | `2f8dbe0bb0dde986411632bf014a13cdbe6596e7` |

Los pesos se obtienen de [`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices), fijados a las revisiones listadas. Los modelos no se incluyen en el repositorio ni en el ZIP de la extensión. Sus fichas indican los datos/licencias asociados a cada voz: [Daniela](https://huggingface.co/rhasspy/piper-voices/blob/375a0fe641dea077c2a47b4e9a056d6da521eed3/es/es_AR/daniela/high/MODEL_CARD) documenta CC BY-SA 4.0 para el conjunto de datos; [DaveFX](https://huggingface.co/rhasspy/piper-voices/blob/2f8dbe0bb0dde986411632bf014a13cdbe6596e7/es/es_ES/davefx/medium/MODEL_CARD) documenta CC0. Los metadatos del repositorio de modelos indican MIT; la licencia de los datos de entrenamiento y la del artefacto del modelo son datos distintos. Revisa las fichas upstream antes de redistribuir pesos o audio.

La extensión convierte cada fragmento en WAV local. El reproductor puede reproducirlo, medir su duración, pausarlo, buscar en él y descargarlo. Las claves de caché incluyen proveedor, voz, revisión de modelo y versión del runtime, por lo que una voz Piper no reutiliza audio Kokoro ni audio de una revisión anterior.

## Migración desde voces Edge/Windows

La extensión ya no consulta ni llama `SpeechSynthesis`. Al abrir una sesión antigua que usaba una voz `system:*`, cambia su voz a Daniela, conserva documento, texto, fragmento y progreso, e invalida las referencias al audio anterior. No inicia reproducción automáticamente. El modelo se descarga solo con la acción explícita del usuario.

## Runtime y licencias

- `@huggingface/transformers` declara Apache-2.0.
- `onnxruntime-web` declara MIT. Kokoro conserva su runtime resuelto por Transformers.js; Piper utiliza el paquete raíz exacto `1.22.0`, sin deduplicar ambas versiones.
- `@noble/hashes` declara MIT y se usa para verificar las descargas en streaming.
- `@diffusionstudio/piper-wasm` declara MIT, pero su README indica que los binarios se construyen con Piper phonemize y eSpeak-NG. eSpeak NG declara GPL-3.0-or-later; revisa la procedencia exacta del WASM y las obligaciones de redistribución antes de distribuir la extensión.
- Las licencias declaradas para el runtime, los datos de voz y el archivo generado no determinan la licencia global de este repositorio. El proyecto no contiene un archivo `LICENSE`.
- El inventario ampliado y las referencias upstream están en [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

### Recuperación y límites de espera

`PiperWorkerClient` controla los límites desde fuera del worker: 15 s para consultas, 180 s para inicializar, hasta 15 min para síntesis según el texto y 10 min para descargar. Síntesis y descarga también tienen límites de inactividad (90 s y 45 s); el progreso válido renueva ese límite, pero no el absoluto. Si un worker queda bloqueado, el cliente lo termina, rechaza sus peticiones y libera la cola para que el siguiente intento cree uno nuevo.

Las descargas de configuración tienen un límite de 60 s total / 20 s sin actividad. OPFS guarda las descargas en archivos temporales y registra una voz solo después de verificar el tamaño, el hash y la configuración. En el siguiente estado/instalación se retiran temporales; los archivos finales huérfanos solo se eliminan si el manifiesto local es válido. Un error de inicialización conserva el modelo verificado. «Restablecer motor Piper» libera el worker sin borrar el modelo ni datos de lectura, y no interrumpe reproducción activa.

## Verificación

La compilación automatizada comprueba las versiones y copia los artefactos requeridos a `dist/ort`, `dist/ort/piper` y `dist/piper`. Las pruebas automatizadas cubren el catálogo, la migración, la caché y los errores de descarga con almacenamiento simulado. La inicialización real, la generación audible y el WAV descargado deben verificarse en Edge con la extensión compilada; una compilación correcta no prueba que la síntesis funcione.
