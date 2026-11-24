import { useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Columns2,
  Eye,
  FilePlus2,
  FolderInput,
  PanelLeft,
  PanelRight,
  Pencil,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type {
  EditorTabState,
  EditorViewMode,
  MovePlan,
  NoteSummary,
} from "../../lib/contracts";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { SafeMarkdownPreview } from "./SafeMarkdownPreview";

interface EditorWorkspaceProps {
  vaultId: string;
  notes: NoteSummary[];
  tabs: EditorTabState[];
  activeTab: EditorTabState | null;
  viewMode: EditorViewMode;
  showExplorer: boolean;
  showInspector: boolean;
  isBusy: boolean;
  onChangeViewMode: (mode: EditorViewMode) => void;
  onToggleExplorer: () => void;
  onToggleInspector: () => void;
  onSelectTab: (noteId: string) => void;
  onRequestCloseTab: (noteId: string) => void;
  onChangeDraft: (noteId: string, nextBody: string) => void;
  onSaveTab: (noteId: string) => Promise<void>;
  onCreateNotePrompt: (relPath: string) => Promise<void>;
  onPreviewMove: (noteId: string, destination: string) => Promise<MovePlan>;
  onConfirmMove: (plan: MovePlan, expectedHash: string) => Promise<void>;
  onConfirmTrash: (noteId: string, expectedHash: string) => Promise<void>;
  onResolveReloadExternal: (noteId: string) => Promise<void>;
  onResolveSaveCopy: (noteId: string) => Promise<void>;
  onResolveOverwriteDisk: (noteId: string) => Promise<void>;
  onCloseDeletedTab: (noteId: string) => void;
  onOpenWikilink: (rawTarget: string) => void;
  onRestorePendingDraft?: (noteId: string) => Promise<void>;
  onDiscardPendingDraft?: (noteId: string) => Promise<void>;
  pendingCloseTab: EditorTabState | null;
  onCancelClosePending: () => void;
  onConfirmDiscardClosePending: () => void;
  onConfirmSaveAndClosePending: () => Promise<void>;
  moveModalNote: NoteSummary | null;
  onCloseMoveModal: () => void;
  trashModalNote: NoteSummary | null;
  onCloseTrashModal: () => void;
}

export function EditorWorkspace({
  activeTab,
  tabs,
  viewMode,
  showExplorer,
  showInspector,
  isBusy,
  onChangeViewMode,
  onToggleExplorer,
  onToggleInspector,
  onSelectTab,
  onRequestCloseTab,
  onChangeDraft,
  onSaveTab,
  onCreateNotePrompt,
  onPreviewMove,
  onConfirmMove,
  onConfirmTrash,
  onResolveReloadExternal,
  onResolveSaveCopy,
  onResolveOverwriteDisk,
  onCloseDeletedTab,
  onOpenWikilink,
  onRestorePendingDraft,
  onDiscardPendingDraft,
  pendingCloseTab,
  onCancelClosePending,
  onConfirmDiscardClosePending,
  onConfirmSaveAndClosePending,
  moveModalNote,
  onCloseMoveModal,
  trashModalNote,
  onCloseTrashModal,
}: EditorWorkspaceProps) {
  const [conflictModalOpen, setConflictModalOpen] = useState(false);
  const [quickCreatePath, setQuickCreatePath] = useState("");
  const [moveDest, setMoveDest] = useState("");
  const [movePlan, setMovePlan] = useState<MovePlan | null>(null);
  const [moveBusy, setMoveBusy] = useState(false);

  async function handleQuickCreate(event: FormEvent) {
    event.preventDefault();
    const trimmed = quickCreatePath.trim();
    if (!trimmed) return;
    const relPath = trimmed.toLowerCase().endsWith(".md")
      ? trimmed
      : `${trimmed}.md`;
    try {
      await onCreateNotePrompt(relPath);
      setQuickCreatePath("");
    } catch {
      // Error surfaced via shell status/banner
    }
  }

  async function handleRunMovePreview(event: FormEvent) {
    event.preventDefault();
    if (!moveModalNote || !moveDest.trim()) return;
    setMoveBusy(true);
    try {
      const plan = await onPreviewMove(
        moveModalNote.note_id,
        moveDest.trim(),
      );
      setMovePlan(plan);
    } catch {
      setMovePlan(null);
    } finally {
      setMoveBusy(false);
    }
  }

  return (
    <main className="pb-editor-column" aria-label="Markdown editor workspace">
      <div className="pb-tabbar" role="tablist" aria-label="Open notes">
        <button
          type="button"
          className="pb-icon-btn"
          style={{ marginLeft: 4 }}
          aria-label="Toggle explorer (Ctrl+B)"
          aria-pressed={showExplorer}
          title="Toggle explorer (Ctrl+B)"
          onClick={onToggleExplorer}
        >
          <PanelLeft size={14} />
        </button>

        {tabs.map((tab) => {
          const isActive = activeTab?.noteId === tab.noteId;
          return (
            <div
              key={tab.noteId}
              className={`pb-tab ${isActive ? "is-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="pb-tab-btn"
                title={tab.relPath}
                onClick={() => onSelectTab(tab.noteId)}
              >
                {tab.dirty ? (
                  <span className="pb-tab-dirty" aria-label="Unsaved changes" />
                ) : null}
                <span className="pb-tab-title">
                  {tab.title || tab.relPath}
                </span>
              </button>
              <button
                type="button"
                className="pb-icon-btn pb-tab-close"
                aria-label={`Close ${tab.title || tab.relPath}`}
                onClick={() => onRequestCloseTab(tab.noteId)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}

        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="pb-icon-btn"
          style={{ marginRight: 4 }}
          aria-label="Toggle inspector (Ctrl+Shift+I)"
          aria-pressed={showInspector}
          title="Toggle inspector (Ctrl+Shift+I)"
          onClick={onToggleInspector}
        >
          <PanelRight size={14} />
        </button>
      </div>

      {activeTab ? (
        <>
          <div className="pb-editor-toolbar">
            <span className="pb-breadcrumbs" title={activeTab.relPath}>
              {activeTab.relPath}
            </span>

            <div className="pb-toolbar-actions">
              <div
                className="pb-segmented"
                role="group"
                aria-label="Editor view mode"
              >
                <button
                  type="button"
                  className={viewMode === "edit" ? "is-active" : ""}
                  onClick={() => onChangeViewMode("edit")}
                >
                  <Pencil size={11} style={{ marginRight: 4 }} />
                  Edit
                </button>
                <button
                  type="button"
                  className={viewMode === "split" ? "is-active" : ""}
                  onClick={() => onChangeViewMode("split")}
                >
                  <Columns2 size={11} style={{ marginRight: 4 }} />
                  Split
                </button>
                <button
                  type="button"
                  className={viewMode === "preview" ? "is-active" : ""}
                  onClick={() => onChangeViewMode("preview")}
                >
                  <Eye size={11} style={{ marginRight: 4 }} />
                  Preview
                </button>
              </div>

              <button
                type="button"
                className="pb-btn pb-btn-sm"
                disabled={isBusy || !activeTab.dirty || Boolean(activeTab.conflict)}
                onClick={() => onSaveTab(activeTab.noteId)}
              >
                <Save size={12} /> Save
              </button>
            </div>
          </div>

          {activeTab.parseStatus === "unsupported" ? (
            <div className="pb-banner pb-banner-warn" role="status">
              <span>
                This note is marked unsupported (for example invalid UTF-8) and is
                open read-only to prevent corruption.
              </span>
            </div>
          ) : null}

          {activeTab.pendingDraftOffer ? (
            <div className="pb-banner pb-banner-warn" role="status">
              <span>
                Recovered unsaved draft ({activeTab.pendingDraftOffer.updated_at}
                {activeTab.pendingDraftOffer.base_hash !== activeTab.baseHash
                  ? " — note changed on disk since draft was saved"
                  : ""}
                ). Restore it into editor or discard it?
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  className="pb-btn pb-btn-sm pb-btn-primary"
                  onClick={() => onRestorePendingDraft?.(activeTab.noteId)}
                >
                  Restore Draft
                </button>
                <button
                  type="button"
                  className="pb-btn pb-btn-sm"
                  onClick={() => onDiscardPendingDraft?.(activeTab.noteId)}
                >
                  Discard Saved Draft
                </button>
              </div>
            </div>
          ) : null}

          {activeTab.externalUpdateNotice ? (
            <div className="pb-banner pb-banner-info" role="status">
              <span>{activeTab.externalUpdateNotice}</span>
            </div>
          ) : null}

          {activeTab.conflict ? (
            <div className="pb-banner pb-banner-error" role="alert">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <AlertTriangle size={14} />
                {activeTab.conflict.message}
              </span>
              <button
                type="button"
                className="pb-btn pb-btn-sm pb-btn-danger"
                onClick={() => setConflictModalOpen(true)}
              >
                Review Conflict
              </button>
            </div>
          ) : null}

          <div
            className={`pb-editor-panes ${
              viewMode === "split" ? "is-split" : ""
            }`}
          >
            {viewMode === "edit" || viewMode === "split" ? (
              <CodeMirrorEditor
                noteId={activeTab.noteId}
                value={activeTab.draftBody}
                readOnly={activeTab.parseStatus === "unsupported"}
                onChange={(next) => onChangeDraft(activeTab.noteId, next)}
                onSaveShortcut={() => {
                  void onSaveTab(activeTab.noteId);
                }}
              />
            ) : null}

            {viewMode === "preview" || viewMode === "split" ? (
              <SafeMarkdownPreview
                markdown={activeTab.draftBody}
                onOpenWikilink={onOpenWikilink}
              />
            ) : null}
          </div>
        </>
      ) : (
        <div className="pb-empty-state">
          <div className="pb-empty-box">
            <h2 style={{ margin: 0, fontSize: 16 }}>No note open</h2>
            <p style={{ margin: 0 }}>
              Select a Markdown note from the Explorer, press Ctrl+K to search,
              or create a new note below.
            </p>
            <form
              onSubmit={handleQuickCreate}
              style={{ display: "flex", gap: 6, width: "100%" }}
            >
              <input
                className="pb-input pb-input-mono"
                style={{ flex: 1 }}
                value={quickCreatePath}
                onChange={(e) => setQuickCreatePath(e.target.value)}
                placeholder="notes/today.md"
                aria-label="Quick create note path"
              />
              <button type="submit" className="pb-btn pb-btn-primary">
                <FilePlus2 size={14} /> Create Note
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Unsaved Tab Close Confirmation */}
      {pendingCloseTab ? (
        <div
          className="pb-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Unsaved changes confirmation"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancelClosePending();
            }
          }}
        >
          <div className="pb-modal">
            <div className="pb-modal-header">
              <h2>Unsaved changes in {pendingCloseTab.relPath}</h2>
            </div>
            <div className="pb-modal-body">
              <p style={{ margin: 0 }}>
                Save your edits to disk before closing this tab, or discard them.
              </p>
            </div>
            <div className="pb-modal-footer">
              <button
                type="button"
                className="pb-btn"
                onClick={onCancelClosePending}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-danger"
                onClick={onConfirmDiscardClosePending}
              >
                Discard Changes
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-primary"
                onClick={onConfirmSaveAndClosePending}
              >
                Save &amp; Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Move / Rename Preview Modal */}
      {moveModalNote ? (
        <div
          className="pb-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Move or rename note"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setMovePlan(null);
              setMoveDest("");
              onCloseMoveModal();
            }
          }}
        >
          <div className="pb-modal">
            <div className="pb-modal-header">
              <h2>
                <FolderInput size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                Move or Rename Note
              </h2>
              <button
                type="button"
                className="pb-icon-btn"
                aria-label="Close move dialog"
                onClick={() => {
                  setMovePlan(null);
                  setMoveDest("");
                  onCloseMoveModal();
                }}
              >
                <X size={15} />
              </button>
            </div>

            <div className="pb-modal-body">
              <div className="pb-field">
                <label>Current path</label>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                  {moveModalNote.rel_path}
                </div>
              </div>

              <form onSubmit={handleRunMovePreview} className="pb-field">
                <label htmlFor="move-dest-input">Destination path</label>
                <div className="pb-input-row">
                  <input
                    id="move-dest-input"
                    className="pb-input pb-input-mono"
                    value={moveDest}
                    onChange={(e) => {
                      setMoveDest(e.target.value);
                      setMovePlan(null);
                    }}
                    placeholder={moveModalNote.rel_path}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="pb-btn"
                    disabled={moveBusy || !moveDest.trim()}
                  >
                    Preview Move
                  </button>
                </div>
              </form>

              {movePlan ? (
                <div className="pb-surface-card">
                  <div>
                    <strong>Move Plan Preview</strong>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {movePlan.old_rel_path} → {movePlan.new_rel_path}
                    </div>
                  </div>
                  <div style={{ fontSize: 12.5 }}>
                    Affected incoming backlinks:{" "}
                    <strong>{movePlan.affected_backlinks.length}</strong>
                  </div>
                  {movePlan.affected_backlinks.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                      {movePlan.affected_backlinks.map((hit, idx) => (
                        <li key={`${hit.source_note_id}:${idx}`}>
                          {hit.source_rel_path} (L{hit.line_number}:{" "}
                          <code>{hit.raw_target}</code>)
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="pb-modal-footer">
              <button
                type="button"
                className="pb-btn"
                onClick={() => {
                  setMovePlan(null);
                  setMoveDest("");
                  onCloseMoveModal();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-primary"
                disabled={!movePlan || moveBusy}
                onClick={async () => {
                  if (!movePlan) return;
                  setMoveBusy(true);
                  try {
                    const expectedHash =
                      activeTab?.noteId === moveModalNote.note_id
                        ? activeTab.baseHash
                        : moveModalNote.content_hash;
                    await onConfirmMove(movePlan, expectedHash);
                    setMovePlan(null);
                    setMoveDest("");
                  } finally {
                    setMoveBusy(false);
                  }
                }}
              >
                Confirm Move
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Trash Confirmation Modal */}
      {trashModalNote ? (
        <div
          className="pb-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Move note to trash"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCloseTrashModal();
            }
          }}
        >
          <div className="pb-modal">
            <div className="pb-modal-header">
              <h2>
                <Trash2 size={15} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                Move Note to Trash
              </h2>
            </div>
            <div className="pb-modal-body">
              <p style={{ margin: 0 }}>
                Move <code>{trashModalNote.rel_path}</code> to vault trash? You
                can restore trashed notes from Settings.
              </p>
            </div>
            <div className="pb-modal-footer">
              <button
                type="button"
                className="pb-btn"
                onClick={onCloseTrashModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-danger"
                onClick={async () => {
                  const expectedHash =
                    activeTab?.noteId === trashModalNote.note_id
                      ? activeTab.baseHash
                      : trashModalNote.content_hash;
                  await onConfirmTrash(trashModalNote.note_id, expectedHash);
                }}
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* External Conflict Resolution Modal */}
      {activeTab?.conflict && conflictModalOpen ? (
        <div
          className="pb-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Resolve external modification conflict"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setConflictModalOpen(false);
            }
          }}
        >
          <div className="pb-modal pb-modal-wide">
            <div className="pb-modal-header">
              <h2>Conflict Resolution — {activeTab.conflict.relPath}</h2>
              <button
                type="button"
                className="pb-icon-btn"
                aria-label="Close conflict dialog"
                onClick={() => setConflictModalOpen(false)}
              >
                <X size={15} />
              </button>
            </div>

            <div className="pb-modal-body">
              <p style={{ margin: 0 }}>{activeTab.conflict.message}</p>

              <div className="pb-diff-grid">
                <div className="pb-diff-pane">
                  <div className="pb-diff-head">Your Local Unsaved Draft</div>
                  <pre className="pb-diff-pre">{activeTab.conflict.localBody}</pre>
                </div>
                <div className="pb-diff-pane">
                  <div className="pb-diff-head">
                    {activeTab.conflict.kind === "modified"
                      ? "Current On-Disk External Version"
                      : "On-Disk File Status"}
                  </div>
                  <pre className="pb-diff-pre">
                    {activeTab.conflict.externalBody ??
                      "(File deleted or moved externally on disk)"}
                  </pre>
                </div>
              </div>
            </div>

            <div className="pb-modal-footer">
              <button
                type="button"
                className="pb-btn"
                onClick={async () => {
                  await onResolveSaveCopy(activeTab.noteId);
                  setConflictModalOpen(false);
                }}
              >
                Save Local as Copy
              </button>

              {activeTab.conflict.kind === "modified" ? (
                <>
                  <button
                    type="button"
                    className="pb-btn"
                    onClick={async () => {
                      await onResolveReloadExternal(activeTab.noteId);
                      setConflictModalOpen(false);
                    }}
                  >
                    Reload External
                  </button>
                  <button
                    type="button"
                    className="pb-btn pb-btn-danger"
                    onClick={async () => {
                      await onResolveOverwriteDisk(activeTab.noteId);
                      setConflictModalOpen(false);
                    }}
                  >
                    Overwrite Disk with Local
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="pb-btn pb-btn-danger"
                  onClick={() => {
                    setConflictModalOpen(false);
                    onCloseDeletedTab(activeTab.noteId);
                  }}
                >
                  Discard &amp; Close Tab
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
