import type { GraphEdgeModel, GraphNodeModel } from "./graphModel";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface LayoutSimulation {
  positions: Map<string, Vec3>;
  clusterCenters: Map<string, Vec3>;
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

/**
 * Deterministic 3D galaxy-cluster layout.
 * - Arranges folder clusters on a flat spiral disk with restrained Z/Y relief.
 * - Preserves prior node coordinates on incremental updates to prevent scene jumps.
 * - Uses bounded cooldown + sampled repulsion so F1000 remains smooth and cools quickly.
 */
export function createUniverseLayout(
  nodes: GraphNodeModel[],
  edges: GraphEdgeModel[],
  previousPositions?: Map<string, Vec3>,
  reducedMotion = false,
): LayoutSimulation {
  const positions = new Map<string, Vec3>();
  const velocities = new Map<string, Vec3>();
  const clusterCenters = new Map<string, Vec3>();

  const uniqueClusters = Array.from(
    new Set(nodes.map((n) => n.clusterKey)),
  ).sort((a, b) => a.localeCompare(b));

  const clusterCount = Math.max(uniqueClusters.length, 1);
  const diskRadius =
    nodes.length > 400 ? 185 : nodes.length > 60 ? 115 : 68;

  uniqueClusters.forEach((clusterKey, idx) => {
    if (clusterCount === 1) {
      clusterCenters.set(clusterKey, { x: 0, y: 0, z: 0 });
      return;
    }
    const goldenAngle = idx * 2.399963229728653;
    const radial = diskRadius * (0.28 + 0.72 * Math.sqrt((idx + 0.5) / clusterCount));
    const yTilt = (seededUnit(fnv1aHash(clusterKey)) - 0.5) * 26;
    clusterCenters.set(clusterKey, {
      x: Math.cos(goldenAngle) * radial,
      y: yTilt,
      z: Math.sin(goldenAngle) * radial,
    });
  });

  const clusterSubIndex = new Map<string, number>();
  for (const node of nodes) {
    const existing = previousPositions?.get(node.id);
    if (existing) {
      positions.set(node.id, { ...existing });
      velocities.set(node.id, { x: 0, y: 0, z: 0 });
      continue;
    }
    const center = clusterCenters.get(node.clusterKey) ?? { x: 0, y: 0, z: 0 };
    const idxInCluster = clusterSubIndex.get(node.clusterKey) ?? 0;
    clusterSubIndex.set(node.clusterKey, idxInCluster + 1);
    const h = fnv1aHash(node.id);
    const angle = h * 0.0001 + idxInCluster * 0.75;
    const localR = 10 + Math.sqrt(idxInCluster + 1) * 7.5;
    const localY = (seededUnit(h ^ 0x5555) - 0.5) * 18;
    positions.set(node.id, {
      x: center.x + Math.cos(angle) * localR,
      y: center.y + localY,
      z: center.z + Math.sin(angle) * localR,
    });
    velocities.set(node.id, { x: 0, y: 0, z: 0 });
  }

  const nonSelfEdges = edges.filter((e) => !e.isSelfLoop);
  const sim: LayoutSimulation = {
    positions,
    clusterCenters,
    alpha: reducedMotion || nodes.length <= 1 ? 0 : 1,
    settled: reducedMotion || nodes.length <= 1,
    step() {
      if (sim.settled || sim.alpha < 0.015) {
        sim.alpha = 0;
        sim.settled = true;
        return false;
      }

      const n = nodes.length;
      const alpha = sim.alpha;
      const clusterPull = 0.045 * alpha;

      // 1. Cluster gravity keeps folder constellations readable.
      for (const node of nodes) {
        const p = positions.get(node.id)!;
        const v = velocities.get(node.id)!;
        const c = clusterCenters.get(node.clusterKey) ?? { x: 0, y: 0, z: 0 };
        v.x += (c.x - p.x) * clusterPull;
        v.y += (c.y - p.y) * (clusterPull * 1.35);
        v.z += (c.z - p.z) * clusterPull;
      }

      // 2. Bounded local repulsion (full O(N^2) for N<=260, deterministic stride sample for larger vaults).
      const stride = n <= 260 ? 1 : Math.ceil(n / 180);
      const repulseStrength = (n > 400 ? 120 : 180) * alpha * stride;
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
          const distSq = dx * dx + dy * dy + dz * dz + 16;
          if (distSq > 6400) continue;
          const inv = repulseStrength / (distSq * Math.sqrt(distSq));
          const fx = dx * inv;
          const fy = dy * inv * 0.6;
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

      // 3. Explicit link springs pull connected stars closer cleanly.
      const restLen = 34;
      const springK = 0.022 * alpha;
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
        const force = ((dist - restLen) / dist) * springK * Math.min(2.5, 0.8 + edge.count * 0.25);
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
        const dx = Math.max(-8, Math.min(8, v.x));
        const dy = Math.max(-5, Math.min(5, v.y));
        const dz = Math.max(-8, Math.min(8, v.z));
        p.x += dx;
        p.y += dy;
        p.z += dz;
        totalMove += Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      }

      sim.alpha *= 0.945;
      if (sim.alpha < 0.015 || (sim.alpha < 0.55 && totalMove < n * 0.03)) {
        sim.alpha = 0;
        sim.settled = true;
        return false;
      }
      return true;
    },
  };

  if (reducedMotion) {
    // Run bounded offline passes synchronously so reduced-motion renders static equilibrium cleanly.
    sim.settled = false;
    sim.alpha = 1;
    for (let k = 0; k < 28 && !sim.settled; k += 1) {
      sim.step();
    }
    sim.alpha = 0;
    sim.settled = true;
  }

  return sim;
}
