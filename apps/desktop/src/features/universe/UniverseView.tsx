import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  ChevronRight,
  Compass,
  Crosshair,
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
  Pin,
  RefreshCw,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  Funnel,
} from "lucide-react";
import type {
  BrokenLinkDto,
  ExclusionPreviewDto,
  GraphSnapshotDto,
  LabelDensity,
  NoteSnapshot,
  ReconcileSummary,
  UniverseSettings,
} from "../../lib/contracts";
import { SafeMarkdownPreview } from "../editor/SafeMarkdownPreview";
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
import {
  OrbitalCanvas,
  type OrbitalCanvasHandle,
} from "./OrbitalCanvas";
import { getOrbitalFolderKey } from "./orbitalLayout";
import { ExclusionsModal } from "./ExclusionsModal";

const ZOOM_TIER_LABELS: Record<SemanticZoomLevel, string> = {
  1: "Overview",
  2: "Systems",
  3: "Local view",
  4: "Detail",
};

const MIN_INSPECTOR_WIDTH = 272;
const MAX_INSPECTOR_WIDTH = 440;

function clampInspectorWidth(width: number) {
  return Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, width));
}

function buildExcerpt(rawBody: string, maxChars = 540): string {
  const withoutFm = rawBody
    .replace(/^\uFEFF/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .trim();
  if (!withoutFm) return "_Empty note._";
  if (withoutFm.length <= maxChars) return withoutFm;
  const sliced = withoutFm.slice(0, maxChars);
  const lastBreak = Math.max(
    sliced.lastIndexOf("\n"),
    sliced.lastIndexOf(" "),
  );
  const clean = lastBreak > maxChars * 0.6 ? sliced.slice(0, lastBreak) : sliced;
  return `${clean.trimEnd()}\n\n…`;
}

interface UniverseViewProps {
  vaultName?: string;
  graphSnapshot: GraphSnapshotDto | null;
  brokenLinks: BrokenLinkDto[];
  selectedNodeId: string | null;
  isLoading: boolean;
  isDarkTheme: boolean;
  reducedMotion: boolean;
  onSelectNodeId: (noteId: string | null) => void;
  onOpenNote: (noteId: string) => void;
  onReadNoteExcerpt?: (noteId: string) => Promise<NoteSnapshot>;
  onRefreshGraph: () => void;
  onGetExclusions?: () => Promise<string[]>;
  onPreviewExclusions?: (patterns: string[]) => Promise<ExclusionPreviewDto>;
  onApplyExclusions?: (patterns: string[]) => Promise<ReconcileSummary>;
}

export function UniverseView({
  vaultName = "Vault Core",
  graphSnapshot,
  brokenLinks,
  selectedNodeId,
  isLoading,
  isDarkTheme,
  reducedMotion,
  onSelectNodeId,
  onOpenNote,
  onReadNoteExcerpt,
  onRefreshGraph,
  onGetExclusions,
  onPreviewExclusions,
  onApplyExclusions,
}: UniverseViewProps) {
  const galaxyRef = useRef<GalaxyCanvasHandle | null>(null);
  const orbitalRef = useRef<OrbitalCanvasHandle | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [listModeOverride, setListModeOverride] = useState(false);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [zoomLevel, setZoomLevel] = useState<SemanticZoomLevel>(1);
  const [focusedSystemKey, setFocusedSystemKey] = useState<string | null>(null);
  const [focusConnectionsNoteId, setFocusConnectionsNoteId] = useState<
    string | null
  >(null);

  const [settings, setSettings] = useState<UniverseSettings>(() =>
    loadUniverseSettings(),
  );
  const [popover, setPopover] = useState<"display" | "filters" | null>(null);
  const displayAnchorRef = useRef<HTMLDivElement>(null);
  const filterAnchorRef = useRef<HTMLDivElement>(null);
  const displayId = useId();
  const filtersId = useId();

  // Contextual floating inspector: collapsed by default when empty, auto-opens on selection unless dismissed.
  const [inspectorOpenWhenEmpty, setInspectorOpenWhenEmpty] = useState(false);
  const [dismissedNodeId, setDismissedNodeId] = useState<string | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(320);
  const inspectorDragRef = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);

  // Guarded note excerpt state (fetched asynchronously only for selected note).
  const [excerptState, setExcerptState] = useState<{
    noteId: string;
    graph: GraphSnapshotDto;
    markdown: string | null;
    error: string | null;
  } | null>(null);

  const [exclusions, setExclusions] = useState<
    | { vaultId: string; phase: "loading" | "error" }
    | { vaultId: string; phase: "ready"; patterns: string[] }
    | null
  >(null);

  const normalized = useMemo(() => {
    if (!graphSnapshot) return null;
    return normalizeGraphSnapshot(graphSnapshot, brokenLinks);
  }, [graphSnapshot, brokenLinks]);

  const focusNodeIds = useMemo(() => {
    if (!normalized || !focusConnectionsNoteId) return null;
    if (!normalized.nodes.some((n) => n.id === focusConnectionsNoteId)) {
      return null;
    }
    const set = new Set<string>([focusConnectionsNoteId]);
    const hop1 = new Set<string>();
    for (const e of normalized.edges) {
      if (e.source === focusConnectionsNoteId) {
        set.add(e.target);
        hop1.add(e.target);
      }
      if (e.target === focusConnectionsNoteId) {
        set.add(e.source);
        hop1.add(e.source);
      }
    }
    if (settings.focusDepth === 2) {
      for (const e of normalized.edges) {
        if (hop1.has(e.source)) set.add(e.target);
        if (hop1.has(e.target)) set.add(e.source);
      }
    }
    return set;
  }, [normalized, focusConnectionsNoteId, settings.focusDepth]);

  const filtered = useMemo(() => {
    if (!normalized) return null;
    return filterGraphModel(normalized, {
      query: searchQuery,
      folder: folderFilter,
      tag: tagFilter,
      hideIsolated: !settings.showIsolated,
      focusNodeIds,
    });
  }, [
    normalized,
    searchQuery,
    folderFilter,
    tagFilter,
    settings.showIsolated,
    focusNodeIds,
  ]);

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

  const vaultId = normalized?.vaultId ?? null;
  const visibleSelectedNoteId = selectedNode?.id ?? null;
  const inspectorExpanded = selectedNode
    ? dismissedNodeId !== selectedNode.id
    : inspectorOpenWhenEmpty;

  useEffect(() => {
    if (
      !inspectorExpanded ||
      !graphSnapshot ||
      !visibleSelectedNoteId ||
      !onReadNoteExcerpt
    ) return;
    let cancelled = false;
    const scope = { noteId: visibleSelectedNoteId, graph: graphSnapshot };
    void onReadNoteExcerpt(visibleSelectedNoteId)
      .then((snap) => {
        if (cancelled) return;
        if (
          snap.vault_id !== graphSnapshot.vault_id ||
          snap.note_id !== visibleSelectedNoteId
        ) {
          throw new Error("Excerpt returned for a different note or vault.");
        }
        setExcerptState({
          ...scope,
          markdown: buildExcerpt(snap.body),
          error: null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setExcerptState({
          ...scope,
          markdown: null,
          error: "Excerpt unavailable",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [graphSnapshot, inspectorExpanded, onReadNoteExcerpt, visibleSelectedNoteId]);

  const exclusionsForVault = exclusions?.vaultId === vaultId ? exclusions : null;
  useEffect(() => {
    if (!popover || exclusionsForVault?.phase === "ready") return;
    const anchor =
      popover === "display" ? displayAnchorRef.current : filterAnchorRef.current;
    const handleOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor?.contains(event.target)) {
        setPopover(null);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPopover(null);
      anchor?.querySelector("button")?.focus();
    };
    window.addEventListener("pointerdown", handleOutsideClick);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handleOutsideClick);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [exclusionsForVault?.phase, popover]);

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
    setFocusConnectionsNoteId(null);
    if (!settings.showIsolated) {
      updateSettings({ showIsolated: true });
    }
  }

  async function openExclusionsDialog() {
    if (!vaultId || !onGetExclusions) return;
    const request = { vaultId, phase: "loading" as const };
    setExclusions(request);
    try {
      const patterns = await onGetExclusions();
      setExclusions((current) =>
        current === request ? { vaultId, phase: "ready", patterns } : current,
      );
    } catch {
      setExclusions((current) =>
        current === request ? { vaultId, phase: "error" } : current,
      );
    }
  }

  function startInspectorResize(ev: React.PointerEvent<HTMLDivElement>) {
    if (ev.button !== 0 || !ev.isPrimary) return;
    ev.preventDefault();
    ev.currentTarget.focus();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    inspectorDragRef.current = {
      pointerId: ev.pointerId,
      x: ev.clientX,
      width: inspectorWidth,
    };
  }

  const effectiveMode: "orbit" | "graph" | "list" =
    webglError || listModeOverride ? "list" : settings.visualizationMode;
  const selectedNodeIsVisible = filtered?.nodes.some(
    (node) => node.id === selectedNodeId,
  ) ?? false;
  const visibleConnectionAnchor = filtered?.nodes.some(
    (node) => node.id === focusConnectionsNoteId,
  ) ? focusConnectionsNoteId : null;

  useEffect(() => {
    if (!visibleConnectionAnchor) return;
    if (effectiveMode === "orbit") {
      orbitalRef.current?.focusNode(visibleConnectionAnchor);
    } else if (effectiveMode === "graph") {
      galaxyRef.current?.focusNode(visibleConnectionAnchor);
    }
  }, [effectiveMode, visibleConnectionAnchor]);

  const activePalette = isDarkTheme ? CLUSTER_PALETTE : CLUSTER_PALETTE_LIGHT;

  function activeCameraFitAll() {
    setFocusedSystemKey(null);
    if (effectiveMode === "orbit") orbitalRef.current?.fitAll();
    else galaxyRef.current?.fitAll();
  }

  function activeCameraReset() {
    setFocusedSystemKey(null);
    if (effectiveMode === "orbit") orbitalRef.current?.resetCamera();
    else galaxyRef.current?.resetCamera();
  }

  function activeCameraFocusNode(noteId: string) {
    if (effectiveMode === "orbit") orbitalRef.current?.focusNode(noteId);
    else galaxyRef.current?.focusNode(noteId);
  }

  function activeCameraFocusFolder(folderKey: string) {
    if (effectiveMode === "orbit") {
      orbitalRef.current?.focusSystem(folderKey);
    } else {
      galaxyRef.current?.focusCluster(folderKey);
    }
  }

  function handleResolveExcerptWikilink(rawTarget: string) {
    if (!normalized) return;
    const q = rawTarget.trim().toLowerCase();
    const qNoExt = q.replace(/\.md$/, "");
    const match = normalized.nodes.find((n) => {
      const rel = n.relPath.toLowerCase();
      const relNoExt = rel.replace(/\.md$/, "");
      const stem = relNoExt.split("/").pop() ?? relNoExt;
      return (
        rel === q ||
        relNoExt === qNoExt ||
        stem === qNoExt ||
        n.title.toLowerCase() === q
      );
    });
    if (match) {
      setDismissedNodeId(null);
      onSelectNodeId(match.id);
      activeCameraFocusNode(match.id);
    }
  }

  // Breadcrumb segments for Orbital navigation hierarchy.
  const breadcrumbSegments = useMemo(() => {
    if (!focusedSystemKey) return [];
    const parts = focusedSystemKey.split("/").filter(Boolean);
    return parts.map((label, idx) => ({
      label,
      key: getOrbitalFolderKey(parts.slice(0, idx + 1)),
    }));
  }, [focusedSystemKey]);

  const searchField = (
    <input
      className="pb-input pb-universe-search-input"
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
      onKeyDown={(e) => {
        const first = filtered?.nodes[0];
        if (e.key === "Enter" && first) {
          setDismissedNodeId(null);
          onSelectNodeId(first.id);
          activeCameraFocusNode(first.id);
        }
      }}
      placeholder="Find a note…"
      aria-label="Search graph nodes"
    />
  );

  const filterFields = (
    <>
      <select
        className="pb-select pb-universe-compact-select"
        aria-label="Filter graph by folder"
        value={folderFilter}
        onChange={(e) => setFolderFilter(e.target.value)}
      >
        <option value="">All folders</option>
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
        title="Toggle visibility of isolated notes with zero verified links"
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

  const counts = filtered ? (
    <span className="pb-universe-counts" aria-label="Visible notes and links">
      {filtered.isFiltered
        ? `${filtered.nodes.length} of ${filtered.totalNodes} notes`
        : `${filtered.nodes.length} notes`}{" "}
      · {filtered.edges.length} links
    </span>
  ) : null;

  const showDisplayPopover =
    popover === "display" && exclusionsForVault?.phase !== "ready";
  const rightControlsContent = (
    <>
      <div
        className="pb-segmented"
        role="group"
        aria-label="Universe display mode"
      >
        <button
          type="button"
          className={effectiveMode === "orbit" ? "is-active" : ""}
          aria-pressed={effectiveMode === "orbit"}
          disabled={Boolean(webglError)}
          onClick={() => {
            setListModeOverride(false);
            if (effectiveMode !== "orbit") setFocusedSystemKey(null);
            updateSettings({ visualizationMode: "orbit" });
          }}
        >
          <Orbit size={12} style={{ marginRight: 4 }} />
          Orbit
        </button>
        <button
          type="button"
          className={effectiveMode === "graph" ? "is-active" : ""}
          aria-pressed={effectiveMode === "graph"}
          disabled={Boolean(webglError)}
          onClick={() => {
            setListModeOverride(false);
            if (effectiveMode !== "graph") setFocusedSystemKey(null);
            updateSettings({ visualizationMode: "graph" });
          }}
        >
          <Share2 size={12} style={{ marginRight: 4 }} />
          Graph
        </button>
        <button
          type="button"
          className={effectiveMode === "list" ? "is-active" : ""}
          aria-pressed={effectiveMode === "list"}
          onClick={() => {
            if (popover === "filters") setPopover(null);
            setFocusedSystemKey(null);
            setListModeOverride(true);
          }}
        >
          <List size={12} style={{ marginRight: 4 }} />
          List
        </button>
      </div>

      <div className="pb-universe-popover-anchor" ref={displayAnchorRef}>
        <button
          type="button"
          className={`pb-btn pb-btn-sm ${showDisplayPopover ? "pb-btn-primary" : ""}`}
          aria-expanded={showDisplayPopover}
          aria-controls={showDisplayPopover ? displayId : undefined}
          aria-label="Universe display settings"
          onClick={() => setPopover(showDisplayPopover ? null : "display")}
        >
          <SlidersHorizontal size={12} /> Display
        </button>

        {showDisplayPopover ? (
          <div
            className="pb-universe-popover"
            id={displayId}
            role="dialog"
            aria-label="Graph visualization settings"
          >
            <div className="pb-universe-popover-head">
              <strong>Universe Display</strong>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                onClick={() => {
                  updateSettings({
                    ...DEFAULT_UNIVERSE_SETTINGS,
                    visualizationMode: settings.visualizationMode,
                  });
                }}
              >
                Reset
              </button>
            </div>

            <label className="pb-universe-setting-row">
              <span>Planet / Star Size ({settings.starSize.toFixed(1)}×)</span>
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
                Orbit / Cluster Spacing ({settings.clusterSpacing.toFixed(1)}×)
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

            <label className="pb-universe-setting-row">
              <span>
                Connection Opacity ({Math.round(settings.connectionOpacity * 100)}
                %)
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

            <div className="pb-universe-setting-inline">
              <span>Label Density</span>
              <div className="pb-segmented" role="group" aria-label="Label density">
                {(["low", "medium", "high"] as LabelDensity[]).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={settings.labelDensity === d ? "is-active" : ""}
                    aria-pressed={settings.labelDensity === d}
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
                    aria-pressed={settings.focusDepth === hop}
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
                checked={settings.showBackgroundStars}
                onChange={(e) =>
                  updateSettings({ showBackgroundStars: e.target.checked })
                }
              />
              <span>Show background starfield</span>
            </label>

            <label className="pb-universe-checkbox">
              <input
                type="checkbox"
                checked={settings.showIsolated}
                onChange={(e) =>
                  updateSettings({ showIsolated: e.target.checked })
                }
              />
              <span>Show isolated notes</span>
            </label>

            <label className="pb-universe-checkbox">
              <input
                type="checkbox"
                checked={
                  !reducedMotion &&
                  !settings.reducedEffects &&
                  settings.orbitalMotion
                }
                disabled={reducedMotion || settings.reducedEffects}
                onChange={(e) =>
                  updateSettings({ orbitalMotion: e.target.checked })
                }
              />
              <span>Gentle orbital motion</span>
            </label>

            <label className="pb-universe-checkbox">
              <input
                type="checkbox"
                checked={settings.reducedEffects}
                onChange={(e) =>
                  updateSettings({ reducedEffects: e.target.checked })
                }
              />
              <span>Performance mode (reduced effects)</span>
            </label>

            {vaultId && onGetExclusions && onPreviewExclusions && onApplyExclusions ? (
              <>
                <button
                  type="button"
                  className="pb-btn pb-btn-sm"
                  disabled={exclusionsForVault?.phase === "loading"}
                  onClick={() => void openExclusionsDialog()}
                >
                  <FolderX size={12} />
                  {exclusionsForVault?.phase === "loading"
                    ? "Loading exclusions…"
                    : "Configure Index Exclusions…"}
                </button>
                {exclusionsForVault?.phase === "error" ? (
                  <span className="pb-universe-field-error" role="alert">
                    Couldn’t load the saved exclusions. Try again.
                  </span>
                ) : null}
              </>
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

  const selectedExcerpt =
    selectedNode &&
    excerptState?.noteId === selectedNode.id &&
    excerptState.graph === graphSnapshot
      ? excerptState
      : null;

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
          <div className="pb-universe-filters">
            {searchField}
            {filterFields}
          </div>
          <div className="pb-universe-controls">
            {counts}
            {rightControlsContent}
          </div>
        </header>
      ) : null}

      <div className="pb-universe-body">
        <div className="pb-universe-stage">
          {effectiveMode !== "list" ? (
            <div className="pb-universe-hud">
              <div className="pb-universe-hud-row">
                <div className="pb-universe-hud-group">
                  {searchField}
                  <div
                    className="pb-universe-popover-anchor"
                    ref={filterAnchorRef}
                  >
                    <button
                      type="button"
                      className={`pb-btn pb-btn-sm ${filtered?.isFiltered ? "pb-btn-primary" : ""}`}
                      aria-expanded={popover === "filters"}
                      aria-controls={popover === "filters" ? filtersId : undefined}
                      onClick={() =>
                        setPopover(popover === "filters" ? null : "filters")
                      }
                    >
                      <Funnel size={12} /> Filters
                    </button>
                    {popover === "filters" ? (
                      <div
                        className="pb-universe-popover pb-universe-filter-popover"
                        id={filtersId}
                        role="group"
                        aria-label="Universe filters"
                      >
                        {filterFields}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="pb-universe-hud-group">{rightControlsContent}</div>
              </div>
              {effectiveMode === "orbit" && breadcrumbSegments.length > 0 ? (
                <nav
                  className="pb-universe-breadcrumb"
                  aria-label="Orbital hierarchy breadcrumb"
                >
                  <button
                    type="button"
                    className="pb-crumb-btn"
                    onClick={() => {
                      setFocusedSystemKey(null);
                      orbitalRef.current?.focusSystem("(vault)");
                    }}
                  >
                    {vaultName}
                  </button>
                  {breadcrumbSegments.map((seg) => (
                    <span key={seg.key} className="pb-crumb-seg">
                      <ChevronRight size={11} aria-hidden="true" />
                      <button
                        type="button"
                        className={`pb-crumb-btn ${
                          focusedSystemKey === seg.key ? "is-current" : ""
                        }`}
                        aria-current={focusedSystemKey === seg.key ? "location" : undefined}
                        onClick={() => {
                          setFocusedSystemKey(seg.key);
                          orbitalRef.current?.focusSystem(seg.key);
                        }}
                      >
                        {seg.label}
                      </button>
                    </span>
                  ))}
                </nav>
              ) : null}
            </div>
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
                  celestial planets and resolved connections.
                </p>
              </div>
            </div>
          ) : filtered && filtered.nodes.length === 0 ? (
            <div className="pb-empty-state">
              <div className="pb-empty-box">
                <h2 style={{ margin: 0, fontSize: 16 }}>
                  No matching notes for active filters
                </h2>
                <p style={{ margin: 0 }}>
                  No notes match the current search, folder, tag, or visibility
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
          ) : effectiveMode === "orbit" && filtered ? (
            <OrbitalCanvas
              ref={orbitalRef}
              vaultId={normalized.vaultId}
              vaultName={vaultName}
              nodes={filtered.nodes}
              edges={filtered.edges}
              selectedNodeId={selectedNodeId}
              focusedSystemKey={focusedSystemKey}
              searchQuery={searchQuery}
              settings={settings}
              isDarkTheme={isDarkTheme}
              reducedMotion={reducedMotion}
              onSelectNode={(id) => {
                setDismissedNodeId(null);
                onSelectNodeId(id);
              }}
              onFocusSystemKey={setFocusedSystemKey}
              onZoomLevelChange={setZoomLevel}
              onWebGlUnavailable={(reason) => setWebglError(reason)}
            />
          ) : effectiveMode === "graph" && filtered ? (
            <GalaxyCanvas
              ref={galaxyRef}
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
                  "#6fa8f6";
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
                      {node.pinned ? (
                        <Pin
                          size={11}
                          style={{ verticalAlign: "-1px", marginRight: 4 }}
                          aria-label="Pinned note"
                        />
                      ) : null}
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

          {effectiveMode !== "list" &&
          filtered &&
          filtered.nodes.length > 0 ? (
            <div
              className="pb-universe-float-bl"
              role="group"
              aria-label="Camera navigation controls"
            >
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                title="Fit entire universe in viewport"
                onClick={activeCameraFitAll}
              >
                <Maximize2 size={12} /> Fit All
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                title="Reset camera angle"
                onClick={activeCameraReset}
              >
                <RotateCcw size={12} /> Reset
              </button>
              <button
                type="button"
                className="pb-btn pb-btn-sm"
                title="Focus camera on selected note"
                disabled={!selectedNodeIsVisible}
                onClick={() => {
                  if (selectedNode) {
                    activeCameraFocusNode(selectedNode.id);
                  }
                }}
              >
                <Focus size={12} /> Focus
              </button>
              {effectiveMode === "orbit" ? (
                <button
                  type="button"
                  className="pb-btn pb-btn-sm"
                  title="Return camera to parent orbital system"
                  disabled={!focusedSystemKey && !selectedNodeIsVisible}
                  onClick={() => orbitalRef.current?.focusParentSystem()}
                >
                  <ArrowUpCircle size={12} /> Parent Orbit
                </button>
              ) : null}
            </div>
          ) : null}

          {effectiveMode !== "list" && counts ? (
            <div className="pb-universe-scene-status">
              {counts}
              <span>{ZOOM_TIER_LABELS[zoomLevel]}</span>
            </div>
          ) : null}
        </div>
        <div className="pb-universe-inspector-host">
          {!inspectorExpanded ? (
            <button
              type="button"
              className="pb-universe-inspector-chip"
              aria-label="Open Note Inspector"
              onClick={() => {
                setDismissedNodeId(null);
                setInspectorOpenWhenEmpty(true);
              }}
            >
              <PanelRightOpen size={13} />
              <span>Inspector</span>
            </button>
          ) : null}

          {inspectorExpanded ? (
            <aside
              className={`pb-pane-inspector pb-universe-inspector ${
                effectiveMode !== "list" ? "is-floating" : ""
              }`}
              style={{ width: inspectorWidth }}
              aria-label="Universe node inspector"
            >
              <div
                className="pb-universe-resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize Note Inspector"
                aria-valuemin={MIN_INSPECTOR_WIDTH}
                aria-valuemax={MAX_INSPECTOR_WIDTH}
                aria-valuenow={inspectorWidth}
                tabIndex={0}
                onPointerDown={startInspectorResize}
                onPointerMove={(event) => {
                  const drag = inspectorDragRef.current;
                  if (drag?.pointerId === event.pointerId) {
                    setInspectorWidth(
                      clampInspectorWidth(drag.width + drag.x - event.clientX),
                    );
                  }
                }}
                onLostPointerCapture={() => {
                  inspectorDragRef.current = null;
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const step = event.key === "ArrowLeft" ? 16 : -16;
                  setInspectorWidth((width) => clampInspectorWidth(width + step));
                }}
              />
              <div className="pb-pane-header">
                <span className="pb-pane-title">Note inspector</span>
                <button
                  type="button"
                  className="pb-icon-btn"
                  aria-label="Collapse Note Inspector"
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
                <div style={{ padding: 14, display: "grid", gap: 10 }}>
                  <p
                    style={{
                      margin: 0,
                      color: "var(--text-secondary)",
                      fontSize: 12.5,
                    }}
                  >
                    Select a planet or note in the 3D universe or list view to
                    inspect metadata, Markdown excerpt, and real connections.
                  </p>
                  {normalized ? (
                    <dl className="pb-kv-compact">
                      <div className="pb-kv-compact-row">
                        <dt>Indexed Notes</dt>
                        <dd>{normalized.nodes.length}</dd>
                      </div>
                      <div className="pb-kv-compact-row">
                        <dt>Verified Edges</dt>
                        <dd>{normalized.edges.length}</dd>
                      </div>
                      <div className="pb-kv-compact-row">
                        <dt>Isolated Notes</dt>
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
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <h3
                        style={{
                          fontSize: 14.5,
                          color: "var(--text-primary)",
                          margin: 0,
                        }}
                      >
                        {selectedNode.title}
                      </h3>
                      {selectedNode.pinned ? (
                        <span
                          className="pb-badge"
                          title="Pinned note"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 4,
                            flexShrink: 0,
                          }}
                        >
                          <Pin size={10} /> Pinned
                        </span>
                      ) : null}
                    </div>

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="pb-btn pb-btn-primary pb-btn-sm"
                        onClick={() => onOpenNote(selectedNode.id)}
                      >
                        <FileText size={12} /> Open in Editor
                      </button>

                      <button
                        type="button"
                        className={`pb-btn pb-btn-sm ${
                          focusConnectionsNoteId === selectedNode.id
                            ? "pb-btn-primary"
                            : ""
                        }`}
                        aria-pressed={
                          focusConnectionsNoteId === selectedNode.id
                        }
                        onClick={() => {
                          if (focusConnectionsNoteId === selectedNode.id) {
                            setFocusConnectionsNoteId(null);
                          } else {
                            setFocusedSystemKey(null);
                            setFocusConnectionsNoteId(selectedNode.id);
                          }
                        }}
                      >
                        <Crosshair size={12} /> Focus Connections
                      </button>

                      {effectiveMode !== "list" &&
                      selectedNode.folderSegments.length > 0 ? (
                        <button
                          type="button"
                          className="pb-btn pb-btn-sm"
                          disabled={!selectedNodeIsVisible}
                          onClick={() => {
                            const key =
                              effectiveMode === "orbit"
                                ? getOrbitalFolderKey(selectedNode.folderSegments)
                                : selectedNode.clusterKey;
                            if (effectiveMode === "orbit") {
                              setFocusedSystemKey(key);
                            }
                            activeCameraFocusFolder(key);
                          }}
                        >
                          {effectiveMode === "orbit"
                            ? "Focus Orbit"
                            : "Focus Cluster"}
                        </button>
                      ) : null}
                    </div>

                    <dl className="pb-kv-compact" style={{ marginTop: 4 }}>
                      <div className="pb-kv-compact-row">
                        <dt>Path</dt>
                        <dd>{selectedNode.relPath}</dd>
                      </div>
                      <div className="pb-kv-compact-row">
                        <dt>Origin</dt>
                        <dd>{selectedNode.origin}</dd>
                      </div>
                      <div className="pb-kv-compact-row">
                        <dt>Verification</dt>
                        <dd>{selectedNode.verification}</dd>
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

                  {onReadNoteExcerpt ? (
                    <section className="pb-inspector-section">
                      <h3>Excerpt</h3>
                      {selectedExcerpt === null ? (
                        <span
                          style={{ color: "var(--text-muted)", fontSize: 12 }}
                        >
                          Loading excerpt…
                        </span>
                      ) : selectedExcerpt.error ? (
                        <span
                          style={{ color: "var(--text-muted)", fontSize: 12 }}
                        >
                          {selectedExcerpt.error}
                        </span>
                      ) : selectedExcerpt.markdown ? (
                        <div className="pb-universe-excerpt">
                          <SafeMarkdownPreview
                            markdown={selectedExcerpt.markdown}
                            onOpenWikilink={handleResolveExcerptWikilink}
                          />
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  <section className="pb-inspector-section">
                    <h3
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <span className="pb-legend-dot is-in" />
                      Incoming Links ({selectedRelations.incoming.length})
                    </h3>
                    {selectedRelations.incoming.length === 0 ? (
                      <span
                        style={{ color: "var(--text-muted)", fontSize: 12 }}
                      >
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
                              activeCameraFocusNode(n.id);
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
                    <h3
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <span className="pb-legend-dot is-out" />
                      Outgoing Links ({selectedRelations.outgoing.length})
                    </h3>
                    {selectedRelations.outgoing.length === 0 ? (
                      <span
                        style={{ color: "var(--text-muted)", fontSize: 12 }}
                      >
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
                              activeCameraFocusNode(n.id);
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
      </div>

      {exclusionsForVault?.phase === "ready" && onPreviewExclusions && onApplyExclusions ? (
        <ExclusionsModal
          vaultName={vaultName}
          initialPatterns={exclusionsForVault.patterns}
          onPreview={onPreviewExclusions}
          onApply={onApplyExclusions}
          onClose={() => {
            setExclusions(null);
            setPopover(null);
            displayAnchorRef.current?.querySelector("button")?.focus();
          }}
        />
      ) : null}
    </section>
  );
}
