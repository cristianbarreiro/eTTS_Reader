---
name: storage-session-migration
description: Use when changing IndexedDB, OPFS model storage, WAV cache, document/session records, migrations, cleanup, deletion confirmations, recovery or storage usage in eTTS_Reader.
---

# Storage and session migration workflow

## Read first

- Read AGENTS.md, docs/ARCHITECTURE.md and docs/TESTING.md.
- Read src/persistence.js, src/piper-model-store.js, src/storage-safety.js, src/confirm-action.js, src/library-confirmation.js and the affected storage/provider code.
- Read the relevant persistence, model-store, storage-safety and confirmation tests.

## Invariants

- Identify which resource is affected before editing: document, session, cached WAV, Kokoro model/runtime resource, Piper model/config in OPFS, or temporary browser state.
- IndexedDB contains documents, sessions and WAV blobs. Piper model files are stored separately in OPFS. Do not treat them as one store.
- Migrations must preserve data not explicitly being migrated. Prefer additive and idempotent migrations; never clear all stores as a shortcut.
- A document deletion may detach sessions that remain independently recoverable. Preserve the behavior verified by the current implementation.
- Deleting a session must not remove WAV used by another session.
- Deleting saved audio must not remove documents, sessions or installed models.
- Deleting one model must not remove the other provider's resources. Audit shared files and cache keys before removal.
- Destructive operations must reuse the internal confirmation modal. Cancellation must have no side effects; confirmation must run once; failures must remain visible and retryable.
- Do not mutate persistent state before a user confirms a destructive action.
- Keep cache invalidation scoped to the model/provider/revision that actually changed.
- Do not autoplay during migration or restoration.

## Required workflow

1. Inspect status, existing schema version and current record shape; avoid assumptions based on older docs.
2. Write down before/after behavior for each affected resource.
3. Implement idempotently and handle missing, corrupt or partially written records.
4. Ensure active synthesis/playback cannot race with deletion or model cleanup. Use the existing busy checks and lifecycle contracts.
5. Add tests for preservation, deletion scope, shared WAV references, retries and legacy records.
6. Run npm test and npm run build.
7. Report exactly which data is removed, retained and not verified.

## Acceptance checklist

- Cancellation preserves all data.
- Confirmed operations delete only the intended resource.
- Errors do not falsely mark data as deleted.
- Old sessions remain recoverable.
- Storage metrics and UI statuses are refreshed after success.
