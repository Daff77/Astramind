import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as ipc from "../lib/ipc";
import type { AppHealthDto, NoteSnapshot, NoteSummary, VaultSummary } from "../lib/contracts";

const SAMPLE_HEALTH: AppHealthDto = {
  app_name: "Personal Brain",
  core_version: "0.1.0",
  platform: "windows-x86_64",
  paths: {
    app_data_dir: "C:\\AppData\\Local\\PersonalBrain",
    registry_db: "C:\\AppData\\Local\\PersonalBrain\\registry.sqlite",
    vaults_dir: "C:\\AppData\\Local\\PersonalBrain\\vaults",
  },
  sqlite: {
    sqlite_version: "3.49.1",
    fts5_enabled: true,
    fts5_probe_hits: 1,
  },
};

const VAULT_A: VaultSummary = {
  vault_id: "0192b1a0-0000-7000-8000-000000000001",
  display_name: "Engineering Notes",
  root_path: "C:\\Vaults\\Engineering",
  status: "active",
  active_index_generation: 3,
  note_count: 1,
};

const NOTE_A_SUMMARY: NoteSummary = {
  note_id: "0192b1a0-0000-7000-8000-000000000101",
  rel_path: "guides/setup.md",
  title: "Setup Guide",
  content_hash: "hash-setup-1",
  parse_status: "ok",
  origin: "user_created",
  verification: "user_verified",
  pinned: true,
  tags: ["onboarding"],
};

const NOTE_A_SNAPSHOT: NoteSnapshot = {
  note_id: NOTE_A_SUMMARY.note_id,
  vault_id: VAULT_A.vault_id,
  rel_path: NOTE_A_SUMMARY.rel_path,
  title: NOTE_A_SUMMARY.title,
  body: "# Setup Guide\n\nWelcome to local notes.",
  content_hash: NOTE_A_SUMMARY.content_hash,
  parse_status: "ok",
  origin: "user_created",
  verification: "user_verified",
  pinned: true,
  tags: ["onboarding"],
  aliases: ["setup"],
  index_generation: 3,
};

describe("App onboarding & Home/Vault navigation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.spyOn(ipc, "fetchAppHealth").mockResolvedValue(SAMPLE_HEALTH);
    vi.spyOn(ipc, "getVaultBrokenLinks").mockResolvedValue([]);
    vi.spyOn(ipc, "listTrashedNotes").mockResolvedValue([]);
    vi.spyOn(ipc, "getNoteBacklinks").mockResolvedValue([]);
    vi.spyOn(ipc, "listRevisions").mockResolvedValue([]);
    vi.spyOn(ipc, "getDraft").mockResolvedValue(null);
    vi.spyOn(ipc, "saveDraft").mockImplementation(
      async (vault_id, note_id, rel_path, base_hash, draft_seq, body) => ({
        vault_id,
        note_id,
        rel_path,
        base_hash,
        draft_seq,
        body,
        updated_at: "2026-11-24T10:00:00Z",
      }),
    );
    vi.spyOn(ipc, "clearDraft").mockResolvedValue(true);
    vi.spyOn(ipc, "getVaultGraph").mockResolvedValue({
      vault_id: VAULT_A.vault_id,
      generation: 3,
      nodes: [],
      edges: [],
    });
    vi.spyOn(ipc, "subscribeVaultReconciled").mockResolvedValue(() => {});
  });

  it("opens an existing folder into Knowledge workspace and handles core validation errors", async () => {
    vi.spyOn(ipc, "listVaults")
      .mockResolvedValueOnce([])
      .mockResolvedValue([VAULT_A]);
    const openSpy = vi
      .spyOn(ipc, "openVault")
      .mockRejectedValueOnce({
        code: "ACCESS_DENIED",
        message: "Outside sandbox boundary",
        retryable: false,
        operation_id: null,
        safe_details: null,
      })
      .mockResolvedValueOnce({
        vault: VAULT_A,
        notes_discovered: 1,
        attachments_discovered: 0,
        broken_links: 0,
        ambiguous_links: 0,
        diagnostics: [],
      });
    vi.spyOn(ipc, "listNotes").mockResolvedValue([NOTE_A_SUMMARY]);
    vi.spyOn(ipc, "readNote").mockResolvedValue(NOTE_A_SNAPSHOT);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Existing Markdown folder/i)).toBeInTheDocument();
    });

    const openInput = screen.getByLabelText(/Existing Markdown folder/i);
    fireEvent.change(openInput, { target: { value: "C:\\Forbidden\\Escape" } });
    fireEvent.click(screen.getByRole("button", { name: "Open Vault" }));

    await waitFor(() => {
      expect(screen.getAllByText(/ACCESS_DENIED/i).length).toBeGreaterThan(0);
    });

    fireEvent.change(openInput, { target: { value: VAULT_A.root_path } });
    fireEvent.click(screen.getByRole("button", { name: "Open Vault" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenLastCalledWith(VAULT_A.root_path);
      expect(screen.getByLabelText("Vault explorer")).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText("setup.md")[0]!);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Setup Guide" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => {
      expect(screen.getByLabelText("Home workspace")).toBeInTheDocument();
      expect(screen.getByText("Indexed Notes")).toBeInTheDocument();
    });
  });

  it("creates a new vault via typed directory input", async () => {
    vi.spyOn(ipc, "listVaults")
      .mockResolvedValueOnce([])
      .mockResolvedValue([VAULT_A]);
    const createSpy = vi.spyOn(ipc, "createVault").mockResolvedValue({
      vault: { ...VAULT_A, note_count: 0 },
      notes_discovered: 0,
      attachments_discovered: 0,
      broken_links: 0,
      ambiguous_links: 0,
      diagnostics: [],
    });
    vi.spyOn(ipc, "listNotes").mockResolvedValue([]);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Target folder/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Target folder/i), {
      target: { value: "C:\\Vaults\\Engineering" },
    });
    fireEvent.change(screen.getByLabelText(/Display name/i), {
      target: { value: "Engineering Notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Vault" }));

    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        "C:\\Vaults\\Engineering",
        "Engineering Notes",
      );
      expect(
        screen.getByText(/This vault has no Markdown notes yet/i),
      ).toBeInTheDocument();
    });
  });
});
