import { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Compass,
  Eye,
  EyeOff,
  FileText,
  FilterX,
  Focus,
  FolderX,
  List,
  Maximize2,
  Orbit,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import type {
  BrokenLinkDto,
  ExclusionPreviewDto,
  GraphSnapshotDto,
  LabelDensity,
  ReconcileSummary,
  UniverseSettings,
} from "../../lib/contracts";
import {
  CLUSTER_PALETTE,
  CLUSTER_PALETTE_LIGHT,
  DEFAULT_UNIVERSE_SETTINGS,
  filterGraphModel,
  loadUniverseSettings,
  normalizeGraphSnapshot,
  saveUniverseSettings,
  type GraphNodeModel,
} from "./graphModel";
import {
  GalaxyCanvas,
  type GalaxyCanvasHandle,
  type SemanticZoomLevel,
} from "./GalaxyCanvas";
import { ExclusionsModal } from "./ExclusionsModal";

const ZOOM_TIER_LABELS: Record<SemanticZoomLevel, string> = {
  1: "L1 · Overview",
  2: "L2 · Galaxies",
  3: "L3 · Cluster",
  4: "L4 · Focus",
};

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
  onGetExclusions?: () => Promise<string[]>;
  onPreviewExclusions?: (patterns: string[]) => Promise<ExclusionPreviewDto>;
  onApplyExclusions?: (patterns: string[]) => Promise<ReconcileSummary>;
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
  onGetExclusions,
  onPreviewExclusions,
  onApplyExclusions,
}: UniverseViewProps) {
  const canvasRef = useRef<GalaxyCanvasHandle | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [viewMode, setViewMode] = useState<"3d" | "list">("3d");
  const [webglError, setWebglError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<SemanticZoomLevel>(1);

  const [settings, setSettings] = useState<UniverseSettings>(() =>
    loadUniverseSettings(),
  );
  const [showDisplayPopover, setShowDisplayPopover] = useState(false);

  // Contextual inspector: collapsed by default when empty, auto-opens on selection unless user collapses it.
  const [inspectorOpenWhenEmpty, setInspectorOpenWhenEmpty] = useState(false);
  const [dismissedNodeId, setDismissedNodeId] = useState<string | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(304);

  // Persistent vault exclusions modal state.
  const [exclusionsOpen, setExclusionsOpen] = useState(false);
  const [exclusionPatterns, setExclusionPatterns] = useState<string[]>([]);

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
      hideIsolated: !settings.showIsolated,
    });
  }, [normalized, searchQuery, folderFilter, tagFilter, settings.showIsolated]);

  const selectedNode: GraphNodeModel | null = useMemo(() => {
    if (!normalized || !selectedNodeId) return null;
    return normalized.nodes.find((n) => n.id === selectedNodeId) ?? null;
  }, [normalized, selectedNodeId]);

  const selectedRelations = useMemo(() => {
    if (!normalized || !selectedNode) {
      return {
        incoming: [] as GraphNodeModel[],
        outgoing: [] as GraphNodeModel[],
      };
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

  function updateSettings(patch: Partial<UniverseSettings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveUniverseSettings(next);
      return next;
    });
  }

  function clearFilters() {
    setSearchQuery("");
    setFolderFilter("");
    setTagFilter("");
    if (!settings.showIsolated) {
      updateSettings({ showIsolated: true });
    }
  }

  async function openExclusionsDialog() {
    setShowDisplayPopover(false);
    if (onGetExclusions) {
      try {
        const current = await onGetExclusions();
        setExclusionPatterns(current);
      } catch {
        setExclusionPatterns([]);
      }
    }
    setExclusionsOpen(true);
  }

  function startInspectorResize(ev: React.PointerEvent<HTMLDivElement>) {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = inspectorWidth;

    const onMove = (moveEv: PointerEvent) => {
      const delta = startX - moveEv.clientX;
      setInspectorWidth(Math.max(260, Math.min(440, startWidth + delta)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  const effectiveMode = webglError ? "list" : viewMode;
  const inspectorExpanded = selectedNode
    ? dismissedNodeId !== selectedNode.id
    : inspectorOpenWhenEmpty;

  const activePalette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;

  const filterBarContent = (
    <>
      <input
        className="pb-input pb-universe-search-input"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        placeholder="Search stars, paths, tags…"
        aria-label="Search graph nodes"
      />

      <select
        className="pb-select pb-universe-compact-select"
        aria-label="Filter graph by folder"
        value={folderFilter}
        onChange={(e) => setFolderFilter(e.target.value)}
      >
        <option value="">All galaxies</option>
        {normalized?.availableFolders.map((folder) => (
          <option key={folder} value={folder}>
            {folder === "(root)" ? "Root Notes" : folder}
          </option>
        ))}
      </select>

      <select
        className="pb-select pb-universe-compact-select"
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

      <button
        type="button"
        className={`pb-btn pb-btn-sm ${!settings.showIsolated ? "pb-btn-primary" : ""}`}
        aria-pressed={!settings.showIsolated}
        title="Toggle visibility of isolated stars with zero verified links"
        onClick={() => updateSettings({ showIsolated: !settings.showIsolated })}
      >
        {settings.showIsolated ? <Eye size={12} /> : <EyeOff size={12} />}
        {settings.showIsolated ? "Isolated" : "Isolated Hidden"}
      </button>

      {filtered?.isFiltered ? (
        <button
          type="button"
          className="pb-btn pb-btn-sm"
          onClick={clearFilters}
        >
          <FilterX size={12} /> Clear Filters
        </button>
      ) : null}
    </>
  );

  const rightControlsContent = (
    <>
      {filtered ? (
        <span
          className="pb-badge pb-universe-telemetry"
          title="Visible stars, verified links, and current semantic zoom tier"
        >
          {filtered.nodes.length}/{filtered.totalNodes} stars ·{" "}
          {filtered.edges.length} links ·{" "}
          {effectiveMode === "3d"
            ? ZOOM_TIER_LABELS[zoomLevel]
            : `Gen #${normalized?.generation ?? 0}`}
        </span>
      ) : null}

      <div
        className="pb-segmented"
        role="group"
        aria-label="Universe display mode"
      >
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

      <div style={{ position: "relative" }}>
        <button
          type="button"
          className={`pb-btn pb-btn-sm ${showDisplayPopover ? "pb-btn-primary" : ""}`}
          aria-expanded={showDisplayPopover}
          aria-label="Universe display settings"
          onClick={() => setShowDisplayPopover((p) => !p)}
        >
          <SlidersHorizontal size={12} /> Display
        </button>

        {showDisplayPopover ? (
          <div
            className="pb-universe-popover"
            role="dialog"
            aria-label="Graph visualization settings"
          >
            <div className="pb-universe-popover-head">
              <strong>Cosmos Display</strong>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                onClick={() => {
                  saveUniverseSettings(DEFAULT_UNIVERSE_SETTINGS);
                  setSettings({ ...DEFAULT_UNIVERSE_SETTINGS });
                }}
              >
                Reset
              </button>
            </div>

            <label className="pb-universe-setting-row">
              <span>Star Size ({settings.starSize.toFixed(1)}×)</span>
              <input
                type="range"
                min={0.6}
                max={1.6}
                step={0.1}
                value={settings.starSize}
                onChange={(e) =>
                  updateSettings({ starSize: Number(e.target.value) })
                }
              />
            </label>

            <label className="pb-universe-setting-row">
              <span>
                Filaments ({Math.round(settings.connectionOpacity * 100)}%)
              </span>
              <input
                type="range"
                min={0.05}
                max={0.65}
                step={0.05}
                value={settings.connectionOpacity}
                onChange={(e) =>
                  updateSettings({ connectionOpacity: Number(e.target.value) })
                }
              />
            </label>

            <label className="pb-universe-setting-row">
              <span>
                Cluster Spread ({settings.clusterSpacing.toFixed(1)}×)
              </span>
              <input
                type="range"
                min={0.7}
                max={1.6}
                step={0.1}
                value={settings.clusterSpacing}
                onChange={(e) =>
                  updateSettings({ clusterSpacing: Number(e.target.value) })
                }
              />
            </label>

            <div className="pb-universe-setting-inline">
              <span>Label Density</span>
              <div className="pb-segmented" role="group" aria-label="Label density">
                {(["low", "medium", "high"] as LabelDensity[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={settings.labelDensity === d ? "is-active" : ""}
                    onClick={() => updateSettings({ labelDensity: d })}
                  >
                    {d === "low" ? "Low" : d === "medium" ? "Med" : "High"}
                  </button>
                ))}
              </div>
            </div>

            <div className="pb-universe-setting-inline">
              <span>Focus Depth</span>
              <div className="pb-segmented" role="group" aria-label="Focus depth">
                {([1, 2] as const).map((hop) => (
                  <button
                    key={hop}
                    type="button"
                    className={settings.focusDepth === hop ? "is-active" : ""}
                    onClick={() => updateSettings({ focusDepth: hop })}
                  >
                    {hop === 1 ? "1 hop" : "2 hops"}
                  </button>
                ))}
              </div>
            </div>

            <label className="pb-universe-checkbox">
              <input
                type="checkbox"
                checked={settings.showIsolated}
                onChange={(e) =>
                  updateSettings({ showIsolated: e.target.checked })
                }
              />
              <span>Show isolated stars</span>
            </label>

            <label className="pb-universe-checkbox">
              <input
                type="checkbox"
                checked={settings.reducedEffects}
                onChange={(e) =>
                  updateSettings({ reducedEffects: e.target.checked })
                }
              />
              <span>Reduced effects (performance mode)</span>
            </label>

            {onPreviewExclusions && onApplyExclusions ? (
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                style={{ width: "100%", marginTop: 4 }}
                onClick={() => void openExclusionsDialog()}
              >
                <FolderX size={12} /> Configure Index Exclusions…
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

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
    </>
  );

  return (
    <section className="pb-universe-shell" aria-label="Knowledge Universe">
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

      {effectiveMode === "list" ? (
        <header className="pb-universe-list-toolbar">
          <div className="pb-universe-filters">{filterBarContent}</div>
          <div className="pb-universe-controls">{rightControlsContent}</div>
        </header>
      ) : null}

      <div className="pb-universe-body">
        <div className="pb-universe-stage">
          {effectiveMode === "3d" ? (
            <>
              <div className="pb-universe-float-tl">{filterBarContent}</div>
              <div className="pb-universe-float-tr">{rightControlsContent}</div>
            </>
          ) : null}

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
                  No notes match the current search, galaxy, tag, or visibility
                  filter.
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
              vaultId={normalized.vaultId}
              nodes={filtered.nodes}
              edges={filtered.edges}
              selectedNodeId={selectedNodeId}
              searchQuery={searchQuery}
              settings={settings}
              isDarkTheme={isDarkTheme}
              reducedMotion={reducedMotion}
              onSelectNode={(id) => {
                setDismissedNodeId(null);
                onSelectNodeId(id);
              }}
              onZoomLevelChange={setZoomLevel}
              onWebGlUnavailable={(reason) => setWebglError(reason)}
            />
          ) : filtered ? (
            <div
              className="pb-universe-list"
              role="listbox"
              aria-label="Graph nodes list"
            >
              {filtered.nodes.map((node) => {
                const isSel = node.id === selectedNodeId;
                const dotColor =
                  activePalette[node.clusterColorIndex % activePalette.length] ??
                  "#60a5fa";
                return (
                  <button
                    key={node.id}
                    type="button"
                    role="option"
                    aria-selected={isSel}
                    className={`pb-universe-list-row ${isSel ? "is-selected" : ""}`}
                    onClick={() => {
                      setDismissedNodeId(null);
                      onSelectNodeId(node.id);
                    }}
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

          {effectiveMode === "3d" && normalized && normalized.nodes.length > 0 ? (
            <div
              className="pb-universe-float-bl"
              role="toolbar"
              aria-label="Camera navigation controls"
            >
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                title="Fit entire cosmos in viewport"
                onClick={() => canvasRef.current?.fitAll()}
              >
                <Maximize2 size={12} /> Fit All
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                title="Reset camera angle"
                onClick={() => canvasRef.current?.resetCamera()}
              >
                <RotateCcw size={12} /> Reset
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                title="Focus camera on selected star"
                disabled={!selectedNode}
                onClick={() => {
                  if (selectedNode) {
                    canvasRef.current?.focusNode(selectedNode.id);
                  }
                }}
              >
                <Focus size={12} /> Focus
              </button>
              {selectedNode ? (
                <span className="pb-universe-edge-legend" aria-hidden="true">
                  <span className="pb-legend-dot is-in" /> In
                  <span className="pb-legend-dot is-out" /> Out
                </span>
              ) : null}
            </div>
          ) : null}

          {!inspectorExpanded ? (
            <button
              type="button"
              className="pb-universe-inspector-chip"
              aria-label="Open Star Inspector"
              onClick={() => {
                setDismissedNodeId(null);
                setInspectorOpenWhenEmpty(true);
              }}
            >
              <PanelRightOpen size={13} />
              <span>
                {normalized
                  ? `${normalized.nodes.length} stars · ${normalized.edges.length} edges`
                  : "Inspector"}
              </span>
            </button>
          ) : null}
        </div>

        {inspectorExpanded ? (
          <aside
            className="pb-pane-inspector pb-universe-inspector"
            style={{ width: inspectorWidth }}
            aria-label="Universe node inspector"
          >
            <div
              className="pb-universe-resize-handle"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Star Inspector"
              onPointerDown={startInspectorResize}
            />
            <div className="pb-pane-header">
              <span className="pb-pane-title">STAR INSPECTOR</span>
              <button
                type="button"
                className="pb-icon-btn"
                aria-label="Collapse Star Inspector"
                title="Collapse Inspector"
                onClick={() => {
                  if (selectedNode) {
                    setDismissedNodeId(selectedNode.id);
                  }
                  setInspectorOpenWhenEmpty(false);
                }}
              >
                <PanelRightClose size={14} />
              </button>
            </div>

            {!selectedNode ? (
              <div style={{ padding: 16, display: "grid", gap: 10 }}>
                <p
                  style={{
                    margin: 0,
                    color: "var(--text-secondary)",
                    fontSize: 12.5,
                  }}
                >
                  Select a star in the 3D cosmos or list view to inspect
                  metadata, incoming/outgoing filaments, and link diagnostics.
                </p>
                {normalized ? (
                  <dl className="pb-kv-compact">
                    <div className="pb-kv-compact-row">
                      <dt>Indexed Stars</dt>
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
                        {normalized.brokenLinkCount} /{" "}
                        {normalized.ambiguousLinkCount}
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
                          canvasRef.current?.focusCluster(
                            selectedNode.clusterKey,
                          )
                        }
                      >
                        Focus Galaxy
                      </button>
                    ) : null}
                  </div>

                  <dl className="pb-kv-compact" style={{ marginTop: 6 }}>
                    <div className="pb-kv-compact-row">
                      <dt>Path</dt>
                      <dd>{selectedNode.relPath}</dd>
                    </div>
                    <div className="pb-kv-compact-row">
                      <dt>Galaxy</dt>
                      <dd>{selectedNode.clusterKey}</dd>
                    </div>
                    {selectedNode.subclusterKey ? (
                      <div className="pb-kv-compact-row">
                        <dt>Subcluster</dt>
                        <dd>{selectedNode.subclusterKey}</dd>
                      </div>
                    ) : null}
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
                  <h3 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="pb-legend-dot is-in" />
                    Incoming Links ({selectedRelations.incoming.length})
                  </h3>
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
                            setDismissedNodeId(null);
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
                  <h3 style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="pb-legend-dot is-out" />
                    Outgoing Links ({selectedRelations.outgoing.length})
                  </h3>
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
                            setDismissedNodeId(null);
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
        ) : null}
      </div>

      {exclusionsOpen && onPreviewExclusions && onApplyExclusions ? (
        <ExclusionsModal
          vaultName={normalized?.vaultId ?? "Vault"}
          initialPatterns={exclusionPatterns}
          onPreview={onPreviewExclusions}
          onApply={onApplyExclusions}
          onClose={() => setExclusionsOpen(false)}
        />
      ) : null}
    </section>
  );
}
