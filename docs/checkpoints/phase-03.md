# Phase 3 Checkpoint — Knowledge Vault Engine

| Field | Value |
|---|---|
| Phase | Phase 3 — Knowledge Vault Engine (`PB-010`–`PB-014`) |
| Date | 2026-11-24 |
| Baseline | Approved Phase 2 (`bd656e5`) |
| Status | `IN_REVIEW` — awaiting owner sign-off at Phase 3 quality gate |

---

## 1. Executive Summary

Phase 3 delivers the complete local-first **Knowledge Vault Engine** (`PB-010` through `PB-014`) inside the shared Rust core (`brain-core`), wired cleanly to the Tauri 2 desktop adapter via typed IPC contracts and backed by real Windows NTFS, SQLite/FTS5, cross-process locking, filesystem watcher, and backup/restore tests.

All Phase 2 technical debt items were resolved before enabling vault writes, and all high/medium findings surfaced by the independent QA & Security audit (`d5a891e9-74e3-4f94-8292-1b26dd601338`) were fixed and re-verified. Automated tests (`13/13` Rust unit & Windows integration tests + `2/2` Vitest tests), `clippy -D warnings`, `eslint`, `tsc --noEmit`, release builds, `--release` benchmarks on `F0`/`F100`/`F1000`, and live `personal-brain.exe` / `brain-mcp.exe` launches all passed with exit code `0`.

**Recommendation:** **GO** for Phase 4 (`PB-015`–`PB-018` — Desktop UI & Knowledge Editor) upon owner sign-off.

---

## 2. Completed Task IDs

| Task ID | Status | Scope Delivered |
|---|---|---|
| `PB-010` | `DONE` | `registry.sqlite` & `state.sqlite` migration 1 (`origin`, `'reserved'` identity), content-addressed blob store, guarded vault scanner (`no write on open`), `VaultEngine` CRUD + `preview_move` + `move_note` + `trash_note` + `restore_trashed_note` + `restore_revision`, `mutation_journal` + crash failpoint recovery, and `(actor_key, request_id)` idempotency. |
| `PB-011` | `DONE` | Non-destructive Markdown & YAML frontmatter parser (`pulldown-cmark 0.13` + `yaml-rust2 0.10`), bounded YAML safety limits, BOM/CRLF/LF/unknown-property preservation, code-span/fenced-block link & tag exclusion, duplicate `personal_brain_id` isolation, and deterministic 2-pass link resolver (`wiki`, `markdown`, `embed`, `broken`, `ambiguous`, `attachment`, `external`, `unsupported`). |
| `PB-012` | `DONE` | Derived `index-<gen>.sqlite` schema & migrations (`notes`, `note_fts`, `tags`, `note_tags`, `aliases`, `note_links`, `attachments`, `dirty_paths`), temp-staged exclusive generation publish (`ADR-0005` `SC-14`), incremental sync with transactional link recomputation (`SC-07`), and automatic index rebuild on missing/corrupt index preserving `state.sqlite`. |
| `PB-013` | `DONE` | Debounced Windows `VaultWatcher` (`notify 8.2.2`), self-write suppression cache using guarded reads, external create/rename/delete reconciliation, overflow fallback, `create_backup` (SQLite backup API + blobs + manifest + race check + unsafe destination/`prepared` journal guards), `restore_backup` (checksum verification + new `VaultId` + disabled grants), and `export_vault`. |
| `PB-014` | `DONE` | Literal-tokenized FTS5 `search_notes` (`bm25` + deterministic `note_id` tie-break, folder/tag filters, cursor pagination, live disk hash revalidation), `get_backlinks`, `get_broken_links`, `get_graph` (`GraphSnapshotDto`), and `--release` benchmark on `F0`/`F100`/`F1000`. |

---

## 3. Implemented Functionality

- **Vault Management:** `create_vault`, `open_vault` (non-destructive), `list_vaults`, `list_notes`, `read_note`, `create_note`, `save_note`, `preview_move` (with `affected_backlinks`), `move_note`, `trash_note`, `restore_trashed_note`, `restore_revision`, `rebuild_index`.
- **Markdown & Relations:** CommonMark + YAML frontmatter extraction without rewriting disk bytes; `tags`, `aliases`, `wikilinks`, relative Markdown links, embeds, broken/ambiguous diagnostics, and backlink/graph DTO queries.
- **Storage Separation:**
  - `%LOCALAPPDATA%\PersonalBrain\registry.sqlite` (vault registrations, grants, settings)
  - `%LOCALAPPDATA%\PersonalBrain\vaults\<vault_id>\state.sqlite` + `blobs/` (authoritative IDs, `origin`, verification status, journal, revisions, audit)
  - `%LOCALAPPDATA%\PersonalBrain\vaults\<vault_id>\index-<gen>.sqlite` (strictly derived, rebuildable FTS5 & graph index)
- **Desktop IPC Integration:** Wired 21 typed Tauri commands in `apps/desktop/src-tauri/src/lib.rs` and corresponding typed TypeScript wrappers in `apps/desktop/src/lib/{contracts,ipc}.ts`; minimal shell (`App.tsx`) displays live `app_health` and `list_vaults` count without Phase 4 UI redesign or mock data.

---

## 4. Files and Modules Changed

- **Dependencies & Docs:** [crates/brain-core/Cargo.toml](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/Cargo.toml), `Cargo.lock`, [docs/checkpoints/phase-02.md](file:///c:/DaffaP/Project%20df/Personal%20Brain/docs/checkpoints/phase-02.md), [docs/MVP_TASKS.md](file:///c:/DaffaP/Project%20df/Personal%20Brain/docs/MVP_TASKS.md), [docs/checkpoints/phase-03.md](file:///c:/DaffaP/Project%20df/Personal%20Brain/docs/checkpoints/phase-03.md)
- **Core Domain & Vault Engine:**
  - [errors.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/domain/errors.rs), [types.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/domain/types.rs)
  - [paths.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/paths.rs), [lock.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/lock.rs), [replace.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/replace.rs), [scan.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/scan.rs), [engine.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/engine.rs), [watcher.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/watcher.rs), [mod.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/mod.rs)
- **State, Markdown, Index, Retrieval & Backup:**
  - [state/mod.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/state/mod.rs), [registry.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/state/registry.rs), [vault_state.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/state/vault_state.rs)
  - [markdown/mod.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/markdown/mod.rs)
  - [index/mod.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/index/mod.rs), [index/store.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/index/store.rs)
  - [retrieval/mod.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/retrieval/mod.rs)
  - [backup/mod.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/backup/mod.rs)
- **Tests & Benchmarks:** `crates/brain-core/tests/{windows_paths,windows_index_gen,vault_crud_and_recovery,markdown_and_links,index_and_backup,watcher_and_reconcile}.rs`, [bench_phase3.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/examples/bench_phase3.rs)
- **Desktop IPC:** [src-tauri/src/lib.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src-tauri/src/lib.rs), [contracts.ts](file:///c:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/lib/contracts.ts), [ipc.ts](file:///c:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/lib/ipc.ts), [App.tsx](file:///c:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/app/App.tsx), [App.test.tsx](file:///c:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/app/App.test.tsx)

---

## 5. Phase 2 Technical Debt Resolution

1. **TOCTOU & dangling junctions (`resolve_guarded_target_for_write`):** Eliminated `current.exists()` prior to handle inspection; opens every intermediate directory segment directly via `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, asserting `FILE_ATTRIBUTE_DIRECTORY` and `!FILE_ATTRIBUTE_REPARSE_POINT`, and rejects dangling junctions and regular-file-as-directory segments (`windows_paths.rs`).
2. **Contextual `CoreError::from_io*`:** Added `from_io_dir` (`NotFound` → `IoFailed`) and `from_io_vault` (`NotFound` → `VaultUnavailable`), mapping Win32 `5` → `AccessDenied` and `112`/`39` → `DiskFull` across `vault/replace.rs`, `vault/lock.rs`, and `vault/paths.rs`.
3. **Temp-staged idempotent generation index:** `write_generation_index` and `rebuild_generation_index` stage into `index-<gen>.sqlite.tmp-<uuid>`, commit, and publish exclusively via `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` without `MOVEFILE_REPLACE_EXISTING` (`Conflict` if generation exists).
4. **IPC `ErrorCode` allowlist:** `parseErrorCode` in `apps/desktop/src/lib/ipc.ts` validates against all 17 canonical `ErrorCode` variants, defaulting unknown values to `"IO_FAILED"` (tested in `App.test.tsx`).

---

## 6. Architecture Compliance

Verified by inspection and `cargo tree -p brain-core --locked`:
- `brain-core` has **zero** dependencies on `tauri` or `rmcp`.
- `apps/desktop/src` has **zero** direct filesystem or SQLite access and zero mock vault metrics.
- `capabilities/default.json` remains restricted to `core:default` for the `main` window with strict CSP.
- `open_healthy_index_or_rebuild` uses `SQLITE_OPEN_READ_ONLY` + `busy_timeout(5s)` on read paths and acquires `VaultLock` before rebuilding missing/corrupted indexes.

---

## 7. Data Integrity Verification

Verified via non-mocked integration tests (`vault_crud_and_recovery.rs`, `index_and_backup.rs`, `windows_replace.rs`, `windows_lock.rs`, `watcher_and_reconcile.rs`):
- Opening an existing vault preserves all note bytes (including BOM, CRLF, unknown YAML) and `.obsidian/app.json` untouched (`AC-002`, `AC-009`).
- `mutation_journal` preimage/postimage blobs + `recover_pending_journal` handle `create`, `save`, `move`, `trash`, and `restore` failpoints cleanly, cleaning orphaned `'reserved'` identities (`SC-13`).
- Competing external edits return `ErrorCode::Conflict` and save attempted edits to `recovery/` without silent overwrite (`AC-016`).
- Corrupted/deleted `index-<gen>.sqlite` automatically rebuilds identical search/graph results while preserving `state.sqlite` (`AC-014`); corrupted, 0-byte truncated, or newer-version `state.sqlite`/`registry.sqlite` fails closed with `ErrorCode::RecoveryRequired`.
- `create_backup` and `restore_backup` verify SHA-256 checksums, refuse unsafe destinations or `prepared` journal states, assign a fresh `VaultId` on restore-alongside, disable restored `agent_grants`, and keep `Attachment` links intact across incremental sync.

---

## 8. Security Verification

- **Path & NTFS boundaries (`windows_paths.rs`):** Rejects traversal (`..`), leading/backslashes, drive letters, UNC paths, ADS (`:`), reserved device names (`CON`, `NUL`, `COM1`), trailing `.`/` `, live & dangling NTFS junctions (`mklink /J`), regular-file-as-dir segments, and hardlinks (`nNumberOfLinks > 1`).
- **Guarded backup/export/watcher reads:** `backup/mod.rs` and `watcher.rs` use `inspect_scanned_file` / `resolve_guarded_existing_file` rather than unvalidated path reads.
- **SQLite / FTS5 / YAML safety:** Parameterized SQLite queries everywhere, literal-quoted FTS5 tokens neutralizing `OR`/`NEAR`/`"`/`*` injection (`markdown_and_links.rs`), and YAML size (`64 KiB`), depth (`16`), node (`2048`), and alias (`32`) bounds.
- **AI frontmatter guard:** `has_forbidden_proposal_frontmatter` helper implemented in `markdown/mod.rs` ahead of Phase 6 (`SC-19`).

---

## 9. Actual Test Results

All checks passed after the final Phase 3 code edits:

| Suite / Command | Exit Code | Result |
|---|---|---|
| `powershell -ExecutionPolicy Bypass -File scripts/verify-all.ps1` | `0` | `ALL_PHASE_2_CHECKS_PASSED` |
| `npm run lint` (`eslint src`) | `0` | `0` errors, `0` warnings |
| `npm run typecheck` (`tsc --noEmit`) | `0` | `0` errors |
| `npm run test` (`vitest run`) | `0` | `2/2` passed (`App.test.tsx`) |
| `cargo fmt --all -- --check` | `0` | Clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | `0` | `0` warnings, `0` errors |
| `cargo test --workspace --locked` | `0` | `13/13` passed (`brain-core` unit `4/4`, `index_and_backup` `1/1`, `markdown_and_links` `1/1`, `vault_crud_and_recovery` `2/2`, `watcher_and_reconcile` `1/1`, `windows_index_gen` `1/1`, `windows_lock` `1/1`, `windows_paths` `2/2`, `windows_replace` `1/1`) |
| `npm run build` (`vite build`) | `0` | Built `apps/desktop/dist/` in `167ms` |
| `cargo build --workspace --locked` | `0` | Compiled `brain-core`, `brain-mcp.exe`, `personal-brain.exe` |

---

## 10. Performance Benchmarks (`--release`)

Hardware (`D-09` baseline): Intel Core i7-13620H, `15.7` GB RAM, NVIDIA GeForce RTX 2050 + Intel UHD Graphics, NVMe WD PC SN740 512 GB, Windows 11 24H2 (`26100.1742`). Executed via `cargo run --release --package brain-core --example bench_phase3` on synthetic seeded fixtures (`scripts/generate-fixtures.mjs`):

| Metric | `F0` (0 notes) | `F100` (100 notes) | `F1000` (1,000 notes / 2,500 edges) | Target |
|---|---|---|---|---|
| Cold `open_vault` | `48.70 ms` | `404.32 ms` | `3565.00 ms` | Measured |
| Warm `scan_vault` | `0.19 ms` | `14.05 ms` | `60.96 ms` | Measured |
| Warm `rebuild_index` | `28.79 ms` | `66.74 ms` | `173.19 ms` | Measured |
| Incremental single-note sync | `5.85 ms` | `12.77 ms` | `37.20 ms` | Measured |
| `create_note` / `read_note` / `save_note` | `15.76` / `3.24` / `15.52 ms` | `24.31` / `6.17` / `45.38 ms` | `63.79` / `5.04` / `45.06 ms` | Measured |
| Warmed search P50 (`120` queries) | `4.06 ms` | `5.56 ms` | `15.28 ms` | — |
| Warmed search P95 (`120` queries) | `5.18 ms` | `10.14 ms` | **`26.35 ms`** | **PASS** (`< 300 ms` `NFR-004`) |
| Process Working Set RSS | `8.04 MB` | `9.26 MB` | `13.85 MB` | Observed |

---

## 11. Runtime Verification

- **`brain-mcp.exe --check`:** Exited `0`, printed valid JSON confirming `core_version: "0.1.0"`, `sqlite_version: "3.49.1"`, `fts5_enabled: true`, and `C:\Users\daffa\AppData\Local\PersonalBrain`.
- **`personal-brain.exe`:** Launched compiled desktop binary (`PID=15576`), confirmed alive and responsive after 5s (`HAS_EXITED=False`, `RESPONDING=True`, `WINDOW_HANDLE=1709020`, `WS_MB=37.7`), and exited cleanly via `CloseMainWindow()`.

---

## 12. Remaining Limitations (Non-Blocking for Phase 4)

1. **Async Tauri command offloading (`PB-015`/`PB-018`):** All 21 Tauri commands in `src-tauri/src/lib.rs` currently run synchronously; Phase 4 should invoke long-running operations (`open_vault`, `rebuild_vault_index`, `create_vault_backup`, `restore_vault_backup`) via `tauri::async_runtime::spawn_blocking` so large vaults never stall IPC responsiveness.
2. **Watcher ↔ `VaultEngine` self-write wiring (`PB-015`):** `VaultWatcher::record_self_write` is tested directly in `watcher_and_reconcile.rs` and ready to be wired into desktop state once a long-lived `VaultWatcher` registry is managed in `AppState` during Phase 4.
3. **Edge-case test expansion backlog:** Specific standalone tests for non-UTF-8 files (`ParseStatus::Unsupported`), cloud placeholder attributes (`WIN_ATTR_OFFLINE`), `VaultWatcher` overflow errors, and search cursor invalidation across generation changes remain straightforward additions alongside Phase 4/8 QA.
4. **Desktop visual screenshot:** `personal-brain.exe` was verified via live Win32 process/HWND health checks; full interactive WebView2 UI inspection begins in Phase 4 (`PB-015`–`PB-018`).

---

## 13. Requirement Traceability

| Requirement / AC | Status | Verification Evidence |
|---|---|---|
| `AC-001` (Create/open Windows vault) | `PASS` | `vault_crud_and_recovery.rs` (`create_vault`, `open_vault`) |
| `AC-002` (Non-destructive open) | `PASS` | `vault_crud_and_recovery.rs` (golden SHA-256 + `.obsidian/app.json` unchanged) |
| `AC-003` (Save & persist) | `PASS` | `vault_crud_and_recovery.rs` (`create_note`, `save_note`, `read_note`, `restore_revision`) |
| `AC-004` (Rename/move preview) | `PASS` | `vault_crud_and_recovery.rs` (`preview_move` `affected_backlinks`, `move_note`) |
| `AC-005` (Failed op leaves no partial file) | `PASS` | `vault_crud_and_recovery.rs` (`AfterJournalPrepared`, `AfterFileReplaced`, read-only `AccessDenied`) |
| `AC-006` (Markdown, YAML, wikilinks, attachments) | `PASS` | `markdown/mod.rs` unit test + `markdown_and_links.rs` |
| `AC-007` (Valid/broken/ambiguous links) | `PASS` | `markdown_and_links.rs` (`get_backlinks`, `get_broken_links`) |
| `AC-008` / `AC-015` (External editor sync) | `PASS` | `watcher_and_reconcile.rs` (live create, rename preserving ID, delete, missed-event reconcile) |
| `AC-009` (Unrelated notes untouched) | `PASS` | `vault_crud_and_recovery.rs` (post-mutation SHA-256 check on `Decision One.md`) |
| `AC-014` (Delete/corrupt index rebuild) | `PASS` | `index_and_backup.rs` (corrupted & deleted index rebuild preserving `NoteId` & `get_graph`) |
| `AC-016` (No silent lost update) | `PASS` | `windows_lock.rs`, `windows_replace.rs`, `vault_crud_and_recovery.rs` (`Conflict` + recovery copy) |
| `AC-017` (Backup & restore with hashes) | `PASS` | `index_and_backup.rs` (`create_backup`, `restore_backup`, disabled grants, `export_vault`) |
| `NFR-004` (`F1000` search P95 `<300 ms`) | `PASS` | `bench_phase3.rs` (`26.35 ms` warmed P95 on 1,000 notes) |

---

## 14. Phase 4 Readiness

- All `PB-010`–`PB-014` core APIs, DTOs, and Tauri IPC commands are compiled, tested, and ready for Phase 4 (`PB-015`–`PB-018`) desktop shell, CodeMirror 6 editor, dashboard/search UI, and onboarding/backup/restore workflows.
- The `impeccable` skill and Phase 1 UI tokens (`docs/checkpoints/phase-01-review.md` §8) remain ready to guide Phase 4 UI design without touching core storage semantics.

---

## 15. Final Recommendation

**GO for Phase 4 (`PB-015`–`PB-018` — Desktop UI / 0.1)** — All Phase 3 acceptance gates, security regression tests, data integrity failpoints, and `NFR-004` performance targets passed with zero open critical/high defects.

### Owner Sign-Off

| Role | Decision (`Approve` \| `Approve with changes` \| `Reject`) | Date | Notes |
|---|---|---|---|
| Product owner | | | |
