# ADR-0004: Backlog Resequencing (`SC-01`, `SC-02`)

- **Status:** Accepted (2026-11-24)
- **Context:** `MVP_TASKS.md` §3–4 placed `registry.sqlite`/`state.sqlite` migrations in `PB-012a` even though `PB-010` requires durable IDs, journal, and blobs; similarly, MCP grant UI controls were placed in `PB-025` even though `PB-022`/`PB-023` require creating and revoking grants (`AC-022`–`AC-024`).
- **Alternatives Considered:**
  1. Keep original ordering and stub state/grants — violates the "mock-free core" rule and delays real integration testing.
  2. Resequence the two prerequisites earlier without altering acceptance criteria.
- **Decision:**
  - `SC-01`: Move `registry.sqlite` and `state.sqlite` migration 1 into `PB-010a`; keep `index.sqlite` and FTS5 migrations in `PB-012`.
  - `SC-02`: Add a minimal **Settings → MCP Permissions** slice (create/enable/disable/revoke grant and folder scopes) to `PB-022`, owned by `UI`.
- **Impact:** Eliminates circular task dependencies in `MVP_TASKS.md` §3–4 without changing any `FR`, `NFR`, or `AC`.
- **Verification:** Checked against `MVP_TASKS.md` §3–5 dependency graph.
