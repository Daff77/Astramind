use crate::domain::errors::ErrorCode;
use crate::domain::ids::{GrantId, NoteId, OperationId, RevisionId, VaultId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Unverified,
    UserVerified,
    Outdated,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteOrigin {
    Imported,
    UserCreated,
    AiProposal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Desktop,
    Agent,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    Ok,
    Warning,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkKind {
    Wiki,
    Markdown,
    Embed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkResolution {
    Resolved,
    Broken,
    Ambiguous,
    Attachment,
    External,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorContext {
    pub kind: ActorKind,
    pub principal: String,
    pub grant_id: Option<GrantId>,
    pub permitted_vaults: Vec<VaultId>,
    pub policy_version: u64,
}

impl ActorContext {
    #[must_use]
    pub fn desktop(principal: impl Into<String>) -> Self {
        Self {
            kind: ActorKind::Desktop,
            principal: principal.into(),
            grant_id: None,
            permitted_vaults: Vec::new(),
            policy_version: 1,
        }
    }

    #[must_use]
    pub fn actor_key(&self) -> String {
        match &self.grant_id {
            Some(gid) => format!("agent:{gid}"),
            None => format!("desktop:{}", self.principal),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppPathsDto {
    pub app_data_dir: String,
    pub registry_db: String,
    pub vaults_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SqliteHealthDto {
    pub sqlite_version: String,
    pub fts5_enabled: bool,
    pub fts5_probe_hits: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppHealthDto {
    pub app_name: String,
    pub core_version: String,
    pub platform: String,
    pub paths: AppPathsDto,
    pub sqlite: SqliteHealthDto,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultSummary {
    pub vault_id: VaultId,
    pub display_name: String,
    pub root_path: String,
    pub status: String,
    pub active_index_generation: u64,
    pub note_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanDiagnostic {
    pub rel_path: String,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultOpenReport {
    pub vault: VaultSummary,
    pub notes_discovered: usize,
    pub attachments_discovered: usize,
    pub broken_links: usize,
    pub ambiguous_links: usize,
    pub diagnostics: Vec<ScanDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSummary {
    pub note_id: NoteId,
    pub rel_path: String,
    pub title: String,
    pub content_hash: String,
    pub parse_status: ParseStatus,
    pub origin: NoteOrigin,
    pub verification: VerificationStatus,
    pub pinned: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSnapshot {
    pub note_id: NoteId,
    pub vault_id: VaultId,
    pub rel_path: String,
    pub title: String,
    pub body: String,
    pub content_hash: String,
    pub parse_status: ParseStatus,
    pub origin: NoteOrigin,
    pub verification: VerificationStatus,
    pub pinned: bool,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub index_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationResult {
    pub operation_id: OperationId,
    pub revision_id: Option<RevisionId>,
    pub note_id: NoteId,
    pub rel_path: String,
    pub content_hash: String,
    pub index_generation: u64,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MovePlan {
    pub vault_id: VaultId,
    pub note_id: NoteId,
    pub old_rel_path: String,
    pub new_rel_path: String,
    pub affected_backlinks: Vec<BacklinkHit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SearchFilters {
    pub folder_prefix: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchHit {
    pub note_id: NoteId,
    pub rel_path: String,
    pub title: String,
    pub content_hash: String,
    pub snippet: String,
    pub verification: VerificationStatus,
    pub index_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BacklinkHit {
    pub source_note_id: NoteId,
    pub source_rel_path: String,
    pub source_title: String,
    pub raw_target: String,
    pub link_kind: LinkKind,
    pub line_number: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrokenLinkDto {
    pub source_note_id: NoteId,
    pub source_rel_path: String,
    pub raw_target: String,
    pub link_kind: LinkKind,
    pub resolution: LinkResolution,
    pub line_number: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconcileSummary {
    pub index_generation: u64,
    pub indexed_notes: usize,
    pub removed_notes: usize,
    pub diagnostics: Vec<ScanDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupInventoryEntry {
    pub rel_path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format_version: u32,
    pub backup_id: String,
    pub vault_id: VaultId,
    pub created_at: String,
    pub app_version: String,
    pub registry_schema_version: u32,
    pub state_schema_version: u32,
    pub state_db_sha256: String,
    pub registry_subset_sha256: String,
    pub vault_files: Vec<BackupInventoryEntry>,
    pub blob_hashes: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackupResult {
    pub backup_id: String,
    pub destination: String,
    pub vault_files_count: usize,
    pub blobs_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreResult {
    pub original_vault_id: VaultId,
    pub restored_vault_id: VaultId,
    pub destination: String,
    pub restored_files_count: usize,
    pub grants_disabled: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNodeDto {
    pub id: NoteId,
    pub rel_path: String,
    pub title: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub origin: NoteOrigin,
    pub parse_status: ParseStatus,
    pub verification: VerificationStatus,
    pub incoming_count: u32,
    pub outgoing_count: u32,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEdgeDto {
    pub source: NoteId,
    pub target: NoteId,
    pub kind: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphSnapshotDto {
    pub vault_id: VaultId,
    pub generation: u64,
    pub nodes: Vec<GraphNodeDto>,
    pub edges: Vec<GraphEdgeDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RevisionSummaryDto {
    pub revision_id: RevisionId,
    pub operation_id: OperationId,
    pub note_id: NoteId,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub actor_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrashedNoteSummary {
    pub note_id: NoteId,
    pub rel_path: String,
    pub last_hash: Option<String>,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WatcherEventDto {
    pub vault_id: VaultId,
    pub index_generation: u64,
    pub indexed_notes: usize,
    pub removed_notes: usize,
    pub from_overflow: bool,
    pub stale: bool,
    pub error_code: Option<ErrorCode>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditorDraftDto {
    pub vault_id: VaultId,
    pub note_id: NoteId,
    pub rel_path: String,
    pub base_hash: String,
    pub draft_seq: u64,
    pub body: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExclusionPreviewDto {
    pub patterns: Vec<String>,
    pub excluded_note_count: usize,
    pub remaining_note_count: usize,
    pub sample_excluded_paths: Vec<String>,
}
