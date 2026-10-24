## Summary

<!-- What changed and why? Keep this focused. -->

## Validation

- [ ] npm test
- [ ] npm run build
- [ ] Manual validation in Edge, if the change touches runtime, audio, storage, permissions, or UI
- [ ] I have distinguished automated checks from manual/audio checks that I actually performed

## Impact checklist

- [ ] No unrelated user changes were overwritten.
- [ ] Session text, progress, selected voice, and audio references remain compatible, or migration behavior is documented.
- [ ] Piper/Kokoro cache and model storage remain isolated, where relevant.
- [ ] Destructive actions use the internal confirmation modal and preserve unrelated data, where relevant.
- [ ] Manifest permissions and local worker/WASM assets were reviewed, where relevant.
- [ ] Dependency, model, phonemizer, and runtime license notices were reviewed, where relevant.
- [ ] Documentation was updated when architecture, workflows, or user-visible behavior changed.

## Evidence and known limitations

<!-- Add screenshots for UI changes. State what was not tested, particularly audible TTS and offline behavior. -->
