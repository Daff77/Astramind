# Phase 2 Checkpoint — Windows Foundation

| Field | Value |
|---|---|
| Phase | Phase 2 — Project Foundation (`PB-006`–`PB-009`) |
| Date | 2026-11-24 |
| Baseline | Approved Phase 1 (`a48dace`), `ADR-0001`–`ADR-0006` & `B-5` spec revisions (`49078a7`) |
| Status | `IN_REVIEW` — awaiting owner sign-off at Phase 2 quality gate |

---

## 1. Completed Task IDs

| Task ID | Status | Scope Delivered |
|---|---|---|
| `PB-006` | `DONE` | Verified Windows 11 toolchain (`rustc 1.100.0`, `cargo 1.100.0`, `stable-x86_64-pc-windows-msvc`, VS 2022 Build Tools `14.44.35207` `cl.exe`/`link.exe`, Windows SDK `10.0.26100.0`, WebView2 `157.0.4341.60`, Node `v26.10.0`, npm `11.19.1`, Git `2.55.0.windows.5`) and ran a native Rust/MSVC/kernel32 smoke compile & execution. |
| `PB-007` | `DONE` | Initialized Tauri 2 (`tauri 2.12.7`, `@tauri-apps/cli 2.12.6`, `@tauri-apps/api 2.12.5`) + React `19.3.1` + TypeScript `~5.8.3` + Vite `8.3.8` desktop foundation under `apps/desktop` with least-privilege `core:default` capability, strict CSP, and generated RGBA/ICO icons. |
| `PB-008` | `DONE` | Established Cargo + npm workspace (`Cargo.toml`, `package.json`, `Cargo.lock`, `package-lock.json`), `crates/brain-core` (`domain`, `paths`, `vault`, `index`, plus Phase 3–7 boundaries) with zero `tauri`/`rmcp` dependencies, standalone `crates/brain-mcp` binary, typed IPC contracts (`ErrorEnvelope` + `AppHealthDto`), and real `app_health` UI wired to `brain-core`. |
| `PB-009` | `DONE` | Implemented `scripts/verify-all.ps1`, `scripts/generate-fixtures.mjs` (`F0`, `F100`, `F1000`), `README.md`, and 4 native Windows prototype integration suites (`windows_lock.rs`, `windows_paths.rs`, `windows_replace.rs`, `windows_index_gen.rs`), and authored `docs/adr/ADR-0002-ntfs-safe-replace.md`. |

---

## 2. Files Created and Modified

- **Workspace & CI:** [Cargo.toml](file:///c:/DaffaP/Project%20df/Personal%20Brain/Cargo.toml), `Cargo.lock`, [package.json](file:///c:/DaffaP/Project%20df/Personal%20Brain/package.json), `package-lock.json`, [.gitignore](file:///c:/DaffaP/Project%20df/Personal%20Brain/.gitignore), [README.md](file:///c:/DaffaP/Project%20df/Personal%20Brain/README.md), [verify-all.ps1](file:///c:/DaffaP/Project%20df/Personal%20Brain/scripts/verify-all.ps1), [generate-fixtures.mjs](file:///c:/DaffaP/Project%20df/Personal%20Brain/scripts/generate-fixtures.mjs)
- **Shared Core (`crates/brain-core`):** [Cargo.toml](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/Cargo.toml), [lib.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/lib.rs), [paths.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/paths.rs), `src/domain/{mod,ids,errors,types}.rs`, `src/vault/{mod,lock,paths,replace}.rs`, [index/mod.rs](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/index/mod.rs), `src/{markdown,state,memory,retrieval,backup,ai}/mod.rs`, and `tests/{windows_lock,windows_paths,windows_replace,windows_index_gen}.rs`
- **Standalone MCP (`crates/brain-mcp`):** [Cargo.toml](file:///c:/DaffaP/Project%20df/Personal%20Brain/crates/brain-mcp/Cargo.toml), [main.rs](file:///c:/DaffaP/Project%20df/Personal%20df/Personal%20Brain/crates/brain-mcp/src/main.rs)
- **Desktop Shell (`apps/desktop`):** `package.json`, `tsconfig.json`, `eslint.config.js`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.tsx`, `src/test-setup.ts`, `src/styles/tokens.css`, `src/lib/{contracts,ipc}.ts`, `src/app/{App,App.test}.tsx`, `src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/default.json,src/main.rs,src/lib.rs,icons/*}`
- **Docs & ADRs:** [ADR-0002-ntfs-safe-replace.md](file:///c:/DaffaP/Project%20df/Personal%20Brain/docs/adr/ADR-0002-ntfs-safe-replace.md), [MVP_TASKS.md](file:///c:/DaffaP/Project%20df/Personal%20Brain/docs/MVP_TASKS.md), [phase-02.md](file:///c:/DaffaP/Project%20df/Personal%20Brain/docs/checkpoints/phase-02.md)

---

## 3. Important Implementation Decisions

1. **TypeScript pinned to `~5.8.3`:** `typescript-eslint@8.74.0` declares peer support for `typescript >=4.8.4 <6.1.0`; pinning `~5.8.3` keeps strict typechecking and ESLint 10 compatibility green without experimental TS 7 native-compiler plugin breakage.
2. **SQLite `rusqlite 0.35` (`bundled`) with FTS5:** Verified bundled SQLite `3.49.1` with `fts5` compiled in (`unicode61` tokenizer), avoiding any frontend `tauri-plugin-sql` dependency.
3. **NTFS safe replace (`ADR-0002`):** Standardized on same-directory temp file + `sync_all()` + `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` with pre-write and post-write SHA-256 verification and conflict recovery-copy preservation.
4. **Generation-named derived index (`ADR-0005` / `SC-14`):** Validated `index-<gen>.sqlite` generation switching while an active read-only connection holds `index-1.sqlite` open, eliminating Windows NTFS file-sharing violations.
5. **Cross-process vault lock (`ADR-0001`):** Validated `LockFileEx` on `vault.lock` across two separate Windows processes, returning `ErrorCode::Busy` on contention and releasing automatically on abrupt child termination.

---

## 4. Environment Verification & Baseline Hardware (`D-09`)

- **OS:** Windows 11 24H2 (`Microsoft Windows NT 10.0.26100.0`, build `26100.1742`, NTFS `C:`, `LongPathsEnabled=1`)
- **CPU / RAM / GPU / Storage:** Intel Core i7-13620H, `15.7` GB RAM, NVIDIA GeForce RTX 2050 (`4` GB) + Intel UHD Graphics, NVMe WD PC SN740 512 GB (`~85.6` GiB free)
- **Toolchain:** `rustc 1.100.0`, `cargo 1.100.0` (`stable-x86_64-pc-windows-msvc`), VS 2022 Build Tools `14.44.35207` (`cl.exe`/`link.exe`), Windows SDK `10.0.26100.0`, WebView2 `157.0.4341.60`, Node `v26.10.0`, npm `11.19.1`, Git `2.55.0.windows.5`
- **Native compiler/linker smoke (`PB-006`):** `rustc` + MSVC `link.exe` + `kernel32` binary executed cleanly (`PB_NATIVE_SMOKE_OK pid=23248 arch=x86_64`, exit code `0`).

---

## 5. Actual Test & Build Results

All checks executed on Windows 11 after the final Rust/TS code edit:

| Check | Command | Exit Code | Result |
|---|---|---|---|
| CI Pipeline (Full) | `powershell -ExecutionPolicy Bypass -File scripts/verify-all.ps1` | `0` | `ALL_PHASE_2_CHECKS_PASSED` |
| Frontend Lint | `npm run lint` (`eslint src`) | `0` | `0` errors, `0` warnings |
| TypeScript Check | `npm run typecheck` (`tsc --noEmit`) | `0` | `0` errors (`strict: true`) |
| Frontend Unit Tests | `npm run test` (`vitest run`) | `0` | `2` passed (`App.test.tsx`: live IPC + `ErrorEnvelope` error state) |
| Rust Formatting | `cargo fmt --all -- --check` | `0` | Clean |
| Rust Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | `0` | `0` warnings, `0` errors |
| Rust Unit & Windows Prototype Tests | `cargo test --workspace --locked` | `0` | `8` passed (`3` `brain-core` unit tests + `windows_index_gen` 1/1 + `windows_lock` 1/1 + `windows_paths` 2/2 incl. live `mklink /J` junction & hardlink + `windows_replace` 1/1) |
| Frontend Production Build | `npm run build` (`tsc --noEmit && vite build`) | `0` | Built `apps/desktop/dist/` (`index.html`, CSS, `222.15 kB` JS) in `230ms` |
| Rust Workspace Build | `cargo build --workspace --locked` | `0` | Built `brain-core`, `brain-mcp.exe`, and `personal-brain.exe` (`4.56s` incremental) |
| Fixture Generator | `node scripts/generate-fixtures.mjs` | `0` | Generated deterministic `F0` (0), `F100` (100 notes / 100 edges), `F1000` (1,000 notes / 2,500 edges / 50 broken links) in gitignored `tests/fixtures/.generated/` |
| Production Dependency Audit | `npm audit --omit=dev` | `0` | `0` vulnerabilities across audited production dependencies |

---

## 6. Runtime Verification Evidence

- **`brain-mcp.exe`:**
  - `target\debug\brain-mcp.exe --version` → `brain-mcp 0.1.0` (exit code `0`)
  - `target\debug\brain-mcp.exe --check` → exit code `0`, printed clean JSON to stdout confirming `core_version: "0.1.0"`, `platform: "windows-x86_64"`, `app_data_dir: "C:\\Users\\daffa\\AppData\\Local\\PersonalBrain"`, `sqlite_version: "3.49.1"`, `fts5_enabled: true`, `fts5_probe_hits: 1`.
- **`personal-brain.exe` (Tauri 2 Desktop App):**
  - Launched compiled binary `target\debug\personal-brain.exe` directly against `apps/desktop/dist/`.
  - Verified live after 5 seconds: `PID=23160`, `HAS_EXITED=False`, `RESPONDING=True`, `WINDOW_HANDLE=330354`, `WS_MB=45.6`.
  - Cleanly closed (`CloseMainWindow()`).

---

## 7. Independent Boundary Review & Remaining Limitations

An independent read-only `research` subagent (`630811f8-d6c9-4585-9dbb-7aec660a0937`) verified:
- `crates/brain-core` has **zero** direct or transitive dependencies on `tauri` or `rmcp`.
- `apps/desktop/src` has **zero** direct filesystem/SQLite access and **zero** mock vault metrics.
- `capabilities/default.json` grants `core:default` only (`main` window), and `tauri.conf.json` enforces restrictive CSP without `'unsafe-eval'` or remote origins.

**Remaining non-blocking limitations & Phase 3 hardening items (tracked for `PB-010`–`PB-012`):**
1. **Dangling reparse-point / non-dir segment edge in `resolve_guarded_target_for_write` (`crates/brain-core/src/vault/paths.rs`):** Currently calls `current.exists()` before `open_reparse_aware_dir`; in `PB-010` harden by opening directly with `FILE_FLAG_OPEN_REPARSE_POINT` (handling `NotFound`) and asserting `FILE_ATTRIBUTE_DIRECTORY != 0` on intermediate path segments so broken junctions or regular files at directory hops fail closed.
2. **`CoreError::from_io` directory vs note mapping (`crates/brain-core/src/domain/errors.rs`):** Maps `ErrorKind::NotFound` to `ErrorCode::NoteNotFound`; `PB-010` vault/directory operations should map missing vault/parent directories contextually (`VaultUnavailable` / `IoFailed`).
3. **IPC error code validation (`apps/desktop/src/lib/ipc.ts`):** `normalizeIpcError` should validate `candidate.code` against the known `ErrorCode` allowlist in Phase 4 (`PB-015`).
4. **`write_generation_index` idempotency (`crates/brain-core/src/index/mod.rs`):** Prototype inserts directly into `index-<gen>.sqlite`; `PB-012` will stage to temp or fail if target exists and switch `vault_meta` only after transaction commit.
5. **Tauri generated folder:** Added `apps/desktop/src-tauri/gen/` to `.gitignore` so `tauri-build`-generated schema JSONs stay untracked.
6. **Note on `personal-brain.exe` runtime check:** Process launch confirmed live Win32 window (`WINDOW_HANDLE=330354`, `RESPONDING=True`, 45.6 MB WS), though `MainWindowTitle` read blank during the headless 5s probe; interactive visual inspection of the WebView2 UI was not captured via screenshot in this headless shell.

---

## 8. Phase 3 Readiness Assessment & Recommendation

- **Recommendation:** **GO for Phase 3 (`PB-010`–`PB-014`)** upon owner review of this Phase 2 checkpoint.
- **Rationale:** Every Phase 2 task (`PB-006`–`PB-009`), CI/lint/typecheck/clippy/test gate, Windows native prototype (`LockFileEx`, NTFS junction/hardlink guard, `MoveFileExW` safe replace, `index-<gen>.sqlite`), production build, and live binary launch succeeded with zero unresolved Phase 2 blockers.

### Owner Sign-Off

| Role | Decision (`Approve` \| `Approve with changes` \| `Reject`) | Date | Notes |
|---|---|---|---|
| Product owner | | | |
