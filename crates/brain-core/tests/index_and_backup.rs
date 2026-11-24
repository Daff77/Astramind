use brain_core::backup::{create_backup, export_vault, restore_backup};
use brain_core::domain::errors::ErrorCode;
use brain_core::domain::types::{ActorContext, SearchFilters};
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::{get_graph, search_notes};
use brain_core::state::registry::RegistryStore;
use brain_core::state::vault_state::VaultStateStore;
use brain_core::vault::engine::{JournalFailpoint, VaultEngine};
use rusqlite::Connection;
use uuid::Uuid;

#[test]
fn rebuilds_corrupted_index_without_losing_state_and_verifies_backup_restore() {
    let base = std::env::temp_dir().join(format!("pb-backup-idx-{}", Uuid::new_v4()));
    let paths = AppPathsSpec::from_root(base.join("app_data"));
    let vault = base.join("vault");
    let backup_parent = base.join("backups");
    let restore_dir = base.join("restored_vault");
    let export_dir = base.join("exported_vault");
    let actor = ActorContext::desktop("qa");

    let rep = VaultEngine::create_vault(&paths, &vault, Some("Durable Vault")).unwrap();
    let vault_id = rep.vault.vault_id;
    let created = VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "CoreNote.md",
        "# Core Note\nPreserved across index corruption. [[LinkedNote]]\n",
        "req-b-1",
    )
    .unwrap();
    VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "LinkedNote.md",
        "# Linked Note\nTarget body.\n",
        "req-b-2",
    )
    .unwrap();

    // Register an enabled agent grant to verify restore disables all grants
    {
        let reg = RegistryStore::open(&paths).unwrap();
        reg.insert_test_grant(&vault_id, "codex-test", true, true, true, &[""])
            .unwrap();
    }

    let graph_before = get_graph(&paths, &vault_id).unwrap();

    // 1. Corrupt active index-<gen>.sqlite -> search & graph must auto-rebuild and preserve state/note_id (AC-014)
    let gen = {
        let st = VaultStateStore::open_or_init(&paths, &vault_id).unwrap();
        st.active_index_generation().unwrap()
    };
    let idx_path = paths.vault_index_db(&vault_id, gen);
    std::fs::write(&idx_path, b"CORRUPTED SQLITE BYTES").unwrap();

    let hits = search_notes(
        &paths,
        &vault_id,
        "Preserved",
        &SearchFilters::default(),
        None,
        None,
    )
    .expect("corrupted index should auto-rebuild from Markdown + state.sqlite");
    assert_eq!(hits.items.len(), 1);
    assert_eq!(hits.items[0].note_id, created.note_id);

    // Also delete active index file completely and verify get_graph equality after rebuild
    let gen_after_corrupt = VaultStateStore::open_or_init(&paths, &vault_id)
        .unwrap()
        .active_index_generation()
        .unwrap();
    std::fs::remove_file(paths.vault_index_db(&vault_id, gen_after_corrupt)).unwrap();
    let graph_after = get_graph(&paths, &vault_id).unwrap();
    assert_eq!(graph_after.nodes, graph_before.nodes);
    assert_eq!(graph_after.edges, graph_before.edges);

    // 2. Reject unsafe backup destinations (inside vault, ancestor of vault, inside app-data)
    assert_eq!(
        create_backup(&paths, &vault_id, &vault.join("nested"))
            .expect_err("inside vault must fail")
            .code(),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        create_backup(&paths, &vault_id, &base)
            .expect_err("vault ancestor must fail")
            .code(),
        ErrorCode::InvalidInput
    );
    assert_eq!(
        create_backup(&paths, &vault_id, &paths.app_data_dir.join("bk"))
            .expect_err("inside app-data must fail")
            .code(),
        ErrorCode::InvalidInput
    );

    // 3. Create valid backup and verify restore-alongside assigns new VaultId + disables grants
    let backup = create_backup(&paths, &vault_id, &backup_parent).expect("create backup");
    assert_eq!(backup.vault_files_count, 2);
    assert!(backup.blobs_count >= 2);

    let restored = restore_backup(
        &paths,
        std::path::Path::new(&backup.destination),
        &restore_dir,
    )
    .expect("restore backup alongside active vault");
    assert_ne!(restored.restored_vault_id, vault_id);
    assert_eq!(restored.grants_disabled, 1);
    assert!(restore_dir.join("CoreNote.md").exists());

    let reg = RegistryStore::open(&paths).unwrap();
    let restored_grants = reg
        .list_grants_for_vault(&restored.restored_vault_id)
        .unwrap();
    assert_eq!(restored_grants.len(), 1);
    assert!(!restored_grants[0].enabled);

    // 4. Export vault produces non-proprietary files
    let exported_count = export_vault(&paths, &vault_id, &export_dir).expect("export vault");
    assert_eq!(exported_count, 2);
    assert!(export_dir.join("CoreNote.md").exists());

    // 4b. create_backup must refuse while prepared journal rows exist (SC-18)
    let _fail_err = VaultEngine::create_note_with_failpoint(
        &paths,
        &actor,
        &vault_id,
        "PendingBackupBlock.md",
        "# Pending",
        "req-pending-bk-1",
        JournalFailpoint::AfterJournalPrepared,
    )
    .expect_err("simulated crash leaves prepared journal row");
    assert_eq!(
        create_backup(&paths, &vault_id, &backup_parent)
            .expect_err("backup must refuse with prepared journal row")
            .code(),
        ErrorCode::RecoveryRequired
    );

    // 5. Unsupported newer schema version in state.sqlite fails closed with RecoveryRequired
    let state_db = paths.vault_state_db(&restored.restored_vault_id);
    {
        let conn = Connection::open(&state_db).unwrap();
        conn.execute_batch("PRAGMA user_version = 99;").unwrap();
    }
    let ver_err = VaultStateStore::open_or_init(&paths, &restored.restored_vault_id)
        .err()
        .expect("newer schema must fail closed");
    assert_eq!(ver_err.code(), ErrorCode::RecoveryRequired);

    // 6. Corrupted state.sqlite AND 0-byte truncated state.sqlite fail closed
    std::fs::write(&state_db, b"CORRUPTED STATE DB").unwrap();
    let corrupt_state_err = VaultStateStore::open_or_init(&paths, &restored.restored_vault_id)
        .err()
        .expect("corrupted state.sqlite must fail closed");
    assert_eq!(corrupt_state_err.code(), ErrorCode::RecoveryRequired);

    std::fs::write(&state_db, b"").unwrap();
    let zero_state_err = VaultStateStore::open_or_init(&paths, &restored.restored_vault_id)
        .err()
        .expect("0-byte truncated state.sqlite must fail closed");
    assert_eq!(zero_state_err.code(), ErrorCode::RecoveryRequired);

    let _ = std::fs::remove_dir_all(&base);
}
