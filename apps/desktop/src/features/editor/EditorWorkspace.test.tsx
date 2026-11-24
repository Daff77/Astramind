import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdownPreview } from "./SafeMarkdownPreview";
import { EditorWorkspace } from "./EditorWorkspace";
import { NoteInspector } from "../inspector/NoteInspector";
import type { EditorTabState, NoteSummary } from "../../lib/contracts";

function makeTab(overrides: Partial<EditorTabState> = {}): EditorTabState {
  return {
    noteId: "note-1",
    relPath: "projects/alpha.md",
    title: "Alpha",
    savedBody: "# Alpha\n\nBody text",
    draftBody: "# Alpha\n\nBody text",
    baseHash: "hash-1",
    parseStatus: "ok",
    origin: "user_created",
    verification: "unverified",
    pinned: false,
    tags: ["design"],
    aliases: [],
    indexGeneration: 4,
    dirty: false,
    saveState: "saved",
    lastSavedAt: "12:00:00",
    conflict: null,
    externalUpdateNotice: null,
    ...overrides,
  };
}

describe("SafeMarkdownPreview security and wikilinks", () => {
  it("sanitizes unsafe scripts/links/images and handles [[Wikilinks]] outside code", () => {
    const onOpenWikilink = vi.fn();
    const unsafeMd = [
      "# Title",
      "",
      `<script>window.__xss = true;</script>`,
      "",
      `[js](javascript:alert(1)) [data](data:text/html,hi) [file](file:///C:/secret.txt) [unc](\\\\server\\share\\x)`,
      "",
      `![remote](https://evil.example/pixel.png)`,
      "",
      "Link to [[Target Note|Display Alias]], [Setup](guides/setup.md), and `[[CodeIgnored]]`.",
    ].join("\n");

    const { container } = render(
      <SafeMarkdownPreview
        markdown={unsafeMd}
        onOpenWikilink={onOpenWikilink}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('a[href^="file:"]')).toBeNull();
    expect(screen.getAllByText(/\[blocked link:/i).length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/image blocked by local privacy policy/i)).toBeInTheDocument();

    const wikiBtn = screen.getByRole("button", { name: "Display Alias" });
    fireEvent.click(wikiBtn);
    expect(onOpenWikilink).toHaveBeenCalledWith("Target Note");
    fireEvent.click(screen.getByRole("button", { name: "Setup" }));
    expect(onOpenWikilink).toHaveBeenCalledWith("guides/setup.md");
    expect(screen.queryByRole("button", { name: "CodeIgnored" })).toBeNull();
  });
});

describe("EditorWorkspace editing, conflicts, move preview, and close protection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts real CodeMirror editor, shows dirty close prompt, and renders unsupported read-only warning", () => {
    const dirtyTab = makeTab({
      dirty: true,
      draftBody: "# Alpha\n\nEdited draft",
      parseStatus: "unsupported",
    });

    const onRequestCloseTab = vi.fn();
    const onConfirmSaveAndClosePending = vi.fn().mockResolvedValue(undefined);
    const onConfirmDiscardClosePending = vi.fn();

    render(
      <EditorWorkspace
        vaultId="v-1"
        notes={[]}
        tabs={[dirtyTab]}
        activeTab={dirtyTab}
        viewMode="split"
        showExplorer={true}
        showInspector={true}
        isBusy={false}
        onChangeViewMode={vi.fn()}
        onToggleExplorer={vi.fn()}
        onToggleInspector={vi.fn()}
        onSelectTab={vi.fn()}
        onRequestCloseTab={onRequestCloseTab}
        onChangeDraft={vi.fn()}
        onSaveTab={vi.fn().mockResolvedValue(undefined)}
        onCreateNotePrompt={vi.fn().mockResolvedValue(undefined)}
        onPreviewMove={vi.fn()}
        onConfirmMove={vi.fn().mockResolvedValue(undefined)}
        onConfirmTrash={vi.fn().mockResolvedValue(undefined)}
        onResolveReloadExternal={vi.fn().mockResolvedValue(undefined)}
        onResolveSaveCopy={vi.fn().mockResolvedValue(undefined)}
        onResolveOverwriteDisk={vi.fn().mockResolvedValue(undefined)}
        onCloseDeletedTab={vi.fn()}
        onOpenWikilink={vi.fn()}
        pendingCloseTab={dirtyTab}
        onCancelClosePending={vi.fn()}
        onConfirmDiscardClosePending={onConfirmDiscardClosePending}
        onConfirmSaveAndClosePending={onConfirmSaveAndClosePending}
        moveModalNote={null}
        onCloseMoveModal={vi.fn()}
        trashModalNote={null}
        onCloseTrashModal={vi.fn()}
      />,
    );

    expect(screen.getByTestId("cm-editor-host")).toBeInTheDocument();
    expect(
      screen.getByText(/open read-only to prevent corruption/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: /Unsaved changes confirmation/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(onConfirmDiscardClosePending).toHaveBeenCalledTimes(1);
  });

  it("opens Conflict Resolution modal and invokes Save Copy / Reload / Overwrite actions", async () => {
    const conflictTab = makeTab({
      dirty: true,
      saveState: "conflict",
      draftBody: "Local draft content",
      conflict: {
        kind: "modified",
        noteId: "note-1",
        relPath: "projects/alpha.md",
        localBody: "Local draft content",
        localBaseHash: "hash-1",
        externalBody: "External disk content",
        externalHash: "hash-2",
        message: "Modified externally on disk while you have unsaved edits.",
      },
    });

    const onResolveSaveCopy = vi.fn().mockResolvedValue(undefined);
    const onResolveReloadExternal = vi.fn().mockResolvedValue(undefined);
    const onResolveOverwriteDisk = vi.fn().mockResolvedValue(undefined);

    render(
      <EditorWorkspace
        vaultId="v-1"
        notes={[]}
        tabs={[conflictTab]}
        activeTab={conflictTab}
        viewMode="edit"
        showExplorer={true}
        showInspector={true}
        isBusy={false}
        onChangeViewMode={vi.fn()}
        onToggleExplorer={vi.fn()}
        onToggleInspector={vi.fn()}
        onSelectTab={vi.fn()}
        onRequestCloseTab={vi.fn()}
        onChangeDraft={vi.fn()}
        onSaveTab={vi.fn().mockResolvedValue(undefined)}
        onCreateNotePrompt={vi.fn().mockResolvedValue(undefined)}
        onPreviewMove={vi.fn()}
        onConfirmMove={vi.fn().mockResolvedValue(undefined)}
        onConfirmTrash={vi.fn().mockResolvedValue(undefined)}
        onResolveReloadExternal={onResolveReloadExternal}
        onResolveSaveCopy={onResolveSaveCopy}
        onResolveOverwriteDisk={onResolveOverwriteDisk}
        onCloseDeletedTab={vi.fn()}
        onOpenWikilink={vi.fn()}
        pendingCloseTab={null}
        onCancelClosePending={vi.fn()}
        onConfirmDiscardClosePending={vi.fn()}
        onConfirmSaveAndClosePending={vi.fn().mockResolvedValue(undefined)}
        moveModalNote={null}
        onCloseMoveModal={vi.fn()}
        trashModalNote={null}
        onCloseTrashModal={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review Conflict" }));
    const dialog = screen.getByRole("dialog", {
      name: /Resolve external modification conflict/i,
    });
    expect(within(dialog).getByText("Local draft content")).toBeInTheDocument();
    expect(within(dialog).getByText("External disk content")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save Local as Copy" }));
    await waitFor(() => {
      expect(onResolveSaveCopy).toHaveBeenCalledWith("note-1");
    });
  });

  it("shows affected backlinks in Move preview modal and confirms move", async () => {
    const moveNoteSummary: NoteSummary = {
      note_id: "note-1",
      rel_path: "projects/alpha.md",
      title: "Alpha",
      content_hash: "hash-1",
      parse_status: "ok",
      origin: "user_created",
      verification: "unverified",
      pinned: false,
      tags: [],
    };
    const onPreviewMove = vi.fn().mockResolvedValue({
      vault_id: "v-1",
      note_id: "note-1",
      old_rel_path: "projects/alpha.md",
      new_rel_path: "archive/alpha-renamed.md",
      affected_backlinks: [
        {
          source_note_id: "note-2",
          source_rel_path: "index.md",
          source_title: "Index",
          raw_target: "Alpha",
          link_kind: "wiki",
          line_number: 4,
        },
      ],
    });
    const onConfirmMove = vi.fn().mockResolvedValue(undefined);

    render(
      <EditorWorkspace
        vaultId="v-1"
        notes={[moveNoteSummary]}
        tabs={[]}
        activeTab={null}
        viewMode="split"
        showExplorer={true}
        showInspector={true}
        isBusy={false}
        onChangeViewMode={vi.fn()}
        onToggleExplorer={vi.fn()}
        onToggleInspector={vi.fn()}
        onSelectTab={vi.fn()}
        onRequestCloseTab={vi.fn()}
        onChangeDraft={vi.fn()}
        onSaveTab={vi.fn().mockResolvedValue(undefined)}
        onCreateNotePrompt={vi.fn().mockResolvedValue(undefined)}
        onPreviewMove={onPreviewMove}
        onConfirmMove={onConfirmMove}
        onConfirmTrash={vi.fn().mockResolvedValue(undefined)}
        onResolveReloadExternal={vi.fn().mockResolvedValue(undefined)}
        onResolveSaveCopy={vi.fn().mockResolvedValue(undefined)}
        onResolveOverwriteDisk={vi.fn().mockResolvedValue(undefined)}
        onCloseDeletedTab={vi.fn()}
        onOpenWikilink={vi.fn()}
        pendingCloseTab={null}
        onCancelClosePending={vi.fn()}
        onConfirmDiscardClosePending={vi.fn()}
        onConfirmSaveAndClosePending={vi.fn().mockResolvedValue(undefined)}
        moveModalNote={moveNoteSummary}
        onCloseMoveModal={vi.fn()}
        trashModalNote={null}
        onCloseTrashModal={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Destination path/i), {
      target: { value: "archive/alpha-renamed.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview Move" }));

    await waitFor(() => {
      expect(screen.getByText(/index\.md/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Confirm Move" }));
    await waitFor(() => {
      expect(onConfirmMove).toHaveBeenCalledTimes(1);
    });
  });

  it("displays Inspector backlinks, broken links, and confirms revision restore", async () => {
    const tab = makeTab();
    const onRestoreRevision = vi.fn().mockResolvedValue(undefined);

    render(
      <NoteInspector
        note={tab}
        backlinks={[
          {
            source_note_id: "note-2",
            source_rel_path: "index.md",
            source_title: "Index",
            raw_target: "Alpha",
            link_kind: "wiki",
            line_number: 2,
          },
        ]}
        brokenLinks={[
          {
            source_note_id: "note-1",
            source_rel_path: "projects/alpha.md",
            raw_target: "MissingNote",
            link_kind: "wiki",
            resolution: "broken",
            line_number: 9,
          },
        ]}
        revisions={[
          {
            revision_id: "rev-1",
            operation_id: "op-1",
            note_id: "note-1",
            old_path: null,
            new_path: "projects/alpha.md",
            actor_key: "desktop-user",
            created_at: "2026-11-24T09:00:00Z",
          },
        ]}
        isLoadingDetails={false}
        onTogglePin={vi.fn().mockResolvedValue(undefined)}
        onOpenNote={vi.fn()}
        onRestoreRevision={onRestoreRevision}
        onRefreshDetails={vi.fn()}
      />,
    );

    expect(screen.getByText("Index")).toBeInTheDocument();
    expect(screen.getByText("MissingNote")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore Revision" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm Restore" }));

    await waitFor(() => {
      expect(onRestoreRevision).toHaveBeenCalledTimes(1);
    });
  });
});
