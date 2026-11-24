import { useCallback, useEffect, useState } from "react";
import type { AppHealthDto, ErrorEnvelope } from "../lib/contracts";
import { fetchAppHealth, normalizeIpcError } from "../lib/ipc";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; health: AppHealthDto }
  | { kind: "error"; error: ErrorEnvelope };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let active = true;
    fetchAppHealth().then(
      (health) => {
        if (active) {
          setState({ kind: "ready", health });
        }
      },
      (err: unknown) => {
        if (active) {
          setState({ kind: "error", error: normalizeIpcError(err) });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [refreshTick]);

  const handleRetry = useCallback(() => {
    setState({ kind: "loading" });
    setRefreshTick((t) => t + 1);
  }, []);

  return (
    <main className="pb-shell">
      <header className="pb-header">
        <h1 className="pb-title">Personal Brain</h1>
        <span className="pb-badge">Phase 2 Foundation</span>
      </header>

      <section className="pb-panel" aria-live="polite">
        {state.kind === "loading" && (
          <p>Checking Rust knowledge core and SQLite FTS5 readiness...</p>
        )}

        {state.kind === "error" && (
          <div>
            <p className="pb-status-err">
              Core health check failed ({state.error.code}):{" "}
              {state.error.message}
            </p>
            <button
              type="button"
              className="pb-btn"
              onClick={handleRetry}
            >
              Retry
            </button>
          </div>
        )}

        {state.kind === "ready" && (
          <>
            <p className="pb-status-ok">
              Knowledge core online ({state.health.platform})
            </p>
            <dl className="pb-kv-list">
              <div className="pb-kv-row">
                <dt>Core version</dt>
                <dd>{state.health.core_version}</dd>
              </div>
              <div className="pb-kv-row">
                <dt>SQLite / FTS5</dt>
                <dd>
                  {state.health.sqlite.sqlite_version} (FTS5{" "}
                  {state.health.sqlite.fts5_enabled ? "enabled" : "disabled"})
                </dd>
              </div>
              <div className="pb-kv-row">
                <dt>App data root</dt>
                <dd>{state.health.paths.app_data_dir}</dd>
              </div>
              <div className="pb-kv-row">
                <dt>Registry DB path</dt>
                <dd>{state.health.paths.registry_db}</dd>
              </div>
              <div className="pb-kv-row">
                <dt>Vault state root</dt>
                <dd>{state.health.paths.vaults_dir}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="pb-btn"
              onClick={handleRetry}
            >
              Re-verify core
            </button>
          </>
        )}
      </section>
    </main>
  );
}
