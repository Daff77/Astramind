import type { GraphEdgeModel, GraphNodeModel } from "./graphModel";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ClusterBound {
  key: string;
  label: string;
  center: Vec3;
  radius: number;
  count: number;
  colorIndex: number;
}

export interface LayoutSimulation {
  positions: Map<string, Vec3>;
  clusterCenters: Map<string, Vec3>;
  clusterBounds: ClusterBound[];
  boundingRadius: number;
  alpha: number;
  settled: boolean;
  step: () => boolean;
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

function computeBounds(
  nodes: GraphNodeModel[],
  positions: Map<string, Vec3>,
): { clusterBounds: ClusterBound[]; boundingRadius: number } {
  if (nodes.length === 0) {
    return { clusterBounds: [], boundingRadius: 60 };
  }

  const acc = new Map<
    string,
    {
      label: string;
      colorIndex: number;
      pts: Vec3[];
      sumX: number;
      sumY: number;
      sumZ: number;
    }
  >();

  let globalSumX = 0;
  let globalSumY = 0;
  let globalSumZ = 0;

  for (const node of nodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    globalSumX += p.x;
    globalSumY += p.y;
    globalSumZ += p.z;
    let entry = acc.get(node.clusterKey);
    if (!entry) {
      entry = {
        label: node.clusterKey === "(root)" ? "Root Notes" : node.clusterKey,
        colorIndex: node.clusterColorIndex,
        pts: [],
        sumX: 0,
        sumY: 0,
        sumZ: 0,
      };
      acc.set(node.clusterKey, entry);
    }
    entry.pts.push(p);
    entry.sumX += p.x;
    entry.sumY += p.y;
    entry.sumZ += p.z;
  }

  const count = nodes.length;
  const gx = globalSumX / count;
  const gy = globalSumY / count;
  const gz = globalSumZ / count;

  let maxGlobalR = 36;
  for (const node of nodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    const d = Math.hypot(p.x - gx, p.y - gy, p.z - gz);
    if (d > maxGlobalR) maxGlobalR = d;
  }

  const clusterBounds: ClusterBound[] = [];
  for (const [key, entry] of acc.entries()) {
    const n = entry.pts.length;
    const cx = entry.sumX / n;
    const cy = entry.sumY / n;
    const cz = entry.sumZ / n;
    let maxR = 14;
    for (const p of entry.pts) {
      const d = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
      if (d > maxR) maxR = d;
    }
    clusterBounds.push({
      key,
      label: entry.label,
      center: { x: cx, y: cy, z: cz },
      radius: maxR,
      count: n,
      colorIndex: entry.colorIndex,
    });
  }

  clusterBounds.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { clusterBounds, boundingRadius: maxGlobalR };
}

/**
 * Deterministic hierarchical 3D cosmos layout.
 * - Adapts spatial topology to vault scale and folder structure (single elliptical nebula,
 *   multi-galaxy constellation, or multi-arm organic spiral cosmos).
 * - Separates subclusters into organic lobes and stratifies connected hubs near cluster cores
 *   while placing isolated notes into lighter outer halos.
 * - Preserves prior node coordinates on incremental updates to prevent viewport jumps.
 */
export function createUniverseLayout(
  nodes: GraphNodeModel[],
  edges: GraphEdgeModel[],
  previousPositions?: Map<string, Vec3>,
  reducedMotion = false,
  clusterSpacing = 1.0,
): LayoutSimulation {
  const positions = new Map<string, Vec3>();
  const velocities = new Map<string, Vec3>();
  const clusterCenters = new Map<string, Vec3>();

  const spacing = Math.max(0.7, Math.min(1.6, clusterSpacing));

  // Count nodes per folder cluster and sort deterministically (largest clusters closer to inner arms).
  const clusterGroups = new Map<string, GraphNodeModel[]>();
  for (const node of nodes) {
    const list = clusterGroups.get(node.clusterKey) ?? [];
    list.push(node);
    clusterGroups.set(node.clusterKey, list);
  }

  const sortedClusters = Array.from(clusterGroups.entries()).sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  const clusterCount = Math.max(sortedClusters.length, 1);
  const armCount = clusterCount >= 8 ? 3 : 2;
  const baseScale =
    (nodes.length > 800
      ? 165
      : nodes.length > 350
        ? 125
        : nodes.length > 60
          ? 88
          : 54) * spacing;

  // Position folder galaxies using adaptive topology rather than one rigid sphere/disk.
  sortedClusters.forEach(([clusterKey, group], idx) => {
    if (clusterCount === 1) {
      clusterCenters.set(clusterKey, { x: 0, y: 0, z: 0 });
      return;
    }

    const h = fnv1aHash(clusterKey);
    const sizeFactor = Math.sqrt(group.length / Math.max(1, nodes.length / clusterCount));

    if (clusterCount <= 4) {
      // Compact organic constellation for small/medium multi-folder vaults.
      const angle = idx * 2.399963229728653 + seededUnit(h) * 0.45;
      const radial =
        baseScale * (0.42 + 0.36 * Math.sqrt((idx + 0.5) / clusterCount)) *
        Math.max(0.8, Math.min(1.25, sizeFactor));
      const yOffset = (seededUnit(h ^ 0x3333) - 0.5) * radial * 0.28;
      clusterCenters.set(clusterKey, {
        x: Math.cos(angle) * radial,
        y: yOffset,
        z: Math.sin(angle) * radial,
      });
      return;
    }

    // Multi-arm organic galactic distribution weighted by cluster size.
    const armIdx = idx % armCount;
    const armRank = Math.floor(idx / armCount);
    const maxRank = Math.max(1, Math.ceil(clusterCount / armCount));
    const t = (armRank + 0.4) / maxRank;
    const spiralAngle =
      (armIdx * (Math.PI * 2)) / armCount +
      t * 2.15 +
      (seededUnit(h) - 0.5) * 0.55;
    const radial = baseScale * (0.22 + 0.78 * Math.sqrt(t));
    const yWave =
      Math.sin(spiralAngle * 1.5 + t * 2.4) * radial * 0.14 +
      (seededUnit(h ^ 0x7777) - 0.5) * 14 * spacing;

    clusterCenters.set(clusterKey, {
      x: Math.cos(spiralAngle) * radial,
      y: yWave,
      z: Math.sin(spiralAngle) * radial,
    });
  });

  // Assign subcluster offsets inside each galaxy + connected-core vs isolated-halo placement.
  for (const [clusterKey, group] of sortedClusters) {
    const center = clusterCenters.get(clusterKey) ?? { x: 0, y: 0, z: 0 };
    const clusterSeed = fnv1aHash(clusterKey);
    const galaxyMajorAngle = seededUnit(clusterSeed ^ 0x1919) * Math.PI;
    const cosG = Math.cos(galaxyMajorAngle);
    const sinG = Math.sin(galaxyMajorAngle);

    // Discover unique subclusters inside this folder.
    const subclusters = Array.from(
      new Set(group.map((n) => n.subclusterKey)),
    ).sort((a, b) => a.localeCompare(b));
    const subOffsets = new Map<string, Vec3>();
    subclusters.forEach((sub, sIdx) => {
      if (!sub || subclusters.length <= 1) {
        subOffsets.set(sub, { x: 0, y: 0, z: 0 });
        return;
      }
      const sh = fnv1aHash(`${clusterKey}/${sub}`);
      const subAngle =
        galaxyMajorAngle +
        (sIdx / subclusters.length) * Math.PI * 2 +
        (seededUnit(sh) - 0.5) * 0.4;
      const subR = (10 + Math.min(24, Math.sqrt(group.length) * 3.2)) * spacing;
      subOffsets.set(sub, {
        x: Math.cos(subAngle) * subR,
        y: (seededUnit(sh ^ 0x4242) - 0.5) * 8 * spacing,
        z: Math.sin(subAngle) * subR,
      });
    });

    // Separate connected vs isolated so connected knowledge forms bright inner filaments.
    let connIdx = 0;
    let isoIdx = 0;
    for (const node of group) {
      const existing = previousPositions?.get(node.id);
      if (existing) {
        positions.set(node.id, { ...existing });
        velocities.set(node.id, { x: 0, y: 0, z: 0 });
        continue;
      }

      const subOff = subOffsets.get(node.subclusterKey) ?? { x: 0, y: 0, z: 0 };
      const nh = fnv1aHash(node.id);
      const golden = 2.399963229728653;

      if (!node.isIsolated) {
        const idx = connIdx;
        connIdx += 1;
        const a = idx * golden + seededUnit(nh) * 0.6;
        const r = (5.5 + Math.sqrt(idx + 0.5) * 4.4) * spacing;
        // Elliptical galaxy flattening (1.35 major axis, 0.72 minor axis)
        const lx = Math.cos(a) * r * 1.3;
        const lz = Math.sin(a) * r * 0.72;
        const rx = lx * cosG - lz * sinG;
        const rz = lx * sinG + lz * cosG;
        const ly = (seededUnit(nh ^ 0x5555) - 0.5) * Math.min(18, 6 + r * 0.22);
        positions.set(node.id, {
          x: center.x + subOff.x + rx,
          y: center.y + subOff.y + ly,
          z: center.z + subOff.z + rz,
        });
      } else {
        const idx = isoIdx;
        isoIdx += 1;
        const a = idx * golden + seededUnit(nh) * 0.5;
        const r = (12 + Math.sqrt(idx + 1) * 5.2) * spacing;
        const lx = Math.cos(a) * r * 1.25;
        const lz = Math.sin(a) * r * 0.8;
        const rx = lx * cosG - lz * sinG;
        const rz = lx * sinG + lz * cosG;
        const ly = (seededUnit(nh ^ 0x9999) - 0.5) * Math.min(22, 8 + r * 0.25);
        positions.set(node.id, {
          x: center.x + subOff.x + rx,
          y: center.y + subOff.y + ly,
          z: center.z + subOff.z + rz,
        });
      }
      velocities.set(node.id, { x: 0, y: 0, z: 0 });
    }
  }

  const nonSelfEdges = edges.filter((e) => !e.isSelfLoop);
  const initialBounds = computeBounds(nodes, positions);

  const sim: LayoutSimulation = {
    positions,
    clusterCenters,
    clusterBounds: initialBounds.clusterBounds,
    boundingRadius: initialBounds.boundingRadius,
    alpha: reducedMotion || nodes.length <= 1 ? 0 : 1,
    settled: reducedMotion || nodes.length <= 1,
    step() {
      if (sim.settled || sim.alpha < 0.015) {
        sim.alpha = 0;
        sim.settled = true;
        const finalBounds = computeBounds(nodes, positions);
        sim.clusterBounds = finalBounds.clusterBounds;
        sim.boundingRadius = finalBounds.boundingRadius;
        return false;
      }

      const n = nodes.length;
      const alpha = sim.alpha;
      // Gentler cluster pull preserves elliptical/filamentary shapes instead of balling into spheres.
      const clusterPull = 0.024 * alpha;

      // 1. Soft galactic-plane attraction keeps clusters cohesive without collapsing into balls.
      for (const node of nodes) {
        const p = positions.get(node.id)!;
        const v = velocities.get(node.id)!;
        const c = clusterCenters.get(node.clusterKey) ?? { x: 0, y: 0, z: 0 };
        const pullScale = node.isIsolated ? clusterPull * 0.72 : clusterPull;
        v.x += (c.x - p.x) * pullScale;
        v.y += (c.y - p.y) * (pullScale * 1.6);
        v.z += (c.z - p.z) * pullScale;
      }

      // 2. Bounded local repulsion (full O(N^2) for N<=260, deterministic stride sample for larger vaults).
      const stride = n <= 260 ? 1 : Math.ceil(n / 180);
      const repulseStrength = (n > 400 ? 105 : 145) * alpha * stride * spacing;
      for (let i = 0; i < n; i += 1) {
        const a = nodes[i]!;
        const pa = positions.get(a.id)!;
        const va = velocities.get(a.id)!;
        for (let j = i + 1; j < n; j += stride) {
          const b = nodes[j]!;
          const pb = positions.get(b.id)!;
          const vb = velocities.get(b.id)!;
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const dz = pa.z - pb.z;
          const distSq = dx * dx + dy * dy + dz * dz + 14;
          if (distSq > 5400) continue;
          const inv = repulseStrength / (distSq * Math.sqrt(distSq));
          const fx = dx * inv;
          const fy = dy * inv * 0.45;
          const fz = dz * inv;
          va.x += fx;
          va.y += fy;
          va.z += fz;
          if (stride === 1) {
            vb.x -= fx;
            vb.y -= fy;
            vb.z -= fz;
          }
        }
      }

      // 3. Explicit resolved link springs form organic cosmic filaments.
      const restLen = 28 * spacing;
      const springK = 0.028 * alpha;
      for (const edge of nonSelfEdges) {
        const pa = positions.get(edge.source);
        const pb = positions.get(edge.target);
        const va = velocities.get(edge.source);
        const vb = velocities.get(edge.target);
        if (!pa || !pb || !va || !vb) continue;
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const dz = pb.z - pa.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
        const force =
          ((dist - restLen) / dist) *
          springK *
          Math.min(2.4, 0.85 + edge.count * 0.25);
        const fx = dx * force;
        const fy = dy * force;
        const fz = dz * force;
        va.x += fx;
        va.y += fy;
        va.z += fz;
        vb.x -= fx;
        vb.y -= fy;
        vb.z -= fz;
      }

      // 4. Damping + bounded displacement.
      let totalMove = 0;
      for (const node of nodes) {
        const p = positions.get(node.id)!;
        const v = velocities.get(node.id)!;
        v.x *= 0.72;
        v.y *= 0.72;
        v.z *= 0.72;
        const dx = Math.max(-6.5, Math.min(6.5, v.x));
        const dy = Math.max(-4.0, Math.min(4.0, v.y));
        const dz = Math.max(-6.5, Math.min(6.5, v.z));
        p.x += dx;
        p.y += dy;
        p.z += dz;
        totalMove += Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      }

      const bounds = computeBounds(nodes, positions);
      sim.clusterBounds = bounds.clusterBounds;
      sim.boundingRadius = bounds.boundingRadius;

      sim.alpha *= 0.94;
      if (sim.alpha < 0.015 || (sim.alpha < 0.55 && totalMove < n * 0.028)) {
        sim.alpha = 0;
        sim.settled = true;
        return false;
      }
      return true;
    },
  };

  if (reducedMotion) {
    sim.settled = false;
    sim.alpha = 1;
    for (let k = 0; k < 28 && !sim.settled; k += 1) {
      sim.step();
    }
    sim.alpha = 0;
    sim.settled = true;
    const finalBounds = computeBounds(nodes, positions);
    sim.clusterBounds = finalBounds.clusterBounds;
    sim.boundingRadius = finalBounds.boundingRadius;
  }

  return sim;
}
