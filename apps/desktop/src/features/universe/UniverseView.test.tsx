import { fireEvent, render, screen } from "@testing-library/react";
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
  });
});
