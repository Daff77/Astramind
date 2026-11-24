import { useState } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  History,
  Link2,
  Pin,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type {
  BacklinkHit,
  BrokenLinkDto,
  EditorTabState,
  RevisionSummaryDto,
} from "../../lib/contracts";

interface NoteInspectorProps {
  note: EditorTabState | null;
  backlinks: BacklinkHit[];
  revisions: RevisionSummaryDto[];
  brokenLinks: BrokenLinkDto[];
  isLoadingDetails: boolean;
  onTogglePin: (noteId: string, pinned: boolean) => Promise<void>;
  onOpenNote: (noteId: string) => void;
  onRestoreRevision: (revision: RevisionSummaryDto) => Promise<void>;
  onRefreshDetails: () => void;
}

export function NoteInspector({
  note,
  backlinks,
  revisions,
  brokenLinks,
  isLoadingDetails,
  onTogglePin,
  onOpenNote,
  onRestoreRevision,
  onRefreshDetails,
}: NoteInspectorProps) {
  const [confirmRevisionId, setConfirmRevisionId] = useState<string | null>(
    null,
  );

  if (!note) {
    return (
      <aside className="pb-pane-inspector" aria-label="Note inspector">
        <div className="pb-pane-header">
          <span className="pb-pane-title">INSPECTOR</span>
        </div>
        <div style={{ padding: 16, color: "var(--text-secondary)", fontSize: 12.5 }}>
          Select or create a note to inspect metadata, backlinks, broken links,
          and revision history.
        </div>
      </aside>
    );
  }

  const noteBrokenLinks = brokenLinks.filter(
    (item) => item.source_note_id === note.noteId,
  );

  return (
    <aside className="pb-pane-inspector" aria-label="Note inspector">
      <div className="pb-pane-header">
        <span className="pb-pane-title">INSPECTOR</span>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            type="button"
            className="pb-icon-btn"
            aria-label={note.pinned ? "Unpin note" : "Pin note"}
            title={note.pinned ? "Unpin note" : "Pin note"}
            onClick={() => onTogglePin(note.noteId, !note.pinned)}
          >
            <Pin size={13} />
          </button>
          <button
            type="button"
            className="pb-icon-btn"
            aria-label="Refresh inspector"
            title="Refresh backlinks and revisions"
            disabled={isLoadingDetails}
            onClick={onRefreshDetails}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      <section className="pb-inspector-section">
        <h3>Properties</h3>
        <dl className="pb-kv-compact">
          <div className="pb-kv-compact-row">
            <dt>Path</dt>
            <dd>{note.relPath}</dd>
          </div>
          <div className="pb-kv-compact-row">
            <dt>Origin</dt>
            <dd>{note.origin}</dd>
          </div>
          <div className="pb-kv-compact-row">
            <dt>Verification</dt>
            <dd>{note.verification}</dd>
          </div>
          <div className="pb-kv-compact-row">
            <dt>Parse</dt>
            <dd>
              <span
                className={`pb-badge ${
                  note.parseStatus === "ok"
                    ? "pb-badge-ok"
                    : note.parseStatus === "warning"
                      ? "pb-badge-warn"
                      : "pb-badge-err"
                }`}
              >
                {note.parseStatus}
              </span>
            </dd>
          </div>
          <div className="pb-kv-compact-row">
            <dt>Generation</dt>
            <dd>#{note.indexGeneration}</dd>
          </div>
        </dl>

        {note.tags.length > 0 ? (
          <div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 4 }}>
              Tags
            </div>
            <div className="pb-tag-list">
              {note.tags.map((tag) => (
                <span key={tag} className="pb-badge">
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {note.aliases.length > 0 ? (
          <div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginBottom: 4 }}>
              Aliases
            </div>
            <div className="pb-tag-list">
              {note.aliases.map((alias) => (
                <span key={alias} className="pb-badge">
                  {alias}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="pb-inspector-section">
        <h3>
          <Link2 size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
          Backlinks ({backlinks.length})
        </h3>
        {backlinks.length === 0 ? (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            No incoming links reference this note.
          </span>
        ) : (
          <div className="pb-note-link-list">
            {backlinks.map((hit, idx) => (
              <button
                key={`${hit.source_note_id}:${hit.line_number}:${idx}`}
                type="button"
                className="pb-note-link-item"
                onClick={() => onOpenNote(hit.source_note_id)}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hit.source_title || hit.source_rel_path}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    flexShrink: 0,
                  }}
                >
                  L{hit.line_number}
                  <ArrowUpRight size={11} />
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {noteBrokenLinks.length > 0 ? (
        <section className="pb-inspector-section">
          <h3>
            <AlertTriangle
              size={12}
              style={{ verticalAlign: "-1px", marginRight: 4, color: "var(--status-warning)" }}
            />
            Unresolved Links ({noteBrokenLinks.length})
          </h3>
          <div style={{ display: "grid", gap: 4 }}>
            {noteBrokenLinks.map((link, idx) => (
              <div
                key={`${link.raw_target}:${link.line_number}:${idx}`}
                style={{
                  fontSize: 12,
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {link.raw_target}
                </span>
                <span className="pb-badge pb-badge-warn">
                  {link.resolution} · L{link.line_number}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="pb-inspector-section">
        <h3>
          <History size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
          Revision History ({revisions.length})
        </h3>
        {revisions.length === 0 ? (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            No recorded revisions yet.
          </span>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {revisions.slice(0, 12).map((rev) => (
              <div
                key={rev.revision_id}
                style={{
                  border: "1px solid var(--border-hairline)",
                  borderRadius: "var(--radius-sm)",
                  padding: "6px 8px",
                  display: "grid",
                  gap: 4,
                  fontSize: 11.5,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                  <strong>{rev.actor_key}</strong>
                  <span style={{ color: "var(--text-muted)" }}>
                    {rev.created_at}
                  </span>
                </div>
                {rev.new_path ? (
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                    {rev.new_path}
                  </span>
                ) : null}

                {confirmRevisionId === rev.revision_id ? (
                  <div style={{ display: "grid", gap: 4 }}>
                    {note.dirty ? (
                      <span style={{ color: "var(--status-warning)", fontSize: 11 }}>
                        Unsaved edits in this tab will be replaced by this revision.
                      </span>
                    ) : null}
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button
                        type="button"
                        className="pb-btn pb-btn-sm"
                        onClick={() => setConfirmRevisionId(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="pb-btn pb-btn-primary pb-btn-sm"
                        onClick={async () => {
                          setConfirmRevisionId(null);
                          await onRestoreRevision(rev);
                        }}
                      >
                        Confirm Restore
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="pb-btn pb-btn-sm"
                    style={{ width: "fit-content" }}
                    onClick={() => setConfirmRevisionId(rev.revision_id)}
                  >
                    <RotateCcw size={11} /> Restore Revision
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
