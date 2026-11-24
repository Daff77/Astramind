# ADR-0002: NTFS Safe File Replacement Primitive

- **Status:** Accepted (2026-11-24)
- **Context:** `SYSTEM_ARCHITECTURE.md` §7.2 requires crash-safe note creation and replacement on Windows NTFS without silent overwrites, partial files, or unverified disk bytes. `PB-009` prototyped both `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` and `ReplaceFileW` in `crates/brain-core/src/vault/replace.rs` and `crates/brain-core/tests/windows_replace.rs`.
- **Alternatives Considered:**
  1. `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` after writing and `sync_all()`-ing a same-directory temp file — works uniformly for both brand-new creation and existing-file replacement, preserves directory ACL inheritance on new files, and enforces write-through semantics on the rename metadata update.
  2. `ReplaceFileW` — only works when the target already exists (fails on create), requires separate fallback for initial creation, and can encounter sharing/attribute preservation edge cases with external editors.
- **Decision:** Standardize on **same-directory temp file + `sync_all()` + `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)`** as the default NTFS replacement primitive for `brain-core`, preceded by guarded path validation + live SHA-256 comparison (`expected_hash`) and followed by read-back SHA-256 verification. Treat `note_identity.file_identity` as a non-authoritative hint refreshed after each commit.
- **Impact:** Unifies create and update code paths under one verified primitive while retaining `ReplaceFileW` comparison coverage in `windows_replace.rs`. Competing external edits (e.g., Obsidian) remain guarded by expected-hash checks and recovery-copy preservation (`ErrorCode::Conflict`).
- **Verification:** `crates/brain-core/tests/windows_replace.rs` (`safe_replace_protects_against_conflicts_and_verifies_bytes`) passed on Windows 11 NTFS (`cargo test --workspace`).
