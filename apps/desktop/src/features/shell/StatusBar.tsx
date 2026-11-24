import {
  AlertTriangle,
  CheckCircle2,
  Database,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  EditorTabState,
  ErrorEnvelope,
  VaultSummary,
} from "../../lib/contracts";

interface StatusBarProps {
  vault: VaultSummary | null;
  activeTab: EditorTabState | null;
  isBusy: boolean;
  externalNotice: string | null;
  errorEnvelope: ErrorEnvelope | null;
  onDismissError: () => void;
  onDismissNotice: () => void;
}

function renderSaveLabel(tab: EditorTabState | null): {
  text: string;
  tone: "ok" | "warn" | "err" | "neutral";
} {
  if (!tab) {
    return { text: "No note active", tone: "neutral" };
  }
  switch (tab.saveState) {
    case "saving":
      return { text: "Saving…", tone: "neutral" };
    case "dirty":
      return { text: "Unsaved changes", tone: "warn" };
    case "conflict":
      return { text: "Conflict — review required", tone: "err" };
    case "error":
      return { text: "Save failed", tone: "err" };
    case "saved":
    default:
      return {
        text: tab.lastSavedAt ? `Saved ${tab.lastSavedAt}` : "Saved",
        tone: "ok",
      };
  }
}

export function StatusBar({
  vault,
  activeTab,
  isBusy,
  externalNotice,
  errorEnvelope,
  onDismissError,
  onDismissNotice,
}: StatusBarProps) {
  const saveStatus = renderSaveLabel(activeTab);

  return (
    <footer className="pb-statusbar" aria-label="Workspace status">
      <div className="pb-status-group">
        <span className="pb-status-item">
          <Database size={12} strokeWidth={1.8} />
          {vault ? (
            <span>
              <strong>{vault.display_name}</strong> ({vault.note_count} notes ·
              Gen {vault.active_index_generation})
            </span>
          ) : (
            <span>No active vault</span>
          )}
        </span>

        {activeTab ? (
          <span
            className={`pb-status-pill ${
              saveStatus.tone === "ok"
                ? "is-ok"
                : saveStatus.tone === "warn"
                  ? "is-warn"
                  : saveStatus.tone === "err"
                    ? "is-err"
                    : ""
            }`}
          >
            {saveStatus.tone === "ok" ? <CheckCircle2 size={11} /> : null}
            {saveStatus.text}
          </span>
        ) : null}

        {isBusy ? (
          <span className="pb-status-item">
            <RefreshCw size={12} /> Syncing…
          </span>
        ) : null}
      </div>

      <div className="pb-status-group">
        {externalNotice ? (
          <span className="pb-status-pill is-warn" role="status">
            {externalNotice}
            <button
              type="button"
              className="pb-icon-btn"
              style={{ width: 16, height: 16 }}
              aria-label="Dismiss external sync notice"
              onClick={onDismissNotice}
            >
              <X size={11} />
            </button>
          </span>
        ) : null}

        {errorEnvelope ? (
          <span className="pb-status-pill is-err" role="alert">
            <AlertTriangle size={11} />
            [{errorEnvelope.code}] {errorEnvelope.message}
            <button
              type="button"
              className="pb-icon-btn"
              style={{ width: 16, height: 16 }}
              aria-label="Dismiss error"
              onClick={onDismissError}
            >
              <X size={11} />
            </button>
          </span>
        ) : null}
      </div>
    </footer>
  );
}
