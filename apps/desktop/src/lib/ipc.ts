import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import type {
  AppHealthDto,
  BacklinkHit,
  BackupResult,
  BrokenLinkDto,
  EditorDraftDto,
  ErrorCode,
  ErrorEnvelope,
  GraphSnapshotDto,
  MovePlan,
  MutationResult,
  NoteSnapshot,
  NoteSummary,
  Page,
  ReconcileSummary,
  RestoreResult,
  RevisionSummaryDto,
  SearchFilters,
  SearchHit,
  TrashedNoteSummary,
  VaultOpenReport,
  VaultSummary,
  WatcherEventDto,
} from "./contracts";

const VALID_ERROR_CODES = new Set<ErrorCode>([
  "INVALID_INPUT",
  "VAULT_UNAVAILABLE",
  "ACCESS_DENIED",
  "NOTE_NOT_FOUND",
  "AMBIGUOUS_LINK",
  "CONFLICT",
  "BUSY",
  "DISK_FULL",
  "IO_FAILED",
  "PARSE_WARNING",
  "INDEX_STALE",
  "STATE_UNAVAILABLE",
  "RECOVERY_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "CONSENT_REQUIRED",
  "CANCELLED",
  "LIMIT_EXCEEDED",
]);

export function parseErrorCode(raw: unknown): ErrorCode {
  if (typeof raw === "string" && VALID_ERROR_CODES.has(raw as ErrorCode)) {
    return raw as ErrorCode;
  }
  return "IO_FAILED";
}

export function normalizeIpcError(err: unknown): ErrorEnvelope {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    "message" in err
  ) {
    const candidate = err as Partial<ErrorEnvelope>;
    return {
      code: parseErrorCode(candidate.code),
      message: String(candidate.message ?? "Unknown core error"),
      retryable: Boolean(candidate.retryable),
      operation_id:
        typeof candidate.operation_id === "string"
          ? candidate.operation_id
          : null,
      safe_details: candidate.safe_details ?? null,
    };
  }
  return {
    code: "IO_FAILED",
    message: err instanceof Error ? err.message : String(err),
    retryable: false,
    operation_id: null,
    safe_details: null,
  };
}

async function invokeTyped<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (err) {
    throw normalizeIpcError(err);
  }
}

export function fetchAppHealth(): Promise<AppHealthDto> {
  return invokeTyped<AppHealthDto>("app_health");
}

export function listVaults(): Promise<VaultSummary[]> {
  return invokeTyped<VaultSummary[]>("list_vaults");
}

export function createVault(
  selectedRoot: string,
  displayName?: string,
): Promise<VaultOpenReport> {
  return invokeTyped<VaultOpenReport>("create_vault", {
    selectedRoot,
    displayName: displayName ?? null,
  });
}

export function openVault(selectedRoot: string): Promise<VaultOpenReport> {
  return invokeTyped<VaultOpenReport>("open_vault", { selectedRoot });
}

export function listNotes(vaultId: string): Promise<NoteSummary[]> {
  return invokeTyped<NoteSummary[]>("list_notes", { vaultId });
}

export function readNote(
  vaultId: string,
  noteId: string,
): Promise<NoteSnapshot> {
  return invokeTyped<NoteSnapshot>("read_note", { vaultId, noteId });
}

export function createNote(
  vaultId: string,
  relPath: string,
  body: string,
  requestId: string,
): Promise<MutationResult> {
  return invokeTyped<MutationResult>("create_note", {
    vaultId,
    relPath,
    body,
    requestId,
  });
}

export function saveNote(
  vaultId: string,
  noteId: string,
  expectedHash: string,
  body: string,
  requestId: string,
): Promise<MutationResult> {
  return invokeTyped<MutationResult>("save_note", {
    vaultId,
    noteId,
    expectedHash,
    body,
    requestId,
  });
}

export function previewMove(
  vaultId: string,
  noteId: string,
  destination: string,
): Promise<MovePlan> {
  return invokeTyped<MovePlan>("preview_move", {
    vaultId,
    noteId,
    destination,
  });
}

export function moveNote(
  plan: MovePlan,
  expectedHash: string,
  requestId: string,
): Promise<MutationResult> {
  return invokeTyped<MutationResult>("move_note", {
    plan,
    expectedHash,
    requestId,
  });
}

export function trashNote(
  vaultId: string,
  noteId: string,
  expectedHash: string,
  requestId: string,
): Promise<MutationResult> {
  return invokeTyped<MutationResult>("trash_note", {
    vaultId,
    noteId,
    expectedHash,
    requestId,
  });
}

export function searchVaultNotes(
  vaultId: string,
  query: string,
  filters: SearchFilters = {},
  limit?: number,
  cursor?: string,
): Promise<Page<SearchHit>> {
  return invokeTyped<Page<SearchHit>>("search_vault_notes", {
    vaultId,
    query,
    filters,
    limit: limit ?? null,
    cursor: cursor ?? null,
  });
}

export function getNoteBacklinks(
  vaultId: string,
  noteId: string,
): Promise<BacklinkHit[]> {
  return invokeTyped<BacklinkHit[]>("get_note_backlinks", { vaultId, noteId });
}

export function restoreTrashedNote(
  vaultId: string,
  noteId: string,
  requestId: string,
): Promise<MutationResult> {
  return invokeTyped<MutationResult>("restore_trashed_note", {
    vaultId,
    noteId,
    requestId,
  });
}

export function restoreRevision(
  vaultId: string,
  revisionId: string,
  expectedCurrentHash: string,
  requestId: string,
): Promise<MutationResult> {
  return invokeTyped<MutationResult>("restore_revision", {
    vaultId,
    revisionId,
    expectedCurrentHash,
    requestId,
  });
}

export function getVaultBrokenLinks(
  vaultId: string,
): Promise<BrokenLinkDto[]> {
  return invokeTyped<BrokenLinkDto[]>("get_vault_broken_links", { vaultId });
}

export function getVaultGraph(vaultId: string): Promise<GraphSnapshotDto> {
  return invokeTyped<GraphSnapshotDto>("get_vault_graph", { vaultId });
}

export function rebuildVaultIndex(vaultId: string): Promise<ReconcileSummary> {
  return invokeTyped<ReconcileSummary>("rebuild_vault_index", { vaultId });
}

export function createVaultBackup(
  vaultId: string,
  destination: string,
): Promise<BackupResult> {
  return invokeTyped<BackupResult>("create_vault_backup", {
    vaultId,
    destination,
  });
}

export function restoreVaultBackup(
  backupDir: string,
  destination: string,
): Promise<RestoreResult> {
  return invokeTyped<RestoreResult>("restore_vault_backup", {
    backupDir,
    destination,
  });
}

export function exportVaultFiles(
  vaultId: string,
  destination: string,
): Promise<number> {
  return invokeTyped<number>("export_vault_files", { vaultId, destination });
}

export function setPinned(
  vaultId: string,
  noteId: string,
  pinned: boolean,
): Promise<boolean> {
  return invokeTyped<boolean>("set_pinned", { vaultId, noteId, pinned });
}

export function listRevisions(
  vaultId: string,
  noteId: string,
): Promise<RevisionSummaryDto[]> {
  return invokeTyped<RevisionSummaryDto[]>("list_revisions", {
    vaultId,
    noteId,
  });
}

export function listTrashedNotes(
  vaultId: string,
): Promise<TrashedNoteSummary[]> {
  return invokeTyped<TrashedNoteSummary[]>("list_trashed_notes", { vaultId });
}

export function saveDraft(
  vaultId: string,
  noteId: string,
  relPath: string,
  baseHash: string,
  draftSeq: number,
  body: string,
): Promise<EditorDraftDto> {
  return invokeTyped<EditorDraftDto>("save_draft", {
    vaultId,
    noteId,
    relPath,
    baseHash,
    draftSeq,
    body,
  });
}

export function getDraft(
  vaultId: string,
  noteId: string,
): Promise<EditorDraftDto | null> {
  return invokeTyped<EditorDraftDto | null>("get_draft", { vaultId, noteId });
}

export function listDrafts(vaultId: string): Promise<EditorDraftDto[]> {
  return invokeTyped<EditorDraftDto[]>("list_drafts", { vaultId });
}

export function clearDraft(
  vaultId: string,
  noteId: string,
  maxDraftSeq?: number,
): Promise<boolean> {
  return invokeTyped<boolean>("clear_draft", {
    vaultId,
    noteId,
    maxDraftSeq: maxDraftSeq ?? null,
  });
}

export function triggerReconcile(vaultId: string): Promise<boolean> {
  return invokeTyped<boolean>("trigger_reconcile", { vaultId });
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createRequestId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function pickDirectoryDialog(
  title = "Select Folder",
): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const selected = await openNativeDialog({
    directory: true,
    multiple: false,
    title,
  });
  return typeof selected === "string" && selected.length > 0 ? selected : null;
}

export async function subscribeVaultReconciled(
  handler: (event: WatcherEventDto) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  const unlisten: UnlistenFn = await listen<WatcherEventDto>(
    "vault:reconciled",
    (event) => {
      handler(event.payload);
    },
  );
  return () => {
    unlisten();
  };
}
