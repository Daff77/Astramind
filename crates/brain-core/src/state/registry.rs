use crate::domain::errors::CoreError;
use crate::domain::ids::{GrantId, VaultId};
use crate::domain::types::VaultSummary;
use crate::paths::AppPathsSpec;
use crate::state::utc_now_rfc3339;
use crate::vault::paths::canonical_root_identity;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS vaults (
  vault_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  root_identity TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_opened_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','unavailable','archived'))
);
CREATE TABLE IF NOT EXISTS agent_grants (
  grant_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(vault_id),
  label TEXT NOT NULL,
  can_read INTEGER NOT NULL DEFAULT 0 CHECK(can_read IN (0,1)),
  can_propose INTEGER NOT NULL DEFAULT 0 CHECK(can_propose IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK(policy_version>0),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK(can_propose=0 OR can_read=1)
);
CREATE TABLE IF NOT EXISTS grant_scopes (
  grant_id TEXT NOT NULL REFERENCES agent_grants(grant_id) ON DELETE CASCADE,
  folder_key TEXT NOT NULL,
  PRIMARY KEY(grant_id,folder_key)
);
CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryVaultRecord {
    pub vault_id: VaultId,
    pub display_name: String,
    pub root_path: String,
    pub root_identity: String,
    pub created_at: String,
    pub last_opened_at: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentGrantSnapshot {
    pub grant_id: GrantId,
    pub vault_id: VaultId,
    pub label: String,
    pub can_read: bool,
    pub can_propose: bool,
    pub enabled: bool,
    pub policy_version: u64,
    pub created_at: String,
    pub revoked_at: Option<String>,
    pub scopes: Vec<String>,
}

pub struct RegistryStore {
    conn: Connection,
}

impl RegistryStore {
    pub fn open(paths: &AppPathsSpec) -> Result<Self, CoreError> {
        std::fs::create_dir_all(&paths.app_data_dir)
            .map_err(|err| CoreError::from_io_dir("create app data dir", &err))?;
        std::fs::create_dir_all(&paths.vaults_dir)
            .map_err(|err| CoreError::from_io_dir("create vaults dir", &err))?;

        let db_exists = paths.registry_db.exists();
        if db_exists {
            let meta = std::fs::metadata(&paths.registry_db).map_err(|err| {
                CoreError::RecoveryRequired(format!("stat registry.sqlite: {err}"))
            })?;
            if meta.len() == 0 {
                return Err(CoreError::RecoveryRequired(
                    "existing registry.sqlite is 0 bytes (truncated); recovery required"
                        .to_string(),
                ));
            }
        }
        let conn = Connection::open(&paths.registry_db)
            .map_err(|err| CoreError::StateUnavailable(format!("open registry.sqlite: {err}")))?;
        if let Err(err) = configure_durable_sqlite(&conn) {
            if db_exists {
                return Err(CoreError::RecoveryRequired(format!(
                    "corrupted registry.sqlite cannot be configured: {err}"
                )));
            }
            return Err(err);
        }

        if db_exists {
            verify_sqlite_integrity(&conn, "registry.sqlite")?;
        }

        let current_version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|err| CoreError::StateUnavailable(format!("read registry version: {err}")))?;

        if current_version > REGISTRY_SCHEMA_VERSION {
            return Err(CoreError::RecoveryRequired(format!(
                "registry schema version {current_version} is newer than supported version {REGISTRY_SCHEMA_VERSION}"
            )));
        }

        if current_version == 0 {
            conn.execute_batch(MIGRATION_V1).map_err(|err| {
                CoreError::StateUnavailable(format!("migrate registry.sqlite v1: {err}"))
            })?;
            conn.execute_batch(&format!("PRAGMA user_version = {REGISTRY_SCHEMA_VERSION};"))
                .map_err(|err| {
                    CoreError::StateUnavailable(format!("set registry user_version: {err}"))
                })?;
        }

        Ok(Self { conn })
    }

    pub fn register_or_open_vault(
        &mut self,
        root_path: &Path,
        display_name_override: Option<&str>,
        create_dir_if_missing: bool,
    ) -> Result<RegistryVaultRecord, CoreError> {
        if create_dir_if_missing {
            std::fs::create_dir_all(root_path)
                .map_err(|err| CoreError::from_io_dir("create vault directory", &err))?;
        }
        let (canonical_path, root_identity) = canonical_root_identity(root_path)?;
        let now = utc_now_rfc3339();

        if let Some(existing) = self.find_by_root_identity(&root_identity)? {
            self.conn
                .execute(
                    "UPDATE vaults SET root_path = ?1, last_opened_at = ?2, status = 'active' WHERE vault_id = ?3",
                    params![
                        canonical_path.to_string_lossy().as_ref(),
                        now,
                        existing.vault_id.as_str()
                    ],
                )
                .map_err(|err| {
                    CoreError::StateUnavailable(format!("update vault last_opened_at: {err}"))
                })?;
            return self.get_vault(&existing.vault_id);
        }

        let vault_id = VaultId::new_v4();
        let display_name = display_name_override
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                canonical_path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "Personal Vault".to_string())
            });

        self.conn
            .execute(
                "INSERT INTO vaults(vault_id, display_name, root_path, root_identity, created_at, last_opened_at, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'active')",
                params![
                    vault_id.as_str(),
                    display_name,
                    canonical_path.to_string_lossy().as_ref(),
                    root_identity,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("register vault: {err}")))?;

        self.get_vault(&vault_id)
    }

    pub fn register_restored_vault(
        &mut self,
        new_vault_id: &VaultId,
        display_name: &str,
        root_path: &Path,
        grants: &[AgentGrantSnapshot],
    ) -> Result<RegistryVaultRecord, CoreError> {
        let (canonical_path, root_identity) = canonical_root_identity(root_path)?;
        let now = utc_now_rfc3339();

        let tx = self
            .conn
            .transaction()
            .map_err(|err| CoreError::StateUnavailable(format!("begin restore tx: {err}")))?;
        tx.execute(
            "INSERT INTO vaults(vault_id, display_name, root_path, root_identity, created_at, last_opened_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, 'active')",
            params![
                new_vault_id.as_str(),
                display_name,
                canonical_path.to_string_lossy().as_ref(),
                root_identity,
                now
            ],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("insert restored vault: {err}")))?;

        for grant in grants {
            let new_grant_id = GrantId::new_v4();
            // Per DATA_SCHEMA §8 and SYSTEM_ARCHITECTURE §7.3, restored grants MUST be disabled.
            tx.execute(
                "INSERT INTO agent_grants(grant_id, vault_id, label, can_read, can_propose, enabled, policy_version, created_at, revoked_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, NULL)",
                params![
                    new_grant_id.as_str(),
                    new_vault_id.as_str(),
                    grant.label,
                    i32::from(grant.can_read),
                    i32::from(grant.can_propose),
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert disabled grant: {err}")))?;

            for scope in &grant.scopes {
                tx.execute(
                    "INSERT INTO grant_scopes(grant_id, folder_key) VALUES (?1, ?2)",
                    params![new_grant_id.as_str(), scope],
                )
                .map_err(|err| {
                    CoreError::StateUnavailable(format!("insert restored grant scope: {err}"))
                })?;
            }
        }

        tx.commit()
            .map_err(|err| CoreError::StateUnavailable(format!("commit restored vault: {err}")))?;
        self.get_vault(new_vault_id)
    }

    pub fn get_vault(&self, vault_id: &VaultId) -> Result<RegistryVaultRecord, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT vault_id, display_name, root_path, root_identity, created_at, last_opened_at, status
                 FROM vaults WHERE vault_id = ?1",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare get_vault: {err}")))?;
        let record = stmt
            .query_row(params![vault_id.as_str()], row_to_vault_record)
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("query get_vault: {err}")))?;
        record.ok_or_else(|| {
            CoreError::VaultUnavailable(format!("vault {} is not registered", vault_id.as_str()))
        })
    }

    pub fn find_by_root_identity(
        &self,
        root_identity: &str,
    ) -> Result<Option<RegistryVaultRecord>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT vault_id, display_name, root_path, root_identity, created_at, last_opened_at, status
                 FROM vaults WHERE root_identity = ?1",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare find_vault: {err}")))?;
        stmt.query_row(params![root_identity], row_to_vault_record)
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("query find_vault: {err}")))
    }

    pub fn list_vaults(&self) -> Result<Vec<RegistryVaultRecord>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT vault_id, display_name, root_path, root_identity, created_at, last_opened_at, status
                 FROM vaults ORDER BY created_at ASC, vault_id ASC",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list_vaults: {err}")))?;
        let rows = stmt
            .query_map([], row_to_vault_record)
            .map_err(|err| CoreError::StateUnavailable(format!("query list_vaults: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::StateUnavailable(format!("collect list_vaults: {err}")))?;
        Ok(rows)
    }

    pub fn list_grants_for_vault(
        &self,
        vault_id: &VaultId,
    ) -> Result<Vec<AgentGrantSnapshot>, CoreError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT grant_id, vault_id, label, can_read, can_propose, enabled, policy_version, created_at, revoked_at
                 FROM agent_grants WHERE vault_id = ?1 ORDER BY created_at ASC",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list_grants: {err}")))?;
        let mut grants = stmt
            .query_map(params![vault_id.as_str()], |row| {
                let gid: String = row.get(0)?;
                let vid: String = row.get(1)?;
                Ok(AgentGrantSnapshot {
                    grant_id: GrantId::parse(&gid).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    vault_id: VaultId::parse(&vid).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    label: row.get(2)?,
                    can_read: row.get::<_, i32>(3)? != 0,
                    can_propose: row.get::<_, i32>(4)? != 0,
                    enabled: row.get::<_, i32>(5)? != 0,
                    policy_version: row.get::<_, i64>(6)? as u64,
                    created_at: row.get(7)?,
                    revoked_at: row.get(8)?,
                    scopes: Vec::new(),
                })
            })
            .map_err(|err| CoreError::StateUnavailable(format!("query list_grants: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::StateUnavailable(format!("collect list_grants: {err}")))?;

        let mut scope_stmt = self
            .conn
            .prepare("SELECT folder_key FROM grant_scopes WHERE grant_id = ?1 ORDER BY folder_key")
            .map_err(|err| CoreError::StateUnavailable(format!("prepare scopes: {err}")))?;
        for grant in &mut grants {
            let scopes = scope_stmt
                .query_map(params![grant.grant_id.as_str()], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|err| CoreError::StateUnavailable(format!("query scopes: {err}")))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| CoreError::StateUnavailable(format!("collect scopes: {err}")))?;
            grant.scopes = scopes;
        }
        Ok(grants)
    }

    pub fn insert_test_grant(
        &self,
        vault_id: &VaultId,
        label: &str,
        can_read: bool,
        can_propose: bool,
        enabled: bool,
        scopes: &[&str],
    ) -> Result<GrantId, CoreError> {
        let grant_id = GrantId::new_v4();
        let now = utc_now_rfc3339();
        self.conn
            .execute(
                "INSERT INTO agent_grants(grant_id, vault_id, label, can_read, can_propose, enabled, policy_version, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
                params![
                    grant_id.as_str(),
                    vault_id.as_str(),
                    label,
                    i32::from(can_read),
                    i32::from(can_propose),
                    i32::from(enabled),
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert grant: {err}")))?;
        for scope in scopes {
            self.conn
                .execute(
                    "INSERT INTO grant_scopes(grant_id, folder_key) VALUES (?1, ?2)",
                    params![grant_id.as_str(), scope],
                )
                .map_err(|err| CoreError::StateUnavailable(format!("insert grant scope: {err}")))?;
        }
        Ok(grant_id)
    }

    pub fn set_active_vault(&self, vault_id: &VaultId) -> Result<(), CoreError> {
        let now = utc_now_rfc3339();
        let val = serde_json::json!({ "vault_id": vault_id.as_str() }).to_string();
        self.conn
            .execute(
                "INSERT INTO settings(setting_key, value_json, updated_at) VALUES ('active_vault_id', ?1, ?2)
                 ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![val, now],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("set active vault: {err}")))?;
        Ok(())
    }

    pub fn to_summary(
        &self,
        record: &RegistryVaultRecord,
        active_index_generation: u64,
        note_count: usize,
    ) -> VaultSummary {
        VaultSummary {
            vault_id: record.vault_id.clone(),
            display_name: record.display_name.clone(),
            root_path: record.root_path.clone(),
            status: record.status.clone(),
            active_index_generation,
            note_count,
        }
    }
}

fn row_to_vault_record(row: &rusqlite::Row<'_>) -> Result<RegistryVaultRecord, rusqlite::Error> {
    let raw_id: String = row.get(0)?;
    let vault_id = VaultId::parse(&raw_id).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(RegistryVaultRecord {
        vault_id,
        display_name: row.get(1)?,
        root_path: row.get(2)?,
        root_identity: row.get(3)?,
        created_at: row.get(4)?,
        last_opened_at: row.get(5)?,
        status: row.get(6)?,
    })
}

pub(crate) fn configure_durable_sqlite(conn: &Connection) -> Result<(), CoreError> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
         PRAGMA synchronous = FULL;
         PRAGMA busy_timeout = 5000;",
    )
    .map_err(|err| CoreError::StateUnavailable(format!("configure sqlite pragmas: {err}")))
}

pub(crate) fn verify_sqlite_integrity(conn: &Connection, label: &str) -> Result<(), CoreError> {
    let check: String = conn
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|err| {
            CoreError::RecoveryRequired(format!("{label} integrity check failed: {err}"))
        })?;
    if !check.eq_ignore_ascii_case("ok") {
        return Err(CoreError::RecoveryRequired(format!(
            "{label} failed integrity check: {check}"
        )));
    }
    Ok(())
}
