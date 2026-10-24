---
name: edge-validation-release
description: Use when validating a production build, testing the extension in Microsoft Edge, preparing a release, checking manifests/WASM assets, dependencies, model licensing or offline claims.
---

# Edge validation and release workflow

## Read first

- Read AGENTS.md, docs/TESTING.md, docs/VOICE-PROVIDERS.md and THIRD_PARTY_NOTICES.md.
- Inspect package.json, package-lock.json, manifest.json, public/manifest.json and vite.config.js.
- Inspect current working-tree changes and the actual latest commit.

## Automated checks

1. Use Node.js 22.13+ and npm as documented by the repository.
2. Run npm ci when validating lockfile reproducibility.
3. Run npm test.
4. Run npm run build.
5. Confirm build output in dist, including the manifest and local worker/WASM/phonemizer assets expected by the current Vite config.
6. Check that manifest.json and public/manifest.json remain consistent.
7. Check that no JavaScript executable is fetched from a remote URL.
8. Inspect dependency updates and third-party notices, including separate licensing considerations for voice model weights, training datasets, runtimes and eSpeak NG.

## Manual Edge checklist

When the task touches runtime, permissions, audio, storage or extension UI:

1. Load dist via edge://extensions using Developer mode and Load unpacked.
2. Check that the extension activates without runtime errors.
3. Test actual model installation and audible synthesis for the affected Piper/Kokoro voice.
4. Test pause/resume, stop, session restore, audio download and model cleanup when affected.
5. Test first-run, retry/error and offline-after-download behavior where applicable.
6. Test browser permissions and page import if touched.
7. Do not say offline was verified unless new audio was synthesized with networking disabled after all required resources were installed.

## Release report

Record the commands and results, the model/voice and Edge build manually tested, known limitations, manifest/resource checks and license notices reviewed.

- A passing build does not prove audible TTS.
- Unit tests with mocks do not prove WebAssembly inference or the downloadable model works in Edge.
- Never claim a manual check that was not performed.
- Do not claim universal browser/hardware compatibility based on a single device.
