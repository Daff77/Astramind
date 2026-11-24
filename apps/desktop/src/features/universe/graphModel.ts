import type {
  BrokenLinkDto,
  GraphNodeDto,
  GraphSnapshotDto,
  NoteOrigin,
  ParseStatus,
  UniverseSettings,
  VerificationStatus,
} from "../../lib/contracts";

export const CLUSTER_PALETTE = [
  "#60a5fa", // Sapphire Blue
  "#2dd4bf", // Celestial Teal
  "#f59e0b", // Stellar Amber
  "#a78bfa", // Nebula Violet
  "#34d399", // Emerald Mint
  "#f472b6", // Cosmic Rose
  "#38bdf8", // Ion Cyan
  "#eab308", // Solar Gold
] as const;

export const CLUSTER_PALETTE_LIGHT = [
  "#2563eb",
  "#0d9488",
  "#d97706",
  "#7c3aed",
  "#059669",
  "#db2777",
  "#0284c7",
  "#ca8a04",
] as const;

export const DEFAULT_UNIVERSE_SETTINGS: UniverseSettings = {
  starSize: 1.0,
  connectionOpacity: 0.24,
  labelDensity: "medium",
  clusterSpacing: 1.0,
  showIsolated: true,
  focusDepth: 1,
  reducedEffects: false,
};

const PREF_UNIVERSE_SETTINGS_KEY = "pb.pref.universeSettings";

export function loadUniverseSettings(): UniverseSettings {
  try {
    const raw = window.localStorage.getItem(PREF_UNIVERSE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_UNIVERSE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<UniverseSettings>;
    return {
      starSize:
        typeof parsed.starSize === "number" && Number.isFinite(parsed.starSize)
          ? Math.max(0.6, Math.min(1.6, parsed.starSize))
          : DEFAULT_UNIVERSE_SETTINGS.starSize,
      connectionOpacity:
        typeof parsed.connectionOpacity === "number" &&
        Number.isFinite(parsed.connectionOpacity)
          ? Math.max(0.05, Math.min(0.65, parsed.connectionOpacity))
          : DEFAULT_UNIVERSE_SETTINGS.connectionOpacity,
      labelDensity:
        parsed.labelDensity === "low" ||
        parsed.labelDensity === "medium" ||
        parsed.labelDensity === "high"
          ? parsed.labelDensity
          : DEFAULT_UNIVERSE_SETTINGS.labelDensity,
      clusterSpacing:
        typeof parsed.clusterSpacing === "number" &&
        Number.isFinite(parsed.clusterSpacing)
          ? Math.max(0.7, Math.min(1.6, parsed.clusterSpacing))
          : DEFAULT_UNIVERSE_SETTINGS.clusterSpacing,
      showIsolated:
        typeof parsed.showIsolated === "boolean"
          ? parsed.showIsolated
          : DEFAULT_UNIVERSE_SETTINGS.showIsolated,
      focusDepth:
        parsed.focusDepth === 1 || parsed.focusDepth === 2
          ? parsed.focusDepth
          : DEFAULT_UNIVERSE_SETTINGS.focusDepth,
      reducedEffects:
        typeof parsed.reducedEffects === "boolean"
          ? parsed.reducedEffects
          : DEFAULT_UNIVERSE_SETTINGS.reducedEffects,
    };
  } catch {
    return { ...DEFAULT_UNIVERSE_SETTINGS };
  }
}

export function saveUniverseSettings(settings: UniverseSettings): void {
  try {
    window.localStorage.setItem(
      PREF_UNIVERSE_SETTINGS_KEY,
      JSON.stringify(settings),
    );
  } catch {
    // Ignore storage quota errors in sandboxed/headless environments.
  }
}

export interface GraphNodeModel {
  id: string;
  relPath: string;
  title: string;
  folder: string;
  clusterKey: string;
  subclusterKey: string;
  clusterColorIndex: number;
  tags: string[];
  origin: NoteOrigin;
  parseStatus: ParseStatus;
  verification: VerificationStatus;
  incomingCount: number;
  outgoingCount: number;
  selfLinkCount: number;
  isIsolated: boolean;
  importance: number;
  diagnostics: BrokenLinkDto[];
}

export interface GraphEdgeModel {
  key: string;
  source: string;
  target: string;
  kind: string;
  count: number;
  isSelfLoop: boolean;
}

export interface GraphClusterSummary {
  key: string;
  label: string;
  count: number;
  colorIndex: number;
}

export interface NormalizedGraphModel {
  vaultId: string;
  generation: number;
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  clusters: GraphClusterSummary[];
  availableFolders: string[];
  availableTags: string[];
  isolatedCount: number;
  brokenLinkCount: number;
  ambiguousLinkCount: number;
}

export interface GraphFilterCriteria {
  query: string;
  folder: string;
  tag: string;
  hideIsolated?: boolean;
}

export interface FilteredGraphModel {
  nodes: GraphNodeModel[];
  edges: GraphEdgeModel[];
  matchedIds: Set<string>;
  totalNodes: number;
  totalEdges: number;
  isFiltered: boolean;
}

export function isStaleGraphSnapshot(
  current: { vaultId: string; generation: number } | null,
  incoming: GraphSnapshotDto,
): boolean {
  return (
    current !== null &&
    current.vaultId === incoming.vault_id &&
    incoming.generation < current.generation
  );
}

function stableClusterKey(node: GraphNodeDto): string {
  const folder = node.folder.trim();
  return folder.length > 0 ? folder : "(root)";
}

function stableSubclusterKey(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  // e.g. "projects/frontend/note.md" -> "frontend"
  if (parts.length >= 3) {
    return parts[1] ?? "";
  }
  return "";
}

export function normalizeGraphSnapshot(
  snapshot: GraphSnapshotDto,
  brokenLinks: BrokenLinkDto[],
): NormalizedGraphModel {
  const diagnosticsByNode = new Map<string, BrokenLinkDto[]>();
  let brokenLinkCount = 0;
  let ambiguousLinkCount = 0;

  for (const diag of brokenLinks) {
    if (diag.resolution === "broken") brokenLinkCount += 1;
    if (diag.resolution === "ambiguous") ambiguousLinkCount += 1;
    const list = diagnosticsByNode.get(diag.source_note_id) ?? [];
    list.push(diag);
    diagnosticsByNode.set(diag.source_note_id, list);
  }

  // Deduplicate nodes by stable NoteId and sort deterministically.
  const dedupedNodes = new Map<string, GraphNodeDto>();
  for (const raw of snapshot.nodes) {
    if (!dedupedNodes.has(raw.id)) {
      dedupedNodes.set(raw.id, raw);
    }
  }
  const sortedRawNodes = Array.from(dedupedNodes.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  // Deterministic cluster indices from sorted unique folder keys.
  const clusterCounts = new Map<string, number>();
  for (const n of sortedRawNodes) {
    const key = stableClusterKey(n);
    clusterCounts.set(key, (clusterCounts.get(key) ?? 0) + 1);
  }
  const sortedClusterKeys = Array.from(clusterCounts.keys()).sort((a, b) =>
    a.localeCompare(b),
  );
  const clusterColorMap = new Map<string, number>();
  sortedClusterKeys.forEach((key, idx) => {
    clusterColorMap.set(key, idx % CLUSTER_PALETTE.length);
  });

  // Normalize & validate edges against known node IDs; accumulate self-links.
  const edgeMap = new Map<string, GraphEdgeModel>();
  const selfLoopCountByNode = new Map<string, number>();
  const computedIncoming = new Map<string, number>();
  const computedOutgoing = new Map<string, number>();

  for (const e of snapshot.edges) {
    if (!dedupedNodes.has(e.source) || !dedupedNodes.has(e.target)) {
      continue;
    }
    const isSelfLoop = e.source === e.target;
    if (isSelfLoop) {
      selfLoopCountByNode.set(
        e.source,
        (selfLoopCountByNode.get(e.source) ?? 0) + e.count,
      );
    }
    computedOutgoing.set(
      e.source,
      (computedOutgoing.get(e.source) ?? 0) + e.count,
    );
    computedIncoming.set(
      e.target,
      (computedIncoming.get(e.target) ?? 0) + e.count,
    );

    const key = `${e.source}->${e.target}:${e.kind}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += e.count;
    } else {
      edgeMap.set(key, {
        key,
        source: e.source,
        target: e.target,
        kind: e.kind,
        count: e.count,
        isSelfLoop,
      });
    }
  }

  const edges = Array.from(edgeMap.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  const tagSet = new Set<string>();
  let isolatedCount = 0;

  const nodes: GraphNodeModel[] = sortedRawNodes.map((raw) => {
    const clusterKey = stableClusterKey(raw);
    const incomingCount = Math.max(
      raw.incoming_count ?? 0,
      computedIncoming.get(raw.id) ?? 0,
    );
    const outgoingCount = Math.max(
      raw.outgoing_count ?? 0,
      computedOutgoing.get(raw.id) ?? 0,
    );
    const selfLinkCount = selfLoopCountByNode.get(raw.id) ?? 0;
    const isIsolated = incomingCount === 0 && outgoingCount === 0;
    if (isIsolated) {
      isolatedCount += 1;
    }
    for (const tag of raw.tags) {
      tagSet.add(tag);
    }
    const degree = incomingCount * 1.6 + outgoingCount * 0.6;
    const importance = 1 + Math.min(1.65, Math.log1p(degree) * 0.52);

    return {
      id: raw.id,
      relPath: raw.rel_path,
      title: raw.title || raw.rel_path || raw.id,
      folder: raw.folder,
      clusterKey,
      subclusterKey: stableSubclusterKey(raw.rel_path),
      clusterColorIndex: clusterColorMap.get(clusterKey) ?? 0,
      tags: [...raw.tags].sort((a, b) => a.localeCompare(b)),
      origin: raw.origin,
      parseStatus: raw.parse_status,
      verification: raw.verification,
      incomingCount,
      outgoingCount,
      selfLinkCount,
      isIsolated,
      importance,
      diagnostics: diagnosticsByNode.get(raw.id) ?? [],
    };
  });

  const clusters: GraphClusterSummary[] = sortedClusterKeys.map((key) => ({
    key,
    label: key === "(root)" ? "Root Notes" : key,
    count: clusterCounts.get(key) ?? 0,
    colorIndex: clusterColorMap.get(key) ?? 0,
  }));

  return {
    vaultId: snapshot.vault_id,
    generation: snapshot.generation,
    nodes,
    edges,
    clusters,
    availableFolders: sortedClusterKeys,
    availableTags: Array.from(tagSet).sort((a, b) => a.localeCompare(b)),
    isolatedCount,
    brokenLinkCount,
    ambiguousLinkCount,
  };
}

export function filterGraphModel(
  model: NormalizedGraphModel,
  criteria: GraphFilterCriteria,
): FilteredGraphModel {
  const q = criteria.query.trim().toLowerCase();
  const folder = criteria.folder.trim();
  const tag = criteria.tag.trim().toLowerCase();
  const hideIsolated = Boolean(criteria.hideIsolated);
  const isFiltered =
    q.length > 0 || folder.length > 0 || tag.length > 0 || hideIsolated;

  if (!isFiltered) {
    const matchedIds = new Set(model.nodes.map((n) => n.id));
    return {
      nodes: model.nodes,
      edges: model.edges,
      matchedIds,
      totalNodes: model.nodes.length,
      totalEdges: model.edges.length,
      isFiltered: false,
    };
  }

  const matchedNodes = model.nodes.filter((node) => {
    if (hideIsolated && node.isIsolated) {
      return false;
    }
    if (folder && node.clusterKey !== folder) {
      return false;
    }
    if (tag && !node.tags.some((t) => t.toLowerCase() === tag)) {
      return false;
    }
    if (q) {
      const hay =
        `${node.title}\n${node.relPath}\n${node.clusterKey}\n${node.tags.join(" ")}`.toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }
    return true;
  });

  const matchedIds = new Set(matchedNodes.map((n) => n.id));
  const matchedEdges = model.edges.filter(
    (e) => matchedIds.has(e.source) && matchedIds.has(e.target),
  );

  return {
    nodes: matchedNodes,
    edges: matchedEdges,
    matchedIds,
    totalNodes: model.nodes.length,
    totalEdges: model.edges.length,
    isFiltered: true,
  };
}
