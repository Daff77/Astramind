# ADR-0007 — Direct Three.js Instanced Graph Engine vs. `3d-force-graph`

- **Date:** 2026-11-24
- **Status:** Accepted (Phase 5 — `PB-019`–`PB-021`)
- **Context:** Phase 5 requires a lazy-loaded, local-first, CSP-safe 3D Knowledge Universe inside Tauri 2 + React + WebView2 meeting `NFR-005` (`F1000`: median >= 30 FPS, <= 150 ms interaction latency, no stalls > 500 ms, strict WebGL resource disposal, pause when hidden/settled, and full reduced-motion compliance).

## Alternatives Considered

1. **`3d-force-graph` (+ `three-spritetext`):** Convenient wrapper, but pulls transitive CDN/UMD/sprite dependencies, owns its own internal animation loop (`requestAnimationFrame`), and obscures `WebGLRenderer` / geometry / material disposal guarantees and custom label caps.
2. **Direct `three` (`InstancedMesh`, `LineSegments`, `OrbitControls`) + Deterministic Pure-TS Layout (`layout3d.ts`):** Smallest dependency footprint (`three` + `@types/three` only), zero remote textures/fonts, explicit demand-driven render loop that halts `rAF` completely once layout cools or `document.hidden` is true, explicit `InstancedMesh` GPU batching for stars (`F1000` in 1 draw call + 1 line draw call), bounded DOM overlay labels (`<= 24`), and auditable WebGL disposal + context-loss fallback.

## Decision

Adopt **direct `three`** (`three` + `@types/three`) lazy-loaded via `React.lazy(() => import("../features/universe/UniverseView"))` and manual Rollup/Vite chunk splitting (`vite.config.ts`) so zero 3D code loads during normal editor/home startup (`REM-048`).

## Consequences

- **Positive:** Strictly offline (zero CDN assets/fonts), CSP unchanged (`default-src 'self'`), full lifecycle ownership (`dispose()`, pause on hidden/settled), deterministic F1000 performance via instancing, zero competing 3D engines.
- **Negative:** Requires maintaining custom `GalaxyCanvas.tsx` and `layout3d.ts` (~400 lines), which remain cleanly isolated behind typed `NormalizedGraphModel` DTOs.
