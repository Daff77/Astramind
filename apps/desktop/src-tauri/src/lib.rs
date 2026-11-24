use brain_core::backup::{create_backup, export_vault, restore_backup};
use brain_core::domain::errors::ErrorEnvelope;
use brain_core::domain::ids::{NoteId, RevisionId, VaultId};
use brain_core::domain::types::{
    ActorContext, AppHealthDto, BacklinkHit, BackupResult, BrokenLinkDto, GraphSnapshotDto,
    MovePlan, MutationResult, NoteSnapshot, NoteSummary, Page, ReconcileSummary, RestoreResult,
    SearchFilters, SearchHit, VaultOpenReport, VaultSummary,
};
use brain_core::health_check;
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::{get_backlinks, get_broken_links, get_graph, search_notes};
use brain_core::vault::engine::VaultEngine;
use std::path::Path;

fn resolve_paths() -> Result<AppPathsSpec, ErrorEnvelope> {
    AppPathsSpec::resolve_default().map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn app_health() -> Result<AppHealthDto, ErrorEnvelope> {
    health_check().map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn list_vaults() -> Result<Vec<VaultSummary>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    VaultEngine::list_vaults(&paths).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn create_vault(
    selected_root: String,
    display_name: Option<String>,
) -> Result<VaultOpenReport, ErrorEnvelope> {
    let paths = resolve_paths()?;
    VaultEngine::create_vault(&paths, Path::new(&selected_root), display_name.as_deref())
        .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn open_vault(selected_root: String) -> Result<VaultOpenReport, ErrorEnvelope> {
    let paths = resolve_paths()?;
    VaultEngine::open_vault(&paths, Path::new(&selected_root))
        .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn list_notes(vault_id: VaultId) -> Result<Vec<NoteSummary>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    VaultEngine::list_notes(&paths, &vault_id).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn read_note(vault_id: VaultId, note_id: NoteId) -> Result<NoteSnapshot, ErrorEnvelope> {
    let paths = resolve_paths()?;
    VaultEngine::read_note(&paths, &vault_id, &note_id).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn create_note(
    vault_id: VaultId,
    rel_path: String,
    body: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let actor = ActorContext::desktop("local-user");
    VaultEngine::create_note(&paths, &actor, &vault_id, &rel_path, &body, &request_id)
        .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn save_note(
    vault_id: VaultId,
    note_id: NoteId,
    expected_hash: String,
    body: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let actor = ActorContext::desktop("local-user");
    VaultEngine::save_note(
        &paths,
        &actor,
        &vault_id,
        &note_id,
        &expected_hash,
        &body,
        &request_id,
    )
    .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn preview_move(
    vault_id: VaultId,
    note_id: NoteId,
    destination: String,
) -> Result<MovePlan, ErrorEnvelope> {
    let paths = resolve_paths()?;
    VaultEngine::preview_move(&paths, &vault_id, &note_id, &destination)
        .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn move_note(
    plan: MovePlan,
    expected_hash: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let actor = ActorContext::desktop("local-user");
    VaultEngine::move_note(&paths, &actor, &plan, &expected_hash, &request_id)
        .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn trash_note(
    vault_id: VaultId,
    note_id: NoteId,
    expected_hash: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let actor = ActorContext::desktop("local-user");
    VaultEngine::trash_note(
        &paths,
        &actor,
        &vault_id,
        &note_id,
        &expected_hash,
        &request_id,
    )
    .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn restore_trashed_note(
    vault_id: VaultId,
    note_id: NoteId,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let actor = ActorContext::desktop("local-user");
    VaultEngine::restore_trashed_note(&paths, &actor, &vault_id, &note_id, &request_id)
        .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn restore_revision(
    vault_id: VaultId,
    revision_id: RevisionId,
    expected_current_hash: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let actor = ActorContext::desktop("local-user");
    VaultEngine::restore_revision(
        &paths,
        &actor,
        &vault_id,
        &revision_id,
        &expected_current_hash,
        &request_id,
    )
    .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn search_vault_notes(
    vault_id: VaultId,
    query: String,
    filters: SearchFilters,
    limit: Option<usize>,
    cursor: Option<String>,
) -> Result<Page<SearchHit>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    search_notes(
        &paths,
        &vault_id,
        &query,
        &filters,
        limit,
        cursor.as_deref(),
    )
    .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn get_note_backlinks(
    vault_id: VaultId,
    note_id: NoteId,
) -> Result<Vec<BacklinkHit>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    get_backlinks(&paths, &vault_id, &note_id).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn get_vault_broken_links(vault_id: VaultId) -> Result<Vec<BrokenLinkDto>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    get_broken_links(&paths, &vault_id).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn get_vault_graph(vault_id: VaultId) -> Result<GraphSnapshotDto, ErrorEnvelope> {
    let paths = resolve_paths()?;
    get_graph(&paths, &vault_id).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn rebuild_vault_index(vault_id: VaultId) -> Result<ReconcileSummary, ErrorEnvelope> {
    let paths = resolve_paths()?;
    VaultEngine::rebuild_index(&paths, &vault_id).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn create_vault_backup(
    vault_id: VaultId,
    destination: String,
) -> Result<BackupResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    create_backup(&paths, &vault_id, Path::new(&destination)).map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn restore_vault_backup(
    backup_dir: String,
    destination: String,
) -> Result<RestoreResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    restore_backup(&paths, Path::new(&backup_dir), Path::new(&destination))
        .map_err(|err| err.into_envelope(None))
}

#[tauri::command]
fn export_vault_files(vault_id: VaultId, destination: String) -> Result<usize, ErrorEnvelope> {
    let paths = resolve_paths()?;
    export_vault(&paths, &vault_id, Path::new(&destination)).map_err(|err| err.into_envelope(None))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            app_health,
            list_vaults,
            create_vault,
            open_vault,
            list_notes,
            read_note,
            create_note,
            save_note,
            preview_move,
            move_note,
            trash_note,
            restore_trashed_note,
            restore_revision,
            search_vault_notes,
            get_note_backlinks,
            get_vault_broken_links,
            get_vault_graph,
            rebuild_vault_index,
            create_vault_backup,
            restore_vault_backup,
            export_vault_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running Personal Brain desktop application");
}
