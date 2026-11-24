# ADR-0005: Pre-PB-008 Schema Corrections (`SC-11`–`SC-14`)

- **Status:** Accepted (2026-11-24)
- **Context:** Independent QA of `DATA_SCHEMA.md` v0.1.0 identified four schema/concurrency defects (`SC-11`–`SC-14`) that would cause FK failures or Windows sharing violations during implementation.
- **Decision:**
  1. **`SC-11` Retention Tombstones & Blob Purge:** History rows (`memory_proposals`, `mutation_journal`, `revisions`, `audit_events`) are retained as metadata tombstones when content expires. Purge deletes unreferenced content files and marks `blobs.content_purged_at` (with nullable `storage_key` or purged state) rather than deleting parent FK rows, preserving audit integrity while allowing content removal.
  2. **`SC-12` `memory_proposals` DDL & Lifecycle:**
     - On `propose_memory`, `brain-core` snapshots live file bytes into `blobs` when `base_hash` matches (mismatch returns `CONFLICT` with no row inserted).
     - Add `result_note_id TEXT REFERENCES note_identity(note_id)` to `memory_proposals` to link newly created notes after approval.
     - Add `action` and `new_rel_path` to `proposal_versions` so destination-occupied `create` conflicts can be rebased to a new path.
     - Desktop "Edit & Approve" records the edited body as a new `proposal_versions` row before setting `approved_hash` and `status='approved'`.
  3. **`SC-13` `create` Identity Reservation:** Add `'reserved'` to `note_identity.state CHECK(state IN ('present','missing','trashed','reserved'))` and extend `note_path_present` to `WHERE state IN ('present','reserved')`. Startup journal recovery resolves or deletes orphaned `'reserved'` rows.
  4. **`SC-14` Generation-Named Index Files:** Replace in-place `index.sqlite` temp-and-swap with generation-named files (`index-<gen>.sqlite`) pointed to by `vault_meta` in `state.sqlite` (and/or a tiny active-generation pointer). Readers reopen when generation advances; old index files are unlinked when unlocked (best-effort retry on Windows sharing violation).
- **Impact:** Updates `DATA_SCHEMA.md` §5.2, §5.3, §7, §8 and `SYSTEM_ARCHITECTURE.md` §6, §7.1 before `PB-008` contract freeze.
- **Verification:** `PB-009` generation-named index test (`windows_index_gen.rs`) and Phase 3 `PB-010`/`PB-012`/`PB-024` schema/migration tests.
