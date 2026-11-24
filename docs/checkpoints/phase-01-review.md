# Phase 1 Architecture Review

| Field | Value |
|---|---|
| Phase | Phase 1 — Architecture Review (`PB-001`–`PB-005`) |
| Date | 2026-11-24 |
| Baseline | `PRD.md` v0.1.0, `SYSTEM_ARCHITECTURE.md` v0.1.0, `DATA_SCHEMA.md` v0.1.0, `MVP_TASKS.md` v0.1.0, `AGENTS.md` v0.1.0 |
| Status | `APPROVED` — Phase 2 authorized by owner |
| Scope | Documentation review only; no product code written |
| Naming note | Named `phase-01-review.md` per owner directive; `AGENTS.md` §8 convention `phase-XX.md` will be used from Phase 2 onward. |

---

## 1. Executive summary

The five specification documents (`PRD.md`, `SYSTEM_ARCHITECTURE.md`, `DATA_SCHEMA.md`, `MVP_TASKS.md`, `AGENTS.md`) provide a coherent, buildable architecture for a local-first Windows desktop application using Tauri 2, React/TypeScript, a shared Rust knowledge core (`brain-core`), SQLite + FTS5, Three.js, and a standalone stdio MCP server (`brain-mcp`).

No contradictions block Phase 2 foundation work (`PB-006`/`PB-007`). However, independent QA found 10 schema/contract defects (`SC-11`–`SC-20`) that must be corrected before the `PB-008` contract freeze (`B-5`). Overall, this review records:

- **20 consistency findings (`SC-01`–`SC-20`)**: 2 backlog sequencing adjustments (`SC-01`, `SC-02`), 8 schema/domain clarifications (`SC-03`–`SC-10`), and 10 schema/contract/security defects (`SC-11`–`SC-20`).
- **6 architecture refinements (`AR-01`–`AR-06`)**: Windows cross-process locking, NTFS safe file replacement, closed-desktop MCP reconciliation, cloud-placeholder reparse points, NTFS path-key folding, and WebView privilege boundaries.
- **Owner decisions `D-01`–`D-20` plus `SC-01`/`SC-02` resequencing**.
- **3 environment blockers (`B-1`–`B-3`)** for Phase 2 start (`PB-006`/`PB-007`) plus **`B-5`** before `PB-008` (and **`B-4`** before the `0.3` gate).

**Recommendation:** **CONDITIONAL GO** — Approve the Phase 1 decisions and authorize toolchain installation plus `git init` to start `PB-006`/`PB-007`; apply the `SC-11`–`SC-20` spec revision batch (`ADR-0005`/`ADR-0006`) before the `PB-008` contract freeze.

---

## 2. Environment readiness

Measured on 2026-11-24 in PowerShell (`C:\DaffaP\Project df\Personal Brain`).

| Component | Measured State | Status | Notes / Action Needed |
|---|---|---|---|
| **Operating System** | Windows 11 24H2, build `26100.1742` (`NTFS` on `C:`, `LongPathsEnabled=1`) | OK | Registry `ProductName` reports `"Windows 10 Pro"` (known registry quirk; build `26100` is Windows 11 24H2). |
| **Hardware (proposed baseline for D-09)** | Intel Core i7-13620H, `15.7` GB RAM, NVIDIA GeForce RTX 2050 (`4` GB VRAM) + Intel UHD Graphics, NVMe WD PC SN740 512 GB (`~85.6` GiB free on `C:`) | OK | Hybrid GPU: WebView2 may render on Intel UHD iGPU rather than RTX 2050, so measure both iGPU and dGPU behavior in `PB-009`/`PB-021`. |
| **Node.js & npm** | Node `v26.10.0`, npm `11.19.1` | OK | Even-numbered release line; confirm LTS alignment and package manager pinning in `PB-006`. |
| **Git & Repository** | `git version 2.55.0.windows.5` installed; workspace is **not a Git repository** | **BLOCKER (`B-3` / `PB-007`)** | Requires owner authorization to run `git init` and commit `.gitignore`/baseline. |
| **Rust Toolchain** | `rustc`, `cargo`, `rustup` not found on `PATH`, `%USERPROFILE%\.cargo`, or `%USERPROFILE%\.rustup` | **BLOCKER (`B-2` / `PB-006`)** | Requires owner-authorized install of `rustup` targeting `stable-x86_64-pc-windows-msvc`. |
| **MSVC Build Tools & Windows SDK** | `vswhere.exe` not found; no Visual Studio folders; `cl.exe`/`link.exe` not found; `Windows Kits\10` not found | **BLOCKER (`B-2` / `PB-006`)** | Requires owner-authorized install of Visual Studio C++ Build Tools (`Desktop development with C++` workload + Windows 10/11 SDK). |
| **WebView2 Runtime** | `157.0.4341.60` installed | OK | Pre-installed evergreen runtime verified via registry. |
| **Package Manager (`winget`)** | `winget.exe` available | OK | Proposed installation channel (owner-run or owner-authorized). |
| **MCP Clients** | `codex-cli 0.171.0` installed; `claude` and `gemini` not found on `PATH` | **LATER GATE (`B-4` / `PB-023`)** | Non-blocking for Phase 2. Owner must install/authorize a second client (Claude Code or Gemini CLI) before the `0.3` gate (`AC-022`). |

---

## 3. Technology compatibility

Frontend package versions were observed on 2026-11-24 via `npm view`; Rust crate versions cannot be resolved locally until `cargo` is installed in `PB-006`/`PB-008`.

| Layer | Observed / Candidate Versions | Compatibility Findings & Decisions |
|---|---|---|
| **Desktop Shell** | `@tauri-apps/cli` `2.12.6`, `@tauri-apps/api` `2.12.5` | Compatible with Windows 11 + WebView2 `157.0.4341.60`. Configure minimal window capabilities and strict CSP; no generic FS/shell plugins. |
| **Frontend UI** | `react` `19.3.1`, `vite` `8.3.8`, `vitest` `5.1.1` | Modern React/Vite stack; verify Vite 8 + Vitest 5 plugin compatibility during `PB-007`/`PB-009`. |
| **TypeScript** | `typescript` `7.0.2` (npm latest) | TypeScript 7 uses the native (Go) compiler. Compatibility with `typescript-eslint` and editor tooling is **UNVERIFIED**. Decide in `PB-008`: adopt TS 7 if the lint toolchain supports it, otherwise pin the latest supported 5.x/6.x release and record the choice. |
| **Typed IPC** | `ts-rs` (candidate) vs `tauri-specta` | Decide in `PB-008` and add a contract test. Recommend `ts-rs` (stable type generation) paired with runtime boundary validation in Rust. |
| **SQLite + FTS5** | `rusqlite` with `bundled` feature | FTS5 is expected to be compiled into `bundled`; `PB-008` must include an automated test that creates and queries an `fts5` virtual table. **Do not** use `tauri-plugin-sql`, which exposes direct DB access to the frontend and violates the core boundary. |
| **MCP SDK** | `rmcp` (web search reported `3.11.0`; **UNVERIFIED** locally without `cargo`) | Official `modelcontextprotocol/rust-sdk` candidate. Verify exact crate version, stdio transport, and schema ergonomics during `PB-006`/`PB-022`. |
| **YAML Frontmatter** | `yaml-rust2` or `saphyr` (candidates) | `serde_yaml` is archived/unmaintained—do not use it. Select a maintained safe YAML parser in `PB-011` with bounded input size, nesting depth, and alias expansion. Never re-serialize whole frontmatter; perform edits via targeted text spans. |
| **Markdown & Preview** | `pulldown-cmark` (core), `react-markdown` + `rehype-sanitize` (UI candidates) | Verify `pulldown-cmark` byte-offset iterator and wikilink extraction in `PB-011`. Preview must sanitize output and disallow raw HTML/scripts/remote images/unsafe schemes by default (`PB-016`, `SC-20`). |
| **Markdown Editor & CSP** | `@codemirror/view` `6.43.15` | CodeMirror 6 injects `<style>` elements at runtime. Verify Tauri CSP `style-src` handling in `PB-007`/`PB-016` without enabling `unsafe-eval` or inline `<script>` execution. |
| **3D Graph** | `three` `0.187.0`, `3d-force-graph` `1.80.2` (MIT) | Suitable for an initial vertical slice behind a strict DTO adapter (`PB-019`). Re-evaluate against custom `three` `InstancedMesh` + `d3-force-3d` worker in `PB-019`/`PB-021` if frame-time or visual-originality targets are missed. |
| **Credentials (Phase 7)** | `keyring` crate (candidate) | Targets Windows Credential Manager for optional AI provider API keys (`PB-026`). |
| **Installer (Phase 8)** | Tauri NSIS vs MSI | Prefer **NSIS** (per-user install, no admin elevation, avoids WiX + Windows VBScript optional-feature dependency); finalize in `PB-030`. Per `PRD.md` §5.9 / `NFR-012` / `PB-030`, the uninstaller must preserve user vaults. Preserving non-derivative `%LOCALAPPDATA%\PersonalBrain` state by default is proposed as **`D-17`** (recommended, since state holds non-derivative proposals and revisions). Unsigned installers trigger Windows SmartScreen and must be disclosed. |
| **App-data Path Resolution** | Windows Known Folder APIs | `brain-core` must resolve `%LOCALAPPDATA%\PersonalBrain` directly via OS Known Folder APIs (not Tauri's bundle-identifier app-data helper) so `brain-mcp.exe` and the desktop binary always share the exact same registry and state paths. |

---

## 4. Specification consistency findings

| ID | Finding | Affected Docs | Proposed Resolution | Gate / Impact |
|---|---|---|---|---|
| **SC-01** | **Backlog sequencing gap (state/registry migrations):** `PB-010` requires `registry.sqlite` and `state.sqlite` (note IDs, journal, blobs), but migrations for state/registry are currently listed in `PB-012a`. | `MVP_TASKS.md` §3–4 | Move `registry.sqlite` and `state.sqlite` migration 1 into `PB-010a`; keep `index.sqlite` + FTS5 migrations in `PB-012`. Requires owner approval (sequencing change only; no AC change). | Non-blocking for Phase 2 (needs approval before Phase 3) |
| **SC-02** | **Backlog sequencing gap (MCP grant UI):** `PB-022` (`AC-023`/`AC-024`) and `PB-023` (`AC-022`) require active grants and revocation testing, but grant UI controls are currently scheduled in `PB-025`. | `MVP_TASKS.md` §3–4 | Add a minimal **Settings → MCP Permissions** slice (create/enable/disable/revoke grant and folder scopes) to `PB-022`, owned by UI. Requires owner approval. | Non-blocking for Phase 2 (needs approval before Phase 6) |
| **SC-03** | **`withdrawn` proposal status has no actor or MCP tool:** `DATA_SCHEMA.md` §5.2/§7 includes `withdrawn`, whereas `SYSTEM_ARCHITECTURE.md` §8 exposes no MCP tool to withdraw proposals. | `DATA_SCHEMA.md` §5.2, §7; `SYSTEM_ARCHITECTURE.md` §8 | Make `withdrawn` a desktop-only user action in MVP (or keep terminal transitions desktop-driven); do not add a new MCP mutation tool. | Non-blocking |
| **SC-04** | **Verification enum mismatch:** `PRD.md` §5.7 lists `unverified`, `user_verified`, `outdated`, while `DATA_SCHEMA.md` §3/§5.2 adds `superseded` (consistent with `FR-026`). Additionally, `PRD.md` `FR-026` / §7.2 say `verified` whereas `DATA_SCHEMA.md` uses `user_verified`. | `PRD.md` `FR-026`, §5.7, §7.2; `DATA_SCHEMA.md` §3, §5.2 | Accept the `DATA_SCHEMA.md` 4-value enum (`unverified`, `user_verified`, `outdated`, `superseded`) as canonical in schema/core, and use `"Verified"` as the UI display label for `user_verified`. | Non-blocking |
| **SC-05** | **Missing explicit provenance `origin` field:** Project requirements distinguish imported notes, user-created notes, and AI-proposed knowledge, but `state.sqlite` only records `verification` in `note_status` and would otherwise have to infer origin from `revisions`. | `DATA_SCHEMA.md` §5.2; `PRD.md` §9.3 | **Proposed `D-15`:** Add `note_status.origin` (`'imported'`, `'user_created'`, `'ai_proposal'`) to `state.sqlite` migration 1, populated and updated by `brain-core` only. | Non-blocking |
| **SC-06** | **"Project" & folder ID undefined:** `SYSTEM_ARCHITECTURE.md` §8 references a `'project folder ID'`, but folders have no ID in `DATA_SCHEMA.md`. Home `'active projects'` and clustering rules are also undefined. | `PRD.md` §7.1; `SYSTEM_ARCHITECTURE.md` §8; `DATA_SCHEMA.md` §3 | **Proposed `D-16`:** Project = vault-relative folder; default graph cluster = top-level folder; folders containing a note with `personal_brain.type: project` surface as active projects on Home. Use vault-relative folder path, not an ID (cross-ref `SC-17`). | Non-blocking |
| **SC-07** | **`note_links` FK vs `resolution` consistency:** `target_note_id REFERENCES notes(note_id) ON DELETE SET NULL` can leave `resolution = 'resolved'` alongside `target_note_id IS NULL` if a target note is deleted without updating links. | `DATA_SCHEMA.md` §5.3 | Enforce in `brain-core` that deleting/moving a target recomputes affected `note_links.resolution` within the same index transaction (matching prose in §5.3) and add a dedicated integration test in `PB-012`. | Non-blocking |
| **SC-08** | **Duplicate body storage in `index.sqlite`:** `notes.body` and `note_fts` both store full note text, doubling derived index disk usage. | `DATA_SCHEMA.md` §5.3 | Keep the simple schema initially; optionally evaluate external-content FTS5 (`content='notes'`) in `PB-012` if index size/write latency warrants it. | Non-blocking |
| **SC-09** | **Error codes for unsupported location / path length:** `SYSTEM_ARCHITECTURE.md` §4.2 omits dedicated codes for unsupported vault locations (e.g., cloud-sync/network drives) or path-length limits. | `SYSTEM_ARCHITECTURE.md` §4.2 | Map path-length failures to `INVALID_INPUT` with actionable `safe_details`, and map unsupported locations to `INVALID_INPUT` / `VAULT_UNAVAILABLE` (or add `UNSUPPORTED_LOCATION` via ADR if distinct UI handling needs it). | Non-blocking |
| **SC-10** | **UI language unspecified:** `PRD.md` is written in Indonesian, while `SYSTEM_ARCHITECTURE.md`, `DATA_SCHEMA.md`, `MVP_TASKS.md`, and `AGENTS.md` are in English. | `PRD.md`; `MVP_TASKS.md` | **Proposed `D-14`:** Ship MVP UI in **English** with centralized UI string constants (i18n-ready structure without adding a runtime i18n framework in MVP). | Non-blocking |
| **SC-11** | **Retention vs SQLite FK deadlock:** `DATA_SCHEMA.md` §8 requires 30-day purge for superseded revisions and 90-day purge for audit metadata and completed proposals, but `revisions.operation_id`, `mutation_journal.proposal_id`, and `audit_events` FKs have no `ON DELETE` clauses—blocking retention deletion and deleted-note `note_identity` purge. | `DATA_SCHEMA.md` §5.2, §8; `PRD.md` §9.4 | History rows are kept as metadata tombstones. Purge deletes blob content and marks it `content_purged_at`; blob-referencing columns become nullable or reference a purged marker. Define exact purge dependency order in `ADR-0005`. | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-12** | **`memory_proposals` DDL breaks `create` conflicts, edited approvals, and untouched/stale `base_hash`:** `base_hash REFERENCES blobs(hash)` fails if an untouched/externally-edited note is not yet in `blobs`; `action='create' CHECK` forbids `target_note_id` and `base_hash` on destination-occupied rebase or post-approval tracking; `proposal_versions` lacks `approved_hash`, `action`, and `new_rel_path`. | `DATA_SCHEMA.md` §5.2, §7 | At proposal submission, `brain-core` snapshots live file bytes into `blobs` when `base_hash` matches (mismatch returns `CONFLICT` and inserts no row). For `create`, destination-occupied transitions to `conflict`, resolved by changing `new_rel_path` (new version) or rejecting. Add `result_note_id` for post-approval tracking, add `action`/`new_rel_path` to `proposal_versions`, and record desktop-edited bodies as a new `proposal_version` before approval. | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-13** | **`mutation_journal.note_id` FK vs `create` identity reservation:** `mutation_journal.note_id` references `note_identity(note_id)`, but `note_identity.state` only permits `'present'`, `'missing'`, `'trashed'`—so reserving before create risks a phantom `'present'` row blocking `note_path_present`, while inserting after breaks the `prepared` FK. | `DATA_SCHEMA.md` §5.2 (lines 115–125, 199, 238) | Add `'reserved'` to `note_identity.state` and extend the partial unique index `note_path_present` to cover `WHERE state IN ('present','reserved')`. Startup journal recovery resolves or removes orphaned `'reserved'` rows. | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-14** | **Windows file-sharing violation on `index.sqlite` swap:** `DATA_SCHEMA.md` §5.3 requires temp-and-swap for `index.sqlite` rebuilds while `SYSTEM_ARCHITECTURE.md` §7.1 allows concurrent desktop + `brain-mcp` SQLite readers, which causes NTFS sharing violations on `ReplaceFileW`/`MoveFileExW`. | `DATA_SCHEMA.md` §5.3; `SYSTEM_ARCHITECTURE.md` §7.1 | Use generation-named index files (`index-<gen>.sqlite`) with an active-generation pointer in `state.sqlite`/`vault_meta`. Readers reopen on generation change, and old index files are deleted with retry once unlocked. Prototype in `PB-009`/`PB-012`. | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-15** | **Backlog priority contradictions for `0.1` P0 requirements:** `PRD.md` §4.1 marks `FR-001` and `FR-005` as `P0` for `0.1`, whereas `MVP_TASKS.md` §3 marks `PB-017` (`P1`), `PB-018` (`P0/P1`), and makes `PB-029` unconditionally depend on `PB-028` (`P2/P1`). | `PRD.md` §4.1; `MVP_TASKS.md` §2, §3 | **Proposed `D-18`:** Promote search/filter/backlink parts of `PB-017` to `P0` (`FR-005`), promote create/open/backup/rebuild in `PB-018` to `P0` (keep settings polish `P1`), and change `PB-029` dependency to "`PB-028` P1 portion done; P2 portion done or approved defer". | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-16** | **Missing core use-case contracts & UI flows:** `SYSTEM_ARCHITECTURE.md` §4.1 omits `create_vault`, `export_vault` (also missing from `MVP_TASKS.md` §3 tasks), `restore_trashed_note`, desktop-only grant CRUD, `set_note_verification`, `set_pinned`, composite `vault_id` on note/proposal/revision calls, and `edited_body`/`verification` on `review_proposal`; `PB-016` omits note trash/delete UI. | `SYSTEM_ARCHITECTURE.md` §4.1; `PRD.md` `FR-001`/`003`/`016`/`023`/`026`; `DATA_SCHEMA.md` §2, §6; `MVP_TASKS.md` §3 | Add `create_vault`, `export_vault` (implemented in `PB-018`, verified in `PB-030`), `restore_trashed_note`, desktop-only grant CRUD, `set_note_verification`, `set_pinned`, `vault_id` on all note/proposal/revision calls, and `edited_body` + `verification` on `review_proposal`; add trash/delete UI to `PB-016`. | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-17** | **MCP scope, path & existence-oracle gaps:** `get_project_context` accepts a nonexistent `project folder ID`; `propose_memory(create)` lacks explicit checks for `grant_scopes`, `.md` extension, and excluded folders; `propose_memory` `sources` lacks cross-scope oracle suppression; `list_pending_changes` lacks filtering after scope narrowing. | `SYSTEM_ARCHITECTURE.md` §8; `DATA_SCHEMA.md` §5.1 | Use vault-relative folder path for `get_project_context`. Require `propose_memory(create)` `new_rel_path` to fall inside `grant_scopes`, end in `.md`, and avoid `.obsidian`/`.git`/app artifacts. Reject out-of-scope source/target `note_id`s with an error indistinguishable from `NOTE_NOT_FOUND`, and filter `list_pending_changes` by active scope. | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-18** | **Backup/restore `vault_id` collision, `registry.sqlite` merge, unsafe destination, & unrecovered journal:** Restoring alongside an active vault collides on `vault_id` and lacks a `registry.sqlite` merge rule; backup destination checks omit `%LOCALAPPDATA%\PersonalBrain` and vault ancestors; `create_backup` lacks a guard against `prepared`/`recovery_required` journal rows. | `SYSTEM_ARCHITECTURE.md` §2, §7.3; `DATA_SCHEMA.md` §5.1, §8 | Restore-alongside assigns a new `vault_id` (recording old→new mapping) and merges a new `registry.sqlite` entry with grants disabled. Reject backup destinations inside the vault, inside app-data, or as an ancestor of the vault. Refuse `create_backup` while `prepared`/`recovery_required` journal rows exist (run recovery first). | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-19** | **AI frontmatter spoofing & `supersedes` vs `superseded_by` mismatch:** `propose_memory`/`review_proposal` do not block AI-proposed `personal_brain.verification: user_verified` or colliding `personal_brain_id`; frontmatter `supersedes: []` vs `note_status.superseded_by` reconciliation is undefined. | `DATA_SCHEMA.md` §3, §5.2; `PRD.md` §9.2–9.3 | Reject (`INVALID_INPUT`) proposals whose `proposed_text` sets `personal_brain_id`, `personal_brain.verification`, or `verified_at` (IDs and verification are core-assigned). Treat frontmatter `supersedes` as user-declared content and `note_status.superseded_by` as user-confirmed state—display side by side without auto-syncing. | **Blocks `PB-008` freeze (`B-5`)** |
| **SC-20** | **Markdown preview UNC/`file://`/`assetProtocol` leak & undefined attachment trash:** Preview sanitization omits explicit blocks on UNC (`\\host\share`), `file://`, and drive-absolute links or scoped attachment serving; `note_identity`/`trash_note` cover `.md` only, leaving attachment deletion/trash undefined. | `SYSTEM_ARCHITECTURE.md` §10; `PRD.md` §5.1–5.2; `DATA_SCHEMA.md` §8 | Block `file://`, UNC (`\\`), and drive-absolute links in preview; serve local attachments only through a core-served scoped protocol that validates vault-relative paths (no broad Tauri `assetProtocol` scope). **Proposed `D-19`:** MVP lists and opens attachments but does not delete or move them (trash covers notes only); attachment lifecycle is deferred. | **Blocks `PB-008` freeze (`B-5`)** |

---

## 5. Architecture review

The process topology—a Tauri desktop binary plus a standalone stdio `brain-mcp` binary sharing `brain-core`, with no background daemon and no TCP listener—is minimal, auditable, and satisfies `D-12`. Six technical refinements are required before or during `PB-009`/`PB-010`:

- **AR-01 — Cross-process vault lock:** A `Local\` named OS mutex is scoped to a single Windows logon session; agents invoked from another session or SSH would not share it. **Recommendation (`ADR-0001`):** Use Windows `LockFileEx` on `%LOCALAPPDATA%\PersonalBrain\vaults\<vault_id>\vault.lock` combined with a journal dirty/prepared marker for crash/abandonment detection. Prototype and stress-test in `PB-009`.
- **AR-02 — NTFS safe file replacement:** Prototype `ReplaceFileW`, `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)`, and `SetFileInformationByHandle` (`FileRenameInfoEx` with POSIX replace semantics) in `PB-009` (`ADR-0002`). Because NTFS file IDs can change across replacement operations, treat `note_identity.file_identity` as a non-authoritative hint refreshed on every app commit.
- **AR-03 — MCP retrieval while desktop is closed:** Rather than running a background filesystem watcher inside `brain-mcp`, perform a bounded, rate-limited stat-based reconcile (checking size, mtime, and SHA-256 on change) under the vault lock before retrieval. If the vault lock is held, return results tagged with the as-of `index_generation` or `BUSY` per policy.
- **AR-04 — Reparse points vs cloud placeholders:** Windows reparse points include both traversal hazards (symlinks, junctions, mount points—must deny) and OneDrive Files On-Demand cloud placeholders. **Proposed `D-13`:** Warn and mark cloud-sync/network vault roots as unsupported locations; skip unhydrated cloud placeholder files with a clear diagnostic rather than triggering silent network hydration.
- **AR-05 — NTFS path key normalization:** Rust `str::to_uppercase()` does not match NTFS `$UpCase` case-folding rules for all Unicode code points. Compute `path_key` using simple uppercase folding as a lookup key, always verify actual destination identity/collision through opened OS handles, and treat Windows per-directory case-sensitive directories as unsupported (surface diagnostic).
- **AR-06 — WebView privilege boundary:** Because the desktop WebView invokes privileged Tauri commands (`review_proposal`, `restore_revision`), a renderer XSS compromise would reach approval workflows. Mitigate via strict CSP (`script-src 'self'`), sanitized Markdown rendering, zero remote content in privileged windows, minimal Tauri capabilities, and mandatory `proposal_version` + `expected_hash` checks in core. Record as an accepted residual risk.

---

## 6. Data integrity assessment

The four-tier storage boundary in `DATA_SCHEMA.md` §1 (`Vault Markdown` authoritative for note bytes; `registry.sqlite` for roots/grants/settings; `state.sqlite` + content-addressed blobs for IDs, proposals, journal, revisions, and audit; `index.sqlite` strictly derived and rebuildable) is sound once the `SC-11`–`SC-14` and `SC-18` schema/recovery corrections are applied.

- **Single-note durability:** The `mutation_journal` (`prepared` → `committed` | `aborted` | `recovery_required`) with persisted preimage/postimage blobs and `request_id` + `input_hash` idempotency protects against partial writes and duplicate replays. Because filesystem replacement and SQLite commits cannot share a single atomic transaction, startup recovery must inspect actual disk hashes and finalize at most once.
- **Required Vault gate proofs (`PB-010`–`PB-013`):**
  1. Golden byte-for-byte invariance on vault open and unrelated note edits (`AC-002`, `AC-009`).
  2. Crash/failpoint injection at every journal state transition (`prepared`, post-temp-write, post-replace, post-state-commit).
  3. Complete `index.sqlite` deletion and rebuild equivalence (`AC-014`).
  4. Independent corruption tests for `index.sqlite` (auto-rebuild) vs `state.sqlite` (fail closed into `RECOVERY_REQUIRED` / read-only mode, never silent blank DB).
  5. Competing external editor race test on real NTFS (`AC-016`) preserving attempted edits as recovery copies.
  6. Backup and restore verification of vault files, `state.sqlite`, referenced blobs, and manifest checksums (`AC-017`).
- **Retention policy (`D-05`):** Defaults (30 days trash/superseded revisions, 90 days audit metadata and completed proposals, keep last 7 successful backups plus pinned copies, explicit user-triggered purge with preview) require owner sign-off alongside `SC-11`'s tombstone/blob-purge model.

---

## 7. Security & privacy assessment (preliminary threat model)

> **Trust boundary disclosure:** `brain-mcp` permissions restrict the application's MCP interface only. Because external coding agents run under the same Windows OS user account, MCP grants are **not** an OS sandbox against a process that accesses the filesystem or `%LOCALAPPDATA%` directly.

| Threat | Control | Verifying Task |
|---|---|---|
| Path traversal, symlink/junction/mount-point escape, ADS (`:`), reserved names, hardlink mutation | Canonical root handle validation, reparse-point inspection, relative-path syntax rejection, hardlink refusal on write/MCP read | `PB-010`, `PB-022` |
| UNC (`\\host\share`) / `file://` NTLM credential leak & arbitrary local file read via Markdown preview | Block `file://`, UNC, and drive-absolute links in preview; serve local attachments only via a core-served scoped protocol validating vault-relative paths (no broad `assetProtocol`) | `PB-016`, `SC-20` |
| Prompt injection embedded in notes or proposals | Treat note text as untrusted data; escape/sanitize UI output; separate tool data from instructions; zero MCP approval/write-direct/shell/SQL tools | `PB-022`, `PB-024`, `PB-025` |
| AI frontmatter spoofing (`personal_brain.verification: user_verified` / colliding `personal_brain_id`) | Reject (`INVALID_INPUT`) proposals setting `personal_brain_id`, `personal_brain.verification`, or `verified_at`; core assigns IDs and verification state | `PB-024`, `SC-19` |
| Fake actor, grant ID reuse, or cross-scope existence probing | Bind grant ID at MCP launch; revalidate grant/scopes on call and pre-return; return `NOTE_NOT_FOUND`-indistinguishable errors for out-of-scope source/target `note_id`s; disclose same-user OS limitation | `PB-022`, `SC-17` |
| Stale proposal overwriting newer user edits | Mandatory `base_hash` + `proposal_version` + live disk hash check inside vault lock; transition to `conflict` rather than overwrite | `PB-024` |
| Malicious Markdown / XSS leading to privileged Tauri IPC | Strict CSP (`script-src 'self'`), sanitized Markdown renderer, no raw HTML/iframes/scripts, external URL scheme validation | `PB-016` |
| YAML bombs / billion-laughs / oversized files | Bounded file-size, YAML nesting, and alias-expansion limits in parser | `PB-011` |
| FTS5 query syntax injection / unauthorized hit leakage | Compile user queries into literal parameterized tokens; filter authorized vault/folder scopes before ranking or snippet extraction | `PB-014`, `PB-022` |
| Secret leakage in logs, notes, or repo | OS credential store (`keyring`) for API keys; structured log redaction; exclude credentials from backups | `PB-013`, `PB-026` |
| Unconsented vault transfer to external AI providers | Explicit per-provider/vault/scope consent, context preview before send, offline isolation when disabled | `PB-026` |
| Restored backup re-enabling old AI access or leaking keys | Disable all `agent_grants` on restore pending explicit re-authorization; exclude credentials from backup archive | `PB-013` |
| DoS via oversized MCP payloads or runaway requests | Hard byte/hit/char limits (`8 KiB` excerpt, `32 KiB` context, `64 KiB` proposal, max `50` hits), UTF-8 & schema validation, bounded retries | `PB-022` |

---

## 8. UI/UX implementation strategy

- **Visual identity:** Original, calm, high-density desktop knowledge tool inspired conceptually by Obsidian and Astrocortex without cloning layouts, assets, or visual gimmicks. Avoid generic dashboard card grids, decorative gradients/glows, oversized headings, inconsistent radii, and gratuitous motion.
- **Navigation & shell:** Left activity rail (`Home`, `Knowledge`, `Universe`, `AI Brain`, `Memory`, `Settings`), collapsible sidebar (vault/folder tree, tags, search), primary workspace/editor, and collapsible context inspector (backlinks, metadata, source provenance). Include a command palette (`Ctrl+K`) and full keyboard navigation across all core workflows (`AC-013`).
- **Design tokens:** System offline typography (`Segoe UI Variable` for UI; `Cascadia Mono` → `Consolas` for Markdown/code), `4 px` spacing grid, restrained `4–6 px` border radii, neutral graphite/stone surfaces with a single primary accent, explicit semantic status tokens (`user_verified` displayed as `"Verified"`, `suggested`, `unverified`, `outdated`, `superseded`, `conflict`, `broken link`), light and dark themes, `prefers-reduced-motion` support, WCAG AA contrast, and Windows DPI scaling awareness.
  - *Note:* Specific fonts, spacing scale, border radii, and `Ctrl+K` are proposed design-system choices to be confirmed in `PB-015`, not frozen decisions.
- **3D Universe:** Dark high-contrast canvas, restrained point sprites, distance-based label LOD, folder-based cluster hulls, right-hand detail panel with **Open Note**, simulation pause when idle or hidden, and a keyboard-accessible list/2D fallback (`FR-013`).
- **Honest states:** Unimplemented views/actions during Phase 4 (`AI Brain`, `Memory` count, `Universe`) must be visibly disabled with clear status rather than populated with fake metrics or placeholder data. Apply the installed `impeccable` skill during `PB-015`, `PB-016`, and `PB-019`.

---

## 9. Implementation dependencies & parallelization

```text
PB-006 (Toolchain) ─▶ PB-007 (Tauri Shell) ─▶ PB-008 (Workspace/DTOs, gated by B-5) ─▶ PB-009 (CI + I/O Prototypes)
                                                                                              │
                                                                                              ▼
                                                                                    PB-010..PB-014 (Vault Engine)
```

- **Critical path:** `PB-006` → `PB-007` → `PB-008` (gated by `B-5`) → `PB-009` → `PB-010`–`PB-014`. The `PB-009` prototypes (`LockFileEx` coordination, NTFS safe replace, two-process contention, external-edit detection, generation-named index files) directly gate `PB-010`.
- **Safe parallel lanes (after interface freezes):**
  - `PB-009+`: QA fixture generators (`F0`, `F100`, `F1000`, `FPATH`, `FCONFLICT`, `FRECOVERY`, `FMCP`, `FRET`) in parallel with `CORE`.
  - After `PB-015` IPC DTO freeze: `PB-016` (Editor) ∥ `PB-017` (Dashboard/Search UI).
  - After `PB-014` `GraphSnapshot` DTO freeze: `GRAPH` prototyping against `F1000` fixture DTOs.
- **Single-owner files:** `Cargo.toml`/`Cargo.lock`, `package.json`/`package-lock.json`, SQLite migration files, and shared IPC DTO definitions have one owner per batch.

---

## 10. Open decisions for owner

| ID | Topic | Proposed Resolution | Owner Action |
|---|---|---|---|
| **D-01 – D-12** | Architecture decisions (`PRD` §15 / `SYSTEM_ARCHITECTURE.md` §12) | Accept all 12 proposed resolutions in `SYSTEM_ARCHITECTURE.md` §12 as written, except that `D-09` is refined below. | Approve / Modify |
| **D-05** | Data retention & purge defaults (`DATA_SCHEMA.md` §8, `SC-11`) | Trash & superseded revisions `30` days; audit & completed proposals `90` days; last `7` successful backups + pinned; manual purge with preview in MVP (tombstone metadata + purged blob content per `SC-11`). | Approve / Modify |
| **D-09** | Baseline hardware & performance thresholds (`SYSTEM_ARCHITECTURE.md` §11–12) | Proposed baseline device = this laptop (i7-13620H, 15.7 GB RAM, RTX 2050 + Intel UHD, NVMe). Thresholds per `SYSTEM_ARCHITECTURE.md` §11 (warmed keyword search P95 `<300 ms` on `F1000`; graph 1,000 nodes / 2,500 edges median `≥30 FPS`, P95 interaction `≤150 ms`, no stall `>500 ms` after warm-up), confirmed in `PB-009` per `SYSTEM_ARCHITECTURE.md` §12. | Approve / Modify |
| **D-13** *(new)* | Cloud-sync / OneDrive placeholder handling (`AR-04`) | Warn on sync-folder vault roots as unsupported; skip unhydrated cloud placeholders with diagnostic rather than hydrating silently. | Approve / Modify |
| **D-14** *(new)* | UI language (`SC-10`) | English UI for MVP with centralized string constants (i18n-ready, no framework in MVP). | Approve / Modify |
| **D-15** *(new)* | Explicit note provenance (`SC-05`) | Add `note_status.origin` (`'imported'`, `'user_created'`, `'ai_proposal'`) to `state.sqlite` migration 1, managed by `brain-core` only. | Approve / Modify |
| **D-16** *(new)* | Project & cluster definition (`SC-06`) | Project = vault-relative folder; default graph cluster = top-level folder; folders containing a note with `personal_brain.type: project` surface as active projects on Home (using relative folder path, not an ID). | Approve / Modify |
| **D-17** *(new)* | Uninstaller app-data preservation (§3) | Uninstaller preserves both user vaults and `%LOCALAPPDATA%\PersonalBrain` non-derivative state by default (recommended to avoid losing proposals/revisions). | Approve / Modify |
| **D-18** *(new)* | Backlog priority alignment (`SC-15`) | Promote search/filter/backlink parts of `PB-017` and create/open/backup/rebuild in `PB-018` to `P0`; keep settings polish `P1`; gate `PB-029` on `PB-028` P1 done + P2 done or approved defer. | Approve / Modify |
| **D-19** *(new)* | Attachment lifecycle deferral (`SC-20`) | MVP lists and opens attachments via core-scoped protocol, but does not delete or move them (trash covers notes only); attachment lifecycle deferred post-MVP. | Approve / Modify |
| **D-20** *(new)* | Spec revision batch (`SC-11`–`SC-20`) | Approve applying `SC-11`–`SC-20` corrections to `DATA_SCHEMA.md`, `SYSTEM_ARCHITECTURE.md`, and `MVP_TASKS.md` via `ADR-0005` and `ADR-0006` before the `PB-008` freeze (`B-5`). | Approve / Modify |
| **SC-01 / SC-02** | Backlog resequencing | Move `registry.sqlite`/`state.sqlite` migration 1 to `PB-010a`; add minimal Settings → MCP Permissions slice to `PB-022`. | Approve / Modify |

**Proposed ADRs (to be authored after owner approval):**
- `ADR-0001`: File-based cross-process vault locking (`LockFileEx` + journal dirty marker).
- `ADR-0002`: NTFS safe file replacement primitive (finalized after `PB-009` prototype benchmarks).
- `ADR-0003`: Explicit `note_status.origin` provenance column.
- `ADR-0004`: `MVP_TASKS.md` Phase 3/Phase 6 sequencing adjustments (`SC-01`, `SC-02`).
- `ADR-0005`: `DATA_SCHEMA.md` pre-`PB-008` corrections (`SC-11`–`SC-14`: retention tombstones, `memory_proposals` DDL, `'reserved'` note state, generation-named `index-<gen>.sqlite`).
- `ADR-0006`: `SYSTEM_ARCHITECTURE.md` / `MVP_TASKS.md` pre-`PB-008` contract and backlog corrections (`SC-15`–`SC-20`).

---

## 11. Blocking vs non-blocking issues

| ID | Issue | Impact | Resolution / Owner Action |
|---|---|---|---|
| **B-1** | Phase 1 owner sign-off (`PB-001`–`PB-005`) | **Blocks Phase 2 start** | Review and approve decisions in §10. |
| **B-2** | Rust (`rustup`/`cargo`/`rustc`), MSVC C++ Build Tools, and Windows SDK not installed | **Blocks `PB-006` / Phase 2** | Authorize installation (`Desktop development with C++` + Windows SDK + `rustup` MSVC stable). |
| **B-3** | Workspace directory is not a Git repository | **Blocks `PB-007`** | Authorize `git init` and baseline `.gitignore` commit. |
| **B-4** | Second MCP client (Claude Code or Gemini CLI) not installed | **Blocks `0.3` gate (`PB-023` / `AC-022`)** | Non-blocking for Phase 2; install/authorize a second client before Phase 6. |
| **B-5** | Spec revision batch (`SC-11`–`SC-20`) not yet applied | **Blocks `PB-008` contract freeze** (non-blocking for `PB-006`/`PB-007`) | Owner approves `D-20`; apply via `ADR-0005`/`ADR-0006` to `DATA_SCHEMA.md`, `SYSTEM_ARCHITECTURE.md`, and `MVP_TASKS.md` before `PB-008`. |

Specification items `SC-01`–`SC-10` and architectural refinements `AR-01`–`AR-06` are non-blocking once the owner records decisions on §10.

---

## 12. Phase 2 readiness checklist

- [ ] Owner approves Phase 1 scope and decisions (`D-01`–`D-20`, `SC-01`/`SC-02`).
- [ ] Spec revision batch (`SC-11`–`SC-20`) approved for application before `PB-008` (`B-5`).
- [ ] Owner authorizes system toolchain install (Visual Studio C++ Build Tools `Desktop development with C++` + Windows 10/11 SDK, and `rustup` `stable-x86_64-pc-windows-msvc`).
- [ ] Owner authorizes `git init` and `.gitignore` setup in `C:\DaffaP\Project df\Personal Brain`.
- [ ] Baseline hardware and `F1000` search/graph thresholds (`D-09`) approved.
- [ ] TypeScript version (`7.0.2` vs `5.x/6.x` lint compatibility) and IPC binding choice (`ts-rs` vs `tauri-specta`) scheduled for decision in `PB-008`.
- [ ] `PB-009` native Windows prototype plan (`LockFileEx`, NTFS safe replace, two-process contention, external-edit race, generation-named index swap) acknowledged.

---

## 13. Recommendation

**CONDITIONAL GO** — Proceed to Phase 2 (`PB-006`/`PB-007`) **only after** blockers `B-1`–`B-3` are satisfied:

1. **B-1:** Owner sign-off on Phase 1 decisions (§10).
2. **B-2:** Authorization to install MSVC C++ Build Tools, Windows SDK, and `rustup` (`stable-x86_64-pc-windows-msvc`).
3. **B-3:** Authorization to initialize Git (`git init`) in the project workspace.

`PB-008` (workspace DTO/contract freeze) additionally requires **`B-5`**: applying the approved `SC-11`–`SC-20` spec revision batch (`ADR-0005`/`ADR-0006`). No Phase 2 implementation, software installation, `git init`, or code scaffolding has been performed.

---

## 14. Requirement traceability verification (PB-002)

Verified by inspection of `docs/MVP_TASKS.md` §5 (lines 106–153) on 2026-11-24:

- All **26 Functional Requirements** (`FR-001`–`FR-026`) are mapped to implementation tasks and acceptance evidence.
- All **15 Non-Functional Requirements** (`NFR-001`–`NFR-015`) are mapped to implementation tasks and verification evidence.
- All **37 Acceptance Criteria** (`AC-001`–`AC-037`) appear at least once in the `FR` acceptance evidence column.

---

## 15. Independent review

A read-only `research` subagent (`Independent Spec QA Reviewer`, conversation `b385f038-122c-4b73-a301-4c66609ab6d1`) cross-checked the initial Phase 1 checkpoint against all five specification documents. Eight accuracy/completeness corrections were integrated across §§1, 3, 4, 8, 10, 12, 14–18, and ten missed schema/contract/security gaps were verified against the specs and added as `SC-11`–`SC-20`. A separate security review of the `SC-11`–`SC-20` spec revision batch will run when `ADR-0005`/`ADR-0006` are applied prior to `PB-008`.

---

## 16. Rollback

Documentation-only phase. Revert by deleting `docs/checkpoints/phase-01-review.md` and restoring `PB-001`–`PB-005` from `IN_REVIEW` back to `TODO` in `docs/MVP_TASKS.md` §7. No product code, vault data, or system configuration was modified.

---

## 17. Owner sign-off

| Role | Decision (`Approve` \| `Approve with changes` \| `Reject`) | Date | Notes |
|---|---|---|---|
| Product owner | Approve | 2026-11-24 | User authorized Phase 2 execution per approved Phase 1 review |

---

## 18. Evidence

Commands executed directly in PowerShell (`C:\DaffaP\Project df\Personal Brain`) on 2026-11-24:

- `git status --short; git branch --show-current; git log --oneline -5` → `git` exited non-zero (`fatal: not a git repository (or any of the parent directories): .git`); the chained wrapper pipeline reported `0`, so the `git` exit code itself was not captured (expected `128`; confirms `B-3`).
- `node -v; npm -v; git --version` → `v26.10.0`, `11.19.1`, `git version 2.55.0.windows.5`.
- `rustc -V; cargo -V; rustup show` → `CommandNotFoundException` for all three; `Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe"` → `False`; `Test-Path "$env:USERPROFILE\.rustup"` → `False`.
- `& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" ...` → `CommandNotFoundException`; `Get-ChildItem 'C:\Program Files\Microsoft Visual Studio','C:\Program Files (x86)\Microsoft Visual Studio'` → empty; `Get-Command cl.exe,link.exe,winget` → only `winget.exe` (`C:\Users\daffa\AppData\Local\Microsoft\WindowsApps\winget.exe`); `Test-Path 'C:\Program Files (x86)\Windows Kits\10'` → `False`.
- `(Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}').pv` → `157.0.4341.60`.
- OS / hardware queries (`Win32_Processor`, `Win32_ComputerSystem`, `Win32_VideoController`, `Get-Volume -DriveLetter C`, `Win32_DiskDrive`, `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion`, `Control\FileSystem\LongPathsEnabled`) → Windows 11 24H2 (`26100.1742`), `LongPathsEnabled=1`, i7-13620H, `15.7` GB RAM, NVIDIA GeForce RTX 2050 (`4293918720` bytes) + Intel(R) UHD Graphics, WD PC SN740 512 GB (`91963801600` / `511304527872` bytes free).
- `npm view <pkg> version` → `@tauri-apps/cli 2.12.6`, `@tauri-apps/api 2.12.5`, `react 19.3.1`, `typescript 7.0.2`, `vite 8.3.8`, `three 0.187.0`, `3d-force-graph 1.80.2`, `@codemirror/view 6.43.15`, `vitest 5.1.1`.
- `Get-Command codex,claude,gemini,obsidian`; `codex --version` → `codex-cli 0.171.0` (`C:\Users\daffa\AppData\Roaming\npm\codex.ps1`); `claude`, `gemini`, `obsidian` not found.
- Web lookup (`rmcp` crates.io / GitHub) → reported `3.11.0` as of November 2026 (marked `UNVERIFIED` until `cargo` is available locally).
- Independent cross-check by `research` subagent (`b385f038-122c-4b73-a301-4c66609ab6d1`); findings verified by orchestrator.
