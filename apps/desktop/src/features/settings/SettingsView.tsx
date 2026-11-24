import { useState } from "react";
import {
  Archive,
  FolderPlus,
  FolderX,
  HardDriveDownload,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  AppHealthDto,
  BackupResult,
  EditorViewMode,
  ExclusionPreviewDto,
  ReconcileSummary,
  RestoreResult,
  ThemePreference,
  TrashedNoteSummary,
  VaultSummary,
} from "../../lib/contracts";
import { pickDirectoryDialog } from "../../lib/ipc";
import { ExclusionsModal } from "../universe/ExclusionsModal";

interface SettingsViewProps {
  activeVault: VaultSummary | null;
  vaults: VaultSummary[];
  theme: ThemePreference;
  viewMode: EditorViewMode;
  autosaveEnabled: boolean;
  appHealth: AppHealthDto | null;
  trashedNotes: TrashedNoteSummary[];
  isBusy: boolean;
  onChangeTheme: (theme: ThemePreference) => void;
  onChangeViewMode: (mode: EditorViewMode) => void;
  onChangeAutosave: (enabled: boolean) => void;
  onSwitchVault: (vault: VaultSummary) => Promise<void>;
  onOpenOnboarding: () => void;
  onRebuildIndex: () => Promise<ReconcileSummary>;
  onExportMarkdown: (destination: string) => Promise<number>;
  onCreateBackup: (destination: string) => Promise<BackupResult>;
  onRestoreBackup: (
    backupDir: string,
    destination: string,
  ) => Promise<RestoreResult>;
  onRestoreTrashed: (noteId: string) => Promise<void>;
  onRefreshTrash: () => Promise<void>;
  onGetExclusions?: () => Promise<string[]>;
  onPreviewExclusions?: (patterns: string[]) => Promise<ExclusionPreviewDto>;
  onApplyExclusions?: (patterns: string[]) => Promise<ReconcileSummary>;
}

export function SettingsView({
  activeVault,
  vaults,
  theme,
  viewMode,
  autosaveEnabled,
  appHealth,
  trashedNotes,
  isBusy,
  onChangeTheme,
  onChangeViewMode,
  onChangeAutosave,
  onSwitchVault,
  onOpenOnboarding,
  onRebuildIndex,
  onExportMarkdown,
  onCreateBackup,
  onRestoreBackup,
  onRestoreTrashed,
  onRefreshTrash,
  onGetExclusions,
  onPreviewExclusions,
  onApplyExclusions,
}: SettingsViewProps) {
  const [exportDest, setExportDest] = useState("");
  const [backupDest, setBackupDest] = useState("");
  const [restoreBackupDir, setRestoreBackupDir] = useState("");
  const [restoreTargetDir, setRestoreTargetDir] = useState("");
  const [confirmAction, setConfirmAction] = useState<
    "rebuild" | "backup-restore" | null
  >(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [exclusionPatterns, setExclusionPatterns] = useState<string[]>([]);

  async function pickInto(setter: (val: string) => void, title: string) {
    const selected = await pickDirectoryDialog(title);
    if (selected) setter(selected);
  }

  return (
    <section className="pb-page" aria-label="Settings and maintenance">
      <div className="pb-page-inner">
        <header className="pb-page-header">
          <div>
            <h1>Settings &amp; Vault Maintenance</h1>
            <div style={{ color: "var(--text-secondary)", fontSize: 12.5 }}>
              Configure appearance, editor behavior, derived index rebuilds,
              exports, and complete vault backups.
            </div>
          </div>
          <button type="button" className="pb-btn" onClick={onOpenOnboarding}>
            <FolderPlus size={14} /> Open / Create Vault
          </button>
        </header>

        {statusMessage ? (
          <div className="pb-banner pb-banner-info" role="status">
            <span>{statusMessage}</span>
          </div>
        ) : null}

        <section className="pb-surface-card" aria-label="Appearance and editor preferences">
          <h2>Appearance &amp; Editor</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div className="pb-field">
              <label htmlFor="pref-theme">Theme</label>
              <select
                id="pref-theme"
                className="pb-select"
                value={theme}
                onChange={(e) =>
                  onChangeTheme(e.target.value as ThemePreference)
                }
              >
                <option value="system">System default</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>

            <div className="pb-field">
              <label htmlFor="pref-view-mode">Default Note View Mode</label>
              <select
                id="pref-view-mode"
                className="pb-select"
                value={viewMode}
                onChange={(e) =>
                  onChangeViewMode(e.target.value as EditorViewMode)
                }
              >
                <option value="split">Split (Edit + Preview)</option>
                <option value="edit">Edit only</option>
                <option value="preview">Preview only</option>
              </select>
            </div>

            <div className="pb-field">
              <label htmlFor="pref-autosave">Debounced Autosave</label>
              <select
                id="pref-autosave"
                className="pb-select"
                value={autosaveEnabled ? "on" : "off"}
                onChange={(e) => onChangeAutosave(e.target.value === "on")}
              >
                <option value="on">Enabled (recommended)</option>
                <option value="off">Manual Ctrl+S only</option>
              </select>
            </div>
          </div>
        </section>

        <section className="pb-surface-card" aria-label="Vault switching">
          <h2>Registered Vaults ({vaults.length})</h2>
          {vaults.length === 0 ? (
            <p style={{ margin: 0, color: "var(--text-secondary)" }}>
              No vaults registered.
            </p>
          ) : (
            <div className="pb-recent-list">
              {vaults.map((v) => (
                <div key={v.vault_id} className="pb-recent-row">
                  <div className="pb-recent-meta">
                    <strong>
                      {v.display_name}
                      {activeVault?.vault_id === v.vault_id ? " (Active)" : ""}
                    </strong>
                    <span className="pb-recent-path">{v.root_path}</span>
                  </div>
                  <button
                    type="button"
                    className="pb-btn"
                    disabled={isBusy || activeVault?.vault_id === v.vault_id}
                    onClick={() => onSwitchVault(v)}
                  >
                    Switch
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {activeVault ? (
          <>
            <section className="pb-surface-card" aria-label="Index maintenance">
              <h2>Derived Index Rebuild</h2>
              <p style={{ margin: 0, color: "var(--text-secondary)" }}>
                Rebuilds the derived FTS5 and link graph database (`index-gen`)
                for <strong>{activeVault.display_name}</strong> from your
                Markdown files. Durable notes, note IDs, and revisions are
                preserved.
              </p>
              {confirmAction === "rebuild" ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="pb-btn pb-btn-primary"
                    disabled={isBusy}
                    onClick={async () => {
                      setConfirmAction(null);
                      try {
                        const summary = await onRebuildIndex();
                        setStatusMessage(
                          `Index rebuilt to generation #${summary.index_generation} (${summary.indexed_notes} indexed, ${summary.removed_notes} removed).`,
                        );
                      } catch {
                        setStatusMessage(null);
                      }
                    }}
                  >
                    Confirm Rebuild Index
                  </button>
                  <button
                    type="button"
                    className="pb-btn"
                    onClick={() => setConfirmAction(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="pb-btn"
                  disabled={isBusy}
                  onClick={() => setConfirmAction("rebuild")}
                >
                  <RefreshCw size={14} /> Rebuild Derived Index
                </button>
              )}
            </section>

            {onGetExclusions && onPreviewExclusions && onApplyExclusions ? (
              <section className="pb-surface-card" aria-label="Indexing exclusions">
                <h2>Indexing &amp; Graph Exclusions</h2>
                <p style={{ margin: 0, color: "var(--text-secondary)" }}>
                  Exclude dependency folders (<code>node_modules</code>,{" "}
                  <code>target</code>, <code>dist</code>), build outputs, or
                  generated documentation from the derived search and Universe
                  index without modifying files on disk.
                </p>
                <div>
                  <button
                    type="button"
                    className="pb-btn"
                    disabled={isBusy}
                    onClick={async () => {
                      try {
                        setExclusionPatterns(await onGetExclusions());
                      } catch {
                        setExclusionPatterns([]);
                      }
                      setExclusionsOpen(true);
                    }}
                  >
                    <FolderX size={14} /> Manage Index Exclusions…
                  </button>
                </div>
              </section>
            ) : null}

            <section className="pb-surface-card" aria-label="Markdown export and backup">
              <h2>Export &amp; Complete Backup</h2>

              <div className="pb-field">
                <label htmlFor="export-dest-input">
                  Export Markdown Notes Only (clean portable files, no internal DBs)
                </label>
                <div className="pb-input-row">
                  <input
                    id="export-dest-input"
                    className="pb-input pb-input-mono"
                    value={exportDest}
                    onChange={(e) => setExportDest(e.target.value)}
                    placeholder="C:\Exports\MyVaultMarkdown"
                  />
                  <button
                    type="button"
                    className="pb-btn"
                    onClick={() =>
                      pickInto(setExportDest, "Choose Markdown Export Folder")
                    }
                  >
                    Browse…
                  </button>
                  <button
                    type="button"
                    className="pb-btn"
                    disabled={isBusy || !exportDest.trim()}
                    onClick={async () => {
                      try {
                        const count = await onExportMarkdown(exportDest.trim());
                        setStatusMessage(
                          `Exported ${count} vault files to ${exportDest.trim()}.`,
                        );
                      } catch {
                        setStatusMessage(null);
                      }
                    }}
                  >
                    <HardDriveDownload size={14} /> Export Markdown
                  </button>
                </div>
              </div>

              <div className="pb-field">
                <label htmlFor="backup-dest-input">
                  Create Complete Vault Backup (notes + state DB + revision blobs + manifest)
                </label>
                <div className="pb-input-row">
                  <input
                    id="backup-dest-input"
                    className="pb-input pb-input-mono"
                    value={backupDest}
                    onChange={(e) => setBackupDest(e.target.value)}
                    placeholder="C:\Backups\PersonalBrain-Backup"
                  />
                  <button
                    type="button"
                    className="pb-btn"
                    onClick={() =>
                      pickInto(setBackupDest, "Choose Backup Output Folder")
                    }
                  >
                    Browse…
                  </button>
                  <button
                    type="button"
                    className="pb-btn pb-btn-primary"
                    disabled={isBusy || !backupDest.trim()}
                    onClick={async () => {
                      try {
                        const res = await onCreateBackup(backupDest.trim());
                        setStatusMessage(
                          `Backup ${res.backup_id} created (${res.vault_files_count} files, ${res.blobs_count} blobs).`,
                        );
                      } catch {
                        setStatusMessage(null);
                      }
                    }}
                  >
                    <Archive size={14} /> Create Backup
                  </button>
                </div>
              </div>
            </section>

            <section className="pb-surface-card" aria-label="Trashed notes">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h2>
                  <Trash2
                    size={14}
                    style={{ verticalAlign: "-2px", marginRight: 6 }}
                  />
                  Trashed Notes ({trashedNotes.length})
                </h2>
                <button
                  type="button"
                  className="pb-btn pb-btn-sm"
                  disabled={isBusy}
                  onClick={onRefreshTrash}
                >
                  Refresh
                </button>
              </div>
              {trashedNotes.length === 0 ? (
                <p style={{ margin: 0, color: "var(--text-secondary)" }}>
                  No trashed notes in this vault.
                </p>
              ) : (
                <div className="pb-recent-list">
                  {trashedNotes.map((item) => (
                    <div key={item.note_id} className="pb-recent-row">
                      <div className="pb-recent-meta">
                        <strong style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                          {item.rel_path}
                        </strong>
                        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                          Last seen {item.last_seen_at}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="pb-btn pb-btn-sm"
                        disabled={isBusy}
                        onClick={async () => {
                          try {
                            await onRestoreTrashed(item.note_id);
                            setStatusMessage(`Restored ${item.rel_path} from trash.`);
                          } catch {
                            setStatusMessage(null);
                          }
                        }}
                      >
                        <RotateCcw size={12} /> Restore Note
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

        <section className="pb-surface-card" aria-label="Restore backup alongside">
          <h2>Restore Backup Alongside</h2>
          <p style={{ margin: 0, color: "var(--text-secondary)" }}>
            Restores a verified backup bundle into a new directory with a fresh
            vault ID and MCP grants disabled by default. Never overwrites your
            current live vault in place.
          </p>
          <div className="pb-field">
            <label htmlFor="restore-src-input">Backup folder</label>
            <div className="pb-input-row">
              <input
                id="restore-src-input"
                className="pb-input pb-input-mono"
                value={restoreBackupDir}
                onChange={(e) => setRestoreBackupDir(e.target.value)}
                placeholder="C:\Backups\PersonalBrain-Backup"
              />
              <button
                type="button"
                className="pb-btn"
                onClick={() =>
                  pickInto(setRestoreBackupDir, "Select Backup Bundle Folder")
                }
              >
                Browse…
              </button>
            </div>
          </div>
          <div className="pb-field">
            <label htmlFor="restore-dst-input">New destination vault folder</label>
            <div className="pb-input-row">
              <input
                id="restore-dst-input"
                className="pb-input pb-input-mono"
                value={restoreTargetDir}
                onChange={(e) => setRestoreTargetDir(e.target.value)}
                placeholder="C:\Notes\RestoredBrain"
              />
              <button
                type="button"
                className="pb-btn"
                onClick={() =>
                  pickInto(setRestoreTargetDir, "Choose Restore Destination Folder")
                }
              >
                Browse…
              </button>
            </div>
          </div>

          {confirmAction === "backup-restore" ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="pb-btn pb-btn-primary"
                disabled={
                  isBusy || !restoreBackupDir.trim() || !restoreTargetDir.trim()
                }
                onClick={async () => {
                  setConfirmAction(null);
                  try {
                    const res = await onRestoreBackup(
                      restoreBackupDir.trim(),
                      restoreTargetDir.trim(),
                    );
                    setStatusMessage(
                      `Backup restored alongside as vault ${res.restored_vault_id} (${res.restored_files_count} files).`,
                    );
                  } catch {
                    setStatusMessage(null);
                  }
                }}
              >
                Confirm Restore Backup
              </button>
              <button
                type="button"
                className="pb-btn"
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="pb-btn"
              disabled={
                isBusy || !restoreBackupDir.trim() || !restoreTargetDir.trim()
              }
              onClick={() => setConfirmAction("backup-restore")}
            >
              Restore Backup Alongside…
            </button>
          )}
        </section>

        {appHealth ? (
          <section className="pb-surface-card" aria-label="Core diagnostics">
            <h2>Core Runtime Diagnostics</h2>
            <dl className="pb-kv-list">
              <div className="pb-kv-row">
                <dt>Core Version</dt>
                <dd>{appHealth.core_version} ({appHealth.platform})</dd>
              </div>
              <div className="pb-kv-row">
                <dt>SQLite / FTS5</dt>
                <dd>
                  {appHealth.sqlite.sqlite_version} · FTS5{" "}
                  {appHealth.sqlite.fts5_enabled ? "enabled" : "disabled"}
                </dd>
              </div>
              <div className="pb-kv-row">
                <dt>Registry DB</dt>
                <dd>{appHealth.paths.registry_db}</dd>
              </div>
            </dl>
          </section>
        ) : null}
      </div>

      {exclusionsOpen &&
      activeVault &&
      onPreviewExclusions &&
      onApplyExclusions ? (
        <ExclusionsModal
          vaultName={activeVault.display_name}
          initialPatterns={exclusionPatterns}
          onPreview={onPreviewExclusions}
          onApply={async (patterns) => {
            const summary = await onApplyExclusions(patterns);
            setStatusMessage(
              `Exclusions applied; index rebuilt to generation #${summary.index_generation} (${summary.indexed_notes} indexed).`,
            );
            return summary;
          }}
          onClose={() => setExclusionsOpen(false)}
        />
      ) : null}
    </section>
  );
}
