import type { GraphEdgeModel, GraphNodeModel } from "./graphModel";
import type { Vec3 } from "./layout3d";

export interface OrbitalSystemNode {
  key: string;
  parentKey: string | null;
  label: string;
  depth: number;
  center: Vec3;
  orbitRadius: number;
  systemRadius: number;
  noteCount: number;
  directNoteCount: number;
  colorIndex: number;
}

export interface OrbitalRingSpec {
  center: Vec3;
  radius: number;
  tiltX: number;
  tiltZ: number;
  depth: number;
  colorIndex: number;
  systemKey: string;
  isBelt: boolean;
}

export interface PlanetOrbitalParam {
  hubCenter: Vec3;
  orbitRadius: number;
  baseAngle: number;
  angularSpeed: number;
  tiltX: number;
  tiltZ: number;
  yOffset: number;
}

export interface OrbitalLayoutResult {
  positions: Map<string, Vec3>;
  planetRadii: Map<string, number>;
  orbitalParams: Map<string, PlanetOrbitalParam>;
  systems: OrbitalSystemNode[];
  systemByKey: Map<string, OrbitalSystemNode>;
  rings: OrbitalRingSpec[];
  vaultCoreRadius: number;
  boundingRadius: number;
}

interface FolderBuildNode {
  key: string;
  parentKey: string | null;
  label: string;
  depth: number;
  colorIndex: number;
  directNotes: GraphNodeModel[];
  children: Map<string, FolderBuildNode>;
  totalNotes: number;
  systemRadius: number;
  belts: BeltSpec[];
  childPlacements: ChildOrbitPlacement[];
}

interface BeltSpec {
  radius: number;
  tiltX: number;
  tiltZ: number;
  isIsolatedBelt: boolean;
  notes: GraphNodeModel[];
}

interface ChildOrbitPlacement {
  child: FolderBuildNode;
  orbitRadius: number;
  angle: number;
  tiltX: number;
  tiltZ: number;
}

export const MAX_SYSTEM_DEPTH = 3;
const VAULT_KEY = "(vault)";
const FULL_TURN = 2 * Math.PI;
const MAX_PLANET_SCALE = 1.6;

export function getOrbitalFolderKey(segments: readonly string[]): string {
  if (segments.length === 0) return VAULT_KEY;
  const path = segments.slice(0, MAX_SYSTEM_DEPTH).join("/");
  return segments[0] === VAULT_KEY ? `/${path}` : path;
}

function planetRadius(note: GraphNodeModel): number {
  const base = 0.84 + Math.min(1.28, (note.importance - 1) * 0.78);
  return Math.min(2.35, base + (note.pinned ? 0.22 : 0));
}

function fnv1aHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededUnit(seed: number): number {
  const x = Math.sin(seed * 0.001 + 1.2345) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Evaluates a point in a tilted circular orbit around `hubCenter` at `elapsedSec`.
 */
export function evaluateOrbitalPosition(
  param: PlanetOrbitalParam,
  elapsedSec = 0,
): Vec3 {
  const angle = param.baseAngle + param.angularSpeed * elapsedSec;
  const lx = Math.cos(angle) * param.orbitRadius;
  const lz = Math.sin(angle) * param.orbitRadius;
  const ly = param.yOffset;

  // Apply gentle rotation around Z then X for authentic inclined orbital planes.
  const cosZ = Math.cos(param.tiltZ);
  const sinZ = Math.sin(param.tiltZ);
  const x1 = lx * cosZ - ly * sinZ;
  const y1 = lx * sinZ + ly * cosZ;
  const z1 = lz;

  const cosX = Math.cos(param.tiltX);
  const sinX = Math.sin(param.tiltX);
  const x2 = x1;
  const y2 = y1 * cosX - z1 * sinX;
  const z2 = y1 * sinX + z1 * cosX;

  return {
    x: param.hubCenter.x + x2,
    y: param.hubCenter.y + y2,
    z: param.hubCenter.z + z2,
  };
}

function packNotesIntoBelts(
  notes: GraphNodeModel[],
  startRadius: number,
  spacing: number,
  systemKey: string,
  isIsolatedBelt: boolean,
  footprint: number,
): { belts: BeltSpec[]; outerRadius: number } {
  if (notes.length === 0) {
    return { belts: [], outerRadius: startRadius };
  }

  const belts: BeltSpec[] = [];
  let cursor = 0;
  let radius = startRadius;
  let beltIndex = 0;
  const centerDistance = Math.max(
    (isIsolatedBelt ? 5.6 : 6.4) * spacing,
    2 * footprint + spacing,
  );

  while (cursor < notes.length) {
    const halfAngle = Math.asin(Math.min(1, centerDistance / (2 * radius)));
    const capacity =
      centerDistance > 2 * radius
        ? 1
        : Math.max(2, Math.floor(Math.PI / halfAngle));
    const batch = notes.slice(cursor, cursor + capacity);
    const seed = fnv1aHash(`${systemKey}:belt:${beltIndex}:${isIsolatedBelt ? 1 : 0}`);
    const tiltSign = beltIndex % 2 === 0 ? 1 : -1;
    const tiltX = tiltSign * (0.04 + seededUnit(seed) * 0.08);
    const tiltZ = -tiltSign * (0.03 + seededUnit(seed ^ 0x3a3a) * 0.07);

    belts.push({
      radius,
      tiltX,
      tiltZ,
      isIsolatedBelt,
      notes: batch,
    });

    cursor += batch.length;
    beltIndex += 1;
    radius += Math.max(
      (5.8 + Math.min(2.8, batch.length * 0.025)) * spacing,
      2 * footprint + spacing,
    );
  }

  return {
    belts,
    outerRadius: belts[belts.length - 1]!.radius + footprint,
  };
}

function buildSubtreeLayout(
  node: FolderBuildNode,
  spacing: number,
  vaultCoreRadius: number,
): void {
  const children = Array.from(node.children.values());
  for (const child of children) {
    buildSubtreeLayout(child, spacing, vaultCoreRadius);
  }
  children.sort(
    (a, b) =>
      b.systemRadius - a.systemRadius ||
      b.totalNotes - a.totalNotes ||
      (a.key < b.key ? -1 : a.key === b.key ? 0 : 1),
  );

  // Sum direct + descendant note counts.
  let totalNotes = node.directNotes.length;
  for (const child of children) {
    totalNotes += child.totalNotes;
  }
  node.totalNotes = totalNotes;

  // Partition direct notes: connected stars on inner belts, isolated stars on outer belts.
  const connected = node.directNotes
    .filter((n) => !n.isIsolated)
    .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id));
  const isolated = node.directNotes
    .filter((n) => n.isIsolated)
    .sort((a, b) => a.id.localeCompare(b.id));
  // Include the largest display size and the vertical jitter in radial bounds.
  const footprint = (notes: GraphNodeModel[]) =>
    notes.reduce((max, note) => Math.max(max, planetRadius(note)), 0) *
      MAX_PLANET_SCALE + 0.7;
  const connectedFootprint = footprint(connected);
  const isolatedFootprint = footprint(isolated);

  const baseBeltRadius =
    node.depth === 0
      ? vaultCoreRadius + 10 * spacing
      : node.depth === 1
        ? 11.5 * spacing
        : node.depth === 2
          ? 7.5 * spacing
          : 5.8 * spacing;

  const connPack = packNotesIntoBelts(
    connected,
    baseBeltRadius,
    spacing,
    node.key,
    false,
    connectedFootprint,
  );
  const isoStartRadius =
    connPack.belts.length > 0
      ? connPack.outerRadius + Math.max(6.5 * spacing, isolatedFootprint + spacing)
      : baseBeltRadius;
  const isoPack = packNotesIntoBelts(
    isolated,
    isoStartRadius,
    spacing,
    node.key,
    true,
    isolatedFootprint,
  );

  node.belts = [...connPack.belts, ...isoPack.belts];
  const directOuter =
    node.belts.length > 0
      ? Math.max(
          connPack.belts.length > 0 ? connPack.outerRadius : 0,
          isoPack.belts.length > 0 ? isoPack.outerRadius : 0,
        )
      : node.depth === 0
        ? vaultCoreRadius
        : 5.5 * spacing;

  if (children.length === 0) {
    node.systemRadius = directOuter;
    return;
  }

  const childGap = (node.depth === 0 ? 10 : 6) * spacing;
  let outerEdge = directOuter;
  let cursor = 0;
  let shellIdx = 0;

  while (cursor < children.length) {
    const largest = children[cursor]!.systemRadius;
    const shellRadius = outerEdge + childGap + largest;
    const shell: { child: FolderBuildNode; span: number }[] = [];
    let occupied = 0;

    // A tangent wedge encloses the entire child envelope. Arc-length
    // estimates understate the angle when a child is large relative to the shell.
    while (cursor < children.length) {
      const child = children[cursor]!;
      const span =
        2 * Math.asin((child.systemRadius + childGap / 2) / shellRadius);
      if (occupied + span > FULL_TURN) break;
      shell.push({ child, span });
      occupied += span;
      cursor += 1;
    }

    const seed = fnv1aHash(`${node.key}:shell:${shellIdx}`);
    const tiltSign = shellIdx % 2 === 0 ? 1 : -1;
    const tiltX = tiltSign * (0.03 + seededUnit(seed ^ 0x1111) * 0.065);
    const tiltZ = -tiltSign * (0.02 + seededUnit(seed ^ 0x2222) * 0.055);
    const angularGap = (FULL_TURN - occupied) / shell.length;
    let angle = (shellIdx * Math.PI) / 3 + seededUnit(seed) * FULL_TURN;
    for (const { child, span } of shell) {
      node.childPlacements.push({
        child,
        orbitRadius: shellRadius,
        angle: angle + span / 2,
        tiltX,
        tiltZ,
      });
      angle += span + angularGap;
    }

    outerEdge = shellRadius + largest;
    shellIdx += 1;
  }

  node.systemRadius = outerEdge;
}

/**
 * Computes a deterministic, collision-free hierarchical orbital layout.
 * - Depth 0: Active Vault central celestial core at (0,0,0).
 * - Depth 1: Top-level folders as orbital systems.
 * - Depth 2..3: Nested subfolders as secondary orbital systems / belts.
 * - Notes: Individual planets packed across multi-belt rings (connected inner, isolated outer).
 */
export function createOrbitalLayout(
  nodes: GraphNodeModel[],
  _edges: GraphEdgeModel[],
  options: { vaultLabel?: string; orbitSpacing?: number } = {},
): OrbitalLayoutResult {
  const spacing = Math.max(0.7, Math.min(1.6, options.orbitSpacing ?? 1.0));
  const vaultLabel = options.vaultLabel?.trim() || "Vault Core";
  const vaultCoreRadius =
    nodes.length > 800 ? 13.5 : nodes.length > 100 ? 10.5 : 8.0;

  const positions = new Map<string, Vec3>();
  const planetRadii = new Map<string, number>();
  const orbitalParams = new Map<string, PlanetOrbitalParam>();
  const systems: OrbitalSystemNode[] = [];
  const systemByKey = new Map<string, OrbitalSystemNode>();
  const rings: OrbitalRingSpec[] = [];

  if (nodes.length === 0) {
    const rootSys: OrbitalSystemNode = {
      key: VAULT_KEY,
      parentKey: null,
      label: vaultLabel,
      depth: 0,
      center: { x: 0, y: 0, z: 0 },
      orbitRadius: 0,
      systemRadius: 36,
      noteCount: 0,
      directNoteCount: 0,
      colorIndex: 0,
    };
    systems.push(rootSys);
    systemByKey.set(rootSys.key, rootSys);
    return {
      positions,
      planetRadii,
      orbitalParams,
      systems,
      systemByKey,
      rings,
      vaultCoreRadius,
      boundingRadius: 42,
    };
  }

  // Build folder tree capped at MAX_SYSTEM_DEPTH visual orbital tiers.
  const rootBuild: FolderBuildNode = {
    key: VAULT_KEY,
    parentKey: null,
    label: vaultLabel,
    depth: 0,
    colorIndex: 0,
    directNotes: [],
    children: new Map(),
    totalNotes: 0,
    systemRadius: 30,
    belts: [],
    childPlacements: [],
  };

  for (const node of nodes) {
    const segs = node.folderSegments.slice(0, MAX_SYSTEM_DEPTH);
    if (segs.length === 0) {
      rootBuild.directNotes.push(node);
      continue;
    }

    let cursor = rootBuild;
    for (let d = 0; d < segs.length; d += 1) {
      const seg = segs[d]!;
      const key = getOrbitalFolderKey(segs.slice(0, d + 1));
      let next = cursor.children.get(key);
      if (!next) {
        next = {
          key,
          parentKey: cursor.key,
          label: seg,
          depth: d + 1,
          colorIndex: node.clusterColorIndex,
          directNotes: [],
          children: new Map(),
          totalNotes: 0,
          systemRadius: 10,
          belts: [],
          childPlacements: [],
        };
        cursor.children.set(key, next);
      }
      cursor = next;
    }
    cursor.directNotes.push(node);
  }

  buildSubtreeLayout(rootBuild, spacing, vaultCoreRadius);

  // Emit world coordinates top-down.
  function realizeSystem(
    buildNode: FolderBuildNode,
    center: Vec3,
    orbitRadius: number,
  ) {
    const sysNode: OrbitalSystemNode = {
      key: buildNode.key,
      parentKey: buildNode.parentKey,
      label: buildNode.label,
      depth: buildNode.depth,
      center,
      orbitRadius,
      systemRadius: buildNode.systemRadius,
      noteCount: buildNode.totalNotes,
      directNoteCount: buildNode.directNotes.length,
      colorIndex: buildNode.colorIndex,
    };
    systems.push(sysNode);
    systemByKey.set(sysNode.key, sysNode);

    // Emit planet belts around this system's hub center.
    buildNode.belts.forEach((belt, bIdx) => {
      rings.push({
        center,
        radius: belt.radius,
        tiltX: belt.tiltX,
        tiltZ: belt.tiltZ,
        depth: buildNode.depth,
        colorIndex: buildNode.colorIndex,
        systemKey: buildNode.key,
        isBelt: true,
      });

      const seed = fnv1aHash(`${buildNode.key}:b:${bIdx}`);
      const phaseOffset = seededUnit(seed) * Math.PI * 2;
      const count = belt.notes.length;
      const baseSpeed = 0.085 / Math.sqrt(Math.max(8, belt.radius));

      belt.notes.forEach((note, nIdx) => {
        const angle = phaseOffset + (nIdx / count) * Math.PI * 2;
        const nSeed = fnv1aHash(note.id);
        const yJitter = (seededUnit(nSeed ^ 0x55aa) - 0.5) * 1.4;
        const param: PlanetOrbitalParam = {
          hubCenter: center,
          orbitRadius: belt.radius,
          baseAngle: angle,
          angularSpeed: baseSpeed * (belt.isIsolatedBelt ? 0.72 : 1.0),
          tiltX: belt.tiltX,
          tiltZ: belt.tiltZ,
          yOffset: yJitter,
        };
        orbitalParams.set(note.id, param);
        positions.set(note.id, evaluateOrbitalPosition(param, 0));

        planetRadii.set(note.id, planetRadius(note));
      });
    });

    // Siblings on a shared shell use a single track and a single set of vertices.
    let lastShellRadius = 0;
    for (const placement of buildNode.childPlacements) {
      if (lastShellRadius !== placement.orbitRadius) {
        rings.push({
          center,
          radius: placement.orbitRadius,
          tiltX: placement.tiltX,
          tiltZ: placement.tiltZ,
          depth: buildNode.depth,
          colorIndex: buildNode.colorIndex,
          systemKey: buildNode.key,
          isBelt: false,
        });
        lastShellRadius = placement.orbitRadius;
      }

      const childCenter = evaluateOrbitalPosition(
        {
          hubCenter: center,
          orbitRadius: placement.orbitRadius,
          baseAngle: placement.angle,
          angularSpeed: 0,
          tiltX: placement.tiltX,
          tiltZ: placement.tiltZ,
          yOffset: 0,
        },
        0,
      );
      realizeSystem(placement.child, childCenter, placement.orbitRadius);
    }
  }

  realizeSystem(rootBuild, { x: 0, y: 0, z: 0 }, 0);

  return {
    positions,
    planetRadii,
    orbitalParams,
    systems,
    systemByKey,
    rings,
    vaultCoreRadius,
    boundingRadius: rootBuild.systemRadius,
  };
}
