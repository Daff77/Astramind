export type ErrorCode =
  | "INVALID_INPUT"
  | "VAULT_UNAVAILABLE"
  | "ACCESS_DENIED"
  | "NOTE_NOT_FOUND"
  | "AMBIGUOUS_LINK"
  | "CONFLICT"
  | "BUSY"
  | "DISK_FULL"
  | "IO_FAILED"
  | "PARSE_WARNING"
  | "INDEX_STALE"
  | "STATE_UNAVAILABLE"
  | "RECOVERY_REQUIRED"
  | "PROVIDER_UNAVAILABLE"
  | "CONSENT_REQUIRED"
  | "CANCELLED"
  | "LIMIT_EXCEEDED";

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  operation_id: string | null;
  safe_details: unknown;
}

export type VerificationStatus =
  | "unverified"
  | "user_verified"
  | "outdated"
  | "superseded";

export type NoteOrigin = "imported" | "user_created" | "ai_proposal";

export type ParseStatus = "ok" | "warning" | "unsupported";

export type LinkKind = "wiki" | "markdown" | "embed";

export type LinkResolution =
  | "resolved"
  | "broken"
  | "ambiguous"
  | "attachment"
  | "external"
  | "unsupported";

export interface AppPathsDto {
  app_data_dir: string;
  registry_db: string;
  vaults_dir: string;
}

export interface SqliteHealthDto {
  sqlite_version: string;
  fts5_enabled: boolean;
  fts5_probe_hits: number;
}

export interface AppHealthDto {
  app_name: string;
  core_version: string;
  platform: string;
  paths: AppPathsDto;
  sqlite: SqliteHealthDto;
}

export interface VaultSummary {
  vault_id: string;
  display_name: string;
  root_path: string;
  status: string;
  active_index_generation: number;
  note_count: number;
}

export interface ScanDiagnostic {
  rel_path: string;
  kind: string;
  message: string;
}

export interface VaultOpenReport {
  vault: VaultSummary;
  notes_discovered: number;
  attachments_discovered: number;
  broken_links: number;
  ambiguous_links: number;
  diagnostics: ScanDiagnostic[];
}

export interface NoteSummary {
  note_id: string;
  rel_path: string;
  title: string;
  content_hash: string;
  parse_status: ParseStatus;
  origin: NoteOrigin;
  verification: VerificationStatus;
  pinned: boolean;
  tags: string[];
}

export interface NoteSnapshot {
  note_id: string;
  vault_id: string;
  rel_path: string;
  title: string;
  body: string;
  content_hash: string;
  parse_status: ParseStatus;
  origin: NoteOrigin;
  verification: VerificationStatus;
  pinned: boolean;
  tags: string[];
  aliases: string[];
  index_generation: number;
}

export interface MutationResult {
  operation_id: string;
  revision_id: string | null;
  note_id: string;
  rel_path: string;
  content_hash: string;
  index_generation: number;
  replayed: boolean;
}

export interface BacklinkHit {
  source_note_id: string;
  source_rel_path: string;
  source_title: string;
  raw_target: string;
  link_kind: LinkKind;
  line_number: number;
}

export interface MovePlan {
  vault_id: string;
  note_id: string;
  old_rel_path: string;
  new_rel_path: string;
  affected_backlinks: BacklinkHit[];
}

export interface SearchFilters {
  folder_prefix?: string | null;
  tag?: string | null;
}

export interface SearchHit {
  note_id: string;
  rel_path: string;
  title: string;
  content_hash: string;
  snippet: string;
  verification: VerificationStatus;
  index_generation: number;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  generation: number;
}

export interface BrokenLinkDto {
  source_note_id: string;
  source_rel_path: string;
  raw_target: string;
  link_kind: LinkKind;
  resolution: LinkResolution;
  line_number: number;
}

export interface GraphNodeDto {
  id: string;
  rel_path: string;
  title: string;
  folder: string;
  tags: string[];
  origin: NoteOrigin;
  parse_status: ParseStatus;
  verification: VerificationStatus;
  incoming_count: number;
  outgoing_count: number;
  pinned?: boolean;
}

export interface GraphEdgeDto {
  source: string;
  target: string;
  kind: string;
  count: number;
}

export interface GraphSnapshotDto {
  vault_id: string;
  generation: number;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
}

export interface ReconcileSummary {
  index_generation: number;
  indexed_notes: number;
  removed_notes: number;
  diagnostics: ScanDiagnostic[];
}

export interface BackupResult {
  backup_id: string;
  destination: string;
  vault_files_count: number;
  blobs_count: number;
}

export interface RestoreResult {
  original_vault_id: string;
  restored_vault_id: string;
  destination: string;
  restored_files_count: number;
  grants_disabled: number;
}

export interface RevisionSummaryDto {
  revision_id: string;
  operation_id: string;
  note_id: string;
  old_path: string | null;
  new_path: string | null;
  actor_key: string;
  created_at: string;
}

export interface TrashedNoteSummary {
  note_id: string;
  rel_path: string;
  last_hash: string | null;
  last_seen_at: string;
}

export interface WatcherEventDto {
  vault_id: string;
  index_generation: number;
  indexed_notes: number;
  removed_notes: number;
  from_overflow: boolean;
  stale: boolean;
  error_code: ErrorCode | null;
  error_message: string | null;
}

export interface EditorDraftDto {
  vault_id: string;
  note_id: string;
  rel_path: string;
  base_hash: string;
  draft_seq: number;
  body: string;
  updated_at: string;
}

export interface ExclusionPreviewDto {
  patterns: string[];
  excluded_note_count: number;
  remaining_note_count: number;
  sample_excluded_paths: string[];
}

export type LabelDensity = "low" | "medium" | "high";

export type UniverseVisualizationMode = "orbit" | "graph";

export interface UniverseSettings {
  visualizationMode: UniverseVisualizationMode;
  starSize: number;
  connectionOpacity: number;
  labelDensity: LabelDensity;
  clusterSpacing: number;
  showBackgroundStars: boolean;
  showIsolated: boolean;
  orbitalMotion: boolean;
  focusDepth: 1 | 2;
  reducedEffects: boolean;
}

export type NavSection = "home" | "knowledge" | "universe" | "settings";

export type ThemePreference = "system" | "light" | "dark";

export type EditorViewMode = "edit" | "split" | "preview";

export type SaveLifecycleState = "saved" | "dirty" | "saving" | "conflict" | "error";

export interface ConflictState {
  kind: "modified" | "deleted";
  noteId: string;
  relPath: string;
  localBody: string;
  localBaseHash: string;
  externalBody: string | null;
  externalHash: string | null;
  message: string;
}

export interface EditorTabState {
  noteId: string;
  relPath: string;
  title: string;
  savedBody: string;
  draftBody: string;
  baseHash: string;
  parseStatus: ParseStatus;
  origin: NoteOrigin;
  verification: VerificationStatus;
  pinned: boolean;
  tags: string[];
  aliases: string[];
  indexGeneration: number;
  dirty: boolean;
  saveState: SaveLifecycleState;
  lastSavedAt: string | null;
  conflict: ConflictState | null;
  externalUpdateNotice: string | null;
  pendingDraftOffer: EditorDraftDto | null;
  draftSeq: number;
}

export interface DraftSnapshot {
  vaultId: string;
  noteId: string;
  relPath: string;
  draftBody: string;
  baseHash: string;
  updatedAt: string;
}
