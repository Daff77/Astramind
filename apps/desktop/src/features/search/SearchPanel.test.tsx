import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPanel } from "./SearchPanel";
import * as ipc from "../../lib/ipc";
import type { NoteSummary } from "../../lib/contracts";

const NOTES: NoteSummary[] = [
  {
    note_id: "n-1",
    rel_path: "work/spec.md",
    title: "Architecture Spec",
    content_hash: "h-1",
    parse_status: "ok",
    origin: "user_created",
    verification: "unverified",
    pinned: false,
    tags: ["arch"],
  },
  {
    note_id: "n-2",
    rel_path: "daily/today.md",
    title: "Daily Log",
    content_hash: "h-2",
    parse_status: "ok",
    origin: "user_created",
    verification: "unverified",
    pinned: false,
    tags: ["journal"],
  },
];

describe("SearchPanel FTS5 query, filters, pagination, and keyboard nav", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("queries searchVaultNotes with folder/tag filters, supports cursor pagination, and navigates via keyboard", async () => {
    const searchSpy = vi
      .spyOn(ipc, "searchVaultNotes")
      .mockResolvedValueOnce({
        items: [
          {
            note_id: "n-1",
            rel_path: "work/spec.md",
            title: "Architecture Spec",
            content_hash: "h-1",
            snippet: "Local-first architecture specification",
            verification: "unverified",
            index_generation: 2,
          },
        ],
        next_cursor: "cursor-2",
        generation: 2,
      })
      .mockResolvedValueOnce({
        items: [
          {
            note_id: "n-2",
            rel_path: "daily/today.md",
            title: "Daily Log",
            content_hash: "h-2",
            snippet: "Second page hit",
            verification: "unverified",
            index_generation: 2,
          },
        ],
        next_cursor: null,
        generation: 2,
      });

    const onSelectNote = vi.fn();
    const onClose = vi.fn();

    render(
      <SearchPanel
        isOpen={true}
        vaultId="v-1"
        notes={NOTES}
        onSelectNote={onSelectNote}
        onClose={onClose}
      />,
    );

    fireEvent.change(screen.getByLabelText("Filter by folder"), {
      target: { value: "work" },
    });
    fireEvent.change(screen.getByLabelText("Filter by tag"), {
      target: { value: "arch" },
    });
    fireEvent.change(screen.getByLabelText("Search query"), {
      target: { value: "architecture" },
    });

    await waitFor(() => {
      expect(searchSpy).toHaveBeenLastCalledWith(
        "v-1",
        "architecture",
        { folder_prefix: "work", tag: "arch" },
        20,
      );
      expect(screen.getByText("Architecture Spec")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Load more results" }));

    await waitFor(() => {
      expect(screen.getByText("Daily Log")).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog", { name: /Search vault notes/i });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });

    expect(onSelectNote).toHaveBeenCalledWith("n-2");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
