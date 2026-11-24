import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as ipc from "../lib/ipc";
import type {
  NoteSnapshot,
  NoteSummary,
  VaultSummary,
  WatcherEventDto,
} from "../lib/contracts";

const HEALTH = {
  app_name: "Personal Brain",
  core_version: "0.1.0",
  platform: "windows-x86_64",
  paths: {
    app_data_dir: "C:\\Users\\test\\AppData\\Local\\PersonalBrain",
    registry_db:
      "C:\\Users\\test\\AppData\\Local\\PersonalBrain\\registry.sqlite",
    vaults_dir: "C:\\Users\\test\\AppData\\Local\\PersonalBrain\\vaults",
  },
  sqlite: {
    sqlite_version: "3.49.1",
    fts5_enabled: true,
    fts5_probe_hits: 1,
  },
};

const VAULT_1: VaultSummary = {
  vault_id: "0192b1a0-0000-7000-8000-000000000001",
  display_name: "Brain One",
  root_path: "C:\\Vaults\\BrainOne",
  status: "active",
  active_index_generation: 2,
  note_count: 1,
};

const NOTE_1: NoteSummary = {
  note_id: "0192b1a0-0000-7000-8000-000000000101",
  rel_path: "notes/alpha.md",
  title: "Alpha",
  content_hash: "h-1",
  parse_status: "ok",
  origin: "user_created",
  verification: "unverified",
  pinned: false,
  tags: [],
};

const SNAP_1: NoteSnapshot = {
  note_id: NOTE_1.note_id,
  vault_id: VAULT_1.vault_id,
  rel_path: NOTE_1.rel_path,
  title: "Alpha",
  body: "# Alpha\n\nSaved body.",
  content_hash: "h-1",
  parse_status: "ok",
  origin: "user_created",
  verification: "unverified",
  pinned: false,
  tags: [],
  aliases: [],
  index_generation: 2,
};

describe("App desktop shell, durable drafts & Universe navigation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("disables Universe until a vault is open and keeps AI Brain / Memory disabled", async () => {
    vi.spyOn(ipc, "fetchAppHealth").mockResolvedValue(HEALTH);
    vi.spyOn(ipc, "listVaults").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: /Open or create a local Markdown vault/i,
        }),
      ).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Universe" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /AI Brain \(Unavailable in Phase 4\)/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Memory \(Unavailable in Phase 4\)/i }),
    ).toBeDisabled();
  });

  it("surfaces structured ErrorEnvelope and rejects unknown ErrorCodes", async () => {
    vi.spyOn(ipc, "fetchAppHealth").mockRejectedValue({
      code: "STATE_UNAVAILABLE",
      message: "database offline",
      retryable: false,
      operation_id: null,
      safe_details: null,
    });
    vi.spyOn(ipc, "listVaults").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getAllByText(/STATE_UNAVAILABLE.*database offline/i).length,
      ).toBeGreaterThan(0);
    });

    expect(ipc.parseErrorCode("CONFLICT")).toBe("CONFLICT");
    expect(ipc.parseErrorCode("UNKNOWN_FAKE_CODE")).toBe("IO_FAILED");
  });

  it("offers explicit durable draft restore/discard and preserves dirty draft across Universe navigation", async () => {
    const watcherHook: { cb: ((ev: WatcherEventDto) => void) | null } = {
      cb: null,
    };
    vi.spyOn(ipc, "fetchAppHealth").mockResolvedValue(HEALTH);
    vi.spyOn(ipc, "listVaults").mockResolvedValue([VAULT_1]);
    vi.spyOn(ipc, "openVault").mockResolvedValue({
      vault: VAULT_1,
      notes_discovered: 1,
      attachments_discovered: 0,
      broken_links: 0,
      ambiguous_links: 0,
      diagnostics: [],
    });
    vi.spyOn(ipc, "listNotes").mockResolvedValue([NOTE_1]);
    vi.spyOn(ipc, "getVaultBrokenLinks").mockResolvedValue([]);
    vi.spyOn(ipc, "listTrashedNotes").mockResolvedValue([]);
    vi.spyOn(ipc, "getNoteBacklinks").mockResolvedValue([]);
    vi.spyOn(ipc, "listRevisions").mockResolvedValue([]);
    vi.spyOn(ipc, "readNote").mockResolvedValue(SNAP_1);
    vi.spyOn(ipc, "getDraft").mockResolvedValue({
      vault_id: VAULT_1.vault_id,
      note_id: NOTE_1.note_id,
      rel_path: NOTE_1.rel_path,
      base_hash: "h-1",
      draft_seq: 4,
      body: "# Alpha\n\nRecovered crash draft!",
      updated_at: "2026-11-24T12:34:56Z",
    });
    vi.spyOn(ipc, "getVaultGraph").mockResolvedValue({
      vault_id: VAULT_1.vault_id,
      generation: 2,
      nodes: [
        {
          id: NOTE_1.note_id,
          rel_path: NOTE_1.rel_path,
          title: "Alpha",
          folder: "notes",
          tags: [],
          origin: "user_created",
          parse_status: "ok",
          verification: "unverified",
          incoming_count: 0,
          outgoing_count: 0,
        },
      ],
      edges: [],
    });
    vi.spyOn(ipc, "subscribeVaultReconciled").mockImplementation(async (cb) => {
      watcherHook.cb = cb;
      return () => {
        watcherHook.cb = null;
      };
    });
    const retrySpy = vi.spyOn(ipc, "triggerReconcile").mockResolvedValue(true);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(screen.getByText("alpha.md")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("alpha.md"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Restore Draft" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore Draft" }));
    await waitFor(() => {
      expect(
        screen.getAllByText(/Recovered crash draft!/i).length,
      ).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });

    // Navigate to Universe and back to Knowledge: dirty draft remains intact.
    fireEvent.click(screen.getByRole("button", { name: "Universe" }));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Knowledge Universe"),
      ).toBeInTheDocument();
    });

    // Stale watcher notification displays Retry Sync button.
    watcherHook.cb?.({
      vault_id: VAULT_1.vault_id,
      index_generation: 2,
      indexed_notes: 0,
      removed_notes: 0,
      from_overflow: false,
      stale: true,
      error_code: "BUSY",
      error_message: "Vault lock busy during reconciliation",
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry Sync" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry Sync" }));
    expect(retrySpy).toHaveBeenCalledWith(VAULT_1.vault_id);

    // Return to Knowledge -> draft preserved.
    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    await waitFor(() => {
      expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    });
  });

  it("enters non-destructive Conflict mode when restoring a stale-base durable draft", async () => {
    vi.spyOn(ipc, "fetchAppHealth").mockResolvedValue(HEALTH);
    vi.spyOn(ipc, "listVaults").mockResolvedValue([VAULT_1]);
    vi.spyOn(ipc, "openVault").mockResolvedValue({
      vault: VAULT_1,
      notes_discovered: 1,
      attachments_discovered: 0,
      broken_links: 0,
      ambiguous_links: 0,
      diagnostics: [],
    });
    vi.spyOn(ipc, "listNotes").mockResolvedValue([NOTE_1]);
    vi.spyOn(ipc, "getVaultBrokenLinks").mockResolvedValue([]);
    vi.spyOn(ipc, "listTrashedNotes").mockResolvedValue([]);
    vi.spyOn(ipc, "getNoteBacklinks").mockResolvedValue([]);
    vi.spyOn(ipc, "listRevisions").mockResolvedValue([]);
    vi.spyOn(ipc, "subscribeVaultReconciled").mockResolvedValue(() => {});
    vi.spyOn(ipc, "readNote").mockResolvedValue({
      ...SNAP_1,
      content_hash: "h-newer-disk",
      body: "# Alpha\n\nNewer disk edit.",
    });
    vi.spyOn(ipc, "getDraft").mockResolvedValue({
      vault_id: VAULT_1.vault_id,
      note_id: NOTE_1.note_id,
      rel_path: NOTE_1.rel_path,
      base_hash: "h-older-stale",
      draft_seq: 5,
      body: "# Alpha\n\nOlder crash draft.",
      updated_at: "2026-11-24T12:34:56Z",
    });
    const saveSpy = vi.spyOn(ipc, "saveNote");

    render(<App />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(screen.getByText("alpha.md")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("alpha.md"));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Restore Draft" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore Draft" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Review Conflict" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
