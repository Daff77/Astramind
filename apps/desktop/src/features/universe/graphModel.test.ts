import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { computeVisibleLabels } from "./GalaxyCanvas";
import { computeOrbitalLabels } from "./OrbitalCanvas";
import {
  filterGraphModel,
  isStaleGraphSnapshot,
  normalizeGraphSnapshot,
} from "./graphModel";
import { createUniverseLayout } from "./layout3d";
import {
  createOrbitalLayout,
  evaluateOrbitalPosition,
} from "./orbitalLayout";
import type { BrokenLinkDto, GraphSnapshotDto } from "../../lib/contracts";

function makeSnapshot(overrides: Partial<GraphSnapshotDto> = {}): GraphSnapshotDto {
  return {
    vault_id: "v-1",
    generation: 2,
    nodes: [],
    edges: [],
    ...overrides,
  };
}

describe("graphModel normalization, filtering, and stale protection (PB-019)", () => {
  it("handles empty and single-note vaults deterministically", () => {
    const empty = normalizeGraphSnapshot(makeSnapshot(), []);
    expect(empty.nodes).toHaveLength(0);
    expect(empty.edges).toHaveLength(0);
    expect(empty.isolatedCount).toBe(0);

    const single = normalizeGraphSnapshot(
      makeSnapshot({
        nodes: [
          {
            id: "n-1",
            rel_path: "solo.md",
            title: "Solo Note",
            folder: "",
            tags: ["idea"],
            origin: "user_created",
            parse_status: "ok",
            verification: "unverified",
            incoming_count: 0,
            outgoing_count: 0,
          },
        ],
      }),
      [],
    );
    expect(single.nodes).toHaveLength(1);
    expect(single.nodes[0]?.clusterKey).toBe("(root)");
    expect(single.isolatedCount).toBe(1);
  });

  it("preserves duplicate titles with distinct IDs, cycles, self-links, Unicode, and broken diagnostics", () => {
    const snap = makeSnapshot({
      nodes: [
        {
          id: "n-a",
          rel_path: "alpha/dup.md",
          title: "Duplicate Title",
          folder: "alpha",
          tags: ["core", "arch"],
          origin: "user_created",
          parse_status: "ok",
          verification: "user_verified",
          incoming_count: 2,
          outgoing_count: 2,
        },
        {
          id: "n-b",
          rel_path: "beta/dup.md",
          title: "Duplicate Title",
          folder: "beta",
          tags: ["arch"],
          origin: "imported",
          parse_status: "warning",
          verification: "unverified",
          incoming_count: 1,
          outgoing_count: 1,
        },
        {
          id: "n-iso",
          rel_path: "日本語/ノート.md",
          title: "日本語タイトル",
          folder: "日本語",
          tags: [],
          origin: "imported",
          parse_status: "unsupported",
          verification: "unverified",
          incoming_count: 0,
          outgoing_count: 0,
        },
      ],
      edges: [
        { source: "n-a", target: "n-a", kind: "wiki", count: 1 },
        { source: "n-a", target: "n-b", kind: "wiki", count: 1 },
        { source: "n-b", target: "n-a", kind: "markdown", count: 1 },
        { source: "n-a", target: "non-existent", kind: "wiki", count: 1 },
      ],
    });

    const broken: BrokenLinkDto[] = [
      {
        source_note_id: "n-a",
        source_rel_path: "alpha/dup.md",
        raw_target: "MissingNote",
        link_kind: "wiki",
        resolution: "broken",
        line_number: 5,
      },
      {
        source_note_id: "n-b",
        source_rel_path: "beta/dup.md",
        raw_target: "dup",
        link_kind: "wiki",
        resolution: "ambiguous",
        line_number: 3,
      },
    ];

    const model = normalizeGraphSnapshot(snap, broken);
    expect(model.nodes).toHaveLength(3);
    expect(model.edges).toHaveLength(3);
    expect(model.isolatedCount).toBe(1);
    expect(model.brokenLinkCount).toBe(1);
    expect(model.ambiguousLinkCount).toBe(1);
    expect(model.nodes.find((n) => n.id === "n-a")?.selfLinkCount).toBe(1);
    expect(model.nodes.find((n) => n.id === "n-iso")?.title).toBe("日本語タイトル");

    // Filters by folder, tag, and query cleanly.
    const byFolder = filterGraphModel(model, {
      query: "",
      folder: "alpha",
      tag: "",
    });
    expect(byFolder.nodes.map((n) => n.id)).toEqual(["n-a"]);
    expect(byFolder.edges.map((e) => e.key)).toEqual(["n-a->n-a:wiki"]);

    const byQuery = filterGraphModel(model, {
      query: "日本語",
      folder: "",
      tag: "",
    });
    expect(byQuery.nodes.map((n) => n.id)).toEqual(["n-iso"]);
  });

  it("rejects stale snapshot generations for same vault while allowing vault switch", () => {
    expect(
      isStaleGraphSnapshot(
        { vaultId: "v-1", generation: 5 },
        makeSnapshot({ vault_id: "v-1", generation: 4 }),
      ),
    ).toBe(true);
    expect(
      isStaleGraphSnapshot(
        { vaultId: "v-1", generation: 5 },
        makeSnapshot({ vault_id: "v-1", generation: 5 }),
      ),
    ).toBe(false);
    expect(
      isStaleGraphSnapshot(
        { vaultId: "v-1", generation: 5 },
        makeSnapshot({ vault_id: "v-2", generation: 1 }),
      ),
    ).toBe(false);
  });

  it("produces deterministic 3D cluster positions and settles immediately in reduced-motion", () => {
    const model = normalizeGraphSnapshot(
      makeSnapshot({
        nodes: [
          {
            id: "n-1",
            rel_path: "a/1.md",
            title: "One",
            folder: "a",
            tags: [],
            origin: "user_created",
            parse_status: "ok",
            verification: "unverified",
            incoming_count: 1,
            outgoing_count: 1,
          },
          {
            id: "n-2",
            rel_path: "b/2.md",
            title: "Two",
            folder: "b",
            tags: [],
            origin: "user_created",
            parse_status: "ok",
            verification: "unverified",
            incoming_count: 1,
            outgoing_count: 1,
          },
        ],
        edges: [{ source: "n-1", target: "n-2", kind: "wiki", count: 1 }],
      }),
      [],
    );

    const simReduced = createUniverseLayout(
      model.nodes,
      model.edges,
      undefined,
      true,
    );
    expect(simReduced.settled).toBe(true);
    expect(simReduced.alpha).toBe(0);
    expect(simReduced.positions.size).toBe(2);

    const simActive = createUniverseLayout(
      model.nodes,
      model.edges,
      undefined,
      false,
    );
    expect(simActive.settled).toBe(false);
    for (let i = 0; i < 200 && !simActive.settled; i += 1) {
      simActive.step();
    }
    expect(simActive.settled).toBe(true);
    expect(simActive.clusterBounds).toHaveLength(2);
    expect(simActive.boundingRadius).toBeGreaterThan(0);
  });

  it("extracts subcluster keys, filters isolated nodes accurately, and rejects overlapping labels", () => {
    const folders = ["projects", "research", "architecture", "daily", "notes"];
    const nodes = Array.from({ length: 40 }, (_, i) => {
      const folder = folders[i % folders.length]!;
      const isIso = i >= 12;
      return {
        id: `n-${i}`,
        rel_path:
          i % 3 === 0
            ? `${folder}/sub-${i % 4}/doc-${i}.md`
            : `${folder}/doc-${i}.md`,
        title: `Star Node ${i}`,
        folder,
        tags: i % 2 === 0 ? ["core"] : [],
        origin: "user_created" as const,
        parse_status: "ok" as const,
        verification: "unverified" as const,
        incoming_count: isIso ? 0 : (i % 4) + 1,
        outgoing_count: isIso ? 0 : 1,
      };
    });
    const edges = Array.from({ length: 11 }, (_, i) => ({
      source: `n-${i}`,
      target: `n-${(i + 1) % 12}`,
      kind: "wiki",
      count: 1,
    }));

    const model = normalizeGraphSnapshot(
      makeSnapshot({ nodes, edges }),
      [],
    );
    expect(model.nodes[0]?.subclusterKey).toBe("sub-0");
    expect(model.isolatedCount).toBe(28);

    const connectedOnly = filterGraphModel(model, {
      query: "",
      folder: "",
      tag: "",
      hideIsolated: true,
    });
    expect(connectedOnly.nodes).toHaveLength(12);
    expect(connectedOnly.totalNodes).toBe(40);
    expect(connectedOnly.isFiltered).toBe(true);

    const sim = createUniverseLayout(model.nodes, model.edges, undefined, true);
    const cam = new THREE.PerspectiveCamera(46, 1280 / 720, 0.5, 4000);
    cam.position.set(0, 60, 140);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();

    const overview = computeVisibleLabels({
      nodes: model.nodes,
      clusterBounds: sim.clusterBounds,
      positions: sim.positions,
      camera: cam,
      width: 1280,
      height: 720,
      cameraDistance: 300,
      boundingRadius: sim.boundingRadius,
      selectedNodeId: null,
      hoveredNodeId: null,
      neighborIds: new Set(),
      searchQuery: "",
      labelDensity: "medium",
      isDarkTheme: true,
    });
    expect(overview.zoomLevel).toBe(1);
    expect(overview.labels.some((l) => l.kind === "cluster")).toBe(true);
    expect(overview.labels.length).toBeLessThanOrEqual(22);

    // Selected node elevates semantic zoom to Level 4 (Star Focus) and appears first.
    const focused = computeVisibleLabels({
      nodes: model.nodes,
      clusterBounds: sim.clusterBounds,
      positions: sim.positions,
      camera: cam,
      width: 1280,
      height: 720,
      cameraDistance: 45,
      boundingRadius: sim.boundingRadius,
      selectedNodeId: "n-0",
      hoveredNodeId: null,
      neighborIds: new Set(["n-1"]),
      searchQuery: "",
      labelDensity: "low",
      isDarkTheme: true,
    });
    expect(focused.zoomLevel).toBe(4);
    expect(focused.labels[0]?.id).toBe("n-0");
    expect(focused.labels.length).toBeLessThanOrEqual(10);
  });

  it("builds deterministic non-overlapping hierarchical orbital systems, deep nesting, pinned planets, and semantic orbital labels", () => {
    const emptyOrb = createOrbitalLayout([], [], { vaultLabel: "EmptyVault" });
    expect(emptyOrb.positions.size).toBe(0);
    expect(emptyOrb.systems[0]?.label).toBe("EmptyVault");

    const rawNodes = [
      {
        id: "n-root",
        rel_path: "index.md",
        title: "Vault Index",
        folder: "",
        tags: ["moc"],
        origin: "user_created" as const,
        parse_status: "ok" as const,
        verification: "user_verified" as const,
        incoming_count: 4,
        outgoing_count: 2,
        pinned: true,
      },
      {
        id: "n-deep",
        rel_path: "projects/alpha/sub/deep/spec.md",
        title: "Deep Spec",
        folder: "projects",
        tags: ["spec"],
        origin: "user_created" as const,
        parse_status: "ok" as const,
        verification: "unverified" as const,
        incoming_count: 1,
        outgoing_count: 1,
        pinned: false,
      },
      ...Array.from({ length: 180 }, (_, i) => {
        const top = ["projects", "research", "architecture", "daily"][i % 4]!;
        const sub = i % 3 === 0 ? `area-${i % 2}/` : "";
        return {
          id: `n-d-${i}`,
          rel_path: `${top}/${sub}note-${i}.md`,
          title: `Orbit Note ${i}`,
          folder: top,
          tags: [],
          origin: "imported" as const,
          parse_status: "ok" as const,
          verification: "unverified" as const,
          incoming_count: i < 30 ? 2 : 0,
          outgoing_count: i < 30 ? 1 : 0,
          pinned: i === 0,
        };
      }),
    ];

    const rawEdges = [
      { source: "n-root", target: "n-deep", kind: "wiki", count: 1 },
      ...Array.from({ length: 24 }, (_, i) => ({
        source: `n-d-${i}`,
        target: `n-d-${(i + 1) % 30}`,
        kind: "wiki",
        count: 1,
      })),
    ];

    const model = normalizeGraphSnapshot(
      makeSnapshot({ nodes: rawNodes, edges: rawEdges }),
      [],
    );
    expect(model.nodes.find((n) => n.id === "n-root")?.pinned).toBe(true);
    expect(model.nodes.find((n) => n.id === "n-deep")?.folderSegments).toEqual([
      "projects",
      "alpha",
      "sub",
      "deep",
    ]);

    const orb1 = createOrbitalLayout(model.nodes, model.edges, {
      vaultLabel: "Main Brain",
      orbitSpacing: 1.0,
    });
    const orb2 = createOrbitalLayout(model.nodes, model.edges, {
      vaultLabel: "Main Brain",
      orbitSpacing: 1.0,
    });

    // Deterministic coordinates across refreshes.
    expect(orb1.positions.size).toBe(model.nodes.length);
    expect(orb1.positions.get("n-deep")).toEqual(orb2.positions.get("n-deep"));
    expect(orb1.systems.some((s) => s.depth === 3 && s.label === "sub")).toBe(
      true,
    );

    // Pinned planets receive subtle size prominence while remaining bounded.
    expect(orb1.planetRadii.get("n-root")!).toBeGreaterThan(
      orb1.planetRadii.get("n-deep")!,
    );
    for (const r of orb1.planetRadii.values()) {
      expect(r).toBeGreaterThanOrEqual(0.8);
      expect(r).toBeLessThanOrEqual(2.35);
    }

    // Top-level sibling systems do not collide in world space.
    const topSystems = orb1.systems.filter((s) => s.depth === 1);
    expect(topSystems).toHaveLength(4);
    for (let i = 0; i < topSystems.length; i += 1) {
      for (let j = i + 1; j < topSystems.length; j += 1) {
        const a = topSystems[i]!;
        const b = topSystems[j]!;
        const centerDist = Math.hypot(
          a.center.x - b.center.x,
          a.center.y - b.center.y,
          a.center.z - b.center.z,
        );
        expect(centerDist).toBeGreaterThan(
          a.systemRadius + b.systemRadius - 1.0,
        );
      }
    }

    // evaluateOrbitalPosition matches static pos at t=0 and orbits smoothly at t>0.
    const pParam = orb1.orbitalParams.get("n-d-0")!;
    expect(evaluateOrbitalPosition(pParam, 0)).toEqual(
      orb1.positions.get("n-d-0"),
    );
    expect(evaluateOrbitalPosition(pParam, 5)).not.toEqual(
      orb1.positions.get("n-d-0"),
    );

    // Semantic zoom & label placement in Orbital mode.
    const cam = new THREE.PerspectiveCamera(45, 1280 / 720, 0.5, 4800);
    cam.position.set(0, 180, 320);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();

    const orbOverview = computeOrbitalLabels({
      nodes: model.nodes,
      systems: orb1.systems,
      positions: orb1.positions,
      camera: cam,
      width: 1280,
      height: 720,
      cameraDistance: orb1.boundingRadius * 1.9,
      boundingRadius: orb1.boundingRadius,
      selectedNodeId: null,
      hoveredNodeId: null,
      focusedSystemKey: null,
      neighborIds: new Set(),
      searchQuery: "",
      labelDensity: "medium",
      isDarkTheme: true,
    });
    expect(orbOverview.zoomLevel).toBe(1);
    expect(orbOverview.labels.some((l) => l.kind === "core")).toBe(true);
    expect(orbOverview.labels.some((l) => l.kind === "system")).toBe(true);
    expect(orbOverview.labels.length).toBeLessThanOrEqual(22);

    const orbFocused = computeOrbitalLabels({
      nodes: model.nodes,
      systems: orb1.systems,
      positions: orb1.positions,
      camera: cam,
      width: 1280,
      height: 720,
      cameraDistance: 40,
      boundingRadius: orb1.boundingRadius,
      selectedNodeId: "n-root",
      hoveredNodeId: null,
      focusedSystemKey: null,
      neighborIds: new Set(["n-deep"]),
      searchQuery: "",
      labelDensity: "low",
      isDarkTheme: true,
    });
    expect(orbFocused.zoomLevel).toBe(4);
    expect(orbFocused.labels[0]?.id).toBe("n-root");
    expect(orbFocused.labels[0]?.isPinned).toBe(true);
  });
});
