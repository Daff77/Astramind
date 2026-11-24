import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import type { VaultSummary } from "../../lib/contracts";

const VAULT: VaultSummary = {
  vault_id: "v-1",
  display_name: "Test Vault",
  root_path: "C:\\Vaults\\Test",
  status: "active",
  active_index_generation: 5,
  note_count: 12,
};

describe("SettingsView maintenance, backup/restore, trash, and preferences", () => {
  it("invokes confirmed Rebuild Index, Export, Backup, Restore Backup, and Trashed Note recovery", async () => {
    const onChangeTheme = vi.fn();
    const onRebuildIndex = vi.fn().mockResolvedValue({
      index_generation: 6,
      indexed_notes: 12,
      removed_notes: 0,
      diagnostics: [],
    });
    const onExportMarkdown = vi.fn().mockResolvedValue(12);
    const onCreateBackup = vi.fn().mockResolvedValue({
      backup_id: "bak-1",
      destination: "C:\\Backups\\Out",
      vault_files_count: 12,
      blobs_count: 4,
    });
    const onRestoreBackup = vi.fn().mockResolvedValue({
      original_vault_id: "v-1",
      restored_vault_id: "v-2",
      destination: "C:\\Vaults\\Restored",
      restored_files_count: 12,
      grants_disabled: 0,
    });
    const onRestoreTrashed = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsView
        activeVault={VAULT}
        vaults={[VAULT]}
        theme="system"
        viewMode="split"
        autosaveEnabled={true}
        appHealth={null}
        trashedNotes={[
          {
            note_id: "n-del",
            rel_path: "old/draft.md",
            last_hash: "h-del",
            last_seen_at: "2026-11-24T08:00:00Z",
          },
        ]}
        isBusy={false}
        onChangeTheme={onChangeTheme}
        onChangeViewMode={vi.fn()}
        onChangeAutosave={vi.fn()}
        onSwitchVault={vi.fn().mockResolvedValue(undefined)}
        onOpenOnboarding={vi.fn()}
        onRebuildIndex={onRebuildIndex}
        onExportMarkdown={onExportMarkdown}
        onCreateBackup={onCreateBackup}
        onRestoreBackup={onRestoreBackup}
        onRestoreTrashed={onRestoreTrashed}
        onRefreshTrash={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "dark" },
    });
    expect(onChangeTheme).toHaveBeenCalledWith("dark");

    fireEvent.click(
      screen.getByRole("button", { name: /Rebuild Derived Index/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Confirm Rebuild Index/i }),
    );
    await waitFor(() => {
      expect(onRebuildIndex).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/generation #6/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Export Markdown Notes Only/i), {
      target: { value: "C:\\Exports\\TestMd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => {
      expect(onExportMarkdown).toHaveBeenCalledWith("C:\\Exports\\TestMd");
    });

    fireEvent.change(screen.getByLabelText(/Create Complete Vault Backup/i), {
      target: { value: "C:\\Backups\\Out" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Backup" }));
    await waitFor(() => {
      expect(onCreateBackup).toHaveBeenCalledWith("C:\\Backups\\Out");
    });

    fireEvent.change(screen.getByLabelText("Backup folder"), {
      target: { value: "C:\\Backups\\Out" },
    });
    fireEvent.change(screen.getByLabelText("New destination vault folder"), {
      target: { value: "C:\\Vaults\\Restored" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Restore Backup Alongside/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Confirm Restore Backup/i }),
    );
    await waitFor(() => {
      expect(onRestoreBackup).toHaveBeenCalledWith(
        "C:\\Backups\\Out",
        "C:\\Vaults\\Restored",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore Note" }));
    await waitFor(() => {
      expect(onRestoreTrashed).toHaveBeenCalledWith("n-del");
    });
  });
});
