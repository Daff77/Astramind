# Personal Brain — MVP Implementation Backlog

Version 0.1.0 | Baseline PRD.md v0.1.0 | Proposed, not an implementation report.

## 1. Execution contract

Every task starts TODO; planning documents are supplied as drafts and need owner review (PB-001–005). No task becomes DONE until acceptance evidence is recorded. P0 = hard gate, P1 = target 1.0 unless explicit exception; P2 = optional. Effort S (0.5–1 developer-day), M (2–3), L (4–7), XL (split before implementation). Estimates exclude hardware/environment blockers and are not delivery commitments. Dependencies are finish-to-start unless orchestrator records a safe interface freeze. Roles: ORCH (orchestrator), ARCH, CORE, UI, GRAPH, AI, QA, SEC, RELEASE. QA reviews independently where possible; owner decides scope/security exceptions. Use branch/worktree isolation, disjoint ownership, small integration commits.

## 2. Milestone gates

| Gate | Tasks | Required evidence |
|---|---|---|
| Planning | PB-001–005 | Signed scope, D-01–12 decisions, reviewed interfaces/schema, acceptance mapping |
| Foundation | PB-006–009 | Real Windows clean build, baseline smoke, lockfiles and CI, baseline hardware documented |
| Vault | PB-010–014 | Core AC-001–009,014–017; destructive operations guarded, restore and concurrency tests |
| 0.1 | PB-015–018 | All vault + AC-010–013, usable offline desktop, backup baseline |
| 0.2 | PB-019–021 | AC-018–021, real graph fixture, performance/fallback |
| 0.3 | PB-022–025 | AC-022–030, minimum 2 real clients, permission and approval security tests |
| Intelligence | PB-026–028 | AC-031–034 for included features; P1 exception if chat deferred; P2 explicit defer acceptable |
| 1.0 | PB-029–030 | AC-035–037, all previous P0 regression, clean installer, restore, no unresolved critical/high data/security issues |

## 3. Detailed backlog (30 steps)

### Phase 1 — Planning (no product code)

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-001 | P0 / S / ORCH | — | Confirm project name, Windows target, single user, offline scope, milestones and non-goals; record product decisions | Owner confirms scope; no mandatory cloud or auto-commit memory |
| PB-002 | P0 / S / ARCH | 001 | Review `docs/PRD.md`, FR/NFR/AC and goals; identify contradictions, record sign-off | All 26 FR, 15 NFR, 37 AC mapped; PRD status updated only with owner approval |
| PB-003 | P0 / M / ARCH+SEC | 002 | Review `SYSTEM_ARCHITECTURE.md`; freeze component boundaries, process topology, permissions, mutation/recovery and 12 open decisions | Design review; threat model and Windows safe I/O prototype plan recorded |
| PB-004 | P0 / M / CORE+ARCH | 003 | Review `DATA_SCHEMA.md`; freeze note IDs, DDL, proposal lifecycle, retention, migration, backup | Schema/architecture consistency review; test plan for constraints and state recovery |
| PB-005 | P0 / S / ORCH+QA | 004 | Review `MVP_TASKS.md`, `AGENTS.md`; owners, phase gates, ADR and evidence conventions | Every task has acceptance/test/dependency; owner authorizes Phase 2 only |

### Phase 2 — Windows foundation

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-006 | P0 / M / RELEASE | 005 | Verify Windows build, Rust MSVC, Node LTS, npm, C++ build tools, WebView2, Git. Document versions, install instructions, hardware and available disk. Review official dependencies/OS support, licenses and risks | Actual version commands; compile/run minimal native sample; record blockers, no silent system changes |
| PB-007 | P0 / S / UI | 006 | Initialize Tauri React TS template; no product feature; configure app ID, native window, lockfile, Git baseline | `npm install`, actual `tauri dev` smoke on Windows; baseline commit or diff report |
| PB-008 | P0 / M / ARCH+CORE | 007 | Restructure npm/Cargo workspace; desktop adapter, core and MCP placeholders; typed DTO/error contract, mock-free core module boundaries; pin lockfiles | Fresh checkout builds, workspace tests run, no circular dependencies; no secrets or personal data committed |
| PB-009 | P0 / M / QA+SEC | 008 | Add formatting/lint/typecheck/test/CI scripts, fixture generators, Windows smoke, dependency scan; record baseline hardware and benchmark method. Prototype mutex, guarded filesystem handles, safe replace and two-process coordination with synthetic files | Clean build + tests, baseline hardware and graph thresholds approved; actual two-process and external-edit experiments; unsupported cases documented and gated |

### Phase 3 — Vault engine

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-010 | P0 / L / CORE+SEC | 009 | Registry, durable note IDs, root selection, bounded directory scan, guarded CRUD, journal/preimage, temp/replace, trash/move preview. Implement no-overwrite create, stale-hash conflict, Unicode/Windows path validation. No write on open | AC-001–005,009; golden bytes before/after open; traversal/junction/ADS/hardlink/case tests; failpoints + recovery |
| PB-011 | P0 / M / CORE | 010 | Parse frontmatter, common Markdown, links, aliases, tags, attachments; preserve unknown bytes, invalid YAML warning, resolve ambiguous links and no code-block links | AC-006,007,009; golden fixtures with CRLF/BOM/unknown YAML, duplicate names, broken links |
| PB-012 | P0 / L / CORE | 011 | Registry/state/index migrations, FTS5, note/link/tag tables and transactions, derived index rebuild, reconciliation generation. SQL prepared statements and bound filters | AC-014; deletion/rebuild equality; schema FK/migration tests, corruption distinction, no state loss |
| PB-013 | P0 / L / CORE+QA | 012 | Native watcher, debounce, external rename/delete, overflow rescan, conflict checks and recovery; implement backup and restore with manifest/blobs/state, staged publish and disabled restored grants | AC-008,015–017; two real processes, competing external editor, interrupted write, disk full, watcher loss, corrupted DB, restore fixture with hashes; block unsafe behavior |
| PB-014 | P0 / M / CORE | 013 | Scoped FTS query, filters, deterministic ranking, pagination, snippets, backlink/related queries, graph DTO. Revalidate live scope/hash. Benchmark 1,000 notes | AC-011 (core), NFR-004 P95 target, fixture expected IDs/ranges and literal-query/unauthorized-count tests |

### Phase 4 — Desktop UI / 0.1

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-015 | P0 / M / UI | 014 | App shell Home/Knowledge/Universe/AI Brain/Memory/Settings; unfinished features clearly disabled, vault selector, accessible sidebar, keyboard navigation, theme/DPI layout, typed IPC and events | AC-010,013; component + real Windows smoke, resize/DPI and keyboard tests; no placeholder claimed as feature |
| PB-016 | P0 / L / UI+CORE | 015 | Markdown editor (candidate CodeMirror 6), sanitized preview, tabs, dirty/undo/redo, debounced save with expected hash, rename/move impact preview, conflict diff/reload/save alternate, error states | AC-003–007,010,012,016; E2E editor persistence and external conflict; malicious Markdown/links tests |
| PB-017 | P1 / M / UI | 015,014 | Real-data dashboard recent/pinned, search result snippets, project/folder filters, backlinks/broken links and note detail; pending count only when feature enabled | AC-010,011,013; compare against fixture and keyboard tasks, no fabricated stats |
| PB-018 | P0/P1 / M / UI+QA | 016,017,013 | Onboarding Create/Open, settings, backup/restore, rebuild index, relink missing vault, error/empty states, reduced motion. Offline usability walkthrough | AC-001,010–017; no-network E2E; tested restore and unmodified existing vault; 0.1 gate review |

### Phase 5 — Knowledge universe / 0.2

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-019 | P0 / M / GRAPH+CORE | 018 | Use graph DTO from real index; node IDs, folder clusters, explicit edge counts, incremental generation handling; select maintained Three.js graph library after review | AC-018; compare node/edge sets to fixture, ambiguous/broken excluded, isolated nodes visible |
| PB-020 | P0 / M / GRAPH+UI | 019 | Orbit/pan/zoom/fit/reset, tag/folder/project filter, node detail/open, search-to-focus, keyboard-friendly list fallback | AC-019,020; link edit reflects graph, duplicate titles open correct ID, keyboard task |
| PB-021 | P0 / L / GRAPH+QA | 020 | Profile 1,000/2,500 fixture; pause when hidden/settled, label/edge budgets, reduced motion, GPU failure fallback and dispose resources | AC-021, NFR-005/011; record FPS/input latency/stalls, hardware and profiler output; 0.2 gate |

### Phase 6 — AI shared memory / 0.3

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-022 | P0 / L / AI+CORE+SEC | 021 | Separate stdio MCP binary, same core, tool schemas, grants/scopes default deny, per-call revocation, bounded outputs + source refs, no approval tools. Verify maintained SDK | AC-023–025; protocol handshake, schema tests, path/scope/revoke/injection tests, works desktop closed |
| PB-023 | P0 / M / AI+QA | 022 | Configure and test Codex then Claude Code and Gemini CLI where installed/authorized. Provide copyable local setup instructions, never auto-write configs. Windows first; WSL qualification optional | AC-022; at least two actual clients call search/read same fixture, record versions, tool logs redacted, desktop closed; third status explicit |
| PB-024 | P0 / L / CORE+AI+SEC | 023 | Create/update proposal tool, durable sources/preimages, request idempotency, proposal version, stale/hash conflict, review native API, journal/rollback/revision/audit, revoke check. No AI delete/approve | AC-026–030 core tests; proposal/reject no file write; duplicate request, stale base, crash, edit&approve, revoke, restore and two agents |
| PB-025 | P0 / L / UI+QA | 024 | Memory Center queue/diff/source attribution/approve/edit/reject/resolve conflict, revision restore, grant controls, verification status and retention/purge preview | AC-024,026–030; E2E actual client proposal → desktop review → source changed → second client reads; backup state; 0.3 gate |

### Phase 7 — Intelligence (controlled scope)

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-026 | P1 / L / AI+UI+SEC | 025 | In-app provider adapter, OS secrets, model/scope consent, included-source preview, bounded context, streaming/cancel, validated citations, provider failure isolation. No API subscription assumptions | AC-031–033; mock network and authorized real provider smoke if credentials available; no transfer without consent; offline local features; if deferred owner exception |
| PB-027 | P2 / L / AI+CORE | 025 | Frozen retrieval eval set; compare FTS to optional semantic/hybrid, chunk versioning, scoped ranking and purge/rebuild. Choose provider only after baseline, cloud opt-in | AC-034 if implemented; report top-k recall/MRR and latency versus baseline, deletion/rebuild; defer if no improvement or privacy/cost unacceptable |
| PB-028 | P2/P1 / M / AI+UI | 025 | Suggest duplicates/relations/outdated conflicts, status verified/outdated/superseded with source and explicit review. P1 note status required; advanced suggestions P2 | FR-026, AC-030; stale verification invalidation, suggestions never factual edges until accepted, no auto-merge; document deferred P2 |

### Phase 8 — Release

| ID | Priority / effort / owner | Depends | Tasks and outputs | Acceptance / verification |
|---|---|---|---|---|
| PB-029 | P0 / XL / QA+SEC | 025,028; 026/027 done or approved defer | Full regression, security and fault injection, offline/network isolation, data recovery, profiling, dependency/license review, UX walkthrough; fix and retest blockers with scoped subtasks | All required AC-001–034, NFR-001–015 evidence; no critical/high unresolved data loss or scope bypass; release candidate commit and report |
| PB-030 | P0 / L / RELEASE+QA | 029 | Tauri Windows installer (choose NSIS/MSI after test), package MCP executable, install/upgrade/uninstall clean Windows VM, checksum, user guide/backup restore/MCP setup/changelog | AC-035–037, export/read in Obsidian/VS Code, uninstall keeps vault, clean VM with no dev tools; signing status disclosed, do not bypass Windows security |

## 4. Subtask packs for complex work

Split L/XL tasks into reviewable units; no acceptance downgrade. Suggested ordering:

- PB-010a registry + stable IDs; b guarded path and enumeration; c write journal/CRUD; d trash/move preview + recovery; e independent QA negative tests.
- PB-012a state/registry migrations; b derived index/FTS transactions; c resolver reindex/rebuild; d migration/corruption tests. Freeze schema before parallel parser work.
- PB-013a watcher queue/reconcile; b optimistic concurrency and real Windows race tests; c backup manifest/snapshot; d restore/retention; e fault injection. Core mutation coordination has single owner.
- PB-016a editor UI + dirty state; b preview sanitization; c conflict and move flows; d keyboard/E2E. Freeze IPC DTOs first.
- PB-022a SDK handshake/tool types; b grant enforcement; c scoped retrieval; d client transport/security tests.
- PB-024a proposal persistence/state machine; b native review/versioning; c durable commit/revision; d idempotency/recovery/concurrent clients; e independent security review.
- PB-029a offline/storage/recovery regression; b MCP/security regression; c UI/graph/accessibility/performance; d release dependency/license audit; e fix/retest/sign-off. QA agents may run independent suites in isolated fixtures.

## 5. Requirement traceability matrix

| PRD requirement | Implementation tasks | Acceptance evidence |
|---|---|---|
| FR-001 | 010,018 | AC-001,002 |
| FR-002 | 010,011,015 | AC-002,006 |
| FR-003 | 010,013,016 | AC-003–005,016 |
| FR-004 | 011,016 | AC-006,007,009 |
| FR-005 | 014,017 | AC-011,007 |
| FR-006 | 013,016 | AC-015,016 |
| FR-007 | 012,018 | AC-014 |
| FR-008 | 015,016 | AC-010,012,013 |
| FR-009 | 015,018 | AC-010,013 |
| FR-010 | 010,013,018,025 | AC-005,017,027,037 |
| FR-011 | 019 | AC-018 |
| FR-012 | 020 | AC-019,020 |
| FR-013 | 020,021 | AC-021,013 |
| FR-014 | 022 | AC-025 |
| FR-015 | 023 | AC-022 |
| FR-016 | 022,025 | AC-023,024 |
| FR-017 | 024,025 | AC-026–029 |
| FR-018 | 024,025 | AC-027,030 |
| FR-019 | 026 | AC-031,032 |
| FR-020 | 027 | AC-034 + retrieval benchmark |
| FR-021 | 028 | AC-030 + suggestion isolation tests |
| FR-022 | 029,030 | AC-035–037 |
| FR-023 | 010,030 | AC-002,006,036 + explicit export test |
| FR-024 | 026 | AC-032,033 |
| FR-025 | 011,013,016 | AC-008,009,015 |
| FR-026 | 025,028 | AC-030 + status lifecycle |

| NFR | Tasks | Evidence |
|---|---|---|
| NFR-001 | 018,026,029 | Network disabled E2E |
| NFR-002 | 009,010,013,024,029 | Crash/concurrency/data integrity |
| NFR-003 | 012,029 | Rebuild index, state preserved |
| NFR-004 | 009,014,029 | Search benchmark P95 |
| NFR-005 | 009,021,029 | Graph benchmark/fallback |
| NFR-006 | 011,016,030 | Golden bytes and external editor compatibility |
| NFR-007 | 022,026,029 | Scoped disclosure/consent/network tests |
| NFR-008 | 010,022,024,029 | Negative path/scope/revoke tests |
| NFR-009 | 016,022,024,026,029 | Sanitization and injection isolation |
| NFR-010 | 008,009,029 | Typed contracts, lint/build, reviews |
| NFR-011 | 015,020,021,029 | Keyboard/reduced motion/list |
| NFR-012 | 030 | Clean install/uninstall |
| NFR-013 | 013,018,025,030 | Verified snapshots/restore |
| NFR-014 | 009,022,024,029 | Redacted actionable errors/audit |
| NFR-015 | 006,009,029,030 | Locked dependencies, license/advisory review |

## 6. Verification fixtures and reproducibility

Create deterministic synthetic datasets via scripts with fixed random seed; never use personal vault in automated tests. Fixture F0 empty; F100 100 notes (known hashes, aliases/tags/YAML/BOM/CRLF); F1000 1,000 notes and 2,500 resolved edges + known broken links; FPATH Unicode/long paths/junctions/traversal/case collisions (create only inside sandbox); FCONFLICT separate editor/process; FRECOVERY fault injection at every journal transition and restore; FMCP two grants with distinct folder scopes, malicious note text; FRET frozen query relevance judgments. Windows CI must run native cases, Linux unit tests are supplemental. Record OS build, CPU/RAM/GPU/disk, tool versions, fixture revision/seed, repetitions, exact command, logs/redacted paths and exit code. Measure local search warmed P95 <300 ms on F1000; graph criteria from architecture §11, confirmed before measurement. For benchmark failures profile bottleneck; don't lower threshold silently.

## 7. Task progress record

Initial state all 30 TODO; docs drafted, review pending. Update in repository only with evidence. Status values TODO, READY, IN_PROGRESS, BLOCKED, IN_REVIEW, DONE, DEFERRED. DONE requires acceptance+test evidence; DEFERRED only with owner approval and no P0 hard gate waived silently.

| Task | Status | Task | Status | Task | Status |
|---|---|---|---|---|---|
| PB-001 | DONE | PB-011 | TODO | PB-021 | TODO |
| PB-002 | DONE | PB-012 | TODO | PB-022 | TODO |
| PB-003 | DONE | PB-013 | TODO | PB-023 | TODO |
| PB-004 | DONE | PB-014 | TODO | PB-024 | TODO |
| PB-005 | DONE | PB-015 | TODO | PB-025 | TODO |
| PB-006 | TODO | PB-016 | TODO | PB-026 | TODO |
| PB-007 | TODO | PB-017 | TODO | PB-027 | TODO |
| PB-008 | TODO | PB-018 | TODO | PB-028 | TODO |
| PB-009 | TODO | PB-019 | TODO | PB-029 | TODO |
| PB-010 | TODO | PB-020 | TODO | PB-030 | TODO |

### Per-task evidence template

```markdown
## PB-xxx — Title
Status: IN_REVIEW
Owner / reviewer:
Base commit / implementation commit:
Requirements and AC:
Files and rationale:
Tests (command, environment, exit code, evidence):
Manual UX / security checks:
Known limitations and blockers:
Data migration / rollback:
Decision required:
```

Record one concise checkpoint report per phase (not dozens of redundant reports), e.g. `docs/checkpoints/phase-03.md`. Link test artifacts rather than committing full logs or screenshots containing secrets. If test cannot run, label NOT RUN and explain why. No "pass" based solely on code inspection or agent summary.
