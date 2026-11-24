use brain_core::domain::types::SearchFilters;
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::search_notes;
use brain_core::vault::engine::VaultEngine;
use brain_core::vault::replace::sha256_hex;
use brain_core::vault::watcher::VaultWatcher;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[test]
fn watcher_detects_external_edits_renames_deletes_and_suppresses_self_writes() {
    let base = std::env::temp_dir().join(format!("pb-watch-test-{}", Uuid::new_v4()));
    let paths = AppPathsSpec::from_root(base.join("app_data"));
    let vault = base.join("vault");

    let rep = VaultEngine::create_vault(&paths, &vault, Some("Watcher Vault")).unwrap();
    let vault_id = rep.vault.vault_id;

    let watcher = VaultWatcher::start(
        paths.clone(),
        vault_id.clone(),
        vault.clone(),
        Duration::from_millis(120),
    )
    .expect("start watcher");

    // 1. Self-write suppression: recording hash prevents redundant reconcile
    let self_body = b"# Self Written\nInternal save.\n";
    let self_hash = sha256_hex(self_body);
    watcher.record_self_write("SelfNote.md", &self_hash);
    std::fs::write(vault.join("SelfNote.md"), self_body).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(watcher.stats().reconcile_runs, 0);

    // 2. External create (like Obsidian) triggers debounced reconcile
    std::fs::write(
        vault.join("External.md"),
        "# External Note\nKeyword nebula_beacon.\n",
    )
    .unwrap();
    wait_until(Duration::from_secs(5), || {
        search_notes(
            &paths,
            &vault_id,
            "nebula_beacon",
            &SearchFilters::default(),
            None,
            None,
        )
        .map(|p| p.items.len() == 1)
        .unwrap_or(false)
    });
    let orig_id = VaultEngine::lookup_note_id_by_path(&paths, &vault_id, "External.md")
        .unwrap()
        .unwrap();

    // 3. External rename preserves stable NoteId via NTFS file_identity
    std::fs::rename(vault.join("External.md"), vault.join("ExternalRenamed.md")).unwrap();
    wait_until(Duration::from_secs(5), || {
        VaultEngine::lookup_note_id_by_path(&paths, &vault_id, "ExternalRenamed.md")
            .ok()
            .flatten()
            .is_some()
    });
    let renamed_id = VaultEngine::lookup_note_id_by_path(&paths, &vault_id, "ExternalRenamed.md")
        .unwrap()
        .unwrap();
    assert_eq!(renamed_id, orig_id);

    // 4. External delete removes note from search index
    std::fs::remove_file(vault.join("ExternalRenamed.md")).unwrap();
    wait_until(Duration::from_secs(5), || {
        search_notes(
            &paths,
            &vault_id,
            "nebula_beacon",
            &SearchFilters::default(),
            None,
            None,
        )
        .map(|p| p.items.is_empty())
        .unwrap_or(false)
    });

    // 5. Missed-event fallback: stop watcher, mutate disk, then call explicit rebuild/reconcile
    watcher.stop();
    std::fs::write(
        vault.join("MissedEvent.md"),
        "# Missed\nKeyword pulsar_sync.\n",
    )
    .unwrap();
    let rec = VaultEngine::rebuild_index(&paths, &vault_id).expect("explicit reconcile");
    assert!(rec.indexed_notes >= 2);
    let hits = search_notes(
        &paths,
        &vault_id,
        "pulsar_sync",
        &SearchFilters::default(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(hits.items.len(), 1);

    let _ = std::fs::remove_dir_all(&base);
}

fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if pred() {
            return;
        }
        std::thread::sleep(Duration::from_millis(80));
    }
    panic!("condition not satisfied within {timeout:?}");
}
