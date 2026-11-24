import {
  AlertTriangle,
  BookOpen,
  Database,
  FileText,
  FolderPlus,
  Pin,
  Search,
} from "lucide-react";
import type {
  AppHealthDto,
  NoteSummary,
  VaultSummary,
} from "../../lib/contracts";

interface HomeDashboardProps {
  activeVault: VaultSummary | null;
  vaults: VaultSummary[];
  notes: NoteSummary[];
  brokenLinksCount: number;
  recentNoteIds: string[];
  appHealth: AppHealthDto | null;
  onOpenKnowledge: () => void;
  onOpenNote: (noteId: string) => void;
  onSelectVault: (vault: VaultSummary) => void;
  onOpenSearch: () => void;
  onOpenOnboarding: () => void;
}

export function HomeDashboard({
  activeVault,
  vaults,
  notes,
  brokenLinksCount,
  recentNoteIds,
  appHealth,
  onOpenKnowledge,
  onOpenNote,
  onSelectVault,
  onOpenSearch,
  onOpenOnboarding,
}: HomeDashboardProps) {
  const pinnedNotes = notes.filter((n) => n.pinned);
  const recentNotes = recentNoteIds
    .map((id) => notes.find((n) => n.note_id === id))
    .filter((n): n is NoteSummary => Boolean(n));

  return (
    <section className="pb-page" aria-label="Home workspace">
      <div className="pb-page-inner">
        <header className="pb-page-header">
          <div>
            <h1>
              {activeVault ? activeVault.display_name : "Personal Brain"}
            </h1>
            <div style={{ color: "var(--text-secondary)", fontSize: 12.5 }}>
              {activeVault ? activeVault.root_path : "Local-first Markdown vault workspace"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {activeVault ? (
              <>
                <button
                  type="button"
                  className="pb-btn pb-btn-primary"
                  onClick={onOpenKnowledge}
                >
                  <BookOpen size={14} /> Open Workspace
                </button>
                <button
                  type="button"
                  className="pb-btn"
                  onClick={onOpenSearch}
                >
                  <Search size={14} /> Search Notes
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="pb-btn"
              onClick={onOpenOnboarding}
            >
              <FolderPlus size={14} /> Open / Create Vault
            </button>
          </div>
        </header>

        {activeVault ? (
          <>
            <div className="pb-stat-grid">
              <div className="pb-stat-box">
                <span className="pb-stat-label">Indexed Notes</span>
                <span className="pb-stat-value">{notes.length}</span>
              </div>
              <div className="pb-stat-box">
                <span className="pb-stat-label">Pinned Notes</span>
                <span className="pb-stat-value">{pinnedNotes.length}</span>
              </div>
              <div className="pb-stat-box">
                <span className="pb-stat-label">Broken / Ambiguous Links</span>
                <span className="pb-stat-value">{brokenLinksCount}</span>
              </div>
              <div className="pb-stat-box">
                <span className="pb-stat-label">Index Generation</span>
                <span className="pb-stat-value">
                  #{activeVault.active_index_generation}
                </span>
              </div>
            </div>

            <div className="pb-home-columns">
              <section className="pb-surface-card" aria-label="Pinned notes">
                <h2>
                  <Pin
                    size={14}
                    style={{ verticalAlign: "-2px", marginRight: 6 }}
                  />
                  Pinned Notes
                </h2>
                {pinnedNotes.length === 0 ? (
                  <p style={{ margin: 0, color: "var(--text-secondary)" }}>
                    Pin important notes from the explorer or inspector for quick
                    access.
                  </p>
                ) : (
                  <div className="pb-note-link-list">
                    {pinnedNotes.map((note) => (
                      <button
                        key={note.note_id}
                        type="button"
                        className="pb-note-link-item"
                        onClick={() => onOpenNote(note.note_id)}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            minWidth: 0,
                          }}
                        >
                          <FileText size={13} />
                          <span>{note.title || note.rel_path}</span>
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 11.5,
                            color: "var(--text-muted)",
                          }}
                        >
                          {note.rel_path}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="pb-surface-card" aria-label="Recent notes">
                <h2>Recent Notes</h2>
                {recentNotes.length === 0 ? (
                  <p style={{ margin: 0, color: "var(--text-secondary)" }}>
                    Open a note in the Knowledge workspace to track recent
                    reading and edits.
                  </p>
                ) : (
                  <div className="pb-note-link-list">
                    {recentNotes.map((note) => (
                      <button
                        key={note.note_id}
                        type="button"
                        className="pb-note-link-item"
                        onClick={() => onOpenNote(note.note_id)}
                      >
                        <span>{note.title || note.rel_path}</span>
                        <span
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: 11.5,
                            color: "var(--text-muted)",
                          }}
                        >
                          {note.rel_path}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </>
        ) : null}

        <section className="pb-surface-card" aria-label="Registered vaults">
          <h2>
            <Database
              size={14}
              style={{ verticalAlign: "-2px", marginRight: 6 }}
            />
            Registered Vaults ({vaults.length})
          </h2>
          {vaults.length === 0 ? (
            <p style={{ margin: 0, color: "var(--text-secondary)" }}>
              No vaults registered yet. Open or create a local vault folder to
              begin.
            </p>
          ) : (
            <div className="pb-recent-list">
              {vaults.map((vault) => (
                <div key={vault.vault_id} className="pb-recent-row">
                  <div className="pb-recent-meta">
                    <strong>
                      {vault.display_name}
                      {activeVault?.vault_id === vault.vault_id
                        ? " (Active)"
                        : ""}
                    </strong>
                    <span className="pb-recent-path">{vault.root_path}</span>
                  </div>
                  <button
                    type="button"
                    className="pb-btn"
                    onClick={() => onSelectVault(vault)}
                  >
                    {activeVault?.vault_id === vault.vault_id
                      ? "Workspace"
                      : "Switch"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {appHealth && !appHealth.sqlite.fts5_enabled ? (
          <div className="pb-banner pb-banner-error" role="alert">
            <AlertTriangle size={14} />
            <span>SQLite FTS5 probe failed. Search may be unavailable.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
