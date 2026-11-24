use brain_core::backup::{create_backup, export_vault, restore_backup};
use brain_core::domain::errors::{CoreError, ErrorEnvelope};
use brain_core::domain::ids::{NoteId, RevisionId, VaultId};
use brain_core::domain::types::{
    ActorContext, AppHealthDto, BacklinkHit, BackupResult, BrokenLinkDto, EditorDraftDto,
    GraphSnapshotDto, MovePlan, MutationResult, NoteSnapshot, NoteSummary, Page, ReconcileSummary,
    RestoreResult, RevisionSummaryDto, SearchFilters, SearchHit, TrashedNoteSummary,
    VaultOpenReport, VaultSummary,
};
use brain_core::health_check;
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::{get_backlinks, get_broken_links, get_graph, search_notes};
use brain_core::vault::engine::VaultEngine;
use brain_core::vault::watcher::VaultWatcher;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct DesktopRuntimeState {
    active_watcher: Mutex<Option<(VaultId, VaultWatcher)>>,
    watcher_epoch: Arc<AtomicU64>,
}

impl Default for DesktopRuntimeState {
    fn default() -> Self {
        Self {
            active_watcher: Mutex::new(None),
            watcher_epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl DesktopRuntimeState {
    fn activate_watcher(
        &self,
        app: &AppHandle,
        paths: &AppPathsSpec,
        vault_id: &VaultId,
        vault_root: PathBuf,
    ) {
        let mut guard = match self.active_watcher.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some((current_id, _)) = guard.as_ref() {
            if current_id == vault_id {
                return;
            }
        }
        // Advance epoch immediately so stale callbacks from the prior vault are dropped (`REM-047`).
        let epoch = self.watcher_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some((_, old)) = guard.take() {
            tauri::async_runtime::spawn_blocking(move || {
                old.stop();
            });
        }
        let app_handle = app.clone();
        let epoch_ref = Arc::clone(&self.watcher_epoch);
        let cb = Arc::new(move |ev| {
            if epoch_ref.load(Ordering::SeqCst) == epoch {
                let _ = app_handle.emit("vault:reconciled", ev);
            }
        });
        if let Ok(watcher) = VaultWatcher::start_with_callback(
            paths.clone(),
            vault_id.clone(),
            vault_root,
            Duration::from_millis(250),
            Some(cb),
        ) {
            *guard = Some((vault_id.clone(), watcher));
        }
    }

    fn record_self_write(&self, vault_id: &VaultId, rel_path: &str, content_hash: &str) {
        if let Ok(guard) = self.active_watcher.lock() {
            if let Some((active_id, watcher)) = guard.as_ref() {
                if active_id == vault_id {
                    watcher.record_self_write(rel_path, content_hash);
                }
            }
        }
    }

    fn trigger_reconcile(&self, vault_id: &VaultId) -> bool {
        if let Ok(guard) = self.active_watcher.lock() {
            if let Some((active_id, watcher)) = guard.as_ref() {
                if active_id == vault_id {
                    watcher.trigger_reconcile();
                    return true;
                }
            }
        }
        false
    }

    fn stop_watcher(&self) {
        self.watcher_epoch.fetch_add(1, Ordering::SeqCst);
        let mut guard = match self.active_watcher.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some((_, watcher)) = guard.take() {
            watcher.stop();
        }
    }
}

fn resolve_paths() -> Result<AppPathsSpec, ErrorEnvelope> {
    AppPathsSpec::resolve_default().map_err(|err| err.into_envelope(None))
}

async fn run_blocking<T, F>(f: F) -> Result<T, ErrorEnvelope>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CoreError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(res) => res.map_err(|err| err.into_envelope(None)),
        Err(join_err) => Err(CoreError::IoFailed(format!(
            "background worker task failed: {join_err}"
        ))
        .into_envelope(None)),
    }
}

#[tauri::command]
async fn app_health() -> Result<AppHealthDto, ErrorEnvelope> {
    run_blocking(health_check).await
}

#[tauri::command]
async fn list_vaults() -> Result<Vec<VaultSummary>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::list_vaults(&paths)).await
}

#[tauri::command]
async fn create_vault(
    app: AppHandle,
    runtime: State<'_, DesktopRuntimeState>,
    selected_root: String,
    display_name: Option<String>,
) -> Result<VaultOpenReport, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let paths_clone = paths.clone();
    let report = run_blocking(move || {
        VaultEngine::create_vault(
            &paths_clone,
            Path::new(&selected_root),
            display_name.as_deref(),
        )
    })
    .await?;
    runtime.activate_watcher(
        &app,
        &paths,
        &report.vault.vault_id,
        PathBuf::from(&report.vault.root_path),
    );
    Ok(report)
}

#[tauri::command]
async fn open_vault(
    app: AppHandle,
    runtime: State<'_, DesktopRuntimeState>,
    selected_root: String,
) -> Result<VaultOpenReport, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let paths_clone = paths.clone();
    let report =
        run_blocking(move || VaultEngine::open_vault(&paths_clone, Path::new(&selected_root)))
            .await?;
    runtime.activate_watcher(
        &app,
        &paths,
        &report.vault.vault_id,
        PathBuf::from(&report.vault.root_path),
    );
    Ok(report)
}

#[tauri::command]
async fn list_notes(vault_id: VaultId) -> Result<Vec<NoteSummary>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::list_notes(&paths, &vault_id)).await
}

#[tauri::command]
async fn read_note(vault_id: VaultId, note_id: NoteId) -> Result<NoteSnapshot, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::read_note(&paths, &vault_id, &note_id)).await
}

#[tauri::command]
async fn create_note(
    runtime: State<'_, DesktopRuntimeState>,
    vault_id: VaultId,
    rel_path: String,
    body: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let vid = vault_id.clone();
    let res = run_blocking(move || {
        let actor = ActorContext::desktop("local-user");
        VaultEngine::create_note(&paths, &actor, &vid, &rel_path, &body, &request_id)
    })
    .await?;
    runtime.record_self_write(&vault_id, &res.rel_path, &res.content_hash);
    Ok(res)
}

#[tauri::command]
async fn save_note(
    runtime: State<'_, DesktopRuntimeState>,
    vault_id: VaultId,
    note_id: NoteId,
    expected_hash: String,
    body: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let vid = vault_id.clone();
    let res = run_blocking(move || {
        let actor = ActorContext::desktop("local-user");
        VaultEngine::save_note(
            &paths,
            &actor,
            &vid,
            &note_id,
            &expected_hash,
            &body,
            &request_id,
        )
    })
    .await?;
    runtime.record_self_write(&vault_id, &res.rel_path, &res.content_hash);
    Ok(res)
}

#[tauri::command]
async fn preview_move(
    vault_id: VaultId,
    note_id: NoteId,
    destination: String,
) -> Result<MovePlan, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::preview_move(&paths, &vault_id, &note_id, &destination)).await
}

#[tauri::command]
async fn move_note(
    runtime: State<'_, DesktopRuntimeState>,
    plan: MovePlan,
    expected_hash: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let vault_id = plan.vault_id.clone();
    let res = run_blocking(move || {
        let actor = ActorContext::desktop("local-user");
        VaultEngine::move_note(&paths, &actor, &plan, &expected_hash, &request_id)
    })
    .await?;
    runtime.record_self_write(&vault_id, &res.rel_path, &res.content_hash);
    Ok(res)
}

#[tauri::command]
async fn trash_note(
    runtime: State<'_, DesktopRuntimeState>,
    vault_id: VaultId,
    note_id: NoteId,
    expected_hash: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let vid = vault_id.clone();
    let res = run_blocking(move || {
        let actor = ActorContext::desktop("local-user");
        VaultEngine::trash_note(&paths, &actor, &vid, &note_id, &expected_hash, &request_id)
    })
    .await?;
    runtime.record_self_write(&vault_id, &res.rel_path, &res.content_hash);
    Ok(res)
}

#[tauri::command]
async fn restore_trashed_note(
    runtime: State<'_, DesktopRuntimeState>,
    vault_id: VaultId,
    note_id: NoteId,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let vid = vault_id.clone();
    let res = run_blocking(move || {
        let actor = ActorContext::desktop("local-user");
        VaultEngine::restore_trashed_note(&paths, &actor, &vid, &note_id, &request_id)
    })
    .await?;
    runtime.record_self_write(&vault_id, &res.rel_path, &res.content_hash);
    Ok(res)
}

#[tauri::command]
async fn restore_revision(
    runtime: State<'_, DesktopRuntimeState>,
    vault_id: VaultId,
    revision_id: RevisionId,
    expected_current_hash: String,
    request_id: String,
) -> Result<MutationResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    let vid = vault_id.clone();
    let res = run_blocking(move || {
        let actor = ActorContext::desktop("local-user");
        VaultEngine::restore_revision(
            &paths,
            &actor,
            &vid,
            &revision_id,
            &expected_current_hash,
            &request_id,
        )
    })
    .await?;
    runtime.record_self_write(&vault_id, &res.rel_path, &res.content_hash);
    Ok(res)
}

#[tauri::command]
async fn set_pinned(
    vault_id: VaultId,
    note_id: NoteId,
    pinned: bool,
) -> Result<bool, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::set_pinned(&paths, &vault_id, &note_id, pinned)).await
}

#[tauri::command]
async fn list_revisions(
    vault_id: VaultId,
    note_id: NoteId,
) -> Result<Vec<RevisionSummaryDto>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::list_revisions(&paths, &vault_id, &note_id)).await
}

#[tauri::command]
async fn list_trashed_notes(vault_id: VaultId) -> Result<Vec<TrashedNoteSummary>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::list_trashed_notes(&paths, &vault_id)).await
}

#[tauri::command]
async fn search_vault_notes(
    vault_id: VaultId,
    query: String,
    filters: SearchFilters,
    limit: Option<usize>,
    cursor: Option<String>,
) -> Result<Page<SearchHit>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || {
        search_notes(
            &paths,
            &vault_id,
            &query,
            &filters,
            limit,
            cursor.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn get_note_backlinks(
    vault_id: VaultId,
    note_id: NoteId,
) -> Result<Vec<BacklinkHit>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || get_backlinks(&paths, &vault_id, &note_id)).await
}

#[tauri::command]
async fn get_vault_broken_links(vault_id: VaultId) -> Result<Vec<BrokenLinkDto>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || get_broken_links(&paths, &vault_id)).await
}

#[tauri::command]
async fn get_vault_graph(vault_id: VaultId) -> Result<GraphSnapshotDto, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || get_graph(&paths, &vault_id)).await
}

#[tauri::command]
async fn rebuild_vault_index(vault_id: VaultId) -> Result<ReconcileSummary, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::rebuild_index(&paths, &vault_id)).await
}

#[tauri::command]
async fn create_vault_backup(
    vault_id: VaultId,
    destination: String,
) -> Result<BackupResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || create_backup(&paths, &vault_id, Path::new(&destination))).await
}

#[tauri::command]
async fn restore_vault_backup(
    backup_dir: String,
    destination: String,
) -> Result<RestoreResult, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || restore_backup(&paths, Path::new(&backup_dir), Path::new(&destination)))
        .await
}

#[tauri::command]
async fn export_vault_files(
    vault_id: VaultId,
    destination: String,
) -> Result<usize, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || export_vault(&paths, &vault_id, Path::new(&destination))).await
}

#[tauri::command]
async fn save_draft(
    vault_id: VaultId,
    note_id: NoteId,
    rel_path: String,
    base_hash: String,
    draft_seq: u64,
    body: String,
) -> Result<EditorDraftDto, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || {
        VaultEngine::save_draft(
            &paths, &vault_id, &note_id, &rel_path, &base_hash, draft_seq, &body,
        )
    })
    .await
}

#[tauri::command]
async fn get_draft(
    vault_id: VaultId,
    note_id: NoteId,
) -> Result<Option<EditorDraftDto>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::get_draft(&paths, &vault_id, &note_id)).await
}

#[tauri::command]
async fn list_drafts(vault_id: VaultId) -> Result<Vec<EditorDraftDto>, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::list_drafts(&paths, &vault_id)).await
}

#[tauri::command]
async fn clear_draft(
    vault_id: VaultId,
    note_id: NoteId,
    max_draft_seq: Option<u64>,
) -> Result<bool, ErrorEnvelope> {
    let paths = resolve_paths()?;
    run_blocking(move || VaultEngine::clear_draft(&paths, &vault_id, &note_id, max_draft_seq)).await
}

#[tauri::command]
async fn trigger_reconcile(
    runtime: State<'_, DesktopRuntimeState>,
    vault_id: VaultId,
) -> Result<bool, ErrorEnvelope> {
    Ok(runtime.trigger_reconcile(&vault_id))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopRuntimeState::default())
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
            set_pinned,
            list_revisions,
            list_trashed_notes,
            search_vault_notes,
            get_note_backlinks,
            get_vault_broken_links,
            get_vault_graph,
            rebuild_vault_index,
            create_vault_backup,
            restore_vault_backup,
            export_vault_files,
            save_draft,
            get_draft,
            list_drafts,
            clear_draft,
            trigger_reconcile
        ])
        .build(tauri::generate_context!())
        .expect("error while building Personal Brain desktop application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            app_handle.state::<DesktopRuntimeState>().stop_watcher();
        }
    });
}
