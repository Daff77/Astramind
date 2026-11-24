# Phase 5 Checkpoint Report — 3D Knowledge Universe (`PB-019`–`PB-021` + Phase 4 Remediation)

- **Phase:** Phase 5 — 3D Knowledge Universe
- **Tasks Covered:** Mandatory Phase 4 Remediation (`REM-041`–`REM-048`) + `PB-019`, `PB-020`, `PB-021`
- **Status:** **IN_REVIEW (Quality Gate — awaiting Owner runtime WebGL/visual verification & sign-off)**
- **Base Commit:** `59805b0` (branch `main`, Phase 4 baseline)
- **Date:** 2026-11-24
- **Environment:** Windows 11 (`x86_64`), Rust `1.100.0` (`stable-x86_64-pc-windows-msvc`), Node `v26.10.0`, npm `11.19.1`, VS 2022 Build Tools `14.44.35207`, Windows SDK `10.0.26100.0`, WebView2 Runtime `157.0.4341.60`

---

## 1. Executive Summary

Mandatory Phase 4 data-integrity, watcher reliability, and bundle-splitting remediations (`REM-041`–`REM-048`) and the Phase 5 **3D Knowledge Universe** (`PB-019`–`PB-021`) have been implemented and verified across automated unit/integration/security checks, core `F0`/`F100`/`F1000` release benchmarks, and native `.exe` launch/memory checks. Interactive WebGL GPU frame-rate profiling and visual screenshot inspection inside live WebView2 were not executed by automated headless agents and remain explicitly marked **`UNVERIFIED`** pending owner-side acceptance (`PB-021` stays `IN_REVIEW`).

---

## 2. Phase 4 Mandatory Remediation Status (`REM-041`–`REM-048`)

| ID | Status | Implementation & Verification Evidence |
|---|---|---|
| `REM-041` | **DONE** | Replaced `sessionStorage` drafts with durable `state.sqlite` migration v2 (`editor_drafts`, `STATE_SCHEMA_VERSION = 2` in [vault_state.rs](file:///C:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/state/vault_state.rs)). Uses monotonic `draft_seq` + conditional `clear_draft`, 350 ms debounce after edits, explicit **Restore Draft** / **Discard Saved Draft** UX, and populates conflict mode on stale-base recovery (`App.test.tsx`, `phase5_remediation.rs`). Note: keystrokes within `<350ms` prior to unexpected termination are not yet flushed to SQLite. |
| `REM-042` | **DONE** | Hardened `VaultWatcher` ([watcher.rs](file:///C:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/watcher.rs)) to retain `dirty` and `pending_overflow` across `Busy`/lock-contention failures with bounded exponential backoff (`200ms..3200ms`, 5 retries), `is_stale` + retry exhaustion callback, UI `Retry Sync` (`trigger_reconcile` in [StatusBar.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/shell/StatusBar.tsx)), and 300 ms lock acquisition timeout so the watcher loop stays responsive. |
| `REM-043` | **DONE** | Added `vaultSessionSeqRef` fencing in [App.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/app/App.tsx) against rapid vault switches, `beforeunload` dirty-tab prompt, explicit unacknowledged draft preservation when closing tabs, and strict `conflict.externalHash` optimistic concurrency on `Overwrite Disk with Local`. |
| `REM-044` | **PARTIAL (`UNVERIFIED` visuals)** | Verified native `personal-brain.exe` startup, HWND creation, responsiveness, host + WebView2 memory, and clean shutdown after final edit. Automated interactive UI driving & screenshot capture across WebView2 remain `UNVERIFIED` (§12). |
| `REM-045` | **DONE (Core Baseline)** | Measured deterministic `F0`, `F100`, `F1000` release baselines via `perf_baseline.rs` + native process-tree RSS/CPU (§13). End-to-end WebView2 IPC roundtrip timings during interactive edit/search remain `UNVERIFIED` interactively. |
| `REM-046` | **DONE (Simulated)** | Added `VaultWatcher::simulate_overflow()` + integration verification in `phase5_remediation.rs` emitting `from_overflow: true`. Explicitly distinguished from OS kernel directory-ring buffer overflow provocation. |
| `REM-047` | **DONE** | Added `watcher_epoch: Arc<AtomicU64>` fencing and non-blocking `spawn_blocking(old.stop())` teardown in [lib.rs](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src-tauri/src/lib.rs). |
| `REM-048` | **DONE** | Configured manual Vite chunk splitting ([vite.config.ts](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/vite.config.ts)) and `React.lazy` Universe loading. Verified startup entry `dist/index.html` excludes `UniverseView-*.js` and `vendor-three-*.js`. |

---

## 3. Completed Task IDs

| Task | Status | Notes |
|---|---|---|
| `PB-019` | **DONE** | Graph Data Engine: enriched `GraphNodeDto`, normalized deduplicated model, cluster mapping, broken/ambiguous diagnostics, cycles/self-links/isolated nodes, stale snapshot rejection |
| `PB-020` | **DONE** | Knowledge Universe Visualization: 3D cosmos canvas, orbit/pan/zoom/fit/reset/focus, search/folder/tag filters, Star Inspector, Knowledge navigation preserving drafts |
| `PB-021` | **IN_REVIEW** | Demand-driven rAF, capped DPR (`<=2`), instanced GPU batching, 24-label budget, disposal + WebGL fallback implemented & unit-tested; awaits owner-side live GPU FPS & visual QA |

---

## 4. Graph Architecture (`PB-019`)

- **Authoritative Backend Source:** `crates/brain-core/src/retrieval/mod.rs` (`get_graph`) derives `GraphSnapshotDto` solely from `index-<gen>.sqlite` and `note_status` (`rel_path`, `title`, top-level `folder`, `tags`, `origin`, `parse_status`, `verification`, `incoming_count`, `outgoing_count`, plus explicit `resolved` edges). Broken/ambiguous/attachment/external links are never turned into fake graph edges and remain separate in `get_vault_broken_links`. Note bodies are omitted from graph DTOs.
- **Frontend Normalization (`graphModel.ts`):** `normalizeGraphSnapshot` deduplicates by `NoteId`, computes deterministic cluster color indices from sorted cluster keys, preserves isolated notes and self-links, binds broken/ambiguous diagnostics per source note, and enforces monotonic generation safety via `isStaleGraphSnapshot`.

---

## 5. Universe 3D Visual Refinement & Data-Quality Audit

### 5.1 Root Causes of Prior Visual & Data-Quality Problems

1. **Unfiltered Dependency & Build Directory Indexing (`2,507` nodes / `2,380` isolated / `2,952` broken links):** [paths.rs](file:///C:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/vault/paths.rs) (`is_excluded_entry`) previously excluded only `.obsidian`, `.git`, `.ds_store`, `thumbs.db`, `.pb-tmp-*`, and `~$*`. Opening any project-adjacent or monorepo folder indexed every `.md` README/changelog inside `node_modules`, `target`, `dist`, `build`, `.next`, `.cache`, and `.venv`, flooding the graph with isolated dependency docs and unresolved relative/package references.
2. **Scatter-Plot Star Geometry:** [GalaxyCanvas.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/GalaxyCanvas.tsx) previously rendered stars as solid `SphereGeometry(1.7, 14, 10)` + `MeshBasicMaterial` scaled linearly up to `4.5×`, making hubs look like flat opaque balls.
3. **Rigid Spherical Clumps:** [layout3d.ts](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/layout3d.ts) pulled all cluster notes tightly toward uniform golden-angle disk points without subcluster structure or connected-vs-isolated stratification, creating separated solid balls and large empty viewport voids.
4. **Cluttered Edges & Overlapping Labels:** Edges shared one flat `LineBasicMaterial` with zero focus dimming or direction distinction, and the `<= 24` overlay labels lacked screen-space AABB collision rejection or semantic zoom gating, piling text directly over dense clusters.
5. **Heavy Chrome & Permanent Sidebar:** [UniverseView.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/UniverseView.tsx) previously used an opaque top toolbar with stretched `<select>` controls and a permanent `296px` right Star Inspector even when no star was selected.

### 5.2 External Design Reference Analysis

- **Google *100,000 Stars*:** Informed single-draw-call `THREE.Points` + custom GLSL vertex/fragment shaders (analytical radial core, soft corona/halo, distance attenuation, no external textures or heavy post-processing bloom) paired with crisp HTML/CSS overlay labels.
- **Cosmograph:** Informed semantic zoom gating (overview cluster labels vs. zoomed-in node labels), strict priority ordering (selected → hovered → search matches → neighbors → top hubs), and dynamic visibility filtering (`showIsolated`).
- **Stellavault / Brain Atlas:** Informed hierarchical spatial grouping (vault → folder galaxies → subfolder subclusters → connected inner filaments vs. isolated outer halos) and restrained deep-cosmos atmospheric contrast.

### 5.3 Implemented Rendering, Layout, Data & Interaction Improvements

- **Configurable Vault Exclusions & Non-Destructive Preview (`brain-core`, `src-tauri`):**
  - Added `DEFAULT_EXCLUSION_PATTERNS` (`node_modules`, `target`, `dist`, `build`, `.next`, `.nuxt`, `.cache`, `.turbo`, `.vite`, `.parcel-cache`, `__pycache__`, `.venv`, `venv`, `coverage`), `normalize_exclusion_patterns`, `matches_exclusion_pattern`, and `scan_vault_with_exclusions` while keeping `scan_vault` unfiltered for `backup/mod.rs` so full backups never drop files.
  - Persisted exclusions per vault in `state.sqlite` `vault_meta` (`exclusion_patterns_json`), synchronized live into `VaultWatcher`, and exposed `get_vault_exclusions`, `preview_vault_exclusions`, and `set_vault_exclusions` (rebuilds index without touching disk files).
- **Custom GLSL Star Shader & Cosmic Filaments ([GalaxyCanvas.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/GalaxyCanvas.tsx)):**
  - Single `THREE.Points` + `ShaderMaterial` draw call for all knowledge stars with analytical core/corona/halo, subtle deterministic per-star spectral tinting, logarithmic hub sizing (`<= 2.65×`), subtle 4-point diffraction flares on major hubs/selected stars (disabled in `reducedEffects`), and light/dark blending parity (`AdditiveBlending` dark / `NormalBlending` light).
  - Non-pickable 620-star distant decorative background starfield (hidden in `reducedEffects`).
  - Dual-layer `LineSegments` cosmic filaments: low-opacity blended overview filaments + focus-highlighted **incoming** (amber), **outgoing** (cyan/blue), and optional **2-hop** (indigo) filaments while dimming unrelated nodes/edges.
  - Billboarded camera-facing selection/hover rings, screen-space nearest-star picking, `OrbitControls.zoomToCursor = true`, cubic-eased `fitAll` / `resetCamera` / `focusNode` / `focusCluster` (instant under `prefers-reduced-motion`, cancelled immediately on pointer/wheel input), and stable camera across background index refreshes.
- **Organic Hierarchical Layout ([layout3d.ts](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/layout3d.ts)):**
  - Adaptive cosmic topology by cluster count (single elliptical nebula, compact multi-galaxy constellation, or multi-arm galactic distribution weighted by cluster size), subfolder lobe offsets (`subclusterKey`), connected inner filaments vs. isolated outer halos, and tracked `clusterBounds` + `boundingRadius`.
- **Semantic Zoom (L1–L4) & AABB Collision-Free Labels (`computeVisibleLabels`):**
  - Transitions smoothly across `L1 Overview` → `L2 Galaxies` → `L3 Cluster` → `L4 Focus`, enforcing strict `7px`-padded screen-space AABB collision rejection, safe-zone margins clear of floating HUD pills, and `<= 14%` viewport area cap across `low` (10), `medium` (22), and `high` (34) density settings.
- **Floating Universe HUD, Graph Settings & Collapsible Inspector ([UniverseView.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/UniverseView.tsx), [ExclusionsModal.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/ExclusionsModal.tsx)):**
  - Full-bleed cosmos stage with floating translucent top-left filters (search with `Enter`-to-focus, compact folder/tag selects, Isolated toggle, Clear Filters), top-right telemetry/`Orbit`·`Graph`·`List` mode toggle/Display popover/refresh controls, bottom-left camera dock + `Parent Orbit` + edge legend, and a collapsible + drag-resizable (`272–440px`) floating contextual Note Inspector (collapsed to a corner chip when nothing is selected).
  - Persisted `UniverseSettings` in `localStorage` (`pb.pref.universeSettings`: `visualizationMode`, star/planet size, orbit/cluster spacing, connection opacity, label density, background starfield visibility, isolated visibility, gentle orbital motion disabled by default, 1/2-hop focus depth, performance mode) and shared Exclusions modal wired into both Universe Display settings and [SettingsView.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/settings/SettingsView.tsx).

### 5.4 Original Orbital Knowledge System ([orbitalLayout.ts](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/orbitalLayout.ts), [OrbitalCanvas.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/OrbitalCanvas.tsx))

- **Clean-Room Implementation:** Built independently using `three@0.187.0` and our `brain-core` contracts; no source code, shaders, textures, or styles were inspected or copied from external PolyForm-licensed plugins.
- **Data-to-Celestial Hierarchy & Pinned Identity:**
  - Exposed `GraphNodeDto.pinned` from `state.sqlite` (`note_status`) in [types.rs](file:///C:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/domain/types.rs) and [retrieval/mod.rs](file:///C:/DaffaP/Project%20df/Personal%20Brain/crates/brain-core/src/retrieval/mod.rs) alongside full `folderSegments`.
  - **Active Vault** renders as a non-pickable central celestial core; **top-level folders** form primary orbital systems; **nested subfolders** (up to depth 3 with deeper notes folded onto depth-3 belts) form secondary orbital systems/belts; **Markdown notes** render as spherical planets (`pinned` notes distinguished by tilted golden equatorial rings and subtle size prominence); **actual resolved edges** remain cosmic filaments without fabricating hierarchy links.
- **Deterministic Non-Overlapping Orbital Layout (`createOrbitalLayout`):**
  - Bottom-up envelope calculation packs connected notes onto inner concentric belts and isolated notes onto outer belts with minimum arc clearance so dense folders (`1,000–2,507` notes) never collapse onto one ring; sibling subfolder and top-level systems occupy staggered heliocentric orbital shells spaced strictly beyond `r_A + r_B + gap` to prevent collisions across refreshes.
- **Procedural Celestial Shaders & ~7-Draw-Call Pipeline (`OrbitalCanvas.tsx`):**
  - Central Vault Core (`SphereGeometry` + Fresnel photosphere `ShaderMaterial`), single `InstancedMesh` for all planets (heliocentric directional lighting from `(0,0,0)`, Fresnel atmospheric rim glow, analytical latitude striping, focus dimming), instanced pinned-note rings, instanced clickable folder hub anchors, batched orbital rings (`LineSegments`), dual-layer wikilink filaments, billboarded selection/hover halos, and non-pickable background starfield.
  - Supports `Orbit` semantic zoom + `computeOrbitalLabels` (AABB collision rejection), `Parent Orbit` + breadcrumb navigation, `Focus Connections` subgraph isolation, and guarded **Safe Markdown Excerpt** rendering inside the floating Note Inspector via [SafeMarkdownPreview.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/editor/SafeMarkdownPreview.tsx).
  - Kept `visualizationMode` default as `"graph"` until live interactive visual acceptance is signed off (`"orbit"` is selectable immediately in the toolbar).

---

## 6. UX & Design Decisions

- Preserved the existing application shell, activity rail, Knowledge/Editor/Draft workflows, and Light/Dark/System themes (`tokens.css`) while giving the 3D stage dedicated deep-cosmos dark (`#03050a`–`#0e172a`) and celestial star-chart light (`#e2e8f2`–`#f7f9fc`) backdrops.
- Distinguished graph-only visibility toggles (`Show/Hide Isolated`, search/galaxy/tag filters) from persistent indexing exclusions (`ExclusionsModal` with non-destructive preview + index rebuild).
- Kept accessible keyboard `List` fallback parity and `prefers-reduced-motion` static equilibrium without disabling user navigation.

---

## 7. Files & Modules Changed

- **Backend & Tauri Adapter:** `crates/brain-core/src/domain/types.rs`, `crates/brain-core/src/state/vault_state.rs`, `crates/brain-core/src/index/store.rs`, `crates/brain-core/src/vault/{engine.rs,paths.rs,scan.rs,watcher.rs}`, `crates/brain-core/src/retrieval/mod.rs`, `crates/brain-core/tests/phase5_remediation.rs`, `crates/brain-core/examples/perf_baseline.rs`, `apps/desktop/src-tauri/src/lib.rs`
- **Frontend & Build:** `package-lock.json`, `apps/desktop/package.json`, `apps/desktop/vite.config.ts`, `apps/desktop/src/lib/contracts.ts`, `apps/desktop/src/lib/ipc.ts`, `apps/desktop/src/styles/app.css`, `apps/desktop/src/features/shell/ActivityRail.tsx`, `apps/desktop/src/features/shell/StatusBar.tsx`, `apps/desktop/src/features/editor/EditorWorkspace.tsx`, `apps/desktop/src/features/settings/SettingsView.tsx`, `apps/desktop/src/app/App.tsx`
- **Universe Module & Tests:** `apps/desktop/src/features/universe/{graphModel.ts,layout3d.ts,orbitalLayout.ts,GalaxyCanvas.tsx,OrbitalCanvas.tsx,UniverseView.tsx,ExclusionsModal.tsx,graphModel.test.ts,UniverseView.test.tsx}`, `apps/desktop/src/app/{App.test.tsx,App.onboarding.test.tsx}`, `apps/desktop/src/features/editor/EditorWorkspace.test.tsx`
- **Docs & ADR:** `docs/adr/ADR-0007-threejs-universe-engine.md`, `docs/checkpoints/{phase-04.md,phase-05.md}`, `docs/MVP_TASKS.md`

---

## 8. Dependency Decisions

Recorded in [ADR-0007-threejs-universe-engine.md](file:///C:/DaffaP/Project%20df/Personal%20Brain/docs/adr/ADR-0007-threejs-universe-engine.md): selected direct **`three`** (`0.187.0` + `@types/three`) instead of `3d-force-graph` for minimal offline dependency footprint, CSP compliance (`default-src 'self'`), instanced batching, strict `rAF` ownership, and auditable WebGL disposal. `npm audit`: 0 vulnerabilities.

---

## 9. Security & Data Integrity Results

- **Orbital Independent QA & Security Audit (`f7342d78-f34c-4ce3-ada3-8cad1d31d62f`):** Reported **0 Blocking**, **0 Major**, and 7 Minor observations across originality, CSP (`default-src 'self'`), zero remote textures/fonts/`innerHTML`, `SafeMarkdownPreview` excerpt safety, stale async excerpt race guards, `pinned` mapping, zero fabricated edges, GLSL `InstancedMesh` attribute validity, demand-driven `rAF`, and full WebGL disposal. Resolved 5 of those minor items (`useCallback` memoized `handleReadNoteExcerpt`, right-click `ev.button !== 0` guard in both canvases, live Light/Dark theme sync for orbital rings/hubs/pinned rings, dynamic `controls.maxDistance` scaling for wide vaults, deleted/excluded `focusConnectionsNoteId` fallback, and effective `orbitalMotion` checkbox state) and re-ran all quality gates and builds afterward.
- **Draft Isolation & Exclusion Integrity:** `phase5_remediation.rs` verified `editor_drafts` survive reopen without polluting `search_notes`, `persistent_exclusions` preserve disk files and backups (`4/4`), and `GraphNodeDto.pinned` matches `state.sqlite`.

---

## 10. Automated Test & Quality Gate Results (Run After Final Code Edit)

| Suite | Command | Scope & Type | Result |
|---|---|---|---|
| Quality Gate Script | `powershell -ExecutionPolicy Bypass -File scripts/verify-all.ps1` | ESLint, `tsc --noEmit`, Vitest, `cargo fmt`, `cargo clippy`, Cargo tests | Exit `0` (`ALL_QUALITY_GATES_PASSED`) |
| Impeccable Design Detector | `impeccable.cmd detect --json UniverseView.tsx OrbitalCanvas.tsx GalaxyCanvas.tsx ExclusionsModal.tsx app.css` | Static UI anti-pattern scan | `0` findings in Universe components/CSS (`1` pre-existing warning on unrelated `.pb-preview-prose blockquote` at `app.css:858`) |
| Frontend Vitest | `npm --workspace @personal-brain/desktop run test` | `jsdom` unit, orbital layout, label-overlap, excerpt, settings, exclusion modal & lifecycle tests | `7` files, `23/23` passed (`5.49s`) |
| Rust Unit & Integration | `cargo test --workspace --locked` | Native Windows Rust, `pinned` DTOs, exclusions, SQLite/watcher/junction tests | `21/21` passed across all suites (`brain-mcp`: 0, `desktop`: 0 unit tests) |
| Frontend Production Build | `npm --workspace @personal-brain/desktop run build` | Split bundle verification (`dist/index.html` excludes Three.js) | Exit `0` (`776 ms`): entry `321.02 kB` (`94.57 kB` gzip), `UniverseView` `80.98 kB` (`23.29 kB` gzip), `vendor-three` `560.25 kB` (`137.96 kB` gzip) |
| Rust Release Build | `cargo build --release --workspace --locked` | Optimized native Windows desktop + MCP binaries | Exit `0` (`0.59s` incremental relink after `1m 12s` full build) |

---

## 11. Native Runtime Evidence

- Launched `target\release\personal-brain.exe` after the final code edit (`2026-11-24`):
  - `PID=33124`, `READY=True`, `RESPONDING=True`, `HWND=7279586`, elapsed `2465 ms`
  - Host process: `45.47 MB` Working Set, `0.17s` CPU
  - WebView2 child tree (`6` `msedgewebview2.exe` processes): `305.35 MB` combined Working Set, `1.06s` CPU (total tree RSS **`350.82 MB`**)
  - Shutdown probe via `CloseMainWindow()`: `CLOSE_SENT=True`, `CLEAN_EXIT=False` within the 8-second `WaitForExit(8000)` timeout.

---

## 12. Visual Verification Evidence (`UNVERIFIED` Interactive WebGL Notice)

- **Automated Interactive WebGL / Before-and-After Screenshots / Live GPU FPS:** **`UNVERIFIED`** (`NOT RUN` — headless `jsdom` does not provide a WebGL GPU context, and automated desktop GUI screenshot/input driving was not executed). Per §10 of the design brief, `visualizationMode` remains `"graph"` by default until your interactive visual & functional sign-off promotes `"orbit"` to default.
- **Required Owner Acceptance Steps:** Launch `target\release\personal-brain.exe` (or `npm --workspace @personal-brain/desktop run tauri dev`), switch between **`Graph`**, **`Orbit`**, and **`List`**, and verify before/after visuals and smoothness across Overview (`L1`), Subfolders (`L2`/`L3`), Selected planet (`L4` incoming amber / outgoing cyan filaments + pinned rings + Safe Markdown excerpt + `Focus Connections` + `Parent Orbit`), dense vault (`2,507`-node real vault before & after exclusions), `F100`, empty vault, Light & Dark themes at `1366×768` and `900×600`, Display Settings (`Planet/Star Size`, `Orbit/Cluster Spacing`, `Show background starfield`, `Gentle orbital motion`), Exclusions preview/apply, and repeated Universe entry/exit on iGPU & RTX 2050.

---

## 13. Core, Bundle & Layout Performance Benchmark Results (`REM-045`, `REM-048`, `F2507`)

Measured on `target\release\examples\perf_baseline.exe` (Windows 11 release build matching current `brain-core`, deterministic synthetic LCG vaults `F0`, `F100`, `F1000`, `F2507`):

| Fixture | Notes | Edges | Open (ms) | Read (ms) | Save (ms) | Search P50 (ms) | Search P95 (ms) | Graph DTO (ms) | Rebuild (ms) | Backup (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| `F0` | `0` | `0` | `61.20` | — | — | `5.61` | `8.41` | `6.41` | `36.91` | `13.49` |
| `F100` | `100` | `198` | `133.90` | `8.10` | `52.80` | `11.58` | `16.99` | `11.50` | `75.37` | `152.43` |
| `F1000` | `1000` | `1997` | `429.74` | `19.63` | `132.45` | `27.18` | `45.46` | `32.61` | `241.37` | `1375.53` |
| `F2507` | `2507` | `173` | `781.65` | `19.81` | `88.76` | `36.16` | `64.78` | `51.98` | `448.76` | `4195.47` |

Pure-TS `layout3d.ts`, `orbitalLayout.ts`, and `graphModel.ts` CPU timings (Node `v26.10.0` via Vite SSR):
- **Orbital (`orbitalLayout.ts`):**
  - `F100` (`100` / `198`): normalize `9.40 ms`, orbital compute `1.89 ms` (`21` systems, `35` rings, `boundingRadius 120.7`)
  - `F1000` (`1000` / `1997`): normalize `3.48 ms`, orbital compute `2.68 ms` (`21` systems, `95` rings, `boundingRadius 247.0`)
  - `F2507` (`2507` / `173`): normalize `5.04 ms`, orbital compute `3.99 ms` (`21` systems, `125` rings, `boundingRadius 317.6`)
- **Force Graph (`layout3d.ts`):**
  - `F100`: settle `15.14 ms` (`66` steps, `0.23 ms/step`); `F1000`: settle `151.18 ms` (`68` steps, `2.22 ms/step`); `F2507`: settle `322.04 ms` (`68` steps, `4.74 ms/step`).

- `F1000` Search P95 (`45.46 ms`) and `get_graph` DTO retrieval (`32.61 ms`) clear the `<300 ms` `NFR-004` ceiling, and closed-form `orbitalLayout` computation completes in `< 4 ms` even at `2,507` notes.
- Live WebView2 FPS / frame-time percentiles, draw-call profiler counts, and post-Universe-exit heap deltas remain **`UNVERIFIED`** until exercised interactively on target GPU hardware.

---

## 14. Resource Lifecycle Verification

- Verified by static audit + React unmount checks (`UniverseView.test.tsx`): leaving Universe cancels `rAF`, removes `ResizeObserver`, pointer/wheel listeners, `webglcontextlost`, and `visibilitychange` listeners, calls `controls.dispose()`, disposes all `BufferGeometry`, `ShaderMaterial`, `LineBasicMaterial`, `PointsMaterial`, and `InstancedMesh` objects across both `OrbitalCanvas` and `GalaxyCanvas`, and calls `renderer.dispose()`.
- Verified via [OrbitalCanvas.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/OrbitalCanvas.tsx) and [GalaxyCanvas.tsx](file:///C:/DaffaP/Project%20df/Personal%20Brain/apps/desktop/src/features/universe/GalaxyCanvas.tsx): `rAF` halts when idle (`orbitalMotion` OFF by default, `sim.settled`, `!controlsMoved`, `!flyAnimRef.current`) or when `document.visibilityState === "hidden"`.

---

## 15. Requirement Traceability

- **FR-011 / FR-012 / FR-013 (`AC-018`–`AC-021`):** Graph DTOs (`pinned` + folder paths), hierarchical `Orbit` system (`orbitalLayout.ts` + `OrbitalCanvas.tsx`), `Graph` cosmos (`layout3d.ts` + `GalaxyCanvas.tsx`), semantic zoom L1–L4, AABB label collision rejection, floating HUD, Graph Settings, Vault Indexing Exclusions with preview, collapsible/resizable floating Note Inspector with Safe Markdown Excerpt & `Focus Connections`, Editor navigation, filtering, and keyboard List fallback implemented and unit/integration tested; live GPU FPS & 10-state visual acceptance awaits owner check.
- **NFR-002 / NFR-003 / NFR-004 / NFR-009 / NFR-010 / NFR-011:** Durable draft isolation, watcher backoff/overflow retention + exclusion filtering, strict optimistic concurrency, reduced-motion static equilibrium, CSP & HTML sanitization verified.

---

## 16. Remaining Limitations

1. Live interactive WebView2 GPU FPS (`>= 30 FPS` median on `F1000` / `F2507` across Intel iGPU & RTX 2050) and the 10 visual state screenshots are **`UNVERIFIED`** (`NOT RUN` headlessly).
2. Unpersisted keystrokes within the 350 ms draft debounce window prior to abrupt OS termination cannot be recovered (`REM-041` honest boundary).
3. Windows `ReadDirectoryChangesW` kernel ring-buffer drop (`from_overflow: true`) was verified via `simulate_overflow()` rather than kernel buffer exhaustion.
4. `CloseMainWindow()` during automated native launch smoke check did not exit within the 5-second timeout (`CLEAN_EXIT=False`); manual window-close timing should be confirmed during owner acceptance.

---

## 17. Phase 6 Readiness

Phase 6 (`PB-022`–`PB-025`: MCP Server & Shared Memory) depends cleanly on `brain-core` contracts and durable `state.sqlite` (`memory_proposals`, grants/scopes already schema-ready in v2). Ready to begin **only after** Product Owner signs off on the Phase 5 quality gate and completes visual/GPU spot-checks.

---

## 18. Final Recommendation & Sign-Off

**Recommendation:** **CONDITIONAL GO / READY FOR OWNER VISUAL & GPU ACCEPTANCE** — All automated Rust/TypeScript/Vitest/security gates, core benchmarks, and native executable smoke checks pass cleanly; `PB-021` visual/GPU qualification awaits owner interactive sign-off before advancing to Phase 6.

| Role | Decision | Notes | Date |
|---|---|---|---|
| Engineering Orchestrator | Ready for Review | `REM-041`–`REM-048`, `PB-019`–`PB-020` complete; `PB-021` ready for visual/GPU check | 2026-11-24 |
| Independent QA / Security Reviewer | Verified Remediated | All 5 audit findings (`1` Blocking, `1` Major, `3` Minor) fixed & re-verified (`20/20` Vitest, `20/20` Rust) | 2026-11-24 |
| Product Owner | `[ ] Approve / [ ] Approve with changes / [ ] Reject` | Verify interactive Universe screenshots & GPU smoothness; authorize Phase 6 | — |

## 19. Orbital visual refinement verification (2026-11-24)

**PB-021 remains IN_REVIEW.** This entry records the latest verification of the working tree based on `ab7c53b`. Earlier native screenshot and timing gaps describe prior runs. Owner acceptance remains open.

- Orbit uses real folder and note data, packs notes into adaptive belts, and represents up to three nested folder levels. Overview rendering samples dense links. Detail and connection focus expose the underlying links. Graph remains the default, and List remains available as a selectable mode and WebGL fallback.
- The renderer uses original procedural lighting and shading, projected bounds for camera fit, screen-space label collision checks, reusable GPU buffers, and explicit WebGL disposal. The floating controls and contextual inspector retain editor navigation and the existing vault exclusion workflows. No new runtime dependencies or changes to vault storage, editor behavior, or IPC permissions were introduced by the visual refinement.
- Separate rendering, layout, and UX agents contributed changes. Read-only cross-review verified renderer disposal and found List docking and stale camera focus issues. Both were corrected and followed by native checks.

### Verification

| Scope | Evidence |
|---|---|
| Windows quality gate | From the repository root, `powershell -ExecutionPolicy Bypass -File scripts/verify-all.ps1` exited 0. ESLint, TypeScript, 26 Vitest tests, Rust formatting, Clippy, and 21 Rust tests passed. |
| Release executable | From `apps/desktop`, `../../node_modules/.bin/tauri.cmd build --no-bundle` exited 0 and built `target/release/personal-brain.exe`. Vite reported its existing chunk-size warning for CodeMirror and Three.js. |
| FR-011, AC-018 | Native Orbit reported 100 notes/100 resolved links in F100 and 1,000 notes/2,500 resolved links in F1000. The generator now prevents duplicate targets per source so the fixture meets the declared edge count. |
| FR-012, AC-019 | Native smoke covered direct planet selection, note excerpt, connection focus, folder focus, parent navigation, opening the selected note in CodeMirror, and applying then removing an exclusion on F100. Watcher and graph reconciliation passed automated coverage. Live edit-to-graph synchronization was outside this native trace. |
| FR-012, AC-020 | Native F100 folder filter reduced the visible set to 25 notes. The tag filter narrowed it further. Filter clearing, keyboard search, and camera reset passed the exercised flow. |
| FR-013, NFR-011 | Native Graph, Orbit, and List switching passed. With WebGL disabled, F100 exposed all 100 notes in List. Empty vault handling, keyboard-accessible controls in the component suite, and compact light-mode rendering were checked. |
| AC-021, NFR-005 | RTX 2050 native WebView2 measurement completed. Intel UHD qualification and owner visual sign-off remain open. |

Windows 11 Pro build 26100, MSVC x64, WebView2 158.0.4370.33, ANGLE D3D11 on GeForce RTX 2050, 1228×772 canvas, 200 Hz display. A 120-step native input drag on F1000 drove frame-callback sampling and WebGL disjoint GPU timer queries. These timings describe the captured overview trace. Input to the next render callback is a software latency measurement and excludes presentation.

| F1000 configuration | Median frame cadence | P95 frame interval | Max frame interval | GPU median / P95 | Input → callback P95 |
|---|---:|---:|---:|---:|---:|
| Before | 200 FPS | 5.1 ms | 5.3 ms | 0.92 / 4.20 ms | 0.5 ms |
| After | 200 FPS | 5.2 ms | 10.7 ms | 0.18 / 0.20 ms | 0.2 ms |
| After with orbital motion enabled | 200 FPS | 5.2 ms | 12.2 ms | 0.20 / 0.21 ms | 0.2 ms |

Before and after screenshots captured from the native WebView2 window accompany the handover. They include F100 and F1000 overviews, the selected-note inspector, folder focus, List, exclusions preview, and a light-mode 900×600 viewport. Final native runs closed within eight seconds. Intel adapter selection, long-run GPU memory measurement, the larger F2507 scenario, and installer lifecycle remain unqualified. The earlier note-commit and draft-recovery findings remain outside this visual change. Recovery for the UI refinement is to switch the Universe to Graph or List. Phase 6 awaits authorization.
