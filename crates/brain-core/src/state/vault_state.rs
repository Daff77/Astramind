use crate::domain::errors::CoreError;
use crate::domain::ids::{EventId, NoteId, OperationId, RevisionId, VaultId};
use crate::domain::types::{EditorDraftDto, NoteOrigin, VerificationStatus};
use crate::index::publish_staged_file_exclusive;
use crate::paths::AppPathsSpec;
use crate::state::registry::{configure_durable_sqlite, verify_sqlite_integrity};
use crate::state::utc_now_rfc3339;
use crate::vault::paths::path_key;
use crate::vault::replace::sha256_hex;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const STATE_SCHEMA_VERSION: u32 = 2;

const STATE_MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS vault_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS note_identity (
  note_id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  file_identity TEXT,
  last_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('present','missing','trashed','reserved')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS note_path_present
  ON note_identity(path_key) WHERE state IN ('present','reserved');
CREATE TABLE IF NOT EXISTS note_status (
  note_id TEXT PRIMARY KEY REFERENCES note_identity(note_id),
  origin TEXT NOT NULL DEFAULT 'imported' CHECK(origin IN ('imported','user_created','ai_proposal')),
  verification TEXT NOT NULL CHECK(verification IN ('unverified','user_verified','outdated','superseded')),
  verified_hash TEXT,
  verified_at TEXT,
  superseded_by TEXT REFERENCES note_identity(note_id),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
  last_opened_at TEXT,
  CHECK(superseded_by IS NULL OR superseded_by<>note_id)
);
CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  storage_key TEXT UNIQUE,
  content_purged_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_proposals (
  proposal_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  agent_label TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','update')),
  target_note_id TEXT REFERENCES note_identity(note_id),
  result_note_id TEXT REFERENCES note_identity(note_id),
  new_rel_path TEXT,
  base_hash TEXT REFERENCES blobs(hash),
  proposed_hash TEXT NOT NULL REFERENCES blobs(hash),
  approved_hash TEXT REFERENCES blobs(hash),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','conflict','approved','rejected','withdrawn')),
  proposal_version INTEGER NOT NULL DEFAULT 1 CHECK(proposal_version>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decision_reason TEXT,
  decision_actor TEXT,
  UNIQUE(grant_id,request_id),
  CHECK((status='approved' AND approved_hash IS NOT NULL) OR (status<>'approved' AND approved_hash IS NULL)),
  CHECK((action='create' AND target_note_id IS NULL AND new_rel_path IS NOT NULL AND base_hash IS NULL)
     OR (action='update' AND target_note_id IS NOT NULL AND new_rel_path IS NULL AND base_hash IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS proposal_versions (
  proposal_id TEXT NOT NULL REFERENCES memory_proposals(proposal_id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0),
  action TEXT NOT NULL CHECK(action IN ('create','update')),
  new_rel_path TEXT,
  base_hash TEXT REFERENCES blobs(hash),
  proposed_hash TEXT NOT NULL REFERENCES blobs(hash),
  review_actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(proposal_id,version)
);
CREATE TABLE IF NOT EXISTS proposal_sources (
  proposal_id TEXT NOT NULL REFERENCES memory_proposals(proposal_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  kind TEXT NOT NULL CHECK(kind IN ('vault_note','external_claim','user_statement')),
  note_id TEXT REFERENCES note_identity(note_id),
  rel_path_at_capture TEXT,
  content_hash TEXT,
  line_start INTEGER,
  line_end INTEGER,
  external_ref TEXT,
  claim_label TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY(proposal_id,ordinal),
  CHECK(line_start IS NULL OR line_start>0),
  CHECK(line_end IS NULL OR line_end>=line_start)
);
CREATE TABLE IF NOT EXISTS mutation_journal (
  operation_id TEXT PRIMARY KEY,
  actor_key TEXT NOT NULL,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('create','save','move','trash','restore','approve')),
  note_id TEXT REFERENCES note_identity(note_id),
  proposal_id TEXT REFERENCES memory_proposals(proposal_id),
  old_path TEXT,
  new_path TEXT,
  old_hash TEXT REFERENCES blobs(hash),
  new_hash TEXT REFERENCES blobs(hash),
  status TEXT NOT NULL CHECK(status IN ('prepared','committed','aborted','recovery_required')),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  UNIQUE(actor_key,request_id)
);
CREATE TABLE IF NOT EXISTS revisions (
  revision_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES mutation_journal(operation_id),
  note_id TEXT NOT NULL REFERENCES note_identity(note_id),
  old_hash TEXT REFERENCES blobs(hash),
  new_hash TEXT REFERENCES blobs(hash),
  old_path TEXT,
  new_path TEXT,
  actor_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_key TEXT NOT NULL,
  operation_id TEXT REFERENCES mutation_journal(operation_id),
  note_id TEXT REFERENCES note_identity(note_id),
  proposal_id TEXT REFERENCES memory_proposals(proposal_id),
  outcome TEXT NOT NULL,
  safe_metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_status_time ON memory_proposals(status,created_at);
CREATE INDEX IF NOT EXISTS revisions_note_time ON revisions(note_id,created_at);
CREATE INDEX IF NOT EXISTS audit_time ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS journal_status ON mutation_journal(status);
"#;

const STATE_MIGRATION_V2: &str = r#"
CREATE TABLE IF NOT EXISTS editor_drafts (
  note_id TEXT PRIMARY KEY REFERENCES note_identity(note_id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  draft_seq INTEGER NOT NULL CHECK(draft_seq > 0),
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS editor_drafts_updated ON editor_drafts(updated_at DESC);
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteIdentityRow {
    pub note_id: NoteId,
    pub rel_path: String,
    pub path_key: String,
    pub file_identity: Option<String>,
    pub last_hash: Option<String>,
    pub state: String,
    pub origin: NoteOrigin,
    pub verification: VerificationStatus,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalRow {
    pub operation_id: OperationId,
    pub actor_key: String,
    pub request_id: String,
    pub input_hash: String,
    pub kind: String,
    pub note_id: Option<NoteId>,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub old_hash: Option<String>,
    pub new_hash: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionRow {
    pub revision_id: RevisionId,
    pub operation_id: OperationId,
    pub note_id: NoteId,
    pub old_hash: Option<String>,
    pub new_hash: Option<String>,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub actor_key: String,
    pub created_at: String,
}

pub struct VaultStateStore {
    conn: Connection,
    vault_dir: PathBuf,
    blobs_dir: PathBuf,
}

impl VaultStateStore {
    pub fn open_or_init(paths: &AppPathsSpec, vault_id: &VaultId) -> Result<Self, CoreError> {
        let vault_dir = paths.vault_dir(vault_id);
        let blobs_dir = vault_dir.join("blobs");
        std::fs::create_dir_all(&vault_dir)
            .map_err(|err| CoreError::from_io_dir("create vault state dir", &err))?;
        std::fs::create_dir_all(&blobs_dir)
            .map_err(|err| CoreError::from_io_dir("create blobs dir", &err))?;

        let state_db = paths.vault_state_db(vault_id);
        let existed = state_db.exists();
        if existed {
            let meta = std::fs::metadata(&state_db)
                .map_err(|err| CoreError::RecoveryRequired(format!("stat state.sqlite: {err}")))?;
            if meta.len() == 0 {
                return Err(CoreError::RecoveryRequired(
                    "existing state.sqlite is 0 bytes (truncated); recovery required".to_string(),
                ));
            }
        }
        let conn = Connection::open(&state_db)
            .map_err(|err| CoreError::RecoveryRequired(format!("open state.sqlite: {err}")))?;
        if let Err(err) = configure_durable_sqlite(&conn) {
            if existed {
                return Err(CoreError::RecoveryRequired(format!(
                    "corrupted state.sqlite cannot be configured: {err}"
                )));
            }
            return Err(err);
        }

        if existed {
            verify_sqlite_integrity(&conn, "state.sqlite")?;
        }

        let current_version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|err| CoreError::RecoveryRequired(format!("read state version: {err}")))?;

        if current_version > STATE_SCHEMA_VERSION {
            return Err(CoreError::RecoveryRequired(format!(
                "state.sqlite schema version {current_version} is newer than supported version {STATE_SCHEMA_VERSION}"
            )));
        }

        if current_version == 0 {
            conn.execute_batch(STATE_MIGRATION_V1).map_err(|err| {
                CoreError::StateUnavailable(format!("migrate state.sqlite v1: {err}"))
            })?;
            conn.execute(
                "INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('vault_id', ?1)",
                params![vault_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("seed vault_id meta: {err}")))?;
            conn.execute(
                "INSERT OR IGNORE INTO vault_meta(key, value) VALUES ('active_index_generation', '0')",
                [],
            )
            .map_err(|err| {
                CoreError::StateUnavailable(format!("seed index generation meta: {err}"))
            })?;
        }

        if current_version < 2 {
            conn.execute_batch(STATE_MIGRATION_V2).map_err(|err| {
                CoreError::StateUnavailable(format!("migrate state.sqlite v2: {err}"))
            })?;
            conn.execute_batch(&format!("PRAGMA user_version = {STATE_SCHEMA_VERSION};"))
                .map_err(|err| {
                    CoreError::StateUnavailable(format!("set state user_version: {err}"))
                })?;
        }

        Ok(Self {
            conn,
            vault_dir,
            blobs_dir,
        })
    }

    #[must_use]
    pub fn vault_dir(&self) -> &Path {
        &self.vault_dir
    }

    #[must_use]
    pub fn blobs_dir(&self) -> &Path {
        &self.blobs_dir
    }

    #[must_use]
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    pub fn active_index_generation(&self) -> Result<u64, CoreError> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM vault_meta WHERE key = 'active_index_generation'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| {
                CoreError::StateUnavailable(format!("read active_index_generation: {err}"))
            })?;
        match raw {
            Some(s) => s.parse::<u64>().map_err(|_| {
                CoreError::RecoveryRequired("invalid active_index_generation in state".to_string())
            }),
            None => Ok(0),
        }
    }

    pub fn set_active_index_generation(&self, generation: u64) -> Result<(), CoreError> {
        self.conn
            .execute(
                "INSERT INTO vault_meta(key, value) VALUES ('active_index_generation', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![generation.to_string()],
            )
            .map_err(|err| {
                CoreError::StateUnavailable(format!("update active_index_generation: {err}"))
            })?;
        Ok(())
    }

    pub fn has_blocking_journal_rows(&self) -> Result<bool, CoreError> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM mutation_journal WHERE status IN ('prepared','recovery_required')",
                [],
                |row| row.get(0),
            )
            .map_err(|err| CoreError::StateUnavailable(format!("check pending journal: {err}")))?;
        Ok(count > 0)
    }

    /// Writes a content-addressed blob safely to disk before inserting into `blobs`.
    pub fn store_blob(&self, bytes: &[u8]) -> Result<String, CoreError> {
        let hash = sha256_hex(bytes);
        let prefix = &hash[..2];
        let rel_key = format!("{prefix}/{hash}.blob");
        let target_dir = self.blobs_dir.join(prefix);
        let target_path = target_dir.join(format!("{hash}.blob"));

        if !target_path.exists() {
            std::fs::create_dir_all(&target_dir)
                .map_err(|err| CoreError::from_io_dir("create blob bucket", &err))?;
            let temp_path = target_dir.join(format!(".tmp-{}.blob", Uuid::new_v4()));
            {
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp_path)
                    .map_err(|err| CoreError::from_io_dir("create temp blob", &err))?;
                f.write_all(bytes)
                    .map_err(|err| CoreError::from_io("write temp blob", &err))?;
                f.sync_all()
                    .map_err(|err| CoreError::from_io("flush temp blob", &err))?;
            }
            if let Err(err) = publish_staged_file_exclusive(&temp_path, &target_path) {
                let _ = std::fs::remove_file(&temp_path);
                if !matches!(err, CoreError::Conflict(_)) {
                    return Err(err);
                }
            }
        }

        let now = utc_now_rfc3339();
        self.conn
            .execute(
                "INSERT OR IGNORE INTO blobs(hash, size_bytes, storage_key, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![hash, bytes.len() as i64, rel_key, now],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert blob metadata: {err}")))?;

        Ok(hash)
    }

    pub fn read_blob(&self, hash: &str) -> Result<Vec<u8>, CoreError> {
        let storage_key: Option<String> = self
            .conn
            .query_row(
                "SELECT storage_key FROM blobs WHERE hash = ?1 AND content_purged_at IS NULL",
                params![hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("lookup blob key: {err}")))?
            .flatten();

        let key = storage_key.ok_or_else(|| {
            CoreError::RecoveryRequired(format!("blob {hash} is missing or purged"))
        })?;
        // Validate storage key has no traversal
        if key.contains("..") || key.starts_with('/') || key.contains('\\') || key.contains(':') {
            return Err(CoreError::AccessDenied(
                "invalid blob storage key".to_string(),
            ));
        }
        let path = self.blobs_dir.join(&key);
        let bytes = std::fs::read(&path)
            .map_err(|err| CoreError::RecoveryRequired(format!("read blob {hash}: {err}")))?;
        let actual = sha256_hex(&bytes);
        if actual != hash {
            return Err(CoreError::RecoveryRequired(format!(
                "blob {hash} failed SHA-256 verification"
            )));
        }
        Ok(bytes)
    }

    pub fn list_active_blob_hashes(&self) -> Result<Vec<String>, CoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT hash FROM blobs WHERE content_purged_at IS NULL AND storage_key IS NOT NULL ORDER BY hash")
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list blobs: {err}")))?;
        let hashes = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| CoreError::StateUnavailable(format!("query blobs: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::StateUnavailable(format!("collect blobs: {err}")))?;
        Ok(hashes)
    }

    pub fn get_note_by_id(&self, note_id: &NoteId) -> Result<Option<NoteIdentityRow>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ni.note_id, ni.rel_path, ni.path_key, ni.file_identity, ni.last_hash, ni.state,
                        COALESCE(ns.origin, 'imported'), COALESCE(ns.verification, 'unverified'), COALESCE(ns.pinned, 0)
                 FROM note_identity ni
                 LEFT JOIN note_status ns ON ns.note_id = ni.note_id
                 WHERE ni.note_id = ?1",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare get_note_by_id: {err}")))?;
        stmt.query_row(params![note_id.as_str()], row_to_note_identity)
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("query get_note_by_id: {err}")))
    }

    pub fn find_present_by_path(
        &self,
        rel_path: &str,
    ) -> Result<Option<NoteIdentityRow>, CoreError> {
        let key = path_key(rel_path);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ni.note_id, ni.rel_path, ni.path_key, ni.file_identity, ni.last_hash, ni.state,
                        COALESCE(ns.origin, 'imported'), COALESCE(ns.verification, 'unverified'), COALESCE(ns.pinned, 0)
                 FROM note_identity ni
                 LEFT JOIN note_status ns ON ns.note_id = ni.note_id
                 WHERE ni.path_key = ?1 AND ni.state = 'present'",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare find_by_path: {err}")))?;
        stmt.query_row(params![key], row_to_note_identity)
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("query find_by_path: {err}")))
    }

    pub fn list_all_identities(&self) -> Result<Vec<NoteIdentityRow>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ni.note_id, ni.rel_path, ni.path_key, ni.file_identity, ni.last_hash, ni.state,
                        COALESCE(ns.origin, 'imported'), COALESCE(ns.verification, 'unverified'), COALESCE(ns.pinned, 0)
                 FROM note_identity ni
                 LEFT JOIN note_status ns ON ns.note_id = ni.note_id
                 ORDER BY ni.rel_path ASC",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list_identities: {err}")))?;
        let rows = stmt
            .query_map([], row_to_note_identity)
            .map_err(|err| CoreError::StateUnavailable(format!("query list_identities: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| {
                CoreError::StateUnavailable(format!("collect list_identities: {err}"))
            })?;
        Ok(rows)
    }

    pub fn find_journal_by_request(
        &self,
        actor_key: &str,
        request_id: &str,
    ) -> Result<Option<JournalRow>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT operation_id, actor_key, request_id, input_hash, kind, note_id, old_path, new_path, old_hash, new_hash, status
                 FROM mutation_journal WHERE actor_key = ?1 AND request_id = ?2",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare find_journal: {err}")))?;
        stmt.query_row(params![actor_key, request_id], row_to_journal)
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("query find_journal: {err}")))
    }

    pub fn list_prepared_journal(&self) -> Result<Vec<JournalRow>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT operation_id, actor_key, request_id, input_hash, kind, note_id, old_path, new_path, old_hash, new_hash, status
                 FROM mutation_journal WHERE status = 'prepared' ORDER BY created_at ASC",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list_prepared: {err}")))?;
        let rows = stmt
            .query_map([], row_to_journal)
            .map_err(|err| CoreError::StateUnavailable(format!("query list_prepared: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::StateUnavailable(format!("collect list_prepared: {err}")))?;
        Ok(rows)
    }

    pub fn get_revision(&self, revision_id: &RevisionId) -> Result<RevisionRow, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at
                 FROM revisions WHERE revision_id = ?1",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare get_revision: {err}")))?;
        let row = stmt
            .query_row(params![revision_id.as_str()], |r| {
                let rev: String = r.get(0)?;
                let op: String = r.get(1)?;
                let nid: String = r.get(2)?;
                Ok(RevisionRow {
                    revision_id: RevisionId::parse(&rev).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    operation_id: OperationId::parse(&op).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    note_id: NoteId::parse(&nid).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    old_hash: r.get(3)?,
                    new_hash: r.get(4)?,
                    old_path: r.get(5)?,
                    new_path: r.get(6)?,
                    actor_key: r.get(7)?,
                    created_at: r.get(8)?,
                })
            })
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("query get_revision: {err}")))?;
        row.ok_or_else(|| CoreError::NoteNotFound("revision not found".to_string()))
    }

    pub fn find_revision_for_operation(
        &self,
        operation_id: &OperationId,
    ) -> Result<Option<RevisionId>, CoreError> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT revision_id FROM revisions WHERE operation_id = ?1",
                params![operation_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("find revision for op: {err}")))?;
        raw.map(|s| RevisionId::parse(&s)).transpose()
    }

    pub fn insert_audit_event(
        &self,
        event_type: &str,
        actor_key: &str,
        operation_id: Option<&OperationId>,
        note_id: Option<&NoteId>,
        outcome: &str,
        safe_metadata: &serde_json::Value,
    ) -> Result<(), CoreError> {
        let event_id = EventId::new_v4();
        let now = utc_now_rfc3339();
        self.conn
            .execute(
                "INSERT INTO audit_events(event_id, event_type, actor_key, operation_id, note_id, proposal_id, outcome, safe_metadata_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8)",
                params![
                    event_id.as_str(),
                    event_type,
                    actor_key,
                    operation_id.map(OperationId::as_str),
                    note_id.map(NoteId::as_str),
                    outcome,
                    safe_metadata.to_string(),
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert audit event: {err}")))?;
        Ok(())
    }

    pub fn count_present_notes(&self) -> Result<usize, CoreError> {
        let cnt: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM note_identity WHERE state = 'present'",
                [],
                |row| row.get(0),
            )
            .map_err(|err| CoreError::StateUnavailable(format!("count notes: {err}")))?;
        Ok(cnt as usize)
    }

    pub fn backup_state_db(&self, destination_db: &Path) -> Result<(), CoreError> {
        let mut dst = Connection::open(destination_db)
            .map_err(|err| CoreError::IoFailed(format!("open backup state target: {err}")))?;
        let backup = rusqlite::backup::Backup::new(&self.conn, &mut dst)
            .map_err(|err| CoreError::IoFailed(format!("init sqlite backup: {err}")))?;
        backup
            .run_to_completion(100, std::time::Duration::from_millis(5), None)
            .map_err(|err| CoreError::IoFailed(format!("run sqlite backup: {err}")))?;
        Ok(())
    }

    pub fn save_draft(
        &self,
        vault_id: &VaultId,
        note_id: &NoteId,
        rel_path: &str,
        base_hash: &str,
        draft_seq: u64,
        body: &str,
    ) -> Result<EditorDraftDto, CoreError> {
        if draft_seq == 0 {
            return Err(CoreError::InvalidInput(
                "draft_seq must be greater than zero".to_string(),
            ));
        }
        let now = utc_now_rfc3339();
        self.conn
            .execute(
                "INSERT INTO editor_drafts(note_id, rel_path, base_hash, draft_seq, body, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(note_id) DO UPDATE SET
                   rel_path = excluded.rel_path,
                   base_hash = excluded.base_hash,
                   draft_seq = excluded.draft_seq,
                   body = excluded.body,
                   updated_at = excluded.updated_at
                 WHERE excluded.draft_seq >= editor_drafts.draft_seq",
                params![
                    note_id.as_str(),
                    rel_path,
                    base_hash,
                    draft_seq as i64,
                    body,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("save editor draft: {err}")))?;
        self.get_draft(vault_id, note_id)?
            .ok_or_else(|| CoreError::StateUnavailable("saved editor draft missing".to_string()))
    }

    pub fn get_draft(
        &self,
        vault_id: &VaultId,
        note_id: &NoteId,
    ) -> Result<Option<EditorDraftDto>, CoreError> {
        self.conn
            .query_row(
                "SELECT note_id, rel_path, base_hash, draft_seq, body, updated_at
                 FROM editor_drafts WHERE note_id = ?1",
                params![note_id.as_str()],
                |row| row_to_editor_draft(vault_id, row),
            )
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("read editor draft: {err}")))
    }

    pub fn list_drafts(&self, vault_id: &VaultId) -> Result<Vec<EditorDraftDto>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT note_id, rel_path, base_hash, draft_seq, body, updated_at
                 FROM editor_drafts ORDER BY updated_at DESC",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list_drafts: {err}")))?;
        let rows = stmt
            .query_map([], |row| row_to_editor_draft(vault_id, row))
            .map_err(|err| CoreError::StateUnavailable(format!("query list_drafts: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::StateUnavailable(format!("collect list_drafts: {err}")))?;
        Ok(rows)
    }

    pub fn clear_draft(
        &self,
        note_id: &NoteId,
        max_draft_seq: Option<u64>,
    ) -> Result<bool, CoreError> {
        let deleted = match max_draft_seq {
            Some(seq) => self.conn.execute(
                "DELETE FROM editor_drafts WHERE note_id = ?1 AND draft_seq <= ?2",
                params![note_id.as_str(), seq as i64],
            ),
            None => self.conn.execute(
                "DELETE FROM editor_drafts WHERE note_id = ?1",
                params![note_id.as_str()],
            ),
        }
        .map_err(|err| CoreError::StateUnavailable(format!("clear editor draft: {err}")))?;
        Ok(deleted > 0)
    }
}

fn row_to_editor_draft(
    vault_id: &VaultId,
    row: &rusqlite::Row<'_>,
) -> Result<EditorDraftDto, rusqlite::Error> {
    let nid_s: String = row.get(0)?;
    let seq_i: i64 = row.get(3)?;
    Ok(EditorDraftDto {
        vault_id: vault_id.clone(),
        note_id: NoteId::parse(&nid_s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        rel_path: row.get(1)?,
        base_hash: row.get(2)?,
        draft_seq: u64::try_from(seq_i).unwrap_or(1),
        body: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub(crate) fn str_to_origin(s: &str) -> NoteOrigin {
    match s {
        "user_created" => NoteOrigin::UserCreated,
        "ai_proposal" => NoteOrigin::AiProposal,
        _ => NoteOrigin::Imported,
    }
}

pub(crate) fn str_to_verification(s: &str) -> VerificationStatus {
    match s {
        "user_verified" => VerificationStatus::UserVerified,
        "outdated" => VerificationStatus::Outdated,
        "superseded" => VerificationStatus::Superseded,
        _ => VerificationStatus::Unverified,
    }
}

fn row_to_note_identity(row: &rusqlite::Row<'_>) -> Result<NoteIdentityRow, rusqlite::Error> {
    let raw_id: String = row.get(0)?;
    let origin_s: String = row.get(6)?;
    let ver_s: String = row.get(7)?;
    Ok(NoteIdentityRow {
        note_id: NoteId::parse(&raw_id).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        rel_path: row.get(1)?,
        path_key: row.get(2)?,
        file_identity: row.get(3)?,
        last_hash: row.get(4)?,
        state: row.get(5)?,
        origin: str_to_origin(&origin_s),
        verification: str_to_verification(&ver_s),
        pinned: row.get::<_, i32>(8)? != 0,
    })
}

fn row_to_journal(row: &rusqlite::Row<'_>) -> Result<JournalRow, rusqlite::Error> {
    let op_s: String = row.get(0)?;
    let nid_s: Option<String> = row.get(5)?;
    let note_id = match nid_s {
        Some(s) => Some(NoteId::parse(&s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e))
        })?),
        None => None,
    };
    Ok(JournalRow {
        operation_id: OperationId::parse(&op_s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?,
        actor_key: row.get(1)?,
        request_id: row.get(2)?,
        input_hash: row.get(3)?,
        kind: row.get(4)?,
        note_id,
        old_path: row.get(6)?,
        new_path: row.get(7)?,
        old_hash: row.get(8)?,
        new_hash: row.get(9)?,
        status: row.get(10)?,
    })
}
