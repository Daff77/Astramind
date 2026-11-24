import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UniverseView } from "./UniverseView";
import type { BrokenLinkDto, GraphSnapshotDto } from "../../lib/contracts";

const SAMPLE_GRAPH: GraphSnapshotDto = {
  vault_id: "v-1",
  generation: 7,
  nodes: [
    {
      id: "n-1",
      rel_path: "projects/alpha.md",
      title: "Alpha Hub",
      folder: "projects",
      tags: ["core"],
      origin: "user_created",
      parse_status: "ok",
      verification: "user_verified",
      incoming_count: 1,
      outgoing_count: 1,
    },
    {
      id: "n-2",
      rel_path: "research/beta.md",
      title: "Beta Paper",
      folder: "research",
      tags: ["ml"],
      origin: "imported",
      parse_status: "ok",
      verification: "unverified",
      incoming_count: 1,
      outgoing_count: 0,
    },
  ],
  edges: [{ source: "n-1", target: "n-2", kind: "wiki", count: 1 }],
};

const BROKEN: BrokenLinkDto[] = [
  {
    source_note_id: "n-1",
    source_rel_path: "projects/alpha.md",
    raw_target: "Ghost",
    link_kind: "wiki",
    resolution: "broken",
    line_number: 8,
  },
];

describe("UniverseView interactions, filtering, inspector, and WebGL fallback", () => {
  it("renders empty state cleanly for empty vaults", () => {
    render(
      <UniverseView
        graphSnapshot={{ vault_id: "v-1", generation: 1, nodes: [], edges: [] }}
        brokenLinks={[]}
        selectedNodeId={null}
        isLoading={false}
        isDarkTheme={true}
        reducedMotion={false}
        onSelectNodeId={vi.fn()}
        onOpenNote={vi.fn()}
        onRefreshGraph={vi.fn()}
      />,
    );

    expect(screen.getByText(/Empty Knowledge Universe/i)).toBeInTheDocument();
  });

  it("falls back cleanly to accessible list view when WebGL is unavailable, supports filtering and inspector navigation", () => {
    const onSelectNodeId = vi.fn();
    const onOpenNote = vi.fn();

    const { rerender } = render(
      <UniverseView
        graphSnapshot={SAMPLE_GRAPH}
        brokenLinks={BROKEN}
        selectedNodeId={null}
        isLoading={false}
        isDarkTheme={true}
        reducedMotion={true}
        onSelectNodeId={onSelectNodeId}
        onOpenNote={onOpenNote}
        onRefreshGraph={vi.fn()}
      />,
    );

    // In jsdom WebGL is absent -> GalaxyCanvas catches initialization failure and falls back to List View cleanly.
    expect(
      screen.getByText(/WebGL initialization unavailable/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: /Graph nodes list/i })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Alpha Hub"));
    expect(onSelectNodeId).toHaveBeenCalledWith("n-1");

    // Filter to non-existent match -> shows empty filter prompt -> Clear Filters restores.
    fireEvent.change(screen.getByLabelText("Search graph nodes"), {
      target: { value: "does-not-match" },
    });
    expect(
      screen.getByText(/No matching stars for active filters/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Clear Filters/i })[0]!);
    expect(screen.getByText("Alpha Hub")).toBeInTheDocument();

    // Rerender with selected node n-1 to verify Inspector details, outgoing neighbor, diagnostics, and Open Note.
    rerender(
      <UniverseView
        graphSnapshot={SAMPLE_GRAPH}
        brokenLinks={BROKEN}
        selectedNodeId="n-1"
        isLoading={false}
        isDarkTheme={false}
        reducedMotion={true}
        onSelectNodeId={onSelectNodeId}
        onOpenNote={onOpenNote}
        onRefreshGraph={vi.fn()}
      />,
    );

    const inspector = screen.getByLabelText("Universe node inspector");
    expect(inspector).toHaveTextContent("Alpha Hub");
    expect(inspector).toHaveTextContent("Beta Paper");
    expect(inspector).toHaveTextContent("Ghost");

    fireEvent.click(screen.getByRole("button", { name: /Open Note in Editor/i }));
    expect(onOpenNote).toHaveBeenCalledWith("n-1");

    // Collapsing the inspector shrinks it back to the unobtrusive inspector toggle chip.
    fireEvent.click(screen.getByRole("button", { name: /Collapse Star Inspector/i }));
    expect(screen.queryByLabelText("Universe node inspector")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open Star Inspector/i }));
    expect(screen.getByLabelText("Universe node inspector")).toBeInTheDocument();
  });

  it("supports Display settings popover and Exclusions preview/apply workflow", async () => {
    const onGetExclusions = vi.fn().mockResolvedValue(["node_modules", "target"]);
    const onPreviewExclusions = vi.fn().mockResolvedValue({
      patterns: ["node_modules", "target", "dist"],
      excluded_note_count: 42,
      remaining_note_count: 15,
      sample_excluded_paths: ["dist/docs.md", "node_modules/pkg/README.md"],
    });
    const onApplyExclusions = vi.fn().mockResolvedValue({
      index_generation: 9,
      indexed_notes: 15,
      removed_notes: 42,
      diagnostics: [],
    });

    render(
      <UniverseView
        graphSnapshot={SAMPLE_GRAPH}
        brokenLinks={BROKEN}
        selectedNodeId={null}
        isLoading={false}
        isDarkTheme={true}
        reducedMotion={true}
        onSelectNodeId={vi.fn()}
        onOpenNote={vi.fn()}
        onRefreshGraph={vi.fn()}
        onGetExclusions={onGetExclusions}
        onPreviewExclusions={onPreviewExclusions}
        onApplyExclusions={onApplyExclusions}
      />,
    );

    // Inspector stays collapsed until a star is selected or user opens it.
    expect(screen.queryByLabelText("Universe node inspector")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Universe display settings/i }));
    expect(screen.getByRole("dialog", { name: /Graph visualization settings/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Configure Index Exclusions/i }));
    await waitFor(() => {
      expect(onGetExclusions).toHaveBeenCalledTimes(1);
    });
    const dialog = screen.getByRole("dialog", { name: /Configure Vault Indexing Exclusions/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "dist" }));
    fireEvent.click(screen.getByRole("button", { name: /Preview Impact/i }));
    await waitFor(() => {
      expect(onPreviewExclusions).toHaveBeenCalledWith([
        "node_modules",
        "target",
        "dist",
      ]);
      expect(screen.getByText(/42 excluded · 15 indexed/i)).toBeInTheDocument();
      expect(screen.getByText("dist/docs.md")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /Apply & Rebuild Index/i }));
    await waitFor(() => {
      expect(onApplyExclusions).toHaveBeenCalledWith([
        "node_modules",
        "target",
        "dist",
      ]);
    });
  });
});
