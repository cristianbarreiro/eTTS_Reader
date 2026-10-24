---
name: ui-polish
description: Use for visual refinements to the eTTS_Reader Side Panel, responsive compact layout, focus/hover states, library, model controls, accordions, dialogs, or CSS alignment.
---

# UI polish workflow

## Read first

- Read AGENTS.md and docs/TESTING.md.
- Inspect sidepanel.html, src/style.css, the relevant render/event code in src/main.js, and the existing UI tests.
- Use current screenshots or a browser view as evidence when available. Do not assume the remote branch matches the user's local working tree.

## Design constraints

- Preserve the eTTS dark navy surface palette and blue/cyan brand accents.
- Keep components compact for the narrow Edge Side Panel without removing actions or important state.
- Do not alter TTS, storage, import or session behavior for a styling-only task.
- Prefer the current DOM, classes, CSS variables and SVG conventions over new dependencies or duplicated markup.
- Avoid brittle typography-dependent Unicode glyph swaps for alignment-critical icons; use stable geometry such as one chevron rotated in place.
- Destructive actions use the internal confirmation modal and a clearly visible red hover. Do not reintroduce native browser confirms.
- Every interactive element needs appropriate disabled and focus-visible states. Color must not be the only way state is communicated.
- Preserve titles and accessible labels when applying visual ellipsis.
- Avoid layout shifts on hover; respect reduced-motion preferences for transitions.

## Required workflow

1. Reproduce the issue at the normal panel width and a narrower width if possible.
2. Make the smallest targeted change. Do not restyle neighboring components unless required for consistency.
3. Keep interactions and event wiring unchanged unless the task explicitly requests behavior changes.
4. Update existing UI tests for DOM classes/semantics/state as appropriate.
5. Run npm test and npm run build.
6. Inspect the final diff. Report whether browser visual validation was actually performed; unit tests do not prove pixel alignment.

## Acceptance checklist

- No horizontal overflow or overlapping controls.
- Compact spacing remains consistent.
- Keyboard focus and disabled states are visible.
- Open/closed and hover/focus states align consistently.
- Existing actions and accessibility semantics remain intact.
