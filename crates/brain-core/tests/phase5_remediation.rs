use brain_core::backup::create_backup;
use brain_core::domain::errors::ErrorCode;
use brain_core::domain::types::{ActorContext, SearchFilters, WatcherEventDto};
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::{get_graph, search_notes};
use brain_core::vault::engine::VaultEngine;
use brain_core::vault::lock::VaultLock;
use brain_core::vault::watcher::VaultWatcher;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

struct ScratchDir(PathBuf);
impl ScratchDir {
    fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn test_paths(dir: &ScratchDir) -> AppPathsSpec {
    AppPathsSpec::from_root(dir.path().join("appdata"))
}

#[test]
fn durable_draft_recovers_after_reopen_respects_monotonic_seq_and_is_excluded_from_search() {
    let tmp = ScratchDir::new("pb-phase5-draft");
    let paths = test_paths(&tmp);
    let root1 = tmp.path().join("vault1");
    let root2 = tmp.path().join("vault2");

    let r1 = VaultEngine::create_vault(&paths, &root1, Some("Vault One")).unwrap();
    let r2 = VaultEngine::create_vault(&paths, &root2, Some("Vault Two")).unwrap();
    let actor = ActorContext::desktop("tester");

    let created = VaultEngine::create_note(
        &paths,
        &actor,
        &r1.vault.vault_id,
        "notes/alpha.md",
        "# Alpha\n\nAuthoritative saved text.",
        "req-1",
    )
    .unwrap();

    let d2 = VaultEngine::save_draft(
        &paths,
        &r1.vault.vault_id,
        &created.note_id,
        "notes/alpha.md",
        &created.content_hash,
        2,
        "# Alpha\n\nUNSAVED_DRAFT_MARKER_991",
    )
    .unwrap();
    assert_eq!(d2.draft_seq, 2);

    // Lower draft_seq must not overwrite newer persisted draft_seq=2.
    let stale_attempt = VaultEngine::save_draft(
        &paths,
        &r1.vault.vault_id,
        &created.note_id,
        "notes/alpha.md",
        &created.content_hash,
        1,
        "# Alpha\n\nOLDER_STALE_TEXT",
    )
    .unwrap();
    assert_eq!(stale_attempt.draft_seq, 2);
    assert!(stale_attempt.body.contains("UNSAVED_DRAFT_MARKER_991"));

    // Simulate process restart via fresh AppPathsSpec handle + engine read.
    let restarted_paths = AppPathsSpec::from_root(tmp.path().join("appdata"));
    let recovered = VaultEngine::get_draft(&restarted_paths, &r1.vault.vault_id, &created.note_id)
        .unwrap()
        .expect("draft must survive restart");
    assert_eq!(recovered.body, "# Alpha\n\nUNSAVED_DRAFT_MARKER_991");
    assert_eq!(recovered.base_hash, created.content_hash);

    // Drafts must never pollute derived search index or another vault's drafts.
    let search_hits = search_notes(
        &restarted_paths,
        &r1.vault.vault_id,
        "UNSAVED_DRAFT_MARKER_991",
        &SearchFilters::default(),
        Some(10),
        None,
    )
    .unwrap();
    assert!(search_hits.items.is_empty());

    let cross_vault = VaultEngine::list_drafts(&restarted_paths, &r2.vault.vault_id).unwrap();
    assert!(cross_vault.is_empty());

    // Authoritative note remains untouched on disk.
    let live =
        VaultEngine::read_note(&restarted_paths, &r1.vault.vault_id, &created.note_id).unwrap();
    assert!(live.body.contains("Authoritative saved text."));

    // clear_draft(max_seq=1) must keep draft_seq=2; clear_draft(max_seq=2) clears it.
    assert!(!VaultEngine::clear_draft(
        &restarted_paths,
        &r1.vault.vault_id,
        &created.note_id,
        Some(1),
    )
    .unwrap());
    assert!(
        VaultEngine::get_draft(&restarted_paths, &r1.vault.vault_id, &created.note_id)
            .unwrap()
            .is_some()
    );
    assert!(VaultEngine::clear_draft(
        &restarted_paths,
        &r1.vault.vault_id,
        &created.note_id,
        Some(2),
    )
    .unwrap());
    assert!(
        VaultEngine::get_draft(&restarted_paths, &r1.vault.vault_id, &created.note_id)
            .unwrap()
            .is_none()
    );
}

#[test]
fn watcher_retains_dirty_state_during_lock_contention_and_handles_simulated_overflow() {
    let tmp = ScratchDir::new("pb-phase5-watcher");
    let paths = test_paths(&tmp);
    let root = tmp.path().join("vault");
    let report = VaultEngine::create_vault(&paths, &root, Some("Watcher Test")).unwrap();
    let vault_id = report.vault.vault_id.clone();

    let events: Arc<Mutex<Vec<WatcherEventDto>>> = Arc::new(Mutex::new(Vec::new()));
    let cb_events = Arc::clone(&events);

    let watcher = VaultWatcher::start_with_options(
        paths.clone(),
        vault_id.clone(),
        root.clone(),
        Duration::from_millis(40),
        Duration::from_millis(60),
        3,
        Duration::from_millis(80),
        Some(Arc::new(move |ev| {
            cb_events.lock().unwrap().push(ev);
        })),
    )
    .unwrap();

    // Case 1: Hold vault lock briefly so first reconcile attempt hits CoreError::Busy, then release.
    let lock =
        VaultLock::acquire(&paths.vault_lock_file(&vault_id), Duration::from_secs(2)).unwrap();
    std::fs::write(
        root.join("external.md"),
        "# External\n\nEdited during lock\n",
    )
    .unwrap();

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && watcher.stats().retry_attempts == 0 {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(
        watcher.stats().retry_attempts >= 1,
        "watcher should record Busy retry attempt while lock held"
    );
    drop(lock);

    let recover_deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < recover_deadline {
        if watcher.stats().reconcile_runs > 0 && !watcher.stats().is_stale {
            break;
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let st = watcher.stats();
    assert!(st.reconcile_runs >= 1);
    assert!(!st.is_stale);

    // Case 2: Simulated overflow triggers full reconcile with from_overflow = true.
    let prev_overflow = st.missed_or_overflow_events;
    watcher.simulate_overflow();
    let ov_deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < ov_deadline {
        let has_ev = events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.from_overflow && !e.stale);
        if has_ev && watcher.stats().missed_or_overflow_events > prev_overflow {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(watcher.stats().missed_or_overflow_events > prev_overflow);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|e| e.from_overflow && !e.stale));

    // Case 3: Exhaust retries under sustained lock contention and confirm stale notification.
    let lock_forever =
        VaultLock::acquire(&paths.vault_lock_file(&vault_id), Duration::from_secs(2)).unwrap();
    watcher.trigger_reconcile();
    let stale_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < stale_deadline && !watcher.stats().is_stale {
        std::thread::sleep(Duration::from_millis(30));
    }
    assert!(watcher.stats().is_stale);
    let captured = events.lock().unwrap().clone();
    assert!(
        captured
            .iter()
            .any(|e| e.stale && e.error_code == Some(ErrorCode::Busy)),
        "expected stale event with Busy error_code, got {captured:?}"
    );
    drop(lock_forever);

    watcher.stop();
}

#[test]
fn graph_snapshot_preserves_stable_ids_cycles_self_links_isolated_nodes_and_unicode() {
    let tmp = ScratchDir::new("pb-phase5-graph");
    let paths = test_paths(&tmp);
    let root = tmp.path().join("vault");
    let report = VaultEngine::create_vault(&paths, &root, Some("Graph Test")).unwrap();
    let vid = report.vault.vault_id;
    let actor = ActorContext::desktop("tester");

    let g_empty = get_graph(&paths, &vid).unwrap();
    assert!(g_empty.nodes.is_empty());
    assert!(g_empty.edges.is_empty());

    let a = VaultEngine::create_note(
        &paths,
        &actor,
        &vid,
        "cluster-a/alpha.md",
        "# SharedTitle\n\n[[Beta]] [[alpha]] [[MissingTarget]] [[SharedTitle]]",
        "g-1",
    )
    .unwrap();
    let b = VaultEngine::create_note(
        &paths,
        &actor,
        &vid,
        "cluster-b/Beta.md",
        "# SharedTitle\n\n[[cluster-a/alpha]]",
        "g-2",
    )
    .unwrap();
    let iso = VaultEngine::create_note(
        &paths,
        &actor,
        &vid,
        "日本語/ノート.md",
        "# 日本語タイトル\n\nIsolated unicode note.",
        "g-3",
    )
    .unwrap();

    let graph = get_graph(&paths, &vid).unwrap();
    assert_eq!(graph.nodes.len(), 3);

    let node_a = graph.nodes.iter().find(|n| n.id == a.note_id).unwrap();
    let node_b = graph.nodes.iter().find(|n| n.id == b.note_id).unwrap();
    let node_iso = graph.nodes.iter().find(|n| n.id == iso.note_id).unwrap();

    assert_eq!(node_a.folder, "cluster-a");
    assert_eq!(node_a.title, "SharedTitle");
    assert_eq!(node_b.title, "SharedTitle");
    assert_ne!(node_a.id, node_b.id);
    assert_eq!(node_iso.folder, "日本語");
    assert_eq!(node_iso.title, "日本語タイトル");
    assert_eq!(node_iso.incoming_count, 0);
    assert_eq!(node_iso.outgoing_count, 0);

    assert!(graph
        .edges
        .iter()
        .any(|e| e.source == a.note_id && e.target == a.note_id));
    assert!(graph
        .edges
        .iter()
        .any(|e| e.source == a.note_id && e.target == b.note_id));
    assert!(graph
        .edges
        .iter()
        .any(|e| e.source == b.note_id && e.target == a.note_id));
    assert_eq!(graph.edges.len(), 3);

    let plan = VaultEngine::preview_move(&paths, &vid, &a.note_id, "renamed/alpha-new.md").unwrap();
    VaultEngine::move_note(&paths, &actor, &plan, &a.content_hash, "g-4").unwrap();
    let graph_after_move = get_graph(&paths, &vid).unwrap();
    let moved_node = graph_after_move
        .nodes
        .iter()
        .find(|n| n.id == a.note_id)
        .unwrap();
    assert_eq!(moved_node.rel_path, "renamed/alpha-new.md");
    assert_eq!(moved_node.folder, "renamed");

    let iso_snap = VaultEngine::read_note(&paths, &vid, &iso.note_id).unwrap();
    VaultEngine::trash_note(
        &paths,
        &actor,
        &vid,
        &iso.note_id,
        &iso_snap.content_hash,
        "g-5",
    )
    .unwrap();
    let graph_after_trash = get_graph(&paths, &vid).unwrap();
    assert_eq!(graph_after_trash.nodes.len(), 2);
    assert!(!graph_after_trash.nodes.iter().any(|n| n.id == iso.note_id));
}

#[test]
fn persistent_exclusions_filter_index_preview_safely_and_preserve_files_and_backups() {
    let tmp = ScratchDir::new("pb-phase5-exclusions");
    let paths = test_paths(&tmp);
    let root = tmp.path().join("vault");
    std::fs::create_dir_all(root.join("notes")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/pkg-a")).unwrap();
    std::fs::create_dir_all(root.join("target/doc")).unwrap();
    std::fs::create_dir_all(root.join("vendor_docs")).unwrap();

    std::fs::write(root.join("notes/idea.md"), "# Real Note\n\nCore idea.").unwrap();
    std::fs::write(
        root.join("node_modules/pkg-a/README.md"),
        "# Package Readme\n\nDependency docs.",
    )
    .unwrap();
    std::fs::write(
        root.join("target/doc/crate.md"),
        "# Target Docs\n\nGenerated build docs.",
    )
    .unwrap();
    std::fs::write(
        root.join("vendor_docs/guide.md"),
        "# Vendor Guide\n\nThird-party guide.",
    )
    .unwrap();

    // Default exclusions already skip node_modules and target during initial open/index.
    let report = VaultEngine::open_vault(&paths, &root).unwrap();
    let vid = report.vault.vault_id;
    let initial_graph = get_graph(&paths, &vid).unwrap();
    assert_eq!(initial_graph.nodes.len(), 2);
    assert!(initial_graph
        .nodes
        .iter()
        .any(|n| n.rel_path == "notes/idea.md"));
    assert!(initial_graph
        .nodes
        .iter()
        .any(|n| n.rel_path == "vendor_docs/guide.md"));

    // Preview adding vendor_docs without modifying index or files on disk.
    let patterns = vec![
        "node_modules".to_string(),
        "target".to_string(),
        "vendor_docs".to_string(),
    ];
    let preview = VaultEngine::preview_vault_exclusions(&paths, &vid, &patterns).unwrap();
    assert_eq!(preview.excluded_note_count, 3);
    assert_eq!(preview.remaining_note_count, 1);
    assert!(preview
        .sample_excluded_paths
        .contains(&"vendor_docs/guide.md".to_string()));
    assert_eq!(get_graph(&paths, &vid).unwrap().nodes.len(), 2);

    // Apply exclusions and verify index shrinks while source files and backups remain intact.
    let actor = ActorContext::desktop("tester");
    let summary = VaultEngine::set_vault_exclusions(&paths, &actor, &vid, &patterns).unwrap();
    assert_eq!(summary.indexed_notes, 1);
    let updated_graph = get_graph(&paths, &vid).unwrap();
    assert_eq!(updated_graph.nodes.len(), 1);
    assert_eq!(updated_graph.nodes[0].rel_path, "notes/idea.md");

    // Source files on disk are never deleted.
    assert!(root.join("node_modules/pkg-a/README.md").exists());
    assert!(root.join("vendor_docs/guide.md").exists());

    // Backup still preserves all vault files regardless of indexing exclusions.
    let backup_dest = tmp.path().join("backup");
    let backup = create_backup(&paths, &vid, &backup_dest).unwrap();
    assert_eq!(backup.vault_files_count, 4);
}
