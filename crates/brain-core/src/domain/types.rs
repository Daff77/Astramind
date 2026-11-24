use crate::domain::ids::{GrantId, NoteId, VaultId};
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
    pub active_index_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNodeDto {
    pub id: NoteId,
    pub title: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub verification: VerificationStatus,
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
