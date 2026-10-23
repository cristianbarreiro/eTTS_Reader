# Proveedores de voz

## Disponibilidad en esta versión

- `af_heart` y `am_michael` usan Kokoro, Transformers.js y ONNX Runtime Web. Kokoro genera WAV, mantiene su caché y puede exportar cada fragmento.
- Las voces españolas se consultan dinámicamente con `speechSynthesis.getVoices()` y se muestran por su nombre e idioma reales. Solo aparecen si Edge/Windows informa una voz cuyo idioma empieza por `es`.
- No se asigna género a una voz del sistema: la API no ofrece un dato fiable para ello. La extensión no inventa perfiles «femenino» o «masculino».
- SpeechSynthesis usa la voz que administra el sistema. No descarga un modelo con la extensión, no garantiza que la voz esté disponible sin conexión, no ofrece WAV exportable y no da duración o búsqueda temporal exactas. La voz puede usar componentes o servicios del sistema según la configuración de Edge/Windows. No se describe como síntesis neuronal local ni se promete que el texto permanezca dentro del proceso de la extensión.
- La voz del sistema comparte la cola, el reproductor, la pausa, la reanudación, la detención, la velocidad y el avance entre fragmentos. Al cambiar la velocidad durante un fragmento, ese fragmento vuelve a comenzar porque SpeechSynthesis no permite cambiar de forma fiable la velocidad de una locución ya iniciada. La recuperación de una sesión vuelve a comenzar el fragmento seleccionado; el sistema no expone una posición temporal exacta.

La selección de una voz de Edge/Windows es explícita: la extensión nunca la elige como sustituto silencioso de Kokoro. Si no se encuentra ninguna voz española, el selector lo indica. La consulta se realiza desde el panel y no inicializa ni descarga Kokoro.

## Auditoría de alternativas neuronales españolas

### `loudness-tts`

La versión publicada revisada es `0.1.1`; su `package.json` declara `GPL-3.0-or-later` y `onnxruntime-web@1.30.0`. El README atribuye la licencia GPL a la combinación de Piper y eSpeak-NG y explica que el navegador descarga los archivos del motor desde jsDelivr salvo que se sirvan localmente. Esta extensión no incorporó el paquete ni cambió su licencia: el repositorio no declara una licencia de distribución y no se resolvió si se aceptarían las obligaciones de GPL al distribuir el paquete. Tampoco se integraron los binarios o recursos de eSpeak-NG. Antes de reconsiderarlo habría que decidir la política de licencia, fijar las versiones, resolver la coexistencia con el ONNX Runtime ya instalado y comprobar el build MV3 con todos los recursos servidos desde la extensión.

Fuentes: [paquete JavaScript `loudness-tts`](https://github.com/Loudness-ai/loudness-tts/blob/main/javascript/package.json), [README JavaScript y privacidad/licencias](https://github.com/Loudness-ai/loudness-tts/blob/main/javascript/README.md).

### `piper-plus`

El proyecto declara su motor MIT y dispone de herramientas WebAssembly y fonemización española. Sin embargo, usa su propio inventario G2P/fonémico y declara incompatibles los modelos Piper publicados en `rhasspy/piper-voices`. El candidato de seis idiomas `zs-v1` se identifica como experimental y usa condicionamiento por audio de referencia; no se verificaron dos voces españolas identificadas por género y región para la compilación JS/WASM de esta extensión. Su documentación no aporta una pareja lista para instalar y validar como `Claude`/`Ald` dentro de Edge MV3. No se añadió la dependencia ni se descargaron sus pesos.

Fuentes: [README de piper-plus](https://github.com/ayutaz/piper-plus/blob/dev/README_EN.md), [compatibilidad de modelos](https://github.com/ayutaz/piper-plus/blob/dev/docs/guides/development/pretrained-models.md), [ficha experimental `zs-v1`](https://huggingface.co/ayousanz/piper-plus-base/blob/3620ed788667cb76f08bd6cf2db8152c1f4c8bd1/releases/zs-v1/README.md).

### Modelos upstream Piper evaluados

Los nombres `Claude` (español de México, calidad High) y `Ald` (español de México, calidad Medium) aparecen en el catálogo de `rhasspy/piper-voices`. Sus fichas describen las licencias del conjunto de datos como Apache-2.0 para Claude y Unlicense para Ald; esas condiciones pertenecen al material de voz y son distintas de la licencia del runtime. Estos checkpoints no son compatibles con piper-plus y no se empaquetan en la extensión. No se afirma que sean aptos para redistribución comercial.

Fuentes: [ficha de Claude](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/claude/high/MODEL_CARD), [ficha de Ald](https://huggingface.co/rhasspy/piper-voices/blob/main/es/es_MX/ald/medium/MODEL_CARD).

## Licencias del repositorio y dependencias

El repositorio no tiene un archivo `LICENSE` ni un campo `license` en `package.json` (el paquete está marcado como `private`). Esto no determina por sí solo los derechos de distribución de la extensión. No se añadió una licencia ni se concluyó que pueda distribuirse una combinación con `loudness-tts` GPL.

No se añadió ninguna dependencia ni modelo vocal español. Kokoro y sus modelos ingleses siguen sujetos a sus respectivas licencias y avisos de upstream; Transformers.js y ONNX Runtime Web permanecen en las versiones fijadas por `package-lock.json`. Revisa los términos de cada artefacto antes de redistribuir una compilación.

## Prueba pendiente

Las pruebas automatizadas simulan la enumeración, la reproducción, la pausa, la velocidad, la cancelación y la cola de SpeechSynthesis. No demuestran que Edge/Windows tenga voces españolas instaladas ni que una voz concreta produzca audio audible. La compilación de esta tarea no se ha probado manualmente en Edge con dos voces españolas, sin conexión o con una descarga de modelos porque este proveedor del sistema no administra ni descarga modelos. La aceptación de voces neurales femeninas y masculinas con WAV local queda pendiente de elegir una ruta de licencia compatible y validar dos modelos concretos en la extensión.
