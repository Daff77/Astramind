use crate::domain::errors::CoreError;
use crate::domain::ids::{NoteId, VaultId};
use crate::domain::types::{
    BacklinkHit, BrokenLinkDto, GraphEdgeDto, GraphNodeDto, GraphSnapshotDto, Page, SearchFilters,
    SearchHit, VerificationStatus,
};
use crate::index::literal_fts_query;
use crate::index::store::{open_healthy_index_or_rebuild, str_to_link_kind, str_to_resolution};
use crate::paths::AppPathsSpec;
use crate::state::registry::RegistryStore;
use crate::state::vault_state::VaultStateStore;
use crate::vault::paths::{path_key, resolve_guarded_existing_file};
use crate::vault::replace::sha256_hex;
use rusqlite::{params, types::Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::Path;

pub const DEFAULT_SEARCH_LIMIT: usize = 20;
pub const MAX_SEARCH_LIMIT: usize = 50;

/// Executes bounded, deterministic FTS5 + metadata search with live vault-root revalidation
/// and optional folder prefix + tag filters (`PB-014`).
pub fn search_notes(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
    query: &str,
    filters: &SearchFilters,
    limit: Option<usize>,
    cursor: Option<&str>,
) -> Result<Page<SearchHit>, CoreError> {
    let registry = RegistryStore::open(paths)?;
    let vault = registry.get_vault(vault_id)?;
    let vault_root = Path::new(&vault.root_path);
    let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
    let (index_conn, generation) =
        open_healthy_index_or_rebuild(paths, vault_id, vault_root, &mut state)?;

    let bounded_limit = limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let offset = parse_cursor(cursor, generation)?;

    let status_map = load_verification_map(&state)?;
    let literal_query = literal_fts_query(query.trim());

    let mut sql = String::from("SELECT n.note_id, n.rel_path, n.title, n.content_hash, n.body");
    if literal_query.is_empty() {
        sql.push_str(", 0.0 AS rank FROM notes n WHERE 1=1");
    } else {
        sql.push_str(
            ", bm25(note_fts, 4.0, 1.0, 2.0) AS rank
             FROM note_fts f
             JOIN notes n ON n.row_id = f.rowid
             WHERE note_fts MATCH ?1",
        );
    }

    let mut bind_values: Vec<Value> = Vec::new();
    if !literal_query.is_empty() {
        bind_values.push(Value::Text(literal_query));
    }

    if let Some(folder) = &filters.folder_prefix {
        let clean = folder.trim().trim_matches('/');
        if !clean.is_empty() {
            let prefix_key = format!("{}/%", path_key(clean));
            let exact_key = path_key(clean);
            let idx1 = bind_values.len() + 1;
            let idx2 = bind_values.len() + 2;
            sql.push_str(&format!(
                " AND (n.path_key LIKE ?{idx1} OR n.path_key = ?{idx2})"
            ));
            bind_values.push(Value::Text(prefix_key));
            bind_values.push(Value::Text(exact_key));
        }
    }

    if let Some(tag) = &filters.tag {
        let clean_tag = tag.trim().trim_start_matches('#').to_lowercase();
        if !clean_tag.is_empty() {
            let idx = bind_values.len() + 1;
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.note_id AND nt.tag_key = ?{idx})"
            ));
            bind_values.push(Value::Text(clean_tag));
        }
    }

    sql.push_str(" ORDER BY rank ASC, n.note_id ASC");
    let limit_idx = bind_values.len() + 1;
    let offset_idx = bind_values.len() + 2;
    sql.push_str(&format!(" LIMIT ?{limit_idx} OFFSET ?{offset_idx}"));
    bind_values.push(Value::Integer((bounded_limit + 1) as i64));
    bind_values.push(Value::Integer(offset as i64));

    let mut stmt = index_conn
        .prepare(&sql)
        .map_err(|err| CoreError::IoFailed(format!("prepare search_notes: {err}")))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bind_values.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|err| CoreError::IoFailed(format!("execute search_notes: {err}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CoreError::IoFailed(format!("collect search_notes: {err}")))?;

    let has_more = rows.len() > bounded_limit;
    let mut items = Vec::new();
    for (nid_s, rel_path, title, indexed_hash, body) in rows.into_iter().take(bounded_limit) {
        // Revalidate live disk presence and hash before emitting hits.
        let Ok((_, mut file)) = resolve_guarded_existing_file(vault_root, &rel_path) else {
            continue;
        };
        let mut live_bytes = Vec::new();
        if file.read_to_end(&mut live_bytes).is_err() {
            continue;
        }
        let live_hash = sha256_hex(&live_bytes);
        if live_hash != indexed_hash {
            // Skip stale hit rather than returning out-of-date content hash.
            continue;
        }
        let note_id = NoteId::parse(&nid_s)?;
        let verification = status_map
            .get(&note_id)
            .copied()
            .unwrap_or(VerificationStatus::Unverified);
        let snippet = build_snippet(&body, query);
        items.push(SearchHit {
            note_id,
            rel_path,
            title,
            content_hash: live_hash,
            snippet,
            verification,
            index_generation: generation,
        });
    }

    let next_cursor = if has_more {
        Some(format!("{generation}:{}", offset + bounded_limit))
    } else {
        None
    };

    Ok(Page {
        items,
        next_cursor,
        generation,
    })
}

pub fn get_backlinks(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
    target_note_id: &NoteId,
) -> Result<Vec<BacklinkHit>, CoreError> {
    let registry = RegistryStore::open(paths)?;
    let vault = registry.get_vault(vault_id)?;
    let vault_root = Path::new(&vault.root_path);
    let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
    let (index_conn, _) = open_healthy_index_or_rebuild(paths, vault_id, vault_root, &mut state)?;

    let mut stmt = index_conn
        .prepare(
            "SELECT l.source_note_id, n.rel_path, n.title, l.raw_target, l.link_kind, l.line_number
             FROM note_links l
             JOIN notes n ON n.note_id = l.source_note_id
             WHERE l.target_note_id = ?1 AND l.resolution = 'resolved'
             ORDER BY n.rel_path ASC, l.line_number ASC",
        )
        .map_err(|err| CoreError::IoFailed(format!("prepare get_backlinks: {err}")))?;
    let rows = stmt
        .query_map(params![target_note_id.as_str()], |row| {
            let src_s: String = row.get(0)?;
            let kind_s: String = row.get(4)?;
            Ok(BacklinkHit {
                source_note_id: NoteId::parse(&src_s).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                source_rel_path: row.get(1)?,
                source_title: row.get(2)?,
                raw_target: row.get(3)?,
                link_kind: str_to_link_kind(&kind_s),
                line_number: row.get::<_, i64>(5)? as usize,
            })
        })
        .map_err(|err| CoreError::IoFailed(format!("query get_backlinks: {err}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CoreError::IoFailed(format!("collect get_backlinks: {err}")))?;
    Ok(rows)
}

pub fn get_broken_links(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
) -> Result<Vec<BrokenLinkDto>, CoreError> {
    let registry = RegistryStore::open(paths)?;
    let vault = registry.get_vault(vault_id)?;
    let vault_root = Path::new(&vault.root_path);
    let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
    let (index_conn, _) = open_healthy_index_or_rebuild(paths, vault_id, vault_root, &mut state)?;

    let mut stmt = index_conn
        .prepare(
            "SELECT l.source_note_id, n.rel_path, l.raw_target, l.link_kind, l.resolution, l.line_number
             FROM note_links l
             JOIN notes n ON n.note_id = l.source_note_id
             WHERE l.resolution IN ('broken','ambiguous','unsupported')
             ORDER BY n.rel_path ASC, l.line_number ASC",
        )
        .map_err(|err| CoreError::IoFailed(format!("prepare get_broken_links: {err}")))?;
    let rows = stmt
        .query_map([], |row| {
            let src_s: String = row.get(0)?;
            let kind_s: String = row.get(3)?;
            let res_s: String = row.get(4)?;
            Ok(BrokenLinkDto {
                source_note_id: NoteId::parse(&src_s).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?,
                source_rel_path: row.get(1)?,
                raw_target: row.get(2)?,
                link_kind: str_to_link_kind(&kind_s),
                resolution: str_to_resolution(&res_s),
                line_number: row.get::<_, i64>(5)? as usize,
            })
        })
        .map_err(|err| CoreError::IoFailed(format!("query get_broken_links: {err}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CoreError::IoFailed(format!("collect get_broken_links: {err}")))?;
    Ok(rows)
}

pub fn get_graph(paths: &AppPathsSpec, vault_id: &VaultId) -> Result<GraphSnapshotDto, CoreError> {
    let registry = RegistryStore::open(paths)?;
    let vault = registry.get_vault(vault_id)?;
    let vault_root = Path::new(&vault.root_path);
    let mut state = VaultStateStore::open_or_init(paths, vault_id)?;
    let (index_conn, generation) =
        open_healthy_index_or_rebuild(paths, vault_id, vault_root, &mut state)?;
    let status_map = load_verification_map(&state)?;

    let mut tag_map: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut t_stmt = index_conn
            .prepare(
                "SELECT nt.note_id, t.display_name
                 FROM note_tags nt
                 JOIN tags t ON t.tag_key = nt.tag_key
                 ORDER BY t.tag_key ASC",
            )
            .map_err(|err| CoreError::IoFailed(format!("prepare graph tags: {err}")))?;
        let t_rows = t_stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|err| CoreError::IoFailed(format!("query graph tags: {err}")))?;
        for row in t_rows {
            let (nid, tag) =
                row.map_err(|err| CoreError::IoFailed(format!("collect graph tags: {err}")))?;
            tag_map.entry(nid).or_default().push(tag);
        }
    }

    let mut nodes = Vec::new();
    {
        let mut n_stmt = index_conn
            .prepare("SELECT note_id, title, rel_path FROM notes ORDER BY note_id ASC")
            .map_err(|err| CoreError::IoFailed(format!("prepare graph nodes: {err}")))?;
        let n_rows = n_stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|err| CoreError::IoFailed(format!("query graph nodes: {err}")))?;
        for row in n_rows {
            let (nid_s, title, rel_path) =
                row.map_err(|err| CoreError::IoFailed(format!("collect graph nodes: {err}")))?;
            let id = NoteId::parse(&nid_s)?;
            let folder = rel_path
                .split('/')
                .next()
                .filter(|_| rel_path.contains('/'))
                .unwrap_or("")
                .to_string();
            let verification = status_map
                .get(&id)
                .copied()
                .unwrap_or(VerificationStatus::Unverified);
            let tags = tag_map.remove(&nid_s).unwrap_or_default();
            nodes.push(GraphNodeDto {
                id,
                title,
                folder,
                tags,
                verification,
            });
        }
    }

    let mut edge_counts: BTreeMap<(String, String, String), u32> = BTreeMap::new();
    {
        let mut e_stmt = index_conn
            .prepare(
                "SELECT source_note_id, target_note_id, link_kind
                 FROM note_links
                 WHERE resolution = 'resolved' AND target_note_id IS NOT NULL",
            )
            .map_err(|err| CoreError::IoFailed(format!("prepare graph edges: {err}")))?;
        let e_rows = e_stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|err| CoreError::IoFailed(format!("query graph edges: {err}")))?;
        for row in e_rows {
            let (src, dst, kind) =
                row.map_err(|err| CoreError::IoFailed(format!("collect graph edges: {err}")))?;
            *edge_counts.entry((src, dst, kind)).or_insert(0) += 1;
        }
    }

    let mut edges = Vec::with_capacity(edge_counts.len());
    for ((src_s, dst_s, kind), count) in edge_counts {
        edges.push(GraphEdgeDto {
            source: NoteId::parse(&src_s)?,
            target: NoteId::parse(&dst_s)?,
            kind,
            count,
        });
    }

    Ok(GraphSnapshotDto {
        vault_id: vault_id.clone(),
        generation,
        nodes,
        edges,
    })
}

fn load_verification_map(
    state: &VaultStateStore,
) -> Result<HashMap<NoteId, VerificationStatus>, CoreError> {
    let mut map = HashMap::new();
    for row in state.list_all_identities()? {
        map.insert(row.note_id, row.verification);
    }
    Ok(map)
}

fn parse_cursor(cursor: Option<&str>, expected_gen: u64) -> Result<usize, CoreError> {
    let Some(raw) = cursor else {
        return Ok(0);
    };
    let Some((gen_s, off_s)) = raw.split_once(':') else {
        return Err(CoreError::InvalidInput(
            "invalid pagination cursor".to_string(),
        ));
    };
    let gen: u64 = gen_s
        .parse()
        .map_err(|_| CoreError::InvalidInput("invalid cursor generation".to_string()))?;
    if gen != expected_gen {
        return Err(CoreError::Conflict(
            "search index generation changed; restart pagination".to_string(),
        ));
    }
    off_s
        .parse::<usize>()
        .map_err(|_| CoreError::InvalidInput("invalid cursor offset".to_string()))
}

fn build_snippet(body: &str, query: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let q_lower = query.trim().to_lowercase();
    let lower = trimmed.to_lowercase();
    let start_byte = if !q_lower.is_empty() {
        lower
            .find(&q_lower)
            .map(|pos| pos.saturating_sub(40))
            .unwrap_or(0)
    } else {
        0
    };
    // Snap to UTF-8 char boundary
    let mut start = start_byte;
    while start > 0 && !trimmed.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (start + 180).min(trimmed.len());
    while end < trimmed.len() && !trimmed.is_char_boundary(end) {
        end += 1;
    }
    trimmed[start..end].replace(['\r', '\n'], " ")
}
