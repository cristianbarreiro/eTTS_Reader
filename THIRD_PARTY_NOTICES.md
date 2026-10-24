# Third-party notices

This extension packages local runtime and phonemization components. The entries below identify the direct components and upstream material used by the current build; transitive dependency notices remain in their respective package distributions.

| Component | Version / source | Declared license | Use in this extension |
|---|---|---|---|
| Kokoro.js | `kokoro-js` 1.2.1 | MIT | Local English voice synthesis |
| Transformers.js | `@huggingface/transformers` 3.8.1 | Apache-2.0 | Kokoro model/runtime integration |
| ONNX Runtime Web | root 1.22.0; Transformers.js resolves `1.22.0-dev.20250409-89f8206ba4` | MIT | WASM inference for Piper and Kokoro |
| Piper WASM package | `@diffusionstudio/piper-wasm` 1.0.0 | MIT in package metadata | eSpeak/Piper phonemizer loader and WASM assets |
| eSpeak NG | bundled into the Piper phonemizer build | GPL-3.0-or-later upstream | Spanish text phonemization data and implementation |
| `@noble/hashes` | 1.8.0 | MIT | Streaming SHA-256 checks for downloaded voice models |

The Piper WASM package README says its build artifacts are generated with eSpeak NG and Piper phonemize. eSpeak NG is GPL-3.0-or-later. The package metadata's MIT declaration does not by itself resolve the licensing obligations of bundled upstream components; review the exact binary provenance and applicable source-offer/notice obligations before distributing the extension. Upstream references: [Piper WASM](https://github.com/diffusion-studio/piper-wasm), [Piper phonemize](https://github.com/rhasspy/piper-phonemize), and [eSpeak NG license](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING).

## Downloadable voice models

The large ONNX models are fetched only after the user explicitly requests installation. They are not included in this repository or the extension build.

| Voice | Pinned model revision | Model card information |
|---|---|---|
| Daniela (`es_AR`, high) | [`375a0fe641dea077c2a47b4e9a056d6da521eed3`](https://huggingface.co/rhasspy/piper-voices/tree/375a0fe641dea077c2a47b4e9a056d6da521eed3/es/es_AR/daniela/high) | The card identifies the training dataset as OpenSLR 61 under CC BY-SA 4.0. |
| DaveFX (`es_ES`, medium) | [`2f8dbe0bb0dde986411632bf014a13cdbe6596e7`](https://huggingface.co/rhasspy/piper-voices/tree/2f8dbe0bb0dde986411632bf014a13cdbe6596e7/es/es_ES/davefx/medium) | The card records CC0 for the dataset. |

The repository's Hugging Face metadata reports MIT, while the model cards separately describe training-data terms. These are different materials; do not treat the repository badge as a complete statement of rights for every model, dataset, generated recording, or redistribution use. Review each pinned `MODEL_CARD` and file before redistributing weights or audio. See [Daniela's pinned card](https://huggingface.co/rhasspy/piper-voices/blob/375a0fe641dea077c2a47b4e9a056d6da521eed3/es/es_AR/daniela/high/MODEL_CARD) and [DaveFX's pinned card](https://huggingface.co/rhasspy/piper-voices/blob/2f8dbe0bb0dde986411632bf014a13cdbe6596e7/es/es_ES/davefx/medium/MODEL_CARD).
