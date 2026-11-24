import { describe, expect, it } from "vitest";
import type { GraphSnapshotDto } from "../../lib/contracts";
import { normalizeGraphSnapshot } from "./graphModel";
import type { Vec3 } from "./layout3d";
import {
  createOrbitalLayout,
  evaluateOrbitalPosition,
  getOrbitalFolderKey,
} from "./orbitalLayout";

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe("orbital layout", () => {
  it("keeps folder envelopes and dense note belts separated at compact spacing", () => {
    const raw: GraphSnapshotDto = {
      vault_id: "fixture",
      generation: 1,
      nodes: Array.from({ length: 1_000 }, (_, index) => ({
        id: `n-${index}`,
        rel_path: index < 290
          ? `(vault)/Research/Notes/archive/n-${index}.md`
          : `System ${index % 19}/n-${index}.md`,
        title: `Note ${index}`,
        folder: index < 290 ? "(vault)" : `System ${index % 19}`,
        tags: [],
        origin: "imported",
        parse_status: "ok",
        verification: "unverified",
        incoming_count: 3,
        outgoing_count: index < 500 ? 3 : 2,
        pinned: index % 5 === 0,
      })),
      edges: Array.from({ length: 1_000 }, (_, index) =>
        Array.from({ length: index < 500 ? 3 : 2 }, (_, link) => ({
          source: `n-${index}`,
          target: `n-${(index + link + 1) % 1_000}`,
          kind: "wiki",
          count: 1,
        })),
      ).flat(),
    };
    const graph = normalizeGraphSnapshot(raw, []);
    expect(graph.edges).toHaveLength(2_500);
    const options = { orbitSpacing: 0.7 };
    const layout = createOrbitalLayout(graph.nodes, graph.edges, options);
    const reordered = createOrbitalLayout(
      [...graph.nodes].reverse(),
      graph.edges,
      options,
    );

    const root = layout.systemByKey.get(getOrbitalFolderKey([]))!;
    const reserved = layout.systemByKey.get(getOrbitalFolderKey(["(vault)"]))!;
    const leaf = layout.systemByKey.get(
      getOrbitalFolderKey(["(vault)", "Research", "Notes", "archive"]),
    )!;
    expect(root.noteCount).toBe(1_000);
    expect(reserved.parentKey).toBe(root.key);
    expect(reserved.noteCount).toBe(290);
    expect(leaf.directNoteCount).toBe(290);
    expect(layout.positions.size).toBe(1_000);
    expect(layout.positions).toEqual(reordered.positions);

    const tracks = layout.rings.filter((ring) => !ring.isBelt);
    expect(new Set(tracks.map((ring) => `${ring.systemKey}:${ring.radius}`)).size)
      .toBe(tracks.length);
    expect(tracks.filter((ring) => ring.systemKey === root.key).length)
      .toBeLessThan(20);

    let minimumSystemGap = Infinity;
    for (const [index, a] of layout.systems.entries()) {
      if (!a.parentKey) continue;
      const parent = layout.systemByKey.get(a.parentKey)!;
      expect(distance(a.center, parent.center) + a.systemRadius)
        .toBeLessThanOrEqual(parent.systemRadius + 1e-9);
      for (const b of layout.systems.slice(index + 1)) {
        if (a.parentKey !== b.parentKey) continue;
        minimumSystemGap = Math.min(
          minimumSystemGap,
          distance(a.center, b.center) - a.systemRadius - b.systemRadius,
        );
      }
    }
    expect(minimumSystemGap).toBeGreaterThan(0);

    const bodies = [...layout.orbitalParams].map(([id, orbit]) => ({
      center: evaluateOrbitalPosition(orbit, 137),
      radius: layout.planetRadii.get(id)! * 1.6,
    }));
    let minimumPlanetGap = Infinity;
    for (const [index, a] of bodies.entries()) {
      expect(distance(a.center, root.center) + a.radius)
        .toBeLessThanOrEqual(layout.boundingRadius);
      for (let other = index + 1; other < bodies.length; other += 1) {
        const b = bodies[other]!;
        minimumPlanetGap = Math.min(
          minimumPlanetGap,
          distance(a.center, b.center) - a.radius - b.radius,
        );
      }
    }
    expect(minimumPlanetGap).toBeGreaterThan(0);
  });
});
