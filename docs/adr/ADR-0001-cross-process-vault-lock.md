# ADR-0001: Cross-Process Vault Locking via `LockFileEx`

- **Status:** Accepted (2026-11-24)
- **Context:** Desktop (`apps/desktop`) and standalone stdio MCP (`brain-mcp`) share `brain-core` across separate processes. A `Local\` named Windows mutex is scoped to a single logon session and fails to coordinate processes across different sessions or SSH.
- **Alternatives Considered:**
  1. `Local\` named mutex — fails across logon sessions.
  2. `Global\` named mutex — requires `SeCreateGlobalPrivilege` / elevation or fails under restricted tokens.
  3. OS advisory/mandatory file lock (`LockFileEx`) on a per-vault lock file in app-data — works across sessions for the same OS user without elevation.
- **Decision:** Use `LockFileEx` (exclusive lock with bounded polling/timeout returning `BUSY`) on `%LOCALAPPDATA%\PersonalBrain\vaults\<vault_id>\vault.lock`, paired with a `mutation_journal` `prepared`/`recovery_required` marker to detect crash/abandoned operations on next acquisition.
- **Impact:** Satisfies `SYSTEM_ARCHITECTURE.md` §7.1 and `AR-01`. Lock path is derived from canonical `VaultId`, never arbitrary user input.
- **Migration / Rollback:** No persistent schema migration needed; `vault.lock` is an ephemeral coordination file.
- **Verification:** `PB-009` two-process contention and abrupt-termination recovery test (`crates/brain-core/tests/windows_lock.rs`).
