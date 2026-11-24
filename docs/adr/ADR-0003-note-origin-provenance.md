# ADR-0003: Explicit Note Origin Provenance (`note_status.origin`)

- **Status:** Accepted (2026-11-24)
- **Context:** `PRD.md` §9.3 and the engineering requirements distinguish imported vault notes, user-created notes, and AI-proposed notes. `DATA_SCHEMA.md` §5.2 previously stored only `verification` in `note_status`, forcing origin to be inferred from `revisions`.
- **Alternatives Considered:**
  1. Infer origin by scanning `revisions` — fragile once old revisions or proposals are pruned and omits imported notes without revisions.
  2. Store origin in `note_status.origin` — O(1) lookup, survives retention pruning, controlled exclusively by `brain-core`.
- **Decision:** Add `origin TEXT NOT NULL DEFAULT 'imported' CHECK(origin IN ('imported','user_created','ai_proposal'))` to `note_status` in `state.sqlite` migration 1 (`D-15`, `SC-05`). Only `brain-core` sets or updates `origin`; AI frontmatter cannot set it.
- **Impact:** Separates origin provenance from factual verification (`unverified`, `user_verified`, `outdated`, `superseded`).
- **Migration / Rollback:** Included in initial `state.sqlite` migration 1 before any production database exists.
- **Verification:** Schema constraint tests in `PB-010`/`PB-012` and proposal approval tests in `PB-024`.
