import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Compass,
  FileText,
  FilterX,
  Focus,
  List,
  Maximize2,
  Orbit,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type { BrokenLinkDto, GraphSnapshotDto } from "../../lib/contracts";
import {
  CLUSTER_PALETTE,
  filterGraphModel,
  normalizeGraphSnapshot,
  type GraphNodeModel,
} from "./graphModel";
import { GalaxyCanvas, type GalaxyCanvasHandle } from "./GalaxyCanvas";

interface UniverseViewProps {
  graphSnapshot: GraphSnapshotDto | null;
  brokenLinks: BrokenLinkDto[];
  selectedNodeId: string | null;
  isLoading: boolean;
  isDarkTheme: boolean;
  reducedMotion: boolean;
  onSelectNodeId: (noteId: string | null) => void;
  onOpenNote: (noteId: string) => void;
  onRefreshGraph: () => void;
}

export function UniverseView({
  graphSnapshot,
  brokenLinks,
  selectedNodeId,
  isLoading,
  isDarkTheme,
  reducedMotion,
  onSelectNodeId,
  onOpenNote,
  onRefreshGraph,
}: UniverseViewProps) {
  const canvasRef = useRef<GalaxyCanvasHandle | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [viewMode, setViewMode] = useState<"3d" | "list">("3d");
  const [webglError, setWebglError] = useState<string | null>(null);

  const normalized = useMemo(() => {
    if (!graphSnapshot) return null;
    return normalizeGraphSnapshot(graphSnapshot, brokenLinks);
  }, [graphSnapshot, brokenLinks]);

  const filtered = useMemo(() => {
    if (!normalized) return null;
    return filterGraphModel(normalized, {
      query: searchQuery,
      folder: folderFilter,
      tag: tagFilter,
    });
  }, [normalized, searchQuery, folderFilter, tagFilter]);

  const selectedNode: GraphNodeModel | null = useMemo(() => {
    if (!normalized || !selectedNodeId) return null;
    return normalized.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [normalized, selectedNodeId]);

  const selectedRelations = useMemo(() => {
    if (!normalized || !selectedNode) {
      return { incoming: [] as GraphNodeModel[], outgoing: [] as GraphNodeModel[] };
    }
    const byId = new Map(normalized.nodes.map((n) => [n.id, n]));
    const incoming: GraphNodeModel[] = [];
    const outgoing: GraphNodeModel[] = [];
    const seenIn = new Set<string>();
    const seenOut = new Set<string>();

    for (const e of normalized.edges) {
      if (e.target === selectedNode.id && !seenIn.has(e.source)) {
        const src = byId.get(e.source);
        if (src) {
          seenIn.add(src.id);
          incoming.push(src);
        }
      }
      if (e.source === selectedNode.id && !seenOut.has(e.target)) {
        const dst = byId.get(e.target);
        if (dst) {
          seenOut.add(dst.id);
          outgoing.push(dst);
        }
      }
    }
    return { incoming, outgoing };
  }, [normalized, selectedNode]);

  function clearFilters() {
    setSearchQuery("");
    setFolderFilter("");
    setTagFilter("");
  }

  const effectiveMode = webglError ? "list" : viewMode;

  return (
    <section className="pb-universe-shell" aria-label="Knowledge Universe">
      <header className="pb-universe-toolbar">
        <div className="pb-universe-filters">
          <input
            className="pb-input"
            style={{ width: 190 }}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search stars, paths, tags…"
            aria-label="Search graph nodes"
          />

          <select
            className="pb-select"
            aria-label="Filter graph by folder"
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
          >
            <option value="">All clusters</option>
            {normalized?.availableFolders.map((folder) => (
              <option key={folder} value={folder}>
                {folder === "(root)" ? "Root Notes" : folder}
              </option>
            ))}
          </select>

          <select
            className="pb-select"
            aria-label="Filter graph by tag"
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
          >
            <option value="">All tags</option>
            {normalized?.availableTags.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
              </option>
            ))}
          </select>

          {filtered?.isFiltered ? (
            <button
              type="button"
              className="pb-btn pb-btn-sm"
              onClick={clearFilters}
            >
              <FilterX size={13} /> Clear Filters
            </button>
          ) : null}
        </div>

        <div className="pb-universe-controls">
          {filtered ? (
            <span className="pb-badge" title="Active visible graph statistics">
              {filtered.nodes.length}/{filtered.totalNodes} stars ·{" "}
              {filtered.edges.length} links · Gen #{normalized?.generation ?? 0}
            </span>
          ) : null}

          {normalized && normalized.nodes.length > 24 && effectiveMode === "3d" ? (
            <span
              className="pb-badge"
              title="Only top 24 labels (selected, neighbors, hubs) are displayed concurrently for readability."
            >
              Labels capped (24)
            </span>
          ) : null}

          <div className="pb-segmented" role="group" aria-label="Universe display mode">
            <button
              type="button"
              className={effectiveMode === "3d" ? "is-active" : ""}
              disabled={Boolean(webglError)}
              onClick={() => setViewMode("3d")}
            >
              <Orbit size={12} style={{ marginRight: 4 }} />
              3D
            </button>
            <button
              type="button"
              className={effectiveMode === "list" ? "is-active" : ""}
              onClick={() => setViewMode("list")}
            >
              <List size={12} style={{ marginRight: 4 }} />
              List
            </button>
          </div>

          {effectiveMode === "3d" ? (
            <>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                onClick={() => canvasRef.current?.fitAll()}
              >
                <Maximize2 size={12} /> Fit All
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                onClick={() => canvasRef.current?.resetCamera()}
              >
                <RotateCcw size={12} /> Reset Camera
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                disabled={!selectedNode}
                onClick={() => {
                  if (selectedNode) {
                    canvasRef.current?.focusNode(selectedNode.id);
                  }
                }}
              >
                <Focus size={12} /> Focus Selected
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="pb-icon-btn"
            aria-label="Refresh graph"
            title="Refresh graph from derived index"
            disabled={isLoading}
            onClick={onRefreshGraph}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {webglError ? (
        <div className="pb-banner pb-banner-warn" role="status">
          <span>
            <AlertTriangle
              size={14}
              style={{ verticalAlign: "-2px", marginRight: 6 }}
            />
            {webglError}
          </span>
        </div>
      ) : null}

      <div className="pb-universe-body">
        <div className="pb-universe-stage">
          {!normalized ? (
            <div className="pb-empty-state">
              <div className="pb-empty-box">
                <p style={{ margin: 0 }}>
                  {isLoading ? "Loading knowledge graph…" : "No graph loaded."}
                </p>
              </div>
            </div>
          ) : normalized.nodes.length === 0 ? (
            <div className="pb-empty-state">
              <div className="pb-empty-box">
                <Compass size={26} />
                <h2 style={{ margin: 0, fontSize: 16 }}>
                  Empty Knowledge Universe
                </h2>
                <p style={{ margin: 0 }}>
                  Create Markdown notes in the Knowledge workspace to populate
                  stars and cluster connections.
                </p>
              </div>
            </div>
          ) : filtered && filtered.nodes.length === 0 ? (
            <div className="pb-empty-state">
              <div className="pb-empty-box">
                <h2 style={{ margin: 0, fontSize: 16 }}>
                  No matching stars for active filters
                </h2>
                <p style={{ margin: 0 }}>
                  No notes match the current search, cluster, or tag filter.
                </p>
                <button
                  type="button"
                  className="pb-btn pb-btn-primary"
                  onClick={clearFilters}
                >
                  Clear Filters
                </button>
              </div>
            </div>
          ) : effectiveMode === "3d" && filtered ? (
            <GalaxyCanvas
              ref={canvasRef}
              nodes={filtered.nodes}
              edges={filtered.edges}
              selectedNodeId={selectedNodeId}
              isDarkTheme={isDarkTheme}
              reducedMotion={reducedMotion}
              onSelectNode={onSelectNodeId}
              onWebGlUnavailable={(reason) => setWebglError(reason)}
            />
          ) : filtered ? (
            <div className="pb-universe-list" role="listbox" aria-label="Graph nodes list">
              {filtered.nodes.map((node) => {
                const isSel = node.id === selectedNodeId;
                const dotColor =
                  CLUSTER_PALETTE[
                    node.clusterColorIndex % CLUSTER_PALETTE.length
                  ] ?? "#4f8ef7";
                return (
                  <button
                    key={node.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`pb-universe-list-row ${isSel ? "is-selected" : ""}`}
                    onClick={() => onSelectNodeId(node.id)}
                  >
                    <span
                      className="pb-cluster-dot"
                      style={{ backgroundColor: dotColor }}
                      aria-hidden="true"
                    />
                    <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
                      <strong>{node.title}</strong>{" "}
                      <span
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11.5,
                          color: "var(--text-muted)",
                        }}
                      >
                        {node.relPath}
                      </span>
                    </span>
                    <span className="pb-badge">
                      {node.incomingCount} in · {node.outgoingCount} out
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <aside
          className="pb-pane-inspector"
          aria-label="Universe node inspector"
        >
          <div className="pb-pane-header">
            <span className="pb-pane-title">STAR INSPECTOR</span>
          </div>

          {!selectedNode ? (
            <div style={{ padding: 16, display: "grid", gap: 10 }}>
              <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 12.5 }}>
                Select a star in the 3D cosmos or list view to inspect metadata,
                connections, and diagnostics.
              </p>
              {normalized ? (
                <dl className="pb-kv-compact">
                  <div className="pb-kv-compact-row">
                    <dt>Total Stars</dt>
                    <dd>{normalized.nodes.length}</dd>
                  </div>
                  <div className="pb-kv-compact-row">
                    <dt>Verified Edges</dt>
                    <dd>{normalized.edges.length}</dd>
                  </div>
                  <div className="pb-kv-compact-row">
                    <dt>Isolated Stars</dt>
                    <dd>{normalized.isolatedCount}</dd>
                  </div>
                  <div className="pb-kv-compact-row">
                    <dt>Broken / Ambiguous</dt>
                    <dd>
                      {normalized.brokenLinkCount} / {normalized.ambiguousLinkCount}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </div>
          ) : (
            <>
              <section className="pb-inspector-section">
                <h3 style={{ fontSize: 14, color: "var(--text-primary)" }}>
                  {selectedNode.title}
                </h3>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className="pb-btn pb-btn-primary pb-btn-sm"
                    onClick={() => onOpenNote(selectedNode.id)}
                  >
                    <FileText size={12} /> Open Note in Editor
                  </button>
                  {effectiveMode === "3d" ? (
                    <button
                      type="button"
                      className="pb-btn pb-btn-sm"
                      onClick={() =>
                        canvasRef.current?.focusCluster(selectedNode.clusterKey)
                      }
                    >
                      Focus Cluster
                    </button>
                  ) : null}
                </div>

                <dl className="pb-kv-compact" style={{ marginTop: 6 }}>
                  <div className="pb-kv-compact-row">
                    <dt>Path</dt>
                    <dd>{selectedNode.relPath}</dd>
                  </div>
                  <div className="pb-kv-compact-row">
                    <dt>Cluster</dt>
                    <dd>{selectedNode.clusterKey}</dd>
                  </div>
                  <div className="pb-kv-compact-row">
                    <dt>Origin</dt>
                    <dd>{selectedNode.origin}</dd>
                  </div>
                  <div className="pb-kv-compact-row">
                    <dt>Parse</dt>
                    <dd>{selectedNode.parseStatus}</dd>
                  </div>
                  <div className="pb-kv-compact-row">
                    <dt>Links</dt>
                    <dd>
                      {selectedNode.incomingCount} in ·{" "}
                      {selectedNode.outgoingCount} out
                    </dd>
                  </div>
                </dl>

                {selectedNode.tags.length > 0 ? (
                  <div className="pb-tag-list">
                    {selectedNode.tags.map((t) => (
                      <span key={t} className="pb-badge">
                        #{t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>

              <section className="pb-inspector-section">
                <h3>Incoming Links ({selectedRelations.incoming.length})</h3>
                {selectedRelations.incoming.length === 0 ? (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    No incoming notes.
                  </span>
                ) : (
                  <div className="pb-note-link-list">
                    {selectedRelations.incoming.map((n) => (
                      <button
                        key={`in:${n.id}`}
                        type="button"
                        className="pb-note-link-item"
                        onClick={() => {
                          onSelectNodeId(n.id);
                          canvasRef.current?.focusNode(n.id);
                        }}
                      >
                        <span>{n.title}</span>
                        <ArrowRight size={11} />
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="pb-inspector-section">
                <h3>Outgoing Links ({selectedRelations.outgoing.length})</h3>
                {selectedRelations.outgoing.length === 0 ? (
                  <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
                    No outgoing notes.
                  </span>
                ) : (
                  <div className="pb-note-link-list">
                    {selectedRelations.outgoing.map((n) => (
                      <button
                        key={`out:${n.id}`}
                        type="button"
                        className="pb-note-link-item"
                        onClick={() => {
                          onSelectNodeId(n.id);
                          canvasRef.current?.focusNode(n.id);
                        }}
                      >
                        <span>{n.title}</span>
                        <ArrowRight size={11} />
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {selectedNode.diagnostics.length > 0 ? (
                <section className="pb-inspector-section">
                  <h3>
                    Link Diagnostics ({selectedNode.diagnostics.length})
                  </h3>
                  <div style={{ display: "grid", gap: 4 }}>
                    {selectedNode.diagnostics.map((d, idx) => (
                      <div
                        key={`${d.raw_target}:${d.line_number}:${idx}`}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 6,
                          fontSize: 12,
                        }}
                      >
                        <span style={{ fontFamily: "var(--font-mono)" }}>
                          {d.raw_target}
                        </span>
                        <span className="pb-badge pb-badge-warn">
                          {d.resolution} · L{d.line_number}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
