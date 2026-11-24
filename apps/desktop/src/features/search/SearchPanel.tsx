import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import type {
  ErrorEnvelope,
  NoteSummary,
  SearchHit,
} from "../../lib/contracts";
import { normalizeIpcError, searchVaultNotes } from "../../lib/ipc";

interface SearchPanelProps {
  isOpen: boolean;
  vaultId: string;
  notes: NoteSummary[];
  onSelectNote: (noteId: string) => void;
  onClose: () => void;
}

export function SearchPanel({
  isOpen,
  vaultId,
  notes,
  onSelectNote,
  onClose,
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<ErrorEnvelope | null>(null);
  const requestSeqRef = useRef(0);

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const note of notes) {
      const idx = note.rel_path.lastIndexOf("/");
      if (idx > 0) {
        set.add(note.rel_path.slice(0, idx));
      }
    }
    return Array.from(set).sort();
  }, [notes]);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const note of notes) {
      for (const tag of note.tags) {
        set.add(tag);
      }
    }
    return Array.from(set).sort();
  }, [notes]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const seq = ++requestSeqRef.current;

    const timer = window.setTimeout(async () => {
      setIsSearching(true);
      setSearchError(null);
      try {
        const page = await searchVaultNotes(
          vaultId,
          query.trim(),
          {
            folder_prefix: folderFilter || null,
            tag: tagFilter || null,
          },
          20,
        );
        if (cancelled || seq !== requestSeqRef.current) return;
        setHits(page.items);
        setNextCursor(page.next_cursor);
        setActiveIndex(0);
      } catch (err) {
        if (cancelled || seq !== requestSeqRef.current) return;
        setSearchError(normalizeIpcError(err));
      } finally {
        if (!cancelled && seq === requestSeqRef.current) {
          setIsSearching(false);
        }
      }
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, vaultId, query, folderFilter, tagFilter]);

  async function handleLoadMore() {
    if (!nextCursor || isSearching) return;
    const seq = ++requestSeqRef.current;
    setIsSearching(true);
    setSearchError(null);
    try {
      const page = await searchVaultNotes(
        vaultId,
        query.trim(),
        {
          folder_prefix: folderFilter || null,
          tag: tagFilter || null,
        },
        20,
        nextCursor,
      );
      if (seq !== requestSeqRef.current) return;
      setHits((prev) => [...prev, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setSearchError(normalizeIpcError(err));
    } finally {
      if (seq === requestSeqRef.current) {
        setIsSearching(false);
      }
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (hits.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, hits.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Enter") {
      const target = hits[activeIndex];
      if (target) {
        event.preventDefault();
        onSelectNote(target.note_id);
        onClose();
      }
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="pb-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Search vault notes"
      onKeyDown={handleKeyDown}
    >
      <div className="pb-modal">
        <div className="pb-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
            <Search size={15} />
            <input
              className="pb-input"
              style={{ flex: 1, border: "none", padding: 0, height: 24 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles, headings, tags, or note content…"
              aria-label="Search query"
              autoFocus
            />
          </div>
          <button
            type="button"
            className="pb-icon-btn"
            aria-label="Close search"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>

        <div className="pb-modal-body">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select
              className="pb-select"
              aria-label="Filter by folder"
              value={folderFilter}
              onChange={(e) => setFolderFilter(e.target.value)}
            >
              <option value="">All folders</option>
              {folders.map((folder) => (
                <option key={folder} value={folder}>
                  {folder}
                </option>
              ))}
            </select>

            <select
              className="pb-select"
              aria-label="Filter by tag"
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="">All tags</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </select>

            {isSearching ? (
              <span style={{ alignSelf: "center", fontSize: 12, color: "var(--text-muted)" }}>
                Searching…
              </span>
            ) : null}
          </div>

          {searchError ? (
            <div className="pb-banner pb-banner-error" role="alert">
              <span>
                <strong>{searchError.code}:</strong> {searchError.message}
              </span>
            </div>
          ) : null}

          <div className="pb-search-results" role="listbox" aria-label="Search results">
            {hits.length === 0 && !isSearching ? (
              <div style={{ padding: 16, color: "var(--text-secondary)", textAlign: "center" }}>
                No matching notes found.
              </div>
            ) : (
              hits.map((hit, idx) => (
                <button
                  key={`${hit.note_id}:${idx}`}
                  type="button"
                  role="option"
                  aria-selected={idx === activeIndex}
                  className={`pb-search-hit ${idx === activeIndex ? "is-active" : ""}`}
                  onClick={() => {
                    onSelectNote(hit.note_id);
                    onClose();
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{hit.title || hit.rel_path}</strong>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11.5,
                        color: "var(--text-muted)",
                      }}
                    >
                      {hit.rel_path}
                    </span>
                  </div>
                  {hit.snippet ? (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {hit.snippet}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>

          {nextCursor ? (
            <button
              type="button"
              className="pb-btn"
              disabled={isSearching}
              onClick={handleLoadMore}
            >
              Load more results
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
