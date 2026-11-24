use crate::domain::errors::CoreError;
use crate::domain::ids::{NoteId, VaultId};
use crate::domain::types::{
    LinkKind, LinkResolution, NoteOrigin, ParseStatus, ReconcileSummary, ScanDiagnostic,
    VerificationStatus,
};
use crate::index::publish_staged_file_exclusive;
use crate::markdown::{parse_markdown_bytes, LinkResolutionCorpus, ParsedNote};
use crate::paths::AppPathsSpec;
use crate::state::registry::verify_sqlite_integrity;
use crate::state::utc_now_rfc3339;
use crate::state::vault_state::VaultStateStore;
use crate::vault::lock::VaultLock;
use crate::vault::paths::path_key;
use crate::vault::scan::{scan_vault_with_exclusions, ScannedNote, VaultScanResult};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

pub const INDEX_SCHEMA_VERSION: u32 = 1;
pub const PARSER_VERSION: &str = "1";

const INDEX_MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (
  row_id INTEGER PRIMARY KEY,
  note_id TEXT NOT NULL UNIQUE,
  rel_path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mtime_hint TEXT,
  size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
  parse_status TEXT NOT NULL CHECK(parse_status IN ('ok','warning','unsupported')),
  indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (tag_key TEXT PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  tag_key TEXT NOT NULL REFERENCES tags(tag_key),
  PRIMARY KEY(note_id,tag_key)
);
CREATE TABLE IF NOT EXISTS aliases (
  note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  alias_key TEXT NOT NULL,
  display_alias TEXT NOT NULL,
  PRIMARY KEY(note_id,alias_key)
);
CREATE TABLE IF NOT EXISTS note_links (
  link_id INTEGER PRIMARY KEY,
  source_note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  target_note_id TEXT REFERENCES notes(note_id) ON DELETE SET NULL,
  raw_target TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK(link_kind IN ('wiki','markdown','embed')),
  resolution TEXT NOT NULL CHECK(resolution IN ('resolved','broken','ambiguous','attachment','external','unsupported')),
  line_number INTEGER NOT NULL CHECK(line_number>0),
  byte_offset INTEGER NOT NULL CHECK(byte_offset>=0),
  UNIQUE(source_note_id,byte_offset)
);
CREATE TABLE IF NOT EXISTS dirty_paths (path_key TEXT PRIMARY KEY, queued_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attachments (path_key TEXT PRIMARY KEY, rel_path TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(title,body,tags, tokenize='unicode61');
CREATE INDEX IF NOT EXISTS links_source ON note_links(source_note_id);
CREATE INDEX IF NOT EXISTS links_target ON note_links(target_note_id);
CREATE INDEX IF NOT EXISTS tags_lookup ON note_tags(tag_key,note_id);
CREATE INDEX IF NOT EXISTS aliases_lookup ON aliases(alias_key);
"#;

pub struct ReconciledScan {
    pub assigned_notes: Vec<(NoteId, ScannedNote, ParsedNote)>,
    pub attachments: Vec<String>,
    pub removed_count: usize,
    pub diagnostics: Vec<ScanDiagnostic>,
}

/// Non-destructively reconciles scanned vault files with `state.sqlite` `note_identity`,
/// honoring unique valid embedded `personal_brain_id`s, tracking external renames via `file_identity`,
/// isolating duplicate embedded IDs, and marking vanished notes `'missing'`.
pub fn reconcile_state_identities(
    state: &mut VaultStateStore,
    scan: VaultScanResult,
) -> Result<ReconciledScan, CoreError> {
    let existing_rows = state.list_all_identities()?;
    let mut by_path_key: HashMap<String, (NoteId, String, Option<String>)> = HashMap::new();
    let mut by_file_id: HashMap<String, Vec<NoteId>> = HashMap::new();
    let mut known_ids: HashSet<NoteId> = HashSet::new();
    let mut present_ids: HashSet<NoteId> = HashSet::new();

    for row in &existing_rows {
        known_ids.insert(row.note_id.clone());
        by_path_key.insert(
            row.path_key.clone(),
            (
                row.note_id.clone(),
                row.state.clone(),
                row.file_identity.clone(),
            ),
        );
        if row.state == "present" {
            present_ids.insert(row.note_id.clone());
            if let Some(fid) = &row.file_identity {
                by_file_id
                    .entry(fid.clone())
                    .or_default()
                    .push(row.note_id.clone());
            }
        }
    }

    let mut diagnostics = scan.diagnostics;
    let mut parsed_notes: Vec<(ScannedNote, ParsedNote)> = Vec::with_capacity(scan.notes.len());
    let mut seen_embedded_ids: HashMap<NoteId, usize> = HashMap::new();

    for note in scan.notes {
        let parsed = parse_markdown_bytes(&note.rel_path, &note.bytes);
        if let Some(id) = &parsed.embedded_id {
            *seen_embedded_ids.entry(id.clone()).or_insert(0) += 1;
        }
        for d in &parsed.diagnostics {
            diagnostics.push(ScanDiagnostic {
                rel_path: note.rel_path.clone(),
                kind: "parse_warning".to_string(),
                message: d.clone(),
            });
        }
        parsed_notes.push((note, parsed));
    }

    let duplicate_embedded: HashSet<NoteId> = seen_embedded_ids
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(id, _)| id)
        .collect();

    let scanned_path_keys: HashSet<String> = parsed_notes
        .iter()
        .map(|(n, _)| path_key(&n.rel_path))
        .collect();

    // Detect vanished notes so their `file_identity` can match external renames unambiguously.
    let mut vanished_by_file_id: HashMap<String, NoteId> = HashMap::new();
    for row in &existing_rows {
        if row.state == "present" && !scanned_path_keys.contains(&row.path_key) {
            if let Some(fid) = &row.file_identity {
                if by_file_id.get(fid).map(Vec::len).unwrap_or(0) == 1 {
                    vanished_by_file_id.insert(fid.clone(), row.note_id.clone());
                }
            }
        }
    }

    let now = utc_now_rfc3339();
    let mut assigned_notes = Vec::with_capacity(parsed_notes.len());
    let mut claimed_ids: HashSet<NoteId> = HashSet::new();

    // Perform identity reconciliation inside a single state transaction.
    let tx = state
        .conn()
        .unchecked_transaction()
        .map_err(|err| CoreError::StateUnavailable(format!("begin state reconcile tx: {err}")))?;

    for (note, parsed) in parsed_notes {
        let pk = path_key(&note.rel_path);
        let note_id = if let Some((existing_id, _, _)) = by_path_key.get(&pk) {
            if let Some(emb) = &parsed.embedded_id {
                if duplicate_embedded.contains(emb) {
                    diagnostics.push(ScanDiagnostic {
                        rel_path: note.rel_path.clone(),
                        kind: "duplicate_note_id".to_string(),
                        message: format!(
                            "duplicate personal_brain_id {} detected; retaining isolated state ID {}",
                            emb.as_str(),
                            existing_id.as_str()
                        ),
                    });
                }
            }
            existing_id.clone()
        } else if let Some(renamed_id) = vanished_by_file_id.remove(&note.file_identity) {
            renamed_id
        } else if let Some(emb) = &parsed.embedded_id {
            if duplicate_embedded.contains(emb)
                || claimed_ids.contains(emb)
                || present_ids.contains(emb)
            {
                let isolated = NoteId::new_v4();
                diagnostics.push(ScanDiagnostic {
                    rel_path: note.rel_path.clone(),
                    kind: "duplicate_note_id".to_string(),
                    message: format!(
                        "duplicate personal_brain_id {} isolated to {}",
                        emb.as_str(),
                        isolated.as_str()
                    ),
                });
                isolated
            } else {
                emb.clone()
            }
        } else {
            NoteId::new_v4()
        };

        claimed_ids.insert(note_id.clone());

        let existed_in_state = known_ids.contains(&note_id);
        if existed_in_state {
            tx.execute(
                "UPDATE note_identity
                 SET rel_path = ?1, path_key = ?2, file_identity = ?3, last_hash = ?4, state = 'present', last_seen_at = ?5
                 WHERE note_id = ?6",
                params![
                    note.rel_path,
                    pk,
                    note.file_identity,
                    note.sha256,
                    now,
                    note_id.as_str()
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("update note_identity: {err}")))?;
        } else {
            tx.execute(
                "INSERT INTO note_identity(note_id, rel_path, path_key, file_identity, last_hash, state, first_seen_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'present', ?6, ?6)",
                params![
                    note_id.as_str(),
                    note.rel_path,
                    pk,
                    note.file_identity,
                    note.sha256,
                    now
                ],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert note_identity: {err}")))?;
            tx.execute(
                "INSERT OR IGNORE INTO note_status(note_id, origin, verification, pinned)
                 VALUES (?1, 'imported', 'unverified', 0)",
                params![note_id.as_str()],
            )
            .map_err(|err| CoreError::StateUnavailable(format!("insert note_status: {err}")))?;
        }

        assigned_notes.push((note_id, note, parsed));
    }

    let mut removed_count = 0usize;
    for row in &existing_rows {
        if row.state == "present" && !claimed_ids.contains(&row.note_id) {
            tx.execute(
                "UPDATE note_identity SET state = 'missing', last_seen_at = ?1 WHERE note_id = ?2",
                params![now, row.note_id.as_str()],
            )
            .map_err(|err| {
                CoreError::StateUnavailable(format!("mark missing note_identity: {err}"))
            })?;
            removed_count += 1;
        }
    }

    tx.commit()
        .map_err(|err| CoreError::StateUnavailable(format!("commit state reconcile: {err}")))?;

    Ok(ReconciledScan {
        assigned_notes,
        attachments: scan.attachments,
        removed_count,
        diagnostics,
    })
}

/// Performs a full guarded scan + state identity reconciliation + temp-staged generation-named
/// `index-<next_gen>.sqlite` rebuild (`ADR-0005` `SC-14`). Never overwrites an existing generation.
pub fn rebuild_generation_index(
    vault_id: &VaultId,
    vault_root: &Path,
    state: &mut VaultStateStore,
) -> Result<(ReconcileSummary, usize, usize, usize), CoreError> {
    let exclusions = state.get_exclusion_patterns()?;
    let scan = scan_vault_with_exclusions(vault_root, &exclusions)?;
    let attachments_count = scan.attachments.len();
    let reconciled = reconcile_state_identities(state, scan)?;

    let current_gen = state.active_index_generation()?;
    let mut next_gen = current_gen + 1;
    while AppPathsSpec::index_file_in(state.vault_dir(), next_gen).exists() {
        next_gen += 1;
    }

    let corpus_items: Vec<_> = reconciled
        .assigned_notes
        .iter()
        .map(|(id, note, parsed)| (id.clone(), note.rel_path.clone(), parsed.aliases.clone()))
        .collect();
    let corpus = LinkResolutionCorpus::build(&corpus_items, &reconciled.attachments);

    let target_path = AppPathsSpec::index_file_in(state.vault_dir(), next_gen);
    let temp_path = state
        .vault_dir()
        .join(format!("index-{next_gen}.sqlite.tmp-{}", Uuid::new_v4()));

    let mut broken_links_count = 0usize;
    let mut ambiguous_links_count = 0usize;
    let now = utc_now_rfc3339();

    let build_res = (|| -> Result<(), CoreError> {
        let mut conn = Connection::open(&temp_path)
            .map_err(|err| CoreError::IoFailed(format!("open staged index: {err}")))?;
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )
        .map_err(|err| CoreError::IoFailed(format!("configure staged index: {err}")))?;
        conn.execute_batch(INDEX_MIGRATION_V1)
            .map_err(|err| CoreError::IoFailed(format!("migrate staged index: {err}")))?;
        conn.execute_batch(&format!("PRAGMA user_version = {INDEX_SCHEMA_VERSION};"))
            .map_err(|err| CoreError::IoFailed(format!("set index user_version: {err}")))?;

        let tx = conn
            .transaction()
            .map_err(|err| CoreError::IoFailed(format!("begin index build tx: {err}")))?;

        tx.execute(
            "INSERT INTO index_meta(key, value) VALUES ('vault_id', ?1), ('generation', ?2), ('parser_version', ?3), ('last_reconcile', ?4)",
            params![vault_id.as_str(), next_gen.to_string(), PARSER_VERSION, now],
        )
        .map_err(|err| CoreError::IoFailed(format!("write index_meta: {err}")))?;

        for att_rel in &reconciled.attachments {
            tx.execute(
                "INSERT OR IGNORE INTO attachments(path_key, rel_path) VALUES (?1, ?2)",
                params![path_key(att_rel), att_rel],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert index attachment: {err}")))?;
        }

        for (note_id, note, parsed) in &reconciled.assigned_notes {
            let pk = path_key(&note.rel_path);
            let tags_joined = parsed
                .tags
                .iter()
                .map(|t| t.display.as_str())
                .collect::<Vec<_>>()
                .join(" ");

            tx.execute(
                "INSERT INTO notes(note_id, rel_path, path_key, title, body, content_hash, mtime_hint, size_bytes, parse_status, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)",
                params![
                    note_id.as_str(),
                    note.rel_path,
                    pk,
                    parsed.title,
                    parsed.body_plain,
                    note.sha256,
                    note.size_bytes as i64,
                    parse_status_str(parsed.parse_status),
                    now
                ],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert index note: {err}")))?;
            let row_id = tx.last_insert_rowid();

            tx.execute(
                "INSERT INTO note_fts(rowid, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
                params![row_id, parsed.title, parsed.body_plain, tags_joined],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert note_fts: {err}")))?;

            for tag in &parsed.tags {
                tx.execute(
                    "INSERT OR IGNORE INTO tags(tag_key, display_name) VALUES (?1, ?2)",
                    params![tag.key, tag.display],
                )
                .map_err(|err| CoreError::IoFailed(format!("insert tag: {err}")))?;
                tx.execute(
                    "INSERT OR IGNORE INTO note_tags(note_id, tag_key) VALUES (?1, ?2)",
                    params![note_id.as_str(), tag.key],
                )
                .map_err(|err| CoreError::IoFailed(format!("insert note_tag: {err}")))?;
            }

            for alias in &parsed.aliases {
                tx.execute(
                    "INSERT OR IGNORE INTO aliases(note_id, alias_key, display_alias) VALUES (?1, ?2, ?3)",
                    params![note_id.as_str(), alias.key, alias.display],
                )
                .map_err(|err| CoreError::IoFailed(format!("insert alias: {err}")))?;
            }
        }

        // Second pass: insert resolved/broken links after all `notes` rows exist for FK integrity.
        for (note_id, note, parsed) in &reconciled.assigned_notes {
            let resolved = corpus.resolve_note_links(note_id, &note.rel_path, &parsed.links);
            for link in resolved {
                match link.resolution {
                    LinkResolution::Broken => broken_links_count += 1,
                    LinkResolution::Ambiguous => ambiguous_links_count += 1,
                    _ => {}
                }
                tx.execute(
                    "INSERT INTO note_links(source_note_id, target_note_id, raw_target, link_kind, resolution, line_number, byte_offset)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        link.source_note_id.as_str(),
                        link.target_note_id.as_ref().map(NoteId::as_str),
                        link.raw_target,
                        link_kind_str(link.kind),
                        resolution_str(link.resolution),
                        link.line_number as i64,
                        link.byte_offset as i64
                    ],
                )
                .map_err(|err| CoreError::IoFailed(format!("insert note_link: {err}")))?;
            }
        }

        tx.commit()
            .map_err(|err| CoreError::IoFailed(format!("commit staged index: {err}")))?;
        Ok(())
    })();

    if let Err(err) = build_res {
        let _ = std::fs::remove_file(&temp_path);
        return Err(err);
    }

    publish_staged_file_exclusive(&temp_path, &target_path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp_path);
    })?;
    state.set_active_index_generation(next_gen)?;
    cleanup_old_index_generations(state.vault_dir(), next_gen);

    Ok((
        ReconcileSummary {
            index_generation: next_gen,
            indexed_notes: reconciled.assigned_notes.len(),
            removed_notes: reconciled.removed_count,
            diagnostics: reconciled.diagnostics,
        },
        attachments_count,
        broken_links_count,
        ambiguous_links_count,
    ))
}

/// Opens the active derived index read-only, automatically rebuilding from Markdown + `state.sqlite`
/// under `VaultLock` if missing or corrupted (`AC-014`, `NFR-003`), without touching `state.sqlite`.
pub fn open_healthy_index_or_rebuild(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
    vault_root: &Path,
    state: &mut VaultStateStore,
) -> Result<(Connection, u64), CoreError> {
    if let Some((conn, gen)) = try_open_readonly_healthy(state)? {
        return Ok((conn, gen));
    }

    let _lock = VaultLock::acquire(&paths.vault_lock_file(vault_id), Duration::from_secs(5))?;
    // Re-read state inside the lock in case another process just completed a rebuild.
    let mut locked_state = VaultStateStore::open_or_init(paths, vault_id)?;
    if let Some((conn, gen)) = try_open_readonly_healthy(&locked_state)? {
        return Ok((conn, gen));
    }

    let (summary, _, _, _) = rebuild_generation_index(vault_id, vault_root, &mut locked_state)?;
    let new_path = AppPathsSpec::index_file_in(locked_state.vault_dir(), summary.index_generation);
    let conn = open_readonly_with_timeout(&new_path)?;
    Ok((conn, summary.index_generation))
}

fn try_open_readonly_healthy(
    state: &VaultStateStore,
) -> Result<Option<(Connection, u64)>, CoreError> {
    let gen = state.active_index_generation()?;
    if gen == 0 {
        return Ok(None);
    }
    let idx_path = AppPathsSpec::index_file_in(state.vault_dir(), gen);
    if !idx_path.exists() {
        return Ok(None);
    }
    let Ok(conn) = open_readonly_with_timeout(&idx_path) else {
        return Ok(None);
    };
    if verify_sqlite_integrity(&conn, "index.sqlite").is_ok() {
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if version == INDEX_SCHEMA_VERSION {
            return Ok(Some((conn, gen)));
        }
    }
    Ok(None)
}

fn open_readonly_with_timeout(path: &Path) -> Result<Connection, CoreError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| CoreError::IoFailed(format!("open readonly index: {err}")))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|err| CoreError::IoFailed(format!("configure index busy_timeout: {err}")))?;
    Ok(conn)
}

/// Incrementally updates or removes a single note in the active index and recomputes affected
/// `note_links` resolutions in one transaction (`SC-07`), bumping `index_meta.generation` hint.
/// Callers must hold `VaultLock`.
pub fn incremental_sync_note(
    vault_id: &VaultId,
    vault_root: &Path,
    state: &mut VaultStateStore,
    note_id: &NoteId,
    rel_path: Option<&str>,
    bytes: Option<&[u8]>,
    sha256: Option<&str>,
) -> Result<u64, CoreError> {
    let gen = if try_open_readonly_healthy(state)?.is_some() {
        state.active_index_generation()?
    } else {
        let (summary, _, _, _) = rebuild_generation_index(vault_id, vault_root, state)?;
        summary.index_generation
    };
    let idx_path = AppPathsSpec::index_file_in(state.vault_dir(), gen);
    let mut conn = Connection::open(&idx_path)
        .map_err(|err| CoreError::IoFailed(format!("open index for incremental sync: {err}")))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|err| CoreError::IoFailed(format!("configure index busy_timeout: {err}")))?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|err| CoreError::IoFailed(format!("enable index foreign_keys: {err}")))?;
    let now = utc_now_rfc3339();

    let tx = conn
        .transaction()
        .map_err(|err| CoreError::IoFailed(format!("begin incremental index tx: {err}")))?;

    if let (Some(path), Some(raw), Some(hash)) = (rel_path, bytes, sha256) {
        let parsed = parse_markdown_bytes(path, raw);
        let pk = path_key(path);
        let tags_joined = parsed
            .tags
            .iter()
            .map(|t| t.display.as_str())
            .collect::<Vec<_>>()
            .join(" ");

        let existing_rowid: Option<i64> = tx
            .query_row(
                "SELECT row_id FROM notes WHERE note_id = ?1",
                params![note_id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| CoreError::IoFailed(format!("lookup note row_id: {err}")))?;

        let row_id = if let Some(rid) = existing_rowid {
            tx.execute(
                "UPDATE notes SET rel_path = ?1, path_key = ?2, title = ?3, body = ?4, content_hash = ?5, size_bytes = ?6, parse_status = ?7, indexed_at = ?8
                 WHERE row_id = ?9",
                params![
                    path,
                    pk,
                    parsed.title,
                    parsed.body_plain,
                    hash,
                    raw.len() as i64,
                    parse_status_str(parsed.parse_status),
                    now,
                    rid
                ],
            )
            .map_err(|err| CoreError::IoFailed(format!("update index note: {err}")))?;
            tx.execute("DELETE FROM note_fts WHERE rowid = ?1", params![rid])
                .map_err(|err| CoreError::IoFailed(format!("delete old fts row: {err}")))?;
            tx.execute(
                "DELETE FROM note_tags WHERE note_id = ?1",
                params![note_id.as_str()],
            )
            .map_err(|err| CoreError::IoFailed(format!("clear note_tags: {err}")))?;
            tx.execute(
                "DELETE FROM aliases WHERE note_id = ?1",
                params![note_id.as_str()],
            )
            .map_err(|err| CoreError::IoFailed(format!("clear aliases: {err}")))?;
            tx.execute(
                "DELETE FROM note_links WHERE source_note_id = ?1",
                params![note_id.as_str()],
            )
            .map_err(|err| CoreError::IoFailed(format!("clear note_links: {err}")))?;
            rid
        } else {
            tx.execute(
                "INSERT INTO notes(note_id, rel_path, path_key, title, body, content_hash, mtime_hint, size_bytes, parse_status, indexed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9)",
                params![
                    note_id.as_str(),
                    path,
                    pk,
                    parsed.title,
                    parsed.body_plain,
                    hash,
                    raw.len() as i64,
                    parse_status_str(parsed.parse_status),
                    now
                ],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert incremental note: {err}")))?;
            tx.last_insert_rowid()
        };

        tx.execute(
            "INSERT INTO note_fts(rowid, title, body, tags) VALUES (?1, ?2, ?3, ?4)",
            params![row_id, parsed.title, parsed.body_plain, tags_joined],
        )
        .map_err(|err| CoreError::IoFailed(format!("insert fts row: {err}")))?;

        for tag in &parsed.tags {
            tx.execute(
                "INSERT OR IGNORE INTO tags(tag_key, display_name) VALUES (?1, ?2)",
                params![tag.key, tag.display],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert tag: {err}")))?;
            tx.execute(
                "INSERT OR IGNORE INTO note_tags(note_id, tag_key) VALUES (?1, ?2)",
                params![note_id.as_str(), tag.key],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert note_tag: {err}")))?;
        }
        for alias in &parsed.aliases {
            tx.execute(
                "INSERT OR IGNORE INTO aliases(note_id, alias_key, display_alias) VALUES (?1, ?2, ?3)",
                params![note_id.as_str(), alias.key, alias.display],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert alias: {err}")))?;
        }
        for link in &parsed.links {
            tx.execute(
                "INSERT INTO note_links(source_note_id, target_note_id, raw_target, link_kind, resolution, line_number, byte_offset)
                 VALUES (?1, NULL, ?2, ?3, 'broken', ?4, ?5)",
                params![
                    note_id.as_str(),
                    link.raw_target,
                    link_kind_str(link.kind),
                    link.line_number as i64,
                    link.byte_offset as i64
                ],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert placeholder link: {err}")))?;
        }
    } else {
        // Note deleted/trashed: remove from FTS + notes, and mark any incoming links broken (`SC-07`)
        if let Some(rid) = tx
            .query_row(
                "SELECT row_id FROM notes WHERE note_id = ?1",
                params![note_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|err| CoreError::IoFailed(format!("lookup deleted note row_id: {err}")))?
        {
            tx.execute("DELETE FROM note_fts WHERE rowid = ?1", params![rid])
                .map_err(|err| CoreError::IoFailed(format!("delete note_fts: {err}")))?;
            tx.execute(
                "UPDATE note_links SET target_note_id = NULL, resolution = 'broken' WHERE target_note_id = ?1",
                params![note_id.as_str()],
            )
            .map_err(|err| CoreError::IoFailed(format!("recompute broken incoming links: {err}")))?;
            tx.execute("DELETE FROM notes WHERE row_id = ?1", params![rid])
                .map_err(|err| CoreError::IoFailed(format!("delete index note: {err}")))?;
        }
    }

    // Recompute link resolutions across current index notes so backlinks & broken links stay exact (`SC-07`).
    recompute_all_links_in_tx(&tx)?;
    tx.execute(
        "INSERT INTO index_meta(key, value) VALUES ('last_reconcile', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![now],
    )
    .map_err(|err| CoreError::IoFailed(format!("update last_reconcile: {err}")))?;

    tx.commit()
        .map_err(|err| CoreError::IoFailed(format!("commit incremental sync: {err}")))?;
    Ok(gen)
}

fn recompute_all_links_in_tx(tx: &rusqlite::Transaction<'_>) -> Result<(), CoreError> {
    use crate::markdown::{ExtractedLink, ParsedAlias};

    let mut notes_vec: Vec<(NoteId, String, Vec<ParsedAlias>)> = Vec::new();
    {
        let mut stmt = tx
            .prepare("SELECT note_id, rel_path FROM notes ORDER BY rel_path")
            .map_err(|err| CoreError::IoFailed(format!("prepare notes for relink: {err}")))?;
        let note_rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|err| CoreError::IoFailed(format!("query notes for relink: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::IoFailed(format!("collect notes for relink: {err}")))?;

        let mut alias_stmt = tx
            .prepare("SELECT alias_key, display_alias FROM aliases WHERE note_id = ?1")
            .map_err(|err| CoreError::IoFailed(format!("prepare aliases for relink: {err}")))?;
        for (nid_s, rel_path) in note_rows {
            let nid = NoteId::parse(&nid_s)?;
            let aliases = alias_stmt
                .query_map(params![nid_s], |r| {
                    Ok(ParsedAlias {
                        key: r.get(0)?,
                        display: r.get(1)?,
                    })
                })
                .map_err(|err| CoreError::IoFailed(format!("query aliases: {err}")))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| CoreError::IoFailed(format!("collect aliases: {err}")))?;
            notes_vec.push((nid, rel_path, aliases));
        }
    }

    let attachments: Vec<String> = {
        let mut att_stmt = tx
            .prepare("SELECT rel_path FROM attachments ORDER BY path_key")
            .map_err(|err| CoreError::IoFailed(format!("prepare attachments for relink: {err}")))?;
        let rows = att_stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|err| CoreError::IoFailed(format!("query attachments for relink: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::IoFailed(format!("collect attachments for relink: {err}")))?;
        rows
    };

    let path_by_id: HashMap<String, String> = notes_vec
        .iter()
        .map(|(id, path, _)| (id.as_str().to_string(), path.clone()))
        .collect();
    let corpus = LinkResolutionCorpus::build(&notes_vec, &attachments);

    let existing_links: Vec<(i64, String, String, String, usize, usize)> = {
        let mut stmt = tx
            .prepare("SELECT link_id, source_note_id, raw_target, link_kind, line_number, byte_offset FROM note_links")
            .map_err(|err| CoreError::IoFailed(format!("prepare relink scan: {err}")))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)? as usize,
                    r.get::<_, i64>(5)? as usize,
                ))
            })
            .map_err(|err| CoreError::IoFailed(format!("query relink scan: {err}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| CoreError::IoFailed(format!("collect relink scan: {err}")))?;
        rows
    };

    for (link_id, src_id_s, raw_target, kind_s, line_number, byte_offset) in existing_links {
        let Some(src_path) = path_by_id.get(&src_id_s) else {
            continue;
        };
        let src_id = NoteId::parse(&src_id_s)?;
        let kind = str_to_link_kind(&kind_s);
        let extracted = [ExtractedLink {
            raw_target,
            display_text: None,
            kind,
            line_number,
            byte_offset,
        }];
        let resolved = corpus.resolve_note_links(&src_id, src_path, &extracted);
        if let Some(first) = resolved.first() {
            tx.execute(
                "UPDATE note_links SET target_note_id = ?1, resolution = ?2 WHERE link_id = ?3",
                params![
                    first.target_note_id.as_ref().map(NoteId::as_str),
                    resolution_str(first.resolution),
                    link_id
                ],
            )
            .map_err(|err| CoreError::IoFailed(format!("update resolved link: {err}")))?;
        }
    }
    Ok(())
}

fn cleanup_old_index_generations(vault_dir: &Path, keep_gen: u64) {
    let Ok(entries) = std::fs::read_dir(vault_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(rest) = name.strip_prefix("index-") {
            if let Some(num_str) = rest.strip_suffix(".sqlite") {
                if let Ok(gen) = num_str.parse::<u64>() {
                    if gen < keep_gen {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
}

pub(crate) fn parse_status_str(s: ParseStatus) -> &'static str {
    match s {
        ParseStatus::Ok => "ok",
        ParseStatus::Warning => "warning",
        ParseStatus::Unsupported => "unsupported",
    }
}

pub(crate) fn str_to_parse_status(s: &str) -> ParseStatus {
    match s {
        "warning" => ParseStatus::Warning,
        "unsupported" => ParseStatus::Unsupported,
        _ => ParseStatus::Ok,
    }
}

pub(crate) fn link_kind_str(k: LinkKind) -> &'static str {
    match k {
        LinkKind::Wiki => "wiki",
        LinkKind::Markdown => "markdown",
        LinkKind::Embed => "embed",
    }
}

pub(crate) fn str_to_link_kind(s: &str) -> LinkKind {
    match s {
        "markdown" => LinkKind::Markdown,
        "embed" => LinkKind::Embed,
        _ => LinkKind::Wiki,
    }
}

pub(crate) fn resolution_str(r: LinkResolution) -> &'static str {
    match r {
        LinkResolution::Resolved => "resolved",
        LinkResolution::Broken => "broken",
        LinkResolution::Ambiguous => "ambiguous",
        LinkResolution::Attachment => "attachment",
        LinkResolution::External => "external",
        LinkResolution::Unsupported => "unsupported",
    }
}

pub(crate) fn str_to_resolution(s: &str) -> LinkResolution {
    match s {
        "resolved" => LinkResolution::Resolved,
        "ambiguous" => LinkResolution::Ambiguous,
        "attachment" => LinkResolution::Attachment,
        "external" => LinkResolution::External,
        "unsupported" => LinkResolution::Unsupported,
        _ => LinkResolution::Broken,
    }
}

#[allow(dead_code)]
pub(crate) fn _index_origin_helper(origin: NoteOrigin) -> &'static str {
    match origin {
        NoteOrigin::Imported => "imported",
        NoteOrigin::UserCreated => "user_created",
        NoteOrigin::AiProposal => "ai_proposal",
    }
}

#[allow(dead_code)]
pub(crate) fn _index_ver_helper(v: VerificationStatus) -> &'static str {
    match v {
        VerificationStatus::Unverified => "unverified",
        VerificationStatus::UserVerified => "user_verified",
        VerificationStatus::Outdated => "outdated",
        VerificationStatus::Superseded => "superseded",
    }
}
