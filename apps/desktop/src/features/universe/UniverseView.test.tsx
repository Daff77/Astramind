import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UniverseView } from "./UniverseView";
import type {
  BrokenLinkDto,
  GraphSnapshotDto,
  NoteSnapshot,
} from "../../lib/contracts";

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
      pinned: true,
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
      pinned: false,
    },
    {
      id: "n-3",
      rel_path: "notes/isolated.md",
      title: "Isolated Note",
      folder: "notes",
      tags: [],
      origin: "imported",
      parse_status: "ok",
      verification: "unverified",
      incoming_count: 0,
      outgoing_count: 0,
      pinned: false,
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

const SNAP_1: NoteSnapshot = {
  vault_id: "v-1",
  note_id: "n-1",
  rel_path: "projects/alpha.md",
  title: "Alpha Hub",
  body: "# Alpha Hub\n\nSafe excerpt referencing [[Beta Paper]].",
  content_hash: "hash-1",
  parse_status: "ok",
  origin: "user_created",
  verification: "user_verified",
  pinned: true,
  tags: ["core"],
  aliases: [],
  index_generation: 7,
};

describe("UniverseView interactions, orbital/graph/list modes, inspector, and exclusions", () => {
  it("renders empty state cleanly for empty vaults", () => {
    render(
      <UniverseView
        vaultName="Empty Brain"
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

  it("falls back cleanly to accessible list view when WebGL is unavailable, renders excerpt, Focus Connections, and inspector controls", async () => {
    const onSelectNodeId = vi.fn();
    const onOpenNote = vi.fn();
    const onReadNoteExcerpt = vi.fn().mockResolvedValue(SNAP_1);

    const { rerender } = render(
      <UniverseView
        vaultName="Main Brain"
        graphSnapshot={SAMPLE_GRAPH}
        brokenLinks={BROKEN}
        selectedNodeId={null}
        isLoading={false}
        isDarkTheme={true}
        reducedMotion={true}
        onSelectNodeId={onSelectNodeId}
        onOpenNote={onOpenNote}
        onReadNoteExcerpt={onReadNoteExcerpt}
        onRefreshGraph={vi.fn()}
      />,
    );

    // In jsdom WebGL is absent -> falls back to List View cleanly.
    expect(
      screen.getByText(/WebGL initialization unavailable/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listbox", { name: /Graph nodes list/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Alpha Hub"));
    expect(onSelectNodeId).toHaveBeenCalledWith("n-1");

    // Filter to non-existent match -> shows empty filter prompt -> Clear Filters restores.
    fireEvent.change(screen.getByLabelText("Search graph nodes"), {
      target: { value: "does-not-match" },
    });
    expect(
      screen.getByText(/No matching notes for active filters/i),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /Clear Filters/i })[0]!);
    expect(screen.getByText("Alpha Hub")).toBeInTheDocument();

    // Rerender with selected node n-1 to verify floating inspector, excerpt, Focus Connections, and Open in Editor.
    rerender(
      <UniverseView
        vaultName="Main Brain"
        graphSnapshot={SAMPLE_GRAPH}
        brokenLinks={BROKEN}
        selectedNodeId="n-1"
        isLoading={false}
        isDarkTheme={false}
        reducedMotion={true}
        onSelectNodeId={onSelectNodeId}
        onOpenNote={onOpenNote}
        onReadNoteExcerpt={onReadNoteExcerpt}
        onRefreshGraph={vi.fn()}
      />,
    );

    const inspector = screen.getByLabelText("Universe node inspector");
    const resize = screen.getByRole("separator", { name: /Resize Note Inspector/i });
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(resize).toHaveAttribute("aria-valuenow", "336");
    expect(inspector).toHaveTextContent("Alpha Hub");
    expect(inspector).toHaveTextContent("Pinned");
    expect(inspector).toHaveTextContent("Beta Paper");
    expect(inspector).toHaveTextContent("Ghost");

    await waitFor(() => {
      expect(onReadNoteExcerpt).toHaveBeenCalledWith("n-1");
      expect(inspector).toHaveTextContent(/Safe excerpt referencing/i);
    });

    // Focus Connections isolates connected subgraph (hides Isolated Note).
    expect(screen.getByText("Isolated Note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Focus Connections/i }));
    expect(screen.queryByText("Isolated Note")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Focus Connections/i }));
    expect(screen.getByText("Isolated Note")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Open in Editor/i }));
    expect(onOpenNote).toHaveBeenCalledWith("n-1");

    // Collapsing the inspector shrinks it back to the unobtrusive inspector toggle chip.
    fireEvent.click(
      screen.getByRole("button", { name: /Collapse Note Inspector/i }),
    );
    expect(
      screen.queryByLabelText("Universe node inspector"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /Open Note Inspector/i }),
    );
    expect(screen.getByLabelText("Universe node inspector")).toBeInTheDocument();
  });

  it("refreshes a selected excerpt after a graph update and discards a late response", async () => {
    let resolveFirst!: (value: NoteSnapshot) => void;
    const firstRead = new Promise<NoteSnapshot>((resolve) => {
      resolveFirst = resolve;
    });
    const onReadNoteExcerpt = vi.fn()
      .mockReturnValueOnce(firstRead)
      .mockResolvedValueOnce({
        ...SNAP_1,
        body: "Current excerpt",
        content_hash: "hash-new",
        index_generation: 8,
      });
    const props = {
      brokenLinks: BROKEN,
      selectedNodeId: "n-1",
      isLoading: false,
      isDarkTheme: true,
      reducedMotion: true,
      onSelectNodeId: vi.fn(),
      onOpenNote: vi.fn(),
      onReadNoteExcerpt,
      onRefreshGraph: vi.fn(),
    };
    const { rerender } = render(
      <UniverseView {...props} graphSnapshot={SAMPLE_GRAPH} />,
    );
    rerender(
      <UniverseView {...props} graphSnapshot={{ ...SAMPLE_GRAPH, generation: 8 }} />,
    );
    expect(await screen.findByText("Current excerpt")).toBeInTheDocument();
    await act(async () => resolveFirst(SNAP_1));
    expect(screen.getByText("Current excerpt")).toBeInTheDocument();
    expect(screen.queryByText(/Safe excerpt referencing/i)).not.toBeInTheDocument();
    expect(onReadNoteExcerpt).toHaveBeenCalledTimes(2);
  });

  it("supports Display settings popover (Orbit settings) and Exclusions preview/apply workflow", async () => {
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
        vaultName="Main Brain"
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

    // Inspector stays collapsed until a note is selected or user opens it.
    expect(
      screen.queryByLabelText("Universe node inspector"),
    ).not.toBeInTheDocument();

    // Display settings exposes Orbit/Graph controls including background starfield and orbital motion.
    fireEvent.click(
      screen.getByRole("button", { name: /Universe display settings/i }),
    );
    const settingsDialog = screen.getByRole("dialog", {
      name: /Graph visualization settings/i,
    });
    expect(settingsDialog).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Show background starfield/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Gentle orbital motion/i)).not.toBeChecked();

    fireEvent.click(
      screen.getByRole("button", { name: /Configure Index Exclusions/i }),
    );
    await waitFor(() => {
      expect(onGetExclusions).toHaveBeenCalledTimes(1);
    });
    const dialog = screen.getByRole("dialog", {
      name: /Configure Vault Indexing Exclusions/i,
    });
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

    fireEvent.click(
      screen.getByRole("button", { name: /Apply & Rebuild Index/i }),
    );
    await waitFor(() => {
      expect(onApplyExclusions).toHaveBeenCalledWith([
        "node_modules",
        "target",
        "dist",
      ]);
    });
  });

  it("keeps the exclusions editor closed when saved preferences cannot be read", async () => {
    const onGetExclusions = vi.fn().mockRejectedValue(new Error("Unavailable"));
    const onApplyExclusions = vi.fn();
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
        onPreviewExclusions={vi.fn()}
        onApplyExclusions={onApplyExclusions}
      />,
    );

    const display = screen.getByRole("button", { name: /Universe display settings/i });
    fireEvent.click(display);
    fireEvent.click(screen.getByRole("button", { name: /Configure Index Exclusions/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t load the saved exclusions",
    );
    expect(screen.queryByRole("dialog", { name: /Configure Vault Indexing Exclusions/i }))
      .not.toBeInTheDocument();
    expect(onApplyExclusions).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(display).toHaveFocus();
    expect(display).toHaveAttribute("aria-expanded", "false");
  });
});
