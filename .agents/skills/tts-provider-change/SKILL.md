---
name: tts-provider-change
description: Use when adding, removing, debugging, or changing Kokoro/Piper voices, model downloads, inference workers, WAV synthesis, provider routing, runtime assets, or voice caches in eTTS_Reader.
---

# TTS provider change workflow

## Read first

- Read AGENTS.md.
- Read docs/ARCHITECTURE.md and docs/VOICE-PROVIDERS.md.
- Read THIRD_PARTY_NOTICES.md before adding/updating runtimes, phonemizers, model files, or model sources.
- Inspect the current voice catalog, provider router, worker client, worker entrypoint, provider implementation, persistence cache-key creation, vite.config.js, and relevant tests.

## Required workflow

1. Inspect git status and the current diff. Preserve unrelated changes.
2. Trace the full path from selected voice ID through getVoiceProvider, TTSProviderRouter, worker messages, synthesis result, WAV validation, persistence and PlaybackController.
3. Keep provider IDs explicit and stable. Reject unknown IDs rather than defaulting them silently to Kokoro.
4. Keep Kokoro and Piper runtime assets isolated as required by their dependency trees. Verify version matching and copied WASM/data files in the production build.
5. For Piper model changes, verify the pinned revision, exact model/config paths, byte size, SHA-256, language metadata, phoneme configuration and license/notice information. Never treat a partial download as installed.
6. Keep model installation user-initiated. Distinguish downloaded, installed, initialized, ready and failed states.
7. Ensure the cache key separates provider, voice, model revision, runtime version, text and any synthesis setting that changes output.
8. Do not send user text to remote TTS or telemetry. Only resources explicitly requested for installation may be downloaded.
9. Preserve queue behavior: generate WAV, validate it, reuse only compatible cache entries, prefetch no more than the documented next chunk and ignore late results belonging to an old session.
10. Add deterministic tests with mocked workers, storage and fetch. A mocked test is not proof of audible synthesis.
11. Run npm test and npm run build. Inspect dist asset paths and manifests.
12. If browser audio was not manually tested, state that limitation rather than claiming the provider works end-to-end.

## Regression checklist

- Kokoro voices still synthesize.
- Piper voices install, initialize, synthesize and produce valid WAV.
- Failed or cancelled downloads are retryable.
- Switching providers never reuses incompatible audio.
- Removing one model does not delete the other provider, sessions or documents.
- Legacy sessions still migrate without autoplay.
