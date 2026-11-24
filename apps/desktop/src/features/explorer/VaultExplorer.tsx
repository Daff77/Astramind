import { useMemo, useState, type FormEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  Pin,
  Search,
  Trash2,
} from "lucide-react";
import type { NoteSummary, VaultSummary } from "../../lib/contracts";

interface VaultExplorerProps {
  vault: VaultSummary;
  allVaults: VaultSummary[];
  notes: NoteSummary[];
  selectedNoteId: string | null;
  newNoteRequestSeq?: number;
  isBusy: boolean;
  onSwitchVault: (vault: VaultSummary) => void;
  onOpenOtherVault: () => void;
  onSelectNote: (noteId: string) => void;
  onCreateNote: (relPath: string) => Promise<void>;
  onTogglePin: (noteId: string, pinned: boolean) => Promise<void>;
  onRequestMove: (note: NoteSummary) => void;
  onRequestTrash: (note: NoteSummary) => void;
  onOpenSearch: () => void;
}

interface TreeFolderNode {
  kind: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}

interface TreeFileNode {
  kind: "file";
  name: string;
  note: NoteSummary;
}

type TreeNode = TreeFolderNode | TreeFileNode;

function buildTree(notes: NoteSummary[]): TreeNode[] {
  interface MutableFolder {
    name: string;
    path: string;
    folders: Map<string, MutableFolder>;
    files: TreeFileNode[];
  }

  const root: MutableFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };

  for (const note of notes) {
    const parts = note.rel_path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = root;
    for (let idx = 0; idx < parts.length - 1; idx += 1) {
      const segment = parts[idx] ?? "";
      const nextPath = cursor.path ? `${cursor.path}/${segment}` : segment;
      let sub = cursor.folders.get(segment);
      if (!sub) {
        sub = { name: segment, path: nextPath, folders: new Map(), files: [] };
        cursor.folders.set(segment, sub);
      }
      cursor = sub;
    }
    const fileName = parts[parts.length - 1] ?? note.rel_path;
    cursor.files.push({ kind: "file", name: fileName, note });
  }

  function finalize(folder: MutableFolder): TreeNode[] {
    const subFolders: TreeFolderNode[] = Array.from(folder.folders.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((sub) => ({
        kind: "folder",
        name: sub.name,
        path: sub.path,
        children: finalize(sub),
      }));
    const files = folder.files.sort((a, b) => a.name.localeCompare(b.name));
    return [...subFolders, ...files];
  }

  return finalize(root);
}

export function VaultExplorer({
  vault,
  allVaults,
  notes,
  selectedNoteId,
  newNoteRequestSeq = 0,
  isBusy,
  onSwitchVault,
  onOpenOtherVault,
  onSelectNote,
  onCreateNote,
  onTogglePin,
  onRequestMove,
  onRequestTrash,
  onOpenSearch,
}: VaultExplorerProps) {
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [manualShowNewForm, setManualShowNewForm] = useState(false);
  const [dismissedSeq, setDismissedSeq] = useState(0);
  const [newPathInput, setNewPathInput] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const showNewForm = manualShowNewForm || newNoteRequestSeq > dismissedSeq;

  const tree = useMemo(() => buildTree(notes), [notes]);
  const pinnedNotes = useMemo(
    () =>
      notes
        .filter((n) => n.pinned)
        .sort((a, b) => a.rel_path.localeCompare(b.rel_path)),
    [notes],
  );

  function toggleFolder(path: string) {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  async function handleNewNoteSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = newPathInput.trim().replace(/^[/\\]+/, "");
    if (!trimmed) {
      setFormError("Enter a note path, e.g. inbox/idea.md");
      return;
    }
    const relPath = trimmed.toLowerCase().endsWith(".md")
      ? trimmed
      : `${trimmed}.md`;
    setFormError(null);
    try {
      await onCreateNote(relPath);
      setNewPathInput("");
      setManualShowNewForm(false);
      setDismissedSeq(newNoteRequestSeq);
    } catch {
      // Error surfaced via shell status/banner
    }
  }

  function renderNodes(nodes: TreeNode[], depth: number) {
    return nodes.map((node) => {
      if (node.kind === "folder") {
        const isCollapsed = collapsedFolders.has(node.path);
        return (
          <div key={`dir:${node.path}`}>
            <button
              type="button"
              className="pb-tree-row"
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={() => toggleFolder(node.path)}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight size={13} />
              ) : (
                <ChevronDown size={13} />
              )}
              <Folder size={13} />
              <span className="pb-tree-label">{node.name}</span>
            </button>
            {!isCollapsed ? renderNodes(node.children, depth + 1) : null}
          </div>
        );
      }

      const { note } = node;
      const isSelected = note.note_id === selectedNoteId;
      return (
        <div
          key={note.note_id}
          style={{ display: "flex", alignItems: "center", gap: 2 }}
        >
          <button
            type="button"
            className={`pb-tree-row ${isSelected ? "is-selected" : ""}`}
            style={{ paddingLeft: 20 + depth * 14, flex: 1 }}
            title={note.rel_path}
            onClick={() => onSelectNote(note.note_id)}
          >
            <FileText size={13} />
            <span className="pb-tree-label">{node.name}</span>
            {note.pinned ? <Pin size={11} /> : null}
          </button>
          {isSelected ? (
            <>
              <button
                type="button"
                className="pb-icon-btn"
                title={note.pinned ? "Unpin note" : "Pin note"}
                aria-label={note.pinned ? "Unpin note" : "Pin note"}
                onClick={() => onTogglePin(note.note_id, !note.pinned)}
              >
                <Pin size={12} />
              </button>
              <button
                type="button"
                className="pb-icon-btn"
                title="Move or rename note"
                aria-label="Move or rename note"
                onClick={() => onRequestMove(note)}
              >
                <FolderInput size={12} />
              </button>
              <button
                type="button"
                className="pb-icon-btn"
                title="Move note to trash"
                aria-label="Move note to trash"
                onClick={() => onRequestTrash(note)}
              >
                <Trash2 size={12} />
              </button>
            </>
          ) : null}
        </div>
      );
    });
  }

  return (
    <aside className="pb-pane-explorer" aria-label="Vault explorer">
      <div className="pb-pane-header">
        <span className="pb-pane-title">EXPLORER</span>
        <div style={{ display: "flex", gap: 2 }}>
          <button
            type="button"
            className="pb-icon-btn"
            aria-label="Search vault (Ctrl+K)"
            title="Search vault (Ctrl+K)"
            onClick={onOpenSearch}
          >
            <Search size={14} />
          </button>
          <button
            type="button"
            className="pb-icon-btn"
            aria-label="New note (Ctrl+N)"
            title="New note (Ctrl+N)"
            onClick={() => {
              if (showNewForm) {
                setManualShowNewForm(false);
                setDismissedSeq(newNoteRequestSeq);
              } else {
                setManualShowNewForm(true);
              }
            }}
          >
            <FilePlus2 size={14} />
          </button>
          <button
            type="button"
            className="pb-icon-btn"
            aria-label="Open another vault"
            title="Open or create another vault"
            onClick={onOpenOtherVault}
          >
            <FolderOpen size={14} />
          </button>
        </div>
      </div>

      <div className="pb-explorer-controls">
        <label className="pb-field" style={{ gap: 2 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Active Vault
          </span>
          <select
            className="pb-select"
            aria-label="Switch active vault"
            value={vault.vault_id}
            disabled={isBusy}
            onChange={(e) => {
              const target = allVaults.find(
                (v) => v.vault_id === e.target.value,
              );
              if (target) {
                onSwitchVault(target);
              }
            }}
          >
            {allVaults.map((v) => (
              <option key={v.vault_id} value={v.vault_id}>
                {v.display_name} ({v.note_count})
              </option>
            ))}
          </select>
        </label>

        {showNewForm ? (
          <form onSubmit={handleNewNoteSubmit} style={{ display: "grid", gap: 4 }}>
            <input
              className="pb-input pb-input-mono"
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              placeholder="folder/new-note.md"
              aria-label="New note path"
              autoFocus
            />
            {formError ? (
              <span style={{ color: "var(--status-error)", fontSize: 11.5 }}>
                {formError}
              </span>
            ) : null}
            <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                onClick={() => {
                  setManualShowNewForm(false);
                  setDismissedSeq(newNoteRequestSeq);
                  setFormError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="pb-btn pb-btn-primary pb-btn-sm"
                disabled={isBusy}
              >
                Create
              </button>
            </div>
          </form>
        ) : null}
      </div>

      <div className="pb-tree-scroll" role="tree" aria-label="Vault notes">
        {pinnedNotes.length > 0 ? (
          <div style={{ marginBottom: 8 }}>
            <div
              style={{
                padding: "4px 8px",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-muted)",
              }}
            >
              PINNED
            </div>
            {pinnedNotes.map((note) => (
              <button
                key={`pin:${note.note_id}`}
                type="button"
                className={`pb-tree-row ${
                  note.note_id === selectedNoteId ? "is-selected" : ""
                }`}
                style={{ paddingLeft: 8 }}
                title={note.rel_path}
                onClick={() => onSelectNote(note.note_id)}
              >
                <Pin size={12} />
                <span className="pb-tree-label">{note.title || note.rel_path}</span>
              </button>
            ))}
          </div>
        ) : null}

        {notes.length === 0 ? (
          <div style={{ padding: 12, color: "var(--text-secondary)", fontSize: 12.5 }}>
            <p style={{ marginTop: 0 }}>This vault has no Markdown notes yet.</p>
            <button
              type="button"
              className="pb-btn pb-btn-sm"
              onClick={() => setManualShowNewForm(true)}
            >
              Create First Note
            </button>
          </div>
        ) : (
          renderNodes(tree, 0)
        )}
      </div>
    </aside>
  );
}
