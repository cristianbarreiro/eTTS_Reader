# Instrucciones para agentes de código

## Objetivo

Mantén eTTS_Reader como una extensión de Microsoft Edge Manifest V3 para leer documentos y texto localmente con Kokoro (inglés) y Piper (español). Sigue la arquitectura y las invariantes de `docs/ARCHITECTURE.md`; ejecuta las verificaciones de `docs/TESTING.md`.

## Antes de trabajar

1. Inspecciona `git status`, la rama, los últimos commits y el diff. No descartes ni sobrescribas cambios del usuario.
2. Lee la documentación especializada que aplique: `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/VOICE-PROVIDERS.md` y `THIRD_PARTY_NOTICES.md`.
3. Inspecciona los módulos y tests afectados antes de decidir qué cambiar. No presupongas que el README o una conversación anterior reflejan el código actual.
4. Haz cambios pequeños y verificables. No refactorices módulos sin relación con la tarea.

## Arquitectura: límites que deben respetarse

- `sidepanel.html` y `src/main.js` son responsables de la UI y de coordinar la interacción del usuario.
- `src/background.js` gestiona permisos, contexto de pestañas, menú contextual, mensajería y ciclo de vida del documento offscreen.
- `offscreen.html` y `src/offscreen.js` mantienen la única autoridad para la cola y la reproducción activa; la lectura debe poder continuar cuando el panel se oculta.
- `src/persistent-engine.js` coordina sesiones, síntesis por fragmentos, persistencia y precarga limitada.
- `src/tts-router.js` enruta voces al proveedor correcto. Kokoro y Piper deben permanecer aislados como proveedores locales distintos.
- La inferencia de ambos motores corre en Web Workers. No muevas inferencia pesada al hilo de la UI.
- `src/persistence.js` guarda documentos, sesiones y WAV en IndexedDB. Los modelos Piper usan OPFS a través de `src/piper-model-store.js`.
- Reutiliza el modal interno existente para confirmar eliminaciones destructivas; no reintroduzcas `window.confirm()` en esos flujos.

## Invariantes de producto, datos y privacidad

- No envíes texto del usuario a servicios TTS externos. La síntesis de Kokoro/Piper es local.
- Descarga pesos solo como resultado de una acción explícita del usuario. No descargues modelos grandes al abrir el panel.
- Mantén las revisiones, tamaños y SHA-256 de los modelos Piper fijados en el catálogo. No aceptes silenciosamente archivos incompletos o modelos no coincidentes.
- Las claves de caché de audio deben aislar proveedor, voz, modelo/revisión, runtime y texto. No reutilices audio incompatible entre voces o versiones.
- Las migraciones de IndexedDB son aditivas y deben preservar documentos, sesiones, progreso y audios no afectados. Nunca vacíes stores como atajo de migración.
- Eliminar un modelo no debe borrar documentos/sesiones ni recursos de otros proveedores. Eliminar audios no debe eliminar modelos.
- Las sesiones heredadas con IDs `system:` se migran según la lógica existente del catálogo, sin autoplay ni pérdida de texto/progreso.
- No reintroduzcas `SpeechSynthesis`/voces Edge como motor español. La arquitectura actual usa Piper para español y Kokoro para inglés.
- No anuncies síntesis offline completa si algún recurso de ejecución aún depende de una URL remota. Los recursos WASM/JS deben servirse desde el paquete de la extensión.

## Código y convenciones

- El proyecto usa JavaScript ESM, Vite y `node:test`; sigue las convenciones del módulo y las APIs reales de las dependencias fijadas en `package-lock.json`.
- No agregues una dependencia para una tarea que puede resolverse con los patrones existentes, salvo justificación concreta.
- No cambies IDs persistidos, versiones de modelos, versiones de runtime, permisos o manifiestos sin evaluar compatibilidad y actualizar las pruebas/documentación.
- Cuando toques `manifest.json`, comprueba también `public/manifest.json` y el resultado de build en `dist/manifest.json`.
- Cuando toques recursos WASM, ONNX, workers o rutas de build, revisa `vite.config.js` y verifica que los archivos requeridos se copian a `dist`.
- Para cambios visuales conserva la identidad oscura de eTTS, los tamaños compactos, los estados accesibles y el comportamiento real de los controles.

## Validación requerida

- Ejecuta `npm test` y `npm run build` para los cambios de implementación, salvo que el entorno no permita ejecutarlos.
- No afirmes que una orden, una prueba manual o la reproducción audible fue verificada si no lo fue.
- Distingue los tests simulados de las verificaciones reales en Edge. Los tests con mocks no validan la calidad de audio ni el funcionamiento del WASM en el navegador.
- Inspecciona el diff final para buscar referencias obsoletas, imports sin uso, estados incompletos y cambios accidentales.
- Si una validación no puede ejecutarse, indica qué quedó sin verificar y por qué.

## Definición de terminado

Un cambio está terminado cuando la implementación, pruebas y documentación relacionada están coherentes; las operaciones destructivas conservan las garantías de datos; no hay regresiones conocidas; y el resumen final reporta archivos modificados, comandos ejecutados y limitaciones pendientes.

No crees nuevas guías, skills o documentos que dupliquen instrucciones existentes sin una necesidad clara.
