use crate::domain::errors::CoreError;
use crate::domain::ids::{NoteId, OperationId, RevisionId, VaultId};
use crate::domain::types::{
    ActorContext, MovePlan, MutationResult, NoteOrigin, NoteSnapshot, NoteSummary,
    ReconcileSummary, VaultOpenReport, VaultSummary,
};
use crate::index::store::{
    incremental_sync_note, open_healthy_index_or_rebuild, rebuild_generation_index,
    str_to_parse_status,
};
use crate::markdown::parse_markdown_bytes;
use crate::paths::AppPathsSpec;
use crate::retrieval::get_backlinks;
use crate::state::registry::RegistryStore;
use crate::state::utc_now_rfc3339;
use crate::state::vault_state::VaultStateStore;
use crate::vault::lock::VaultLock;
use crate::vault::paths::{
    file_identity_from_handle, path_key, resolve_guarded_existing_file,
    resolve_guarded_target_for_write, validate_vault_root,
};
use crate::vault::replace::{safe_replace_note, sha256_hex, ReplacePrimitive};
use rusqlite::{params, OptionalExtension};
use std::io::Read;
use std::path::Path;
use std::time::Duration;

const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(3);

/// Test-only crash injection points at `SYSTEM_ARCHITECTURE.md` §7.2 journal boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JournalFailpoint {
    None,
    AfterJournalPrepared,
    AfterFileReplaced,
}

pub struct VaultEngine;

impl VaultEngine {
    pub fn create_vault(
        paths: &AppPathsSpec,
        root_path: &Path,
        display_name: Option<&str>,
    ) -> Result<VaultOpenReport, CoreError> {
        let mut registry = RegistryStore::open(paths)?;
        let record = registry.register_or_open_vault(root_path, display_name, true)?;
        Self::open_and_reconcile_registered(paths, &registry, &record.vault_id)
    }

    pub fn open_vault(
        paths: &AppPathsSpec,
        root_path: &Path,
    ) -> Result<VaultOpenReport, CoreError> {
        let mut registry = RegistryStore::open(paths)?;
        let record = registry.register_or_open_vault(root_path, None, false)?;
        Self::open_and_reconcile_registered(paths, &registry, &record.vault_id)
    }

    pub fn list_vaults(paths: &AppPathsSpec) -> Result<Vec<VaultSummary>, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let records = registry.list_vaults()?;
        let mut summaries = Vec::with_capacity(records.len());
        for rec in records {
            let (gen, count) =
                if let Ok(state) = VaultStateStore::open_or_init(paths, &rec.vault_id) {
                    (
                        state.active_index_generation().unwrap_or(0),
                        state.count_present_notes().unwrap_or(0),
                    )
                } else {
                    (0, 0)
                };
            summaries.push(registry.to_summary(&rec, gen, count));
        }
        Ok(summaries)
    }

    fn open_and_reconcile_registered(
        paths: &AppPathsSpec,
        registry: &RegistryStore,
        vault_id: &VaultId,
    ) -> Result<VaultOpenReport, CoreError> {
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        validate_vault_root(vault_root)?;
        let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
        Self::recover_pending_journal(vault_root, &mut state)?;
        let (reconcile, attachments_discovered, broken_links, ambiguous_links) =
            rebuild_generation_index(vault_id, vault_root, &mut state)?;
        let _ = registry.set_active_vault(vault_id);

        Ok(VaultOpenReport {
            vault: registry.to_summary(
                &record,
                reconcile.index_generation,
                reconcile.indexed_notes,
            ),
            notes_discovered: reconcile.indexed_notes,
            attachments_discovered,
            broken_links,
            ambiguous_links,
            diagnostics: reconcile.diagnostics,
        })
    }

    pub fn list_notes(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
    ) -> Result<Vec<NoteSummary>, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
        let (index_conn, _) =
            open_healthy_index_or_rebuild(paths, vault_id, vault_root, &mut state)?;

        let identities = state.list_all_identities()?;
        let mut status_by_id = std::collections::HashMap::new();
        for id_row in identities {
            status_by_id.insert(
                id_row.note_id.as_str().to_string(),
                (id_row.origin, id_row.verification, id_row.pinned),
            );
        }

        let mut tags_by_id: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        {
            let mut t_stmt = index_conn
                .prepare(
                    "SELECT nt.note_id, t.display_name FROM note_tags nt JOIN tags t ON t.tag_key = nt.tag_key ORDER BY t.tag_key",
                )
                .map_err(|err| CoreError::IoFailed(format!("prepare list_notes tags: {err}")))?;
            let rows = t_stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|err| CoreError::IoFailed(format!("query list_notes tags: {err}")))?;
            for row in rows {
                let (nid, tag) = row.map_err(|err| {
                    CoreError::IoFailed(format!("collect list_notes tags: {err}"))
                })?;
                tags_by_id.entry(nid).or_default().push(tag);
            }
        }

        let mut stmt = index_conn
            .prepare(
                "SELECT note_id, rel_path, title, content_hash, parse_status FROM notes ORDER BY rel_path ASC",
            )
            .map_err(|err| CoreError::IoFailed(format!("prepare list_notes: {err}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|err| CoreError::IoFailed(format!("query list_notes: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::IoFailed(format!("collect list_notes: {err}")))?;

        let mut out = Vec::with_capacity(rows.len());
        for (nid_s, rel_path, title, content_hash, parse_s) in rows {
            let note_id = NoteId::parse(&nid_s)?;
            let (origin, verification, pinned) = status_by_id.get(&nid_s).copied().unwrap_or((
                NoteOrigin::Imported,
                crate::domain::types::VerificationStatus::Unverified,
                false,
            ));
            let tags = tags_by_id.remove(&nid_s).unwrap_or_default();
            out.push(NoteSummary {
                note_id,
                rel_path,
                title,
                content_hash,
                parse_status: str_to_parse_status(&parse_s),
                origin,
                verification,
                pinned,
                tags,
            });
        }
        Ok(out)
    }

    pub fn read_note(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
        note_id: &NoteId,
    ) -> Result<NoteSnapshot, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let state = VaultStateStore::open_or_init(paths, vault_id)?;
        let id_row = state
            .get_note_by_id(note_id)?
            .filter(|r| r.state == "present")
            .ok_or_else(|| CoreError::NoteNotFound("note not found in vault".to_string()))?;

        let (_, mut file) = resolve_guarded_existing_file(vault_root, &id_row.rel_path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|err| CoreError::from_io("read note content", &err))?;
        let content_hash = sha256_hex(&bytes);
        let parsed = parse_markdown_bytes(&id_row.rel_path, &bytes);
        let body = String::from_utf8_lossy(&bytes).into_owned();
        let gen = state.active_index_generation()?;

        Ok(NoteSnapshot {
            note_id: note_id.clone(),
            vault_id: vault_id.clone(),
            rel_path: id_row.rel_path,
            title: parsed.title,
            body,
            content_hash,
            parse_status: parsed.parse_status,
            origin: id_row.origin,
            verification: id_row.verification,
            pinned: id_row.pinned,
            tags: parsed.tags.into_iter().map(|t| t.display).collect(),
            aliases: parsed.aliases.into_iter().map(|a| a.display).collect(),
            index_generation: gen,
        })
    }

    pub fn create_note(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        vault_id: &VaultId,
        rel_path: &str,
        body: &str,
        request_id: &str,
    ) -> Result<MutationResult, CoreError> {
        Self::create_note_with_failpoint(
            paths,
            actor,
            vault_id,
            rel_path,
            body,
            request_id,
            JournalFailpoint::None,
        )
    }

    pub fn create_note_with_failpoint(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        vault_id: &VaultId,
        rel_path: &str,
        body: &str,
        request_id: &str,
        failpoint: JournalFailpoint,
    ) -> Result<MutationResult, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
        Self::recover_pending_journal(vault_root, &mut state)?;

        let new_bytes = body.as_bytes();
        let input_hash =
            sha256_hex(format!("create:{rel_path}:{}", sha256_hex(new_bytes)).as_bytes());
        let actor_key = actor.actor_key();

        if let Some(existing) =
            Self::check_idempotency(&state, &actor_key, request_id, &input_hash)?
        {
            return Ok(existing);
        }

        let (_, exists) = resolve_guarded_target_for_write(vault_root, rel_path)?;
        if exists {
            return Err(CoreError::Conflict(
                "destination note already exists on disk".to_string(),
            ));
        }

        let new_hash = state.store_blob(new_bytes)?;
        let note_id = NoteId::new_v4();
        let op_id = OperationId::new_v4();
        let rev_id = RevisionId::new_v4();
        let pk = path_key(rel_path);
        let now = utc_now_rfc3339();

        // Reserve note_identity (`ADR-0005` SC-13) + insert `prepared` journal in one transaction.
        {
            let tx = state.conn().unchecked_transaction().map_err(|err| {
                CoreError::StateUnavailable(format!("begin create prepare: {err}"))
            })?;
            tx.execute(
                "INSERT INTO note_identity(note_id, rel_path, path_key, file_identity, last_hash, state, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, NULL, NULL, 'reserved', ?4, ?4)",
                params![note_id.as_str(), rel_path, pk, now],
            )
            .map_err(|err| CoreError::Conflict(format!("reserve note_identity: {err}")))?;
            tx.execute(
                "INSERT INTO mutation_journal(operation_id, actor_key, request_id, input_hash, kind, note_id, proposal_id, old_path, new_path, old_hash, new_hash, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'create', ?5, NULL, NULL, ?6, NULL, ?7, 'prepared', ?8)",
                params![
                    op_id.as_str(),
                    actor_key,
                    request_id,
                    input_hash,
                    note_id.as_str(),
                    rel_path,
                    new_hash,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert create journal: {err}")))?;
            tx.commit().map_err(|err| {
                CoreError::StateUnavailable(format!("commit create prepare: {err}"))
            })?;
        }

        if failpoint == JournalFailpoint::AfterJournalPrepared {
            return Err(CoreError::IoFailed(
                "simulated crash after journal prepared".to_string(),
            ));
        }

        let recovery_dir = state.vault_dir().join("recovery");
        if let Err(err) = safe_replace_note(
            vault_root,
            rel_path,
            None,
            new_bytes,
            Some(&recovery_dir),
            ReplacePrimitive::MoveFileExWriteThrough,
        ) {
            let _ = Self::abort_prepared_create(&state, &op_id, &note_id);
            return Err(err);
        }

        if failpoint == JournalFailpoint::AfterFileReplaced {
            return Err(CoreError::IoFailed(
                "simulated crash after file replaced".to_string(),
            ));
        }

        let (_, file) = resolve_guarded_existing_file(vault_root, rel_path)?;
        let fid = file_identity_from_handle(&file)?;
        Self::finalize_create(
            &state, &op_id, &rev_id, &note_id, rel_path, &fid, &new_hash, &actor_key,
        )?;

        let gen = incremental_sync_note(
            vault_id,
            vault_root,
            &mut state,
            &note_id,
            Some(rel_path),
            Some(new_bytes),
            Some(&new_hash),
        )?;

        Ok(MutationResult {
            operation_id: op_id,
            revision_id: Some(rev_id),
            note_id,
            rel_path: rel_path.to_string(),
            content_hash: new_hash,
            index_generation: gen,
            replayed: false,
        })
    }

    pub fn save_note(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        vault_id: &VaultId,
        note_id: &NoteId,
        expected_hash: &str,
        body: &str,
        request_id: &str,
    ) -> Result<MutationResult, CoreError> {
        Self::save_note_with_failpoint(
            paths,
            actor,
            vault_id,
            note_id,
            expected_hash,
            body,
            request_id,
            JournalFailpoint::None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_note_with_failpoint(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        vault_id: &VaultId,
        note_id: &NoteId,
        expected_hash: &str,
        body: &str,
        request_id: &str,
        failpoint: JournalFailpoint,
    ) -> Result<MutationResult, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
        Self::recover_pending_journal(vault_root, &mut state)?;

        let new_bytes = body.as_bytes();
        let input_hash = sha256_hex(
            format!(
                "save:{}:{}:{}",
                note_id.as_str(),
                expected_hash,
                sha256_hex(new_bytes)
            )
            .as_bytes(),
        );
        let actor_key = actor.actor_key();

        if let Some(existing) =
            Self::check_idempotency(&state, &actor_key, request_id, &input_hash)?
        {
            return Ok(existing);
        }

        let id_row = state
            .get_note_by_id(note_id)?
            .filter(|r| r.state == "present")
            .ok_or_else(|| CoreError::NoteNotFound("note not found".to_string()))?;

        let (_, mut live_file) = resolve_guarded_existing_file(vault_root, &id_row.rel_path)?;
        let mut old_bytes = Vec::new();
        live_file
            .read_to_end(&mut old_bytes)
            .map_err(|err| CoreError::from_io("read live note before save", &err))?;
        drop(live_file);
        let actual_old_hash = sha256_hex(&old_bytes);

        let recovery_dir = state.vault_dir().join("recovery");
        if actual_old_hash != expected_hash {
            // Do not overwrite newer disk content; preserve attempted edit in recovery dir.
            let _ = safe_replace_note(
                vault_root,
                &id_row.rel_path,
                Some(expected_hash),
                new_bytes,
                Some(&recovery_dir),
                ReplacePrimitive::MoveFileExWriteThrough,
            );
            return Err(CoreError::Conflict(
                "note changed on disk since last read; attempted edit saved to recovery"
                    .to_string(),
            ));
        }

        let old_blob_hash = state.store_blob(&old_bytes)?;
        let new_blob_hash = state.store_blob(new_bytes)?;
        let op_id = OperationId::new_v4();
        let rev_id = RevisionId::new_v4();
        let now = utc_now_rfc3339();

        state
            .conn()
            .execute(
                "INSERT INTO mutation_journal(operation_id, actor_key, request_id, input_hash, kind, note_id, proposal_id, old_path, new_path, old_hash, new_hash, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'save', ?5, NULL, ?6, ?6, ?7, ?8, 'prepared', ?9)",
                params![
                    op_id.as_str(),
                    actor_key,
                    request_id,
                    input_hash,
                    note_id.as_str(),
                    id_row.rel_path,
                    old_blob_hash,
                    new_blob_hash,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert save journal: {err}")))?;

        if failpoint == JournalFailpoint::AfterJournalPrepared {
            return Err(CoreError::IoFailed(
                "simulated crash after save journal prepared".to_string(),
            ));
        }

        if let Err(err) = safe_replace_note(
            vault_root,
            &id_row.rel_path,
            Some(expected_hash),
            new_bytes,
            Some(&recovery_dir),
            ReplacePrimitive::MoveFileExWriteThrough,
        ) {
            let _ = state.conn().execute(
                "UPDATE mutation_journal SET status = 'aborted', finalized_at = ?1 WHERE operation_id = ?2",
                params![utc_now_rfc3339(), op_id.as_str()],
            );
            return Err(err);
        }

        if failpoint == JournalFailpoint::AfterFileReplaced {
            return Err(CoreError::IoFailed(
                "simulated crash after save file replaced".to_string(),
            ));
        }

        let (_, new_file) = resolve_guarded_existing_file(vault_root, &id_row.rel_path)?;
        let fid = file_identity_from_handle(&new_file)?;
        Self::finalize_save(
            &state,
            &op_id,
            &rev_id,
            note_id,
            &id_row.rel_path,
            &fid,
            &old_blob_hash,
            &new_blob_hash,
            &actor_key,
        )?;

        let gen = incremental_sync_note(
            vault_id,
            vault_root,
            &mut state,
            note_id,
            Some(&id_row.rel_path),
            Some(new_bytes),
            Some(&new_blob_hash),
        )?;

        Ok(MutationResult {
            operation_id: op_id,
            revision_id: Some(rev_id),
            note_id: note_id.clone(),
            rel_path: id_row.rel_path,
            content_hash: new_blob_hash,
            index_generation: gen,
            replayed: false,
        })
    }

    pub fn preview_move(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
        note_id: &NoteId,
        destination_rel_path: &str,
    ) -> Result<MovePlan, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let state = VaultStateStore::open_or_init(paths, vault_id)?;
        let id_row = state
            .get_note_by_id(note_id)?
            .filter(|r| r.state == "present")
            .ok_or_else(|| CoreError::NoteNotFound("note not found".to_string()))?;

        let (_, exists) = resolve_guarded_target_for_write(vault_root, destination_rel_path)?;
        if exists {
            return Err(CoreError::Conflict(
                "move destination already exists".to_string(),
            ));
        }

        let affected_backlinks = get_backlinks(paths, vault_id, note_id)?;
        Ok(MovePlan {
            vault_id: vault_id.clone(),
            note_id: note_id.clone(),
            old_rel_path: id_row.rel_path,
            new_rel_path: destination_rel_path.to_string(),
            affected_backlinks,
        })
    }

    pub fn move_note(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        plan: &MovePlan,
        expected_hash: &str,
        request_id: &str,
    ) -> Result<MutationResult, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(&plan.vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let _lock =
            VaultLock::acquire(&paths.vault_lock_file(&plan.vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let mut state = VaultStateStore::open_or_init(paths, &plan.vault_id)?;
        Self::recover_pending_journal(vault_root, &mut state)?;

        let actor_key = actor.actor_key();
        let input_hash = sha256_hex(
            format!(
                "move:{}:{}:{}:{}",
                plan.note_id.as_str(),
                plan.old_rel_path,
                plan.new_rel_path,
                expected_hash
            )
            .as_bytes(),
        );

        if let Some(existing) =
            Self::check_idempotency(&state, &actor_key, request_id, &input_hash)?
        {
            return Ok(existing);
        }

        let id_row = state
            .get_note_by_id(&plan.note_id)?
            .filter(|r| r.state == "present" && r.rel_path == plan.old_rel_path)
            .ok_or_else(|| CoreError::Conflict("note moved or missing since plan".to_string()))?;

        let (old_abs, mut old_file) = resolve_guarded_existing_file(vault_root, &id_row.rel_path)?;
        let mut bytes = Vec::new();
        old_file
            .read_to_end(&mut bytes)
            .map_err(|err| CoreError::from_io("read source note for move", &err))?;
        drop(old_file);
        let actual_hash = sha256_hex(&bytes);
        if actual_hash != expected_hash {
            return Err(CoreError::Conflict(
                "note modified on disk since move plan".to_string(),
            ));
        }

        let (_, dst_exists) = resolve_guarded_target_for_write(vault_root, &plan.new_rel_path)?;
        if dst_exists {
            return Err(CoreError::Conflict(
                "move destination already exists".to_string(),
            ));
        }

        let blob_hash = state.store_blob(&bytes)?;
        let op_id = OperationId::new_v4();
        let rev_id = RevisionId::new_v4();
        let now = utc_now_rfc3339();

        state
            .conn()
            .execute(
                "INSERT INTO mutation_journal(operation_id, actor_key, request_id, input_hash, kind, note_id, proposal_id, old_path, new_path, old_hash, new_hash, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'move', ?5, NULL, ?6, ?7, ?8, ?8, 'prepared', ?9)",
                params![
                    op_id.as_str(),
                    actor_key,
                    request_id,
                    input_hash,
                    plan.note_id.as_str(),
                    plan.old_rel_path,
                    plan.new_rel_path,
                    blob_hash,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert move journal: {err}")))?;

        let recovery_dir = state.vault_dir().join("recovery");
        safe_replace_note(
            vault_root,
            &plan.new_rel_path,
            None,
            &bytes,
            Some(&recovery_dir),
            ReplacePrimitive::MoveFileExWriteThrough,
        )?;
        if let Err(err) = std::fs::remove_file(&old_abs) {
            let _ = state.conn().execute(
                "UPDATE mutation_journal SET status = 'recovery_required', finalized_at = ?1 WHERE operation_id = ?2",
                params![utc_now_rfc3339(), op_id.as_str()],
            );
            return Err(CoreError::from_io("remove old note path after move", &err));
        }

        let (_, new_file) = resolve_guarded_existing_file(vault_root, &plan.new_rel_path)?;
        let fid = file_identity_from_handle(&new_file)?;
        let new_pk = path_key(&plan.new_rel_path);
        let fin_now = utc_now_rfc3339();

        {
            let tx = state.conn().unchecked_transaction().map_err(|err| {
                CoreError::StateUnavailable(format!("begin move finalize: {err}"))
            })?;
            tx.execute(
                "UPDATE note_identity SET rel_path = ?1, path_key = ?2, file_identity = ?3, last_hash = ?4, last_seen_at = ?5 WHERE note_id = ?6",
                params![
                    plan.new_rel_path,
                    new_pk,
                    fid,
                    blob_hash,
                    fin_now,
                    plan.note_id.as_str()
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("update moved identity: {err}")))?;
            tx.execute(
                "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
                params![fin_now, op_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("commit move journal: {err}")))?;
            tx.execute(
                "INSERT INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
                params![
                    rev_id.as_str(),
                    op_id.as_str(),
                    plan.note_id.as_str(),
                    blob_hash,
                    plan.old_rel_path,
                    plan.new_rel_path,
                    actor_key,
                    fin_now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert move revision: {err}")))?;
            tx.commit()
                .map_err(|err| CoreError::StateUnavailable(format!("commit move tx: {err}")))?;
        }
        state.insert_audit_event(
            "note_moved",
            &actor_key,
            Some(&op_id),
            Some(&plan.note_id),
            "committed",
            &serde_json::json!({ "old_path": plan.old_rel_path, "new_path": plan.new_rel_path }),
        )?;

        let gen = incremental_sync_note(
            &plan.vault_id,
            vault_root,
            &mut state,
            &plan.note_id,
            Some(&plan.new_rel_path),
            Some(&bytes),
            Some(&blob_hash),
        )?;

        Ok(MutationResult {
            operation_id: op_id,
            revision_id: Some(rev_id),
            note_id: plan.note_id.clone(),
            rel_path: plan.new_rel_path.clone(),
            content_hash: blob_hash,
            index_generation: gen,
            replayed: false,
        })
    }

    pub fn trash_note(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        vault_id: &VaultId,
        note_id: &NoteId,
        expected_hash: &str,
        request_id: &str,
    ) -> Result<MutationResult, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
        Self::recover_pending_journal(vault_root, &mut state)?;

        let actor_key = actor.actor_key();
        let input_hash =
            sha256_hex(format!("trash:{}:{}", note_id.as_str(), expected_hash).as_bytes());
        if let Some(existing) =
            Self::check_idempotency(&state, &actor_key, request_id, &input_hash)?
        {
            return Ok(existing);
        }

        let id_row = state
            .get_note_by_id(note_id)?
            .filter(|r| r.state == "present")
            .ok_or_else(|| CoreError::NoteNotFound("note not found".to_string()))?;

        let (abs_path, mut file) = resolve_guarded_existing_file(vault_root, &id_row.rel_path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .map_err(|err| CoreError::from_io("read note before trash", &err))?;
        drop(file);
        let actual_hash = sha256_hex(&bytes);
        if actual_hash != expected_hash {
            return Err(CoreError::Conflict(
                "note changed on disk since last read; trash aborted".to_string(),
            ));
        }

        // Persist recoverable preimage blob BEFORE deleting from disk.
        let old_blob_hash = state.store_blob(&bytes)?;
        let op_id = OperationId::new_v4();
        let rev_id = RevisionId::new_v4();
        let now = utc_now_rfc3339();

        state
            .conn()
            .execute(
                "INSERT INTO mutation_journal(operation_id, actor_key, request_id, input_hash, kind, note_id, proposal_id, old_path, new_path, old_hash, new_hash, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'trash', ?5, NULL, ?6, NULL, ?7, NULL, 'prepared', ?8)",
                params![
                    op_id.as_str(),
                    actor_key,
                    request_id,
                    input_hash,
                    note_id.as_str(),
                    id_row.rel_path,
                    old_blob_hash,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert trash journal: {err}")))?;

        std::fs::remove_file(&abs_path)
            .map_err(|err| CoreError::from_io("delete trashed note file", &err))?;

        let fin_now = utc_now_rfc3339();
        {
            let tx = state.conn().unchecked_transaction().map_err(|err| {
                CoreError::StateUnavailable(format!("begin trash finalize: {err}"))
            })?;
            tx.execute(
                "UPDATE note_identity SET state = 'trashed', last_seen_at = ?1 WHERE note_id = ?2",
                params![fin_now, note_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("update trashed state: {err}")))?;
            tx.execute(
                "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
                params![fin_now, op_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("commit trash journal: {err}")))?;
            tx.execute(
                "INSERT INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, ?6, ?7)",
                params![
                    rev_id.as_str(),
                    op_id.as_str(),
                    note_id.as_str(),
                    old_blob_hash,
                    id_row.rel_path,
                    actor_key,
                    fin_now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert trash revision: {err}")))?;
            tx.commit()
                .map_err(|err| CoreError::StateUnavailable(format!("commit trash tx: {err}")))?;
        }
        state.insert_audit_event(
            "note_trashed",
            &actor_key,
            Some(&op_id),
            Some(note_id),
            "committed",
            &serde_json::json!({ "old_path": id_row.rel_path }),
        )?;

        let gen =
            incremental_sync_note(vault_id, vault_root, &mut state, note_id, None, None, None)?;

        Ok(MutationResult {
            operation_id: op_id,
            revision_id: Some(rev_id),
            note_id: note_id.clone(),
            rel_path: id_row.rel_path,
            content_hash: old_blob_hash,
            index_generation: gen,
            replayed: false,
        })
    }

    pub fn restore_trashed_note(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        vault_id: &VaultId,
        note_id: &NoteId,
        request_id: &str,
    ) -> Result<MutationResult, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
        Self::recover_pending_journal(vault_root, &mut state)?;

        let actor_key = actor.actor_key();
        let input_hash = sha256_hex(format!("restore_trash:{}", note_id.as_str()).as_bytes());
        if let Some(existing) =
            Self::check_idempotency(&state, &actor_key, request_id, &input_hash)?
        {
            return Ok(existing);
        }

        let id_row = state
            .get_note_by_id(note_id)?
            .filter(|r| r.state == "trashed")
            .ok_or_else(|| CoreError::NoteNotFound("trashed note not found".to_string()))?;
        let blob_hash = id_row
            .last_hash
            .as_deref()
            .ok_or_else(|| CoreError::RecoveryRequired("missing trashed hash".to_string()))?;
        let bytes = state.read_blob(blob_hash)?;

        let (_, exists) = resolve_guarded_target_for_write(vault_root, &id_row.rel_path)?;
        if exists {
            return Err(CoreError::Conflict(
                "restore path already occupied on disk".to_string(),
            ));
        }

        let op_id = OperationId::new_v4();
        let rev_id = RevisionId::new_v4();
        let now = utc_now_rfc3339();
        state
            .conn()
            .execute(
                "INSERT INTO mutation_journal(operation_id, actor_key, request_id, input_hash, kind, note_id, proposal_id, old_path, new_path, old_hash, new_hash, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, 'restore', ?5, NULL, NULL, ?6, NULL, ?7, 'prepared', ?8)",
                params![
                    op_id.as_str(),
                    actor_key,
                    request_id,
                    input_hash,
                    note_id.as_str(),
                    id_row.rel_path,
                    blob_hash,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert restore journal: {err}")))?;

        let recovery_dir = state.vault_dir().join("recovery");
        safe_replace_note(
            vault_root,
            &id_row.rel_path,
            None,
            &bytes,
            Some(&recovery_dir),
            ReplacePrimitive::MoveFileExWriteThrough,
        )?;
        let (_, new_file) = resolve_guarded_existing_file(vault_root, &id_row.rel_path)?;
        let fid = file_identity_from_handle(&new_file)?;
        let fin_now = utc_now_rfc3339();

        {
            let tx = state.conn().unchecked_transaction().map_err(|err| {
                CoreError::StateUnavailable(format!("begin restore finalize: {err}"))
            })?;
            tx.execute(
                "UPDATE note_identity SET state = 'present', file_identity = ?1, last_hash = ?2, last_seen_at = ?3 WHERE note_id = ?4",
                params![fid, blob_hash, fin_now, note_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("restore note_identity: {err}")))?;
            tx.execute(
                "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
                params![fin_now, op_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("commit restore journal: {err}")))?;
            tx.execute(
                "INSERT INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?6, ?7)",
                params![
                    rev_id.as_str(),
                    op_id.as_str(),
                    note_id.as_str(),
                    blob_hash,
                    id_row.rel_path,
                    actor_key,
                    fin_now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert restore revision: {err}")))?;
            tx.commit()
                .map_err(|err| CoreError::StateUnavailable(format!("commit restore tx: {err}")))?;
        }
        state.insert_audit_event(
            "note_restored",
            &actor_key,
            Some(&op_id),
            Some(note_id),
            "committed",
            &serde_json::json!({ "rel_path": id_row.rel_path }),
        )?;

        let gen = incremental_sync_note(
            vault_id,
            vault_root,
            &mut state,
            note_id,
            Some(&id_row.rel_path),
            Some(&bytes),
            Some(blob_hash),
        )?;

        Ok(MutationResult {
            operation_id: op_id,
            revision_id: Some(rev_id),
            note_id: note_id.clone(),
            rel_path: id_row.rel_path,
            content_hash: blob_hash.to_string(),
            index_generation: gen,
            replayed: false,
        })
    }

    pub fn restore_revision(
        paths: &AppPathsSpec,
        actor: &ActorContext,
        vault_id: &VaultId,
        revision_id: &RevisionId,
        expected_current_hash: &str,
        request_id: &str,
    ) -> Result<MutationResult, CoreError> {
        let state = VaultStateStore::open_or_init(paths, vault_id)?;
        let rev = state.get_revision(revision_id)?;
        let target_hash = rev
            .old_hash
            .as_deref()
            .or(rev.new_hash.as_deref())
            .ok_or_else(|| CoreError::InvalidInput("revision has no content blob".to_string()))?;
        let bytes = state.read_blob(target_hash)?;
        let body = String::from_utf8(bytes)
            .map_err(|_| CoreError::InvalidInput("revision blob is not UTF-8".to_string()))?;
        Self::save_note(
            paths,
            actor,
            vault_id,
            &rev.note_id,
            expected_current_hash,
            &body,
            request_id,
        )
    }

    pub fn rebuild_index(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
    ) -> Result<ReconcileSummary, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let record = registry.get_vault(vault_id)?;
        let vault_root = Path::new(&record.root_path);
        let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
        Self::recover_pending_journal(vault_root, &mut state)?;
        let (summary, _, _, _) = rebuild_generation_index(vault_id, vault_root, &mut state)?;
        Ok(summary)
    }

    /// Resolves any unfinalized `prepared` journal operations from a previous crash (`SYSTEM_ARCHITECTURE.md` §7.2).
    pub fn recover_pending_journal(
        vault_root: &Path,
        state: &mut VaultStateStore,
    ) -> Result<(), CoreError> {
        let prepared = state.list_prepared_journal()?;
        for row in prepared {
            let op_id = row.operation_id.clone();
            match row.kind.as_str() {
                "create" => {
                    let Some(note_id) = row.note_id.clone() else {
                        continue;
                    };
                    let Some(rel_path) = row.new_path.clone() else {
                        continue;
                    };
                    let Some(expected_new_hash) = row.new_hash.clone() else {
                        continue;
                    };
                    if let Ok((_, mut f)) = resolve_guarded_existing_file(vault_root, &rel_path) {
                        let mut bytes = Vec::new();
                        let _ = f.read_to_end(&mut bytes);
                        let actual_hash = sha256_hex(&bytes);
                        if actual_hash == expected_new_hash {
                            let fid = file_identity_from_handle(&f)?;
                            let rev_id = RevisionId::new_v4();
                            Self::finalize_create(
                                state,
                                &op_id,
                                &rev_id,
                                &note_id,
                                &rel_path,
                                &fid,
                                &expected_new_hash,
                                &row.actor_key,
                            )?;
                        } else {
                            Self::mark_recovery_required(state, &op_id)?;
                        }
                    } else {
                        Self::abort_prepared_create(state, &op_id, &note_id)?;
                    }
                }
                "save" => {
                    let Some(note_id) = row.note_id.clone() else {
                        continue;
                    };
                    let Some(rel_path) = row.old_path.clone() else {
                        continue;
                    };
                    let Some(expected_old_hash) = row.old_hash.clone() else {
                        continue;
                    };
                    let Some(expected_new_hash) = row.new_hash.clone() else {
                        continue;
                    };
                    if let Ok((_, mut f)) = resolve_guarded_existing_file(vault_root, &rel_path) {
                        let mut bytes = Vec::new();
                        let _ = f.read_to_end(&mut bytes);
                        let actual_hash = sha256_hex(&bytes);
                        if actual_hash == expected_new_hash {
                            let fid = file_identity_from_handle(&f)?;
                            let rev_id = RevisionId::new_v4();
                            Self::finalize_save(
                                state,
                                &op_id,
                                &rev_id,
                                &note_id,
                                &rel_path,
                                &fid,
                                &expected_old_hash,
                                &expected_new_hash,
                                &row.actor_key,
                            )?;
                        } else if actual_hash == expected_old_hash {
                            state
                                .conn()
                                .execute(
                                    "UPDATE mutation_journal SET status = 'aborted', finalized_at = ?1 WHERE operation_id = ?2",
                                    params![utc_now_rfc3339(), op_id.as_str()],
                                )
                                .map_err(|err| CoreError::StateUnavailable(format!("abort save journal: {err}")))?;
                        } else {
                            Self::mark_recovery_required(state, &op_id)?;
                        }
                    } else {
                        Self::mark_recovery_required(state, &op_id)?;
                    }
                }
                "move" => {
                    let (Some(note_id), Some(old_path), Some(new_path), Some(blob_hash)) = (
                        row.note_id.clone(),
                        row.old_path.clone(),
                        row.new_path.clone(),
                        row.new_hash.clone(),
                    ) else {
                        Self::mark_recovery_required(state, &op_id)?;
                        continue;
                    };
                    let new_res = resolve_guarded_existing_file(vault_root, &new_path);
                    let old_res = resolve_guarded_existing_file(vault_root, &old_path);
                    match (old_res, new_res) {
                        (Ok((old_abs, mut old_f)), Ok((_, mut new_f))) => {
                            let mut old_b = Vec::new();
                            let mut new_b = Vec::new();
                            let _ = old_f.read_to_end(&mut old_b);
                            let _ = new_f.read_to_end(&mut new_b);
                            drop(old_f);
                            if sha256_hex(&new_b) == blob_hash && sha256_hex(&old_b) == blob_hash {
                                if std::fs::remove_file(&old_abs).is_ok() {
                                    let fid = file_identity_from_handle(&new_f)?;
                                    let rev_id = RevisionId::new_v4();
                                    Self::finalize_move(
                                        state,
                                        &op_id,
                                        &rev_id,
                                        &note_id,
                                        &old_path,
                                        &new_path,
                                        &fid,
                                        &blob_hash,
                                        &row.actor_key,
                                    )?;
                                } else {
                                    Self::mark_recovery_required(state, &op_id)?;
                                }
                            } else {
                                Self::mark_recovery_required(state, &op_id)?;
                            }
                        }
                        (Err(_), Ok((_, mut new_f))) => {
                            let mut new_b = Vec::new();
                            let _ = new_f.read_to_end(&mut new_b);
                            if sha256_hex(&new_b) == blob_hash {
                                let fid = file_identity_from_handle(&new_f)?;
                                let rev_id = RevisionId::new_v4();
                                Self::finalize_move(
                                    state,
                                    &op_id,
                                    &rev_id,
                                    &note_id,
                                    &old_path,
                                    &new_path,
                                    &fid,
                                    &blob_hash,
                                    &row.actor_key,
                                )?;
                            } else {
                                Self::mark_recovery_required(state, &op_id)?;
                            }
                        }
                        (Ok((_, mut old_f)), Err(_)) => {
                            let mut old_b = Vec::new();
                            let _ = old_f.read_to_end(&mut old_b);
                            if sha256_hex(&old_b) == blob_hash {
                                state
                                    .conn()
                                    .execute(
                                        "UPDATE mutation_journal SET status = 'aborted', finalized_at = ?1 WHERE operation_id = ?2",
                                        params![utc_now_rfc3339(), op_id.as_str()],
                                    )
                                    .map_err(|err| CoreError::StateUnavailable(format!("abort move journal: {err}")))?;
                            } else {
                                Self::mark_recovery_required(state, &op_id)?;
                            }
                        }
                        (Err(_), Err(_)) => {
                            Self::mark_recovery_required(state, &op_id)?;
                        }
                    }
                }
                "trash" => {
                    let (Some(note_id), Some(old_path), Some(old_hash)) = (
                        row.note_id.clone(),
                        row.old_path.clone(),
                        row.old_hash.clone(),
                    ) else {
                        Self::mark_recovery_required(state, &op_id)?;
                        continue;
                    };
                    if let Ok((_, mut old_f)) = resolve_guarded_existing_file(vault_root, &old_path)
                    {
                        let mut old_b = Vec::new();
                        let _ = old_f.read_to_end(&mut old_b);
                        if sha256_hex(&old_b) == old_hash {
                            state
                                .conn()
                                .execute(
                                    "UPDATE mutation_journal SET status = 'aborted', finalized_at = ?1 WHERE operation_id = ?2",
                                    params![utc_now_rfc3339(), op_id.as_str()],
                                )
                                .map_err(|err| CoreError::StateUnavailable(format!("abort trash journal: {err}")))?;
                        } else {
                            Self::mark_recovery_required(state, &op_id)?;
                        }
                    } else {
                        let rev_id = RevisionId::new_v4();
                        Self::finalize_trash(
                            state,
                            &op_id,
                            &rev_id,
                            &note_id,
                            &old_path,
                            &old_hash,
                            &row.actor_key,
                        )?;
                    }
                }
                "restore" => {
                    let (Some(note_id), Some(new_path), Some(new_hash)) = (
                        row.note_id.clone(),
                        row.new_path.clone(),
                        row.new_hash.clone(),
                    ) else {
                        Self::mark_recovery_required(state, &op_id)?;
                        continue;
                    };
                    if let Ok((_, mut new_f)) = resolve_guarded_existing_file(vault_root, &new_path)
                    {
                        let mut new_b = Vec::new();
                        let _ = new_f.read_to_end(&mut new_b);
                        if sha256_hex(&new_b) == new_hash {
                            let fid = file_identity_from_handle(&new_f)?;
                            let rev_id = RevisionId::new_v4();
                            Self::finalize_restore(
                                state,
                                &op_id,
                                &rev_id,
                                &note_id,
                                &new_path,
                                &fid,
                                &new_hash,
                                &row.actor_key,
                            )?;
                        } else {
                            Self::mark_recovery_required(state, &op_id)?;
                        }
                    } else {
                        state
                            .conn()
                            .execute(
                                "UPDATE mutation_journal SET status = 'aborted', finalized_at = ?1 WHERE operation_id = ?2",
                                params![utc_now_rfc3339(), op_id.as_str()],
                            )
                            .map_err(|err| CoreError::StateUnavailable(format!("abort restore journal: {err}")))?;
                    }
                }
                _ => {
                    Self::mark_recovery_required(state, &op_id)?;
                }
            }
        }

        // Clean up any orphaned `'reserved'` identity rows that lack an active `'prepared'` journal entry.
        state
            .conn()
            .execute(
                "DELETE FROM note_identity WHERE state = 'reserved' AND note_id NOT IN (SELECT note_id FROM mutation_journal WHERE status = 'prepared' AND note_id IS NOT NULL)",
                [],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("clean reserved identities: {err}")))?;
        Ok(())
    }

    fn check_idempotency(
        state: &VaultStateStore,
        actor_key: &str,
        request_id: &str,
        input_hash: &str,
    ) -> Result<Option<MutationResult>, CoreError> {
        let Some(row) = state.find_journal_by_request(actor_key, request_id)? else {
            return Ok(None);
        };
        if row.input_hash != input_hash {
            return Err(CoreError::Conflict(
                "request_id reused with different payload".to_string(),
            ));
        }
        if row.status == "committed" {
            let note_id = row.note_id.ok_or_else(|| {
                CoreError::RecoveryRequired("journal missing note_id".to_string())
            })?;
            let revision_id = state.find_revision_for_operation(&row.operation_id)?;
            let gen = state.active_index_generation()?;
            return Ok(Some(MutationResult {
                operation_id: row.operation_id,
                revision_id,
                note_id,
                rel_path: row.new_path.or(row.old_path).unwrap_or_default(),
                content_hash: row.new_hash.or(row.old_hash).unwrap_or_default(),
                index_generation: gen,
                replayed: true,
            }));
        }
        if row.status == "recovery_required" {
            return Err(CoreError::RecoveryRequired(
                "previous operation requires recovery before retry".to_string(),
            ));
        }
        Ok(None)
    }

    fn abort_prepared_create(
        state: &VaultStateStore,
        op_id: &OperationId,
        note_id: &NoteId,
    ) -> Result<(), CoreError> {
        let tx = state
            .conn()
            .unchecked_transaction()
            .map_err(|err| CoreError::StateUnavailable(format!("begin abort create: {err}")))?;
        tx.execute(
            "UPDATE mutation_journal SET status = 'aborted', finalized_at = ?1, note_id = NULL WHERE operation_id = ?2",
            params![utc_now_rfc3339(), op_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("abort create journal: {err}")))?;
        tx.execute(
            "DELETE FROM note_identity WHERE note_id = ?1 AND state = 'reserved'",
            params![note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("delete reserved identity: {err}")))?;
        tx.commit()
            .map_err(|err| CoreError::StateUnavailable(format!("commit abort create: {err}")))
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize_create(
        state: &VaultStateStore,
        op_id: &OperationId,
        rev_id: &RevisionId,
        note_id: &NoteId,
        rel_path: &str,
        file_identity: &str,
        new_hash: &str,
        actor_key: &str,
    ) -> Result<(), CoreError> {
        let now = utc_now_rfc3339();
        let tx = state
            .conn()
            .unchecked_transaction()
            .map_err(|err| CoreError::StateUnavailable(format!("begin finalize create: {err}")))?;
        tx.execute(
            "UPDATE note_identity SET file_identity = ?1, last_hash = ?2, state = 'present', last_seen_at = ?3 WHERE note_id = ?4",
            params![file_identity, new_hash, now, note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("activate note_identity: {err}")))?;
        tx.execute(
            "INSERT OR IGNORE INTO note_status(note_id, origin, verification, pinned) VALUES (?1, 'user_created', 'unverified', 0)",
            params![note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("insert user_created status: {err}")))?;
        tx.execute(
            "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
            params![now, op_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("commit create journal: {err}")))?;
        tx.execute(
            "INSERT OR IGNORE INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?6, ?7)",
            params![
                rev_id.as_str(),
                op_id.as_str(),
                note_id.as_str(),
                new_hash,
                rel_path,
                actor_key,
                now
            ],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("insert create revision: {err}")))?;
        tx.commit()
            .map_err(|err| CoreError::StateUnavailable(format!("commit finalize create: {err}")))?;
        state.insert_audit_event(
            "note_created",
            actor_key,
            Some(op_id),
            Some(note_id),
            "committed",
            &serde_json::json!({ "rel_path": rel_path }),
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize_save(
        state: &VaultStateStore,
        op_id: &OperationId,
        rev_id: &RevisionId,
        note_id: &NoteId,
        rel_path: &str,
        file_identity: &str,
        old_hash: &str,
        new_hash: &str,
        actor_key: &str,
    ) -> Result<(), CoreError> {
        let now = utc_now_rfc3339();
        let tx = state
            .conn()
            .unchecked_transaction()
            .map_err(|err| CoreError::StateUnavailable(format!("begin finalize save: {err}")))?;
        tx.execute(
            "UPDATE note_identity SET file_identity = ?1, last_hash = ?2, last_seen_at = ?3 WHERE note_id = ?4",
            params![file_identity, new_hash, now, note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("update saved identity: {err}")))?;
        tx.execute(
            "UPDATE note_status SET verification = CASE WHEN verification = 'user_verified' AND verified_hash <> ?1 THEN 'outdated' ELSE verification END WHERE note_id = ?2",
            params![new_hash, note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("invalidate stale verification: {err}")))?;
        tx.execute(
            "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
            params![now, op_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("commit save journal: {err}")))?;
        tx.execute(
            "INSERT OR IGNORE INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)",
            params![
                rev_id.as_str(),
                op_id.as_str(),
                note_id.as_str(),
                old_hash,
                new_hash,
                rel_path,
                actor_key,
                now
            ],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("insert save revision: {err}")))?;
        tx.commit()
            .map_err(|err| CoreError::StateUnavailable(format!("commit finalize save: {err}")))?;
        state.insert_audit_event(
            "note_saved",
            actor_key,
            Some(op_id),
            Some(note_id),
            "committed",
            &serde_json::json!({ "rel_path": rel_path }),
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize_move(
        state: &VaultStateStore,
        op_id: &OperationId,
        rev_id: &RevisionId,
        note_id: &NoteId,
        old_path: &str,
        new_path: &str,
        file_identity: &str,
        blob_hash: &str,
        actor_key: &str,
    ) -> Result<(), CoreError> {
        let new_pk = path_key(new_path);
        let fin_now = utc_now_rfc3339();
        let tx = state
            .conn()
            .unchecked_transaction()
            .map_err(|err| CoreError::StateUnavailable(format!("begin move finalize: {err}")))?;
        tx.execute(
            "UPDATE note_identity SET rel_path = ?1, path_key = ?2, file_identity = ?3, last_hash = ?4, last_seen_at = ?5 WHERE note_id = ?6",
            params![new_path, new_pk, file_identity, blob_hash, fin_now, note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("update moved identity: {err}")))?;
        tx.execute(
            "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
            params![fin_now, op_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("commit move journal: {err}")))?;
        tx.execute(
            "INSERT OR IGNORE INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8)",
            params![
                rev_id.as_str(),
                op_id.as_str(),
                note_id.as_str(),
                blob_hash,
                old_path,
                new_path,
                actor_key,
                fin_now
            ],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("insert move revision: {err}")))?;
        tx.commit()
            .map_err(|err| CoreError::StateUnavailable(format!("commit move tx: {err}")))?;
        state.insert_audit_event(
            "note_moved",
            actor_key,
            Some(op_id),
            Some(note_id),
            "committed",
            &serde_json::json!({ "old_path": old_path, "new_path": new_path }),
        )?;
        Ok(())
    }

    fn finalize_trash(
        state: &VaultStateStore,
        op_id: &OperationId,
        rev_id: &RevisionId,
        note_id: &NoteId,
        old_path: &str,
        old_hash: &str,
        actor_key: &str,
    ) -> Result<(), CoreError> {
        let fin_now = utc_now_rfc3339();
        let tx = state
            .conn()
            .unchecked_transaction()
            .map_err(|err| CoreError::StateUnavailable(format!("begin trash finalize: {err}")))?;
        tx.execute(
            "UPDATE note_identity SET state = 'trashed', last_seen_at = ?1 WHERE note_id = ?2",
            params![fin_now, note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("update trashed state: {err}")))?;
        tx.execute(
            "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
            params![fin_now, op_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("commit trash journal: {err}")))?;
        tx.execute(
            "INSERT OR IGNORE INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL, ?6, ?7)",
            params![
                rev_id.as_str(),
                op_id.as_str(),
                note_id.as_str(),
                old_hash,
                old_path,
                actor_key,
                fin_now
            ],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("insert trash revision: {err}")))?;
        tx.commit()
            .map_err(|err| CoreError::StateUnavailable(format!("commit trash tx: {err}")))?;
        state.insert_audit_event(
            "note_trashed",
            actor_key,
            Some(op_id),
            Some(note_id),
            "committed",
            &serde_json::json!({ "old_path": old_path }),
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn finalize_restore(
        state: &VaultStateStore,
        op_id: &OperationId,
        rev_id: &RevisionId,
        note_id: &NoteId,
        rel_path: &str,
        file_identity: &str,
        blob_hash: &str,
        actor_key: &str,
    ) -> Result<(), CoreError> {
        let fin_now = utc_now_rfc3339();
        let tx = state
            .conn()
            .unchecked_transaction()
            .map_err(|err| CoreError::StateUnavailable(format!("begin restore finalize: {err}")))?;
        tx.execute(
            "UPDATE note_identity SET state = 'present', file_identity = ?1, last_hash = ?2, last_seen_at = ?3 WHERE note_id = ?4",
            params![file_identity, blob_hash, fin_now, note_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("restore note_identity: {err}")))?;
        tx.execute(
            "UPDATE mutation_journal SET status = 'committed', finalized_at = ?1 WHERE operation_id = ?2",
            params![fin_now, op_id.as_str()],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("commit restore journal: {err}")))?;
        tx.execute(
            "INSERT OR IGNORE INTO revisions(revision_id, operation_id, note_id, old_hash, new_hash, old_path, new_path, actor_key, created_at)
             VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?6, ?7)",
            params![
                rev_id.as_str(),
                op_id.as_str(),
                note_id.as_str(),
                blob_hash,
                rel_path,
                actor_key,
                fin_now
            ],
        )
        .map_err(|err| CoreError::StateUnavailable(format!("insert restore revision: {err}")))?;
        tx.commit()
            .map_err(|err| CoreError::StateUnavailable(format!("commit restore tx: {err}")))?;
        state.insert_audit_event(
            "note_restored",
            actor_key,
            Some(op_id),
            Some(note_id),
            "committed",
            &serde_json::json!({ "rel_path": rel_path }),
        )?;
        Ok(())
    }

    fn mark_recovery_required(
        state: &VaultStateStore,
        op_id: &OperationId,
    ) -> Result<(), CoreError> {
        state
            .conn()
            .execute(
                "UPDATE mutation_journal SET status = 'recovery_required', finalized_at = ?1 WHERE operation_id = ?2",
                params![utc_now_rfc3339(), op_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("mark recovery_required: {err}")))?;
        Ok(())
    }

    pub fn set_pinned(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
        note_id: &NoteId,
        pinned: bool,
    ) -> Result<bool, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let _ = registry.get_vault(vault_id)?;
        let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), DEFAULT_LOCK_TIMEOUT)?;
        let state = VaultStateStore::open_or_init(paths, vault_id)?;
        let exists = state
            .get_note_by_id(note_id)?
            .filter(|r| r.state == "present")
            .is_some();
        if !exists {
            return Err(CoreError::NoteNotFound("note not found".to_string()));
        }
        state
            .conn()
            .execute(
                "INSERT INTO note_status(note_id, origin, verification, pinned) VALUES (?1, 'imported', 'unverified', ?2)
                 ON CONFLICT(note_id) DO UPDATE SET pinned = excluded.pinned",
                params![note_id.as_str(), i32::from(pinned)],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("update pinned status: {err}")))?;
        Ok(pinned)
    }

    pub fn list_revisions(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
        note_id: &NoteId,
    ) -> Result<Vec<crate::domain::types::RevisionSummaryDto>, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let _ = registry.get_vault(vault_id)?;
        let state = VaultStateStore::open_or_init(paths, vault_id)?;
        let mut stmt = state
            .conn()
            .prepare(
                "SELECT revision_id, operation_id, note_id, old_path, new_path, actor_key, created_at
                 FROM revisions WHERE note_id = ?1 ORDER BY created_at DESC LIMIT 50",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list_revisions: {err}")))?;
        let rows = stmt
            .query_map(params![note_id.as_str()], |r| {
                let rev_s: String = r.get(0)?;
                let op_s: String = r.get(1)?;
                let nid_s: String = r.get(2)?;
                Ok(crate::domain::types::RevisionSummaryDto {
                    revision_id: RevisionId::parse(&rev_s).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    operation_id: OperationId::parse(&op_s).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    note_id: NoteId::parse(&nid_s).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    old_path: r.get(3)?,
                    new_path: r.get(4)?,
                    actor_key: r.get(5)?,
                    created_at: r.get(6)?,
                })
            })
            .map_err(|err| CoreError::StateUnavailable(format!("query list_revisions: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::StateUnavailable(format!("collect list_revisions: {err}")))?;
        Ok(rows)
    }

    pub fn list_trashed_notes(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
    ) -> Result<Vec<crate::domain::types::TrashedNoteSummary>, CoreError> {
        let registry = RegistryStore::open(paths)?;
        let _ = registry.get_vault(vault_id)?;
        let state = VaultStateStore::open_or_init(paths, vault_id)?;
        let mut stmt = state
            .conn()
            .prepare(
                "SELECT note_id, rel_path, last_hash, last_seen_at
                 FROM note_identity WHERE state = 'trashed' ORDER BY last_seen_at DESC",
            )
            .map_err(|err| CoreError::StateUnavailable(format!("prepare list_trashed: {err}")))?;
        let rows = stmt
            .query_map([], |r| {
                let nid_s: String = r.get(0)?;
                Ok(crate::domain::types::TrashedNoteSummary {
                    note_id: NoteId::parse(&nid_s).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?,
                    rel_path: r.get(1)?,
                    last_hash: r.get(2)?,
                    last_seen_at: r.get(3)?,
                })
            })
            .map_err(|err| CoreError::StateUnavailable(format!("query list_trashed: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::StateUnavailable(format!("collect list_trashed: {err}")))?;
        Ok(rows)
    }

    pub fn lookup_note_id_by_path(
        paths: &AppPathsSpec,
        vault_id: &VaultId,
        rel_path: &str,
    ) -> Result<Option<NoteId>, CoreError> {
        let state = VaultStateStore::open_or_init(paths, vault_id)?;
        let pk = path_key(rel_path);
        let raw: Option<String> = state
            .conn()
            .query_row(
                "SELECT note_id FROM note_identity WHERE path_key = ?1 AND state = 'present'",
                params![pk],
                |r| r.get(0),
            )
            .optional()
            .map_err(|err| CoreError::StateUnavailable(format!("lookup note id by path: {err}")))?;
        raw.map(|s| NoteId::parse(&s)).transpose()
    }
}
