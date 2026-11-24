# Personal Brain

Local-first Windows desktop AI Second Brain with Markdown/Obsidian-compatible vaults, 3D knowledge graph, and auditable MCP shared memory.

## Prerequisites (Windows 10/11)

- **Rust (`rustup`):** `stable-x86_64-pc-windows-msvc` with `rustfmt` and `clippy`
- **Visual Studio 2022 Build Tools:** `Desktop development with C++` workload + Windows 10/11 SDK
- **Node.js & npm:** Node LTS + npm
- **WebView2 Runtime:** Evergreen runtime (pre-installed on Windows 11 / modern Windows 10)

## Workspace Layout

- `apps/desktop` — React + TypeScript UI (`apps/desktop/src`) and Tauri 2 native adapter (`apps/desktop/src-tauri`)
- `crates/brain-core` — Shared Rust knowledge core (`domain`, `paths`, `vault`, `index`, plus Phase 3–7 boundaries)
- `crates/brain-mcp` — Standalone stdio MCP server executable consuming `brain-core`
- `docs/` — Authoritative contracts (`PRD.md`, `SYSTEM_ARCHITECTURE.md`, `DATA_SCHEMA.md`, `MVP_TASKS.md`), `adr/`, and `checkpoints/`
- `scripts/` — Quality verification and synthetic fixture generators

## Setup & Verification

```powershell
npm ci
powershell -ExecutionPolicy Bypass -File scripts/verify-all.ps1
```

### Individual Commands

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
```

### Generate Synthetic Test Fixtures

```powershell
node scripts/generate-fixtures.mjs
```

Generated fixtures are written under `tests/fixtures/.generated/` (gitignored). Never commit or test against personal vaults.
