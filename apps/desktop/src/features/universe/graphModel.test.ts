import { describe, expect, it } from "vitest";
import {
  filterGraphModel,
  isStaleGraphSnapshot,
  normalizeGraphSnapshot,
} from "./graphModel";
import { createUniverseLayout } from "./layout3d";
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
  });
});
