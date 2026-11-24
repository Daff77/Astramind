use crate::domain::errors::CoreError;
use crate::domain::ids::VaultId;
use crate::domain::types::{BackupInventoryEntry, BackupManifest, BackupResult, RestoreResult};
use crate::index::store::rebuild_generation_index;
use crate::paths::AppPathsSpec;
use crate::state::registry::{AgentGrantSnapshot, RegistryStore, REGISTRY_SCHEMA_VERSION};
use crate::state::utc_now_rfc3339;
use crate::state::vault_state::{VaultStateStore, STATE_SCHEMA_VERSION};
use crate::vault::lock::VaultLock;
use crate::vault::paths::{open_guarded_dir, validate_relative_path, validate_vault_root};
use crate::vault::replace::sha256_hex;
use crate::vault::scan::scan_vault;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

pub const BACKUP_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryBackupSubset {
    vault_id: VaultId,
    display_name: String,
    grants: Vec<AgentGrantSnapshot>,
}

/// Validates that `destination` does not overlap `vault_root`, `%LOCALAPPDATA%\PersonalBrain`,
/// or any ancestor directory containing `vault_root` (`SC-18`).
pub fn validate_safe_destination(
    paths: &AppPathsSpec,
    vault_root: &Path,
    destination: &Path,
) -> Result<PathBuf, CoreError> {
    let canonical_vault = validate_vault_root(vault_root)?;
    let norm_vault = normalize_cmp_path(&canonical_vault);
    let norm_dest = normalize_cmp_path(&absolutize_path(destination)?);
    let norm_app = normalize_cmp_path(&absolutize_path(&paths.app_data_dir)?);

    if norm_dest.starts_with(&norm_vault) || norm_vault.starts_with(&norm_dest) {
        return Err(CoreError::InvalidInput(
            "destination cannot be inside the vault or an ancestor of the vault".to_string(),
        ));
    }
    if norm_dest.starts_with(&norm_app) || norm_app.starts_with(&norm_dest) {
        return Err(CoreError::InvalidInput(
            "destination cannot overlap Personal Brain app-data directory".to_string(),
        ));
    }
    absolutize_path(destination)
}

fn normalize_cmp_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().to_uppercase();
    let clean = s.strip_prefix("\\\\?\\").unwrap_or(&s);
    PathBuf::from(clean)
}

/// Creates a verified, staged backup containing vault Markdown + attachments, consistent `state.sqlite`
/// snapshot, active content blobs, and `registry_subset.json` (zero credentials, `index` omitted).
pub fn create_backup(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
    destination_root: &Path,
) -> Result<BackupResult, CoreError> {
    let registry = RegistryStore::open(paths)?;
    let record = registry.get_vault(vault_id)?;
    let vault_root = Path::new(&record.root_path);
    let safe_dest_parent = validate_safe_destination(paths, vault_root, destination_root)?;
    std::fs::create_dir_all(&safe_dest_parent)
        .map_err(|err| CoreError::from_io_dir("create backup destination", &err))?;

    let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), Duration::from_secs(5))?;
    let state = VaultStateStore::open_or_init(paths, vault_id)?;
    if state.has_blocking_journal_rows()? {
        return Err(CoreError::RecoveryRequired(
            "cannot create backup while prepared or recovery_required journal rows exist"
                .to_string(),
        ));
    }

    let backup_id = Uuid::new_v4().to_string();
    let final_dir = safe_dest_parent.join(format!("pb-backup-{backup_id}"));
    let staged_dir = safe_dest_parent.join(format!(".pb-backup-staging-{backup_id}"));
    std::fs::create_dir_all(&staged_dir)
        .map_err(|err| CoreError::from_io_dir("create staged backup dir", &err))?;

    let res = (|| -> Result<BackupResult, CoreError> {
        let initial_scan = scan_vault(vault_root)?;
        let mut vault_entries = Vec::new();
        let mut pre_hashes: HashMap<String, String> = HashMap::new();

        let staged_vault = staged_dir.join("vault");
        std::fs::create_dir_all(&staged_vault)
            .map_err(|err| CoreError::from_io_dir("create staged vault dir", &err))?;

        for note in &initial_scan.notes {
            validate_relative_path(&note.rel_path)?;
            let dst = staged_vault.join(note.rel_path.replace('/', "\\"));
            if let Some(p) = dst.parent() {
                std::fs::create_dir_all(p)
                    .map_err(|err| CoreError::from_io_dir("create staged note parent", &err))?;
            }
            write_synced_file(&dst, &note.bytes)?;
            pre_hashes.insert(note.rel_path.clone(), note.sha256.clone());
            vault_entries.push(BackupInventoryEntry {
                rel_path: note.rel_path.clone(),
                size_bytes: note.size_bytes,
                sha256: note.sha256.clone(),
            });
        }

        let canonical_vault = validate_vault_root(vault_root)?;
        for att_rel in &initial_scan.attachments {
            validate_relative_path(att_rel)?;
            let src = canonical_vault.join(att_rel.replace('/', "\\"));
            let (mut file, meta) =
                crate::vault::paths::inspect_scanned_file(&canonical_vault, &src)?;
            if meta.link_count > 1 {
                return Err(CoreError::AccessDenied(
                    "hardlinked attachment denied during backup".to_string(),
                ));
            }
            use std::io::Read;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|err| CoreError::from_io("read attachment for backup", &err))?;
            let hash = sha256_hex(&bytes);
            let dst = staged_vault.join(att_rel.replace('/', "\\"));
            if let Some(p) = dst.parent() {
                std::fs::create_dir_all(p)
                    .map_err(|err| CoreError::from_io_dir("create attachment parent", &err))?;
            }
            write_synced_file(&dst, &bytes)?;
            pre_hashes.insert(att_rel.clone(), hash.clone());
            vault_entries.push(BackupInventoryEntry {
                rel_path: att_rel.clone(),
                size_bytes: bytes.len() as u64,
                sha256: hash,
            });
        }

        // Snapshot state.sqlite via SQLite backup API
        let state_snapshot_path = staged_dir.join("state.sqlite");
        state.backup_state_db(&state_snapshot_path)?;
        let state_bytes = std::fs::read(&state_snapshot_path)
            .map_err(|err| CoreError::from_io("hash backed up state.sqlite", &err))?;
        let state_db_sha256 = sha256_hex(&state_bytes);

        // Copy active blobs
        let blob_hashes = state.list_active_blob_hashes()?;
        let staged_blobs = staged_dir.join("blobs");
        std::fs::create_dir_all(&staged_blobs)
            .map_err(|err| CoreError::from_io_dir("create staged blobs dir", &err))?;
        for hash in &blob_hashes {
            let bytes = state.read_blob(hash)?;
            let dst = staged_blobs.join(format!("{hash}.blob"));
            write_synced_file(&dst, &bytes)?;
        }

        // Write registry subset (never includes OS credentials)
        let grants = registry.list_grants_for_vault(vault_id)?;
        let subset = RegistryBackupSubset {
            vault_id: vault_id.clone(),
            display_name: record.display_name.clone(),
            grants,
        };
        let subset_bytes = serde_json::to_vec_pretty(&subset)
            .map_err(|err| CoreError::IoFailed(format!("serialize registry subset: {err}")))?;
        let registry_subset_sha256 = sha256_hex(&subset_bytes);
        write_synced_file(&staged_dir.join("registry_subset.json"), &subset_bytes)?;

        // Re-scan vault to detect any competing external modification during snapshot capture.
        let post_scan = scan_vault(vault_root)?;
        let mut post_hashes: HashMap<String, String> = HashMap::new();
        for note in &post_scan.notes {
            post_hashes.insert(note.rel_path.clone(), note.sha256.clone());
        }
        if post_scan.notes.len() != initial_scan.notes.len()
            || post_scan.attachments != initial_scan.attachments
            || !initial_scan
                .notes
                .iter()
                .all(|n| post_hashes.get(&n.rel_path) == Some(&n.sha256))
        {
            return Err(CoreError::Conflict(
                "external vault changes raced with backup capture; retry backup".to_string(),
            ));
        }

        let manifest = BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            backup_id: backup_id.clone(),
            vault_id: vault_id.clone(),
            created_at: utc_now_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            registry_schema_version: REGISTRY_SCHEMA_VERSION,
            state_schema_version: STATE_SCHEMA_VERSION,
            state_db_sha256,
            registry_subset_sha256,
            vault_files: vault_entries,
            blob_hashes,
            complete: true,
        };
        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|err| CoreError::IoFailed(format!("serialize backup manifest: {err}")))?;
        write_synced_file(&staged_dir.join("manifest.json"), &manifest_bytes)?;

        std::fs::rename(&staged_dir, &final_dir)
            .map_err(|err| CoreError::from_io_dir("publish backup directory", &err))?;

        Ok(BackupResult {
            backup_id,
            destination: final_dir.to_string_lossy().into_owned(),
            vault_files_count: manifest.vault_files.len(),
            blobs_count: manifest.blob_hashes.len(),
        })
    })();

    if res.is_err() {
        let _ = std::fs::remove_dir_all(&staged_dir);
    }
    res
}

/// Verifies manifest, checksums, and path safety, then restores a backup into an empty target
/// directory with a fresh `VaultId` (if restoring alongside an existing vault), all grants disabled,
/// and a freshly rebuilt `index-1.sqlite`.
pub fn restore_backup(
    paths: &AppPathsSpec,
    backup_dir: &Path,
    destination_vault_dir: &Path,
) -> Result<RestoreResult, CoreError> {
    let manifest_bytes = std::fs::read(backup_dir.join("manifest.json"))
        .map_err(|err| CoreError::RecoveryRequired(format!("read backup manifest: {err}")))?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|err| CoreError::RecoveryRequired(format!("invalid backup manifest: {err}")))?;

    if !manifest.complete {
        return Err(CoreError::RecoveryRequired(
            "backup is incomplete (complete=false)".to_string(),
        ));
    }
    if manifest.format_version > BACKUP_FORMAT_VERSION
        || manifest.registry_schema_version > REGISTRY_SCHEMA_VERSION
        || manifest.state_schema_version > STATE_SCHEMA_VERSION
    {
        return Err(CoreError::RecoveryRequired(
            "backup was created by a newer incompatible schema version".to_string(),
        ));
    }

    // Refuse non-empty target directory so existing data cannot be silently overwritten.
    if destination_vault_dir.exists() {
        let mut entries = std::fs::read_dir(destination_vault_dir)
            .map_err(|err| CoreError::from_io_dir("inspect restore target", &err))?;
        if entries.next().is_some() {
            return Err(CoreError::Conflict(
                "restore destination directory must be empty".to_string(),
            ));
        }
    }

    // Validate state.sqlite & registry_subset.json checksums before writing anything.
    let state_bytes = std::fs::read(backup_dir.join("state.sqlite")).map_err(|err| {
        CoreError::RecoveryRequired(format!("missing backup state.sqlite: {err}"))
    })?;
    if sha256_hex(&state_bytes) != manifest.state_db_sha256 {
        return Err(CoreError::RecoveryRequired(
            "backup state.sqlite checksum mismatch".to_string(),
        ));
    }

    let subset_bytes = std::fs::read(backup_dir.join("registry_subset.json")).map_err(|err| {
        CoreError::RecoveryRequired(format!("missing backup registry_subset.json: {err}"))
    })?;
    if sha256_hex(&subset_bytes) != manifest.registry_subset_sha256 {
        return Err(CoreError::RecoveryRequired(
            "backup registry_subset.json checksum mismatch".to_string(),
        ));
    }
    let subset: RegistryBackupSubset = serde_json::from_slice(&subset_bytes)
        .map_err(|err| CoreError::RecoveryRequired(format!("parse registry subset: {err}")))?;

    // Verify all vault inventory files and blobs before touching registry/state.
    let mut verified_files = Vec::with_capacity(manifest.vault_files.len());
    for entry in &manifest.vault_files {
        validate_relative_path(&entry.rel_path)?;
        let src = backup_dir
            .join("vault")
            .join(entry.rel_path.replace('/', "\\"));
        let bytes = std::fs::read(&src).map_err(|err| {
            CoreError::RecoveryRequired(format!("missing backup file {}: {err}", entry.rel_path))
        })?;
        if bytes.len() as u64 != entry.size_bytes || sha256_hex(&bytes) != entry.sha256 {
            return Err(CoreError::RecoveryRequired(format!(
                "backup file {} failed checksum verification",
                entry.rel_path
            )));
        }
        verified_files.push((entry.rel_path.clone(), bytes));
    }

    let mut verified_blobs = Vec::with_capacity(manifest.blob_hashes.len());
    for hash in &manifest.blob_hashes {
        let src = backup_dir.join("blobs").join(format!("{hash}.blob"));
        let bytes = std::fs::read(&src).map_err(|err| {
            CoreError::RecoveryRequired(format!("missing backup blob {hash}: {err}"))
        })?;
        if sha256_hex(&bytes) != *hash {
            return Err(CoreError::RecoveryRequired(format!(
                "backup blob {hash} failed checksum verification"
            )));
        }
        verified_blobs.push((hash.clone(), bytes));
    }

    // Prevent restoring inside or overlapping %LOCALAPPDATA%\PersonalBrain
    let norm_dest_check = normalize_cmp_path(&absolutize_path(destination_vault_dir)?);
    let norm_app = normalize_cmp_path(&absolutize_path(&paths.app_data_dir)?);
    if norm_dest_check.starts_with(&norm_app) || norm_app.starts_with(&norm_dest_check) {
        return Err(CoreError::InvalidInput(
            "restore destination cannot overlap Personal Brain app-data directory".to_string(),
        ));
    }

    // Create destination vault directory and verify not reparse point
    std::fs::create_dir_all(destination_vault_dir)
        .map_err(|err| CoreError::from_io_dir("create restore destination", &err))?;
    let abs_dest = validate_vault_root(destination_vault_dir)?;

    let mut registry = RegistryStore::open(paths)?;
    let restored_vault_id = if registry.get_vault(&manifest.vault_id).is_ok() {
        VaultId::new_v4()
    } else {
        manifest.vault_id.clone()
    };

    let vault_state_dir = paths.vault_dir(&restored_vault_id);
    let _lock = VaultLock::acquire(
        &paths.vault_lock_file(&restored_vault_id),
        Duration::from_secs(5),
    )?;
    std::fs::create_dir_all(&vault_state_dir)
        .map_err(|err| CoreError::from_io_dir("create restored state dir", &err))?;
    write_synced_file(&paths.vault_state_db(&restored_vault_id), &state_bytes)?;

    let blobs_dir = vault_state_dir.join("blobs");
    for (hash, bytes) in verified_blobs {
        let bucket = blobs_dir.join(&hash[..2]);
        std::fs::create_dir_all(&bucket)
            .map_err(|err| CoreError::from_io_dir("create restored blob bucket", &err))?;
        write_synced_file(&bucket.join(format!("{hash}.blob")), &bytes)?;
    }

    for (rel_path, bytes) in &verified_files {
        let dst = abs_dest.join(rel_path.replace('/', "\\"));
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)
                .map_err(|err| CoreError::from_io_dir("create restored note dir", &err))?;
        }
        write_synced_file(&dst, bytes)?;
    }

    let mut state = VaultStateStore::open_or_init(paths, &restored_vault_id)?;
    state.conn().execute(
        "INSERT INTO vault_meta(key, value) VALUES ('vault_id', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![restored_vault_id.as_str()],
    ).map_err(|err| CoreError::StateUnavailable(format!("update restored vault_id meta: {err}")))?;
    state.set_active_index_generation(0)?;
    rebuild_generation_index(&restored_vault_id, &abs_dest, &mut state)?;

    let grants_disabled = subset.grants.len();
    registry.register_restored_vault(
        &restored_vault_id,
        &subset.display_name,
        &abs_dest,
        &subset.grants,
    )?;

    Ok(RestoreResult {
        original_vault_id: manifest.vault_id,
        restored_vault_id,
        destination: abs_dest.to_string_lossy().into_owned(),
        restored_files_count: verified_files.len(),
        grants_disabled,
    })
}

/// Exports the entire vault (Markdown + attachments) to an empty destination directory
/// without any proprietary database or wrapper format (`FR-023`).
pub fn export_vault(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
    destination: &Path,
) -> Result<usize, CoreError> {
    let registry = RegistryStore::open(paths)?;
    let record = registry.get_vault(vault_id)?;
    let vault_root = Path::new(&record.root_path);
    let safe_dest = validate_safe_destination(paths, vault_root, destination)?;

    if safe_dest.exists() {
        let mut entries = std::fs::read_dir(&safe_dest)
            .map_err(|err| CoreError::from_io_dir("inspect export destination", &err))?;
        if entries.next().is_some() {
            return Err(CoreError::Conflict(
                "export destination directory must be empty".to_string(),
            ));
        }
    }
    std::fs::create_dir_all(&safe_dest)
        .map_err(|err| CoreError::from_io_dir("create export destination", &err))?;

    let canonical_vault = validate_vault_root(vault_root)?;
    let _guard = open_guarded_dir(&canonical_vault, &canonical_vault)?;
    let scan = scan_vault(&canonical_vault)?;

    let mut exported = 0usize;
    for note in &scan.notes {
        validate_relative_path(&note.rel_path)?;
        let dst = safe_dest.join(note.rel_path.replace('/', "\\"));
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)
                .map_err(|err| CoreError::from_io_dir("create export note parent", &err))?;
        }
        write_synced_file(&dst, &note.bytes)?;
        exported += 1;
    }
    for att_rel in &scan.attachments {
        validate_relative_path(att_rel)?;
        let src = canonical_vault.join(att_rel.replace('/', "\\"));
        let (mut file, meta) = crate::vault::paths::inspect_scanned_file(&canonical_vault, &src)?;
        if meta.link_count > 1 {
            return Err(CoreError::AccessDenied(
                "hardlinked attachment denied during export".to_string(),
            ));
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|err| CoreError::from_io("read attachment for export", &err))?;
        let dst = safe_dest.join(att_rel.replace('/', "\\"));
        if let Some(p) = dst.parent() {
            std::fs::create_dir_all(p)
                .map_err(|err| CoreError::from_io_dir("create export attachment parent", &err))?;
        }
        write_synced_file(&dst, &bytes)?;
        exported += 1;
    }

    Ok(exported)
}

fn write_synced_file(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|err| CoreError::from_io("create output file", &err))?;
    f.write_all(bytes)
        .map_err(|err| CoreError::from_io("write output file", &err))?;
    f.sync_all()
        .map_err(|err| CoreError::from_io("flush output file", &err))?;
    Ok(())
}

fn absolutize_path(p: &Path) -> Result<PathBuf, CoreError> {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|err| CoreError::IoFailed(format!("resolve cwd: {err}")))?
            .join(p)
    };
    let normalized = abs.to_string_lossy().to_uppercase();
    // Strip \\?\ prefix if present for consistent starts_with comparisons with GetFinalPathNameByHandleW
    let clean = normalized.strip_prefix("\\\\?\\").unwrap_or(&normalized);
    Ok(PathBuf::from(clean))
}
