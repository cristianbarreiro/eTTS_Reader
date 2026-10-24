# GitHub Copilot instructions

Read the repository root AGENTS.md before changing code. It defines the shared invariants and validation requirements.

Use the canonical task procedures under .agents/skills/ when the task matches one of their descriptions. The corresponding entries under .github/skills/ are compatibility adapters; their instructions point back to the canonical source rather than duplicating it.

Read only the relevant references:
- Architecture and message/context boundaries: docs/ARCHITECTURE.md
- Commands and manual Edge verification: docs/TESTING.md
- Provider models and runtime versions: docs/VOICE-PROVIDERS.md
- Licenses and redistributable assets: THIRD_PARTY_NOTICES.md

Preserve local changes, prefer small reviewable diffs, and do not claim that audible TTS, offline operation, or manual Edge validation was verified unless it was actually tested.
