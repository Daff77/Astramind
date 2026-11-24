use brain_core::domain::errors::ErrorCode;
use brain_core::domain::types::ActorContext;
use brain_core::paths::AppPathsSpec;
use brain_core::state::vault_state::VaultStateStore;
use brain_core::vault::engine::{JournalFailpoint, VaultEngine};
use brain_core::vault::replace::sha256_hex;
use uuid::Uuid;

fn temp_env() -> (std::path::PathBuf, AppPathsSpec, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!("pb-crud-{}", Uuid::new_v4()));
    let app_data = base.join("app_data");
    let vault_dir = base.join("vault");
    (base, AppPathsSpec::from_root(app_data), vault_dir)
}

#[test]
fn empty_and_existing_vault_non_destructive_open_and_crud_lifecycle() {
    let (base, paths, vault_dir) = temp_env();
    let actor = ActorContext::desktop("tester");

    // 1. Create & open empty vault
    let empty_dir = base.join("empty_vault");
    let empty_rep =
        VaultEngine::create_vault(&paths, &empty_dir, Some("Empty Test")).expect("create empty");
    assert_eq!(empty_rep.notes_discovered, 0);

    // 2. Existing Obsidian-like vault with unknown frontmatter, CRLF, BOM, Unicode & spaces:
    // opening MUST NOT modify a single byte of existing files (AC-002).
    std::fs::create_dir_all(vault_dir.join(".obsidian")).unwrap();
    std::fs::create_dir_all(vault_dir.join("Projects/Café Notes")).unwrap();
    let existing_a = vault_dir.join("Projects/Café Notes/Decision One.md");
    let raw_a = b"\xEF\xBB\xBF---\r\ntitle: Decision One\r\ncustom_obs_key: preserve_me\r\n---\r\n# Decision One\r\n\r\nSee [[Target Two]].\r\n";
    std::fs::write(&existing_a, raw_a).unwrap();
    let hash_a_before = sha256_hex(raw_a);

    let existing_b = vault_dir.join("Target Two.md");
    let raw_b = b"Plain markdown without frontmatter.\n";
    std::fs::write(&existing_b, raw_b).unwrap();
    let obs_cfg = vault_dir.join(".obsidian/app.json");
    std::fs::write(&obs_cfg, b"{\"strictLineBreaks\":true}").unwrap();

    let open_rep = VaultEngine::open_vault(&paths, &vault_dir).expect("open existing vault");
    assert_eq!(open_rep.notes_discovered, 2);
    assert_eq!(
        sha256_hex(&std::fs::read(&existing_a).unwrap()),
        hash_a_before
    );
    assert_eq!(std::fs::read(&existing_b).unwrap(), raw_b);
    assert_eq!(
        std::fs::read(&obs_cfg).unwrap(),
        b"{\"strictLineBreaks\":true}"
    );

    let vault_id = open_rep.vault.vault_id;

    // 3. Create, read, save (with idempotency replay), move preview + move, trash + restore
    let created = VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "Projects/New Note.md",
        "# New Note\nHello [[Decision One]].\n",
        "req-create-1",
    )
    .expect("create note");
    assert!(!created.replayed);

    // Idempotent replay with same request_id + payload returns same outcome
    let replayed = VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "Projects/New Note.md",
        "# New Note\nHello [[Decision One]].\n",
        "req-create-1",
    )
    .expect("idempotent replay");
    assert!(replayed.replayed);
    assert_eq!(replayed.note_id, created.note_id);

    // Reusing request_id with different payload must fail Conflict
    let bad_replay = VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "Projects/New Note.md",
        "# Different Body",
        "req-create-1",
    )
    .expect_err("request_id payload mismatch must conflict");
    assert_eq!(bad_replay.code(), ErrorCode::Conflict);

    // Read & save
    let snap = VaultEngine::read_note(&paths, &vault_id, &created.note_id).expect("read created");
    assert_eq!(snap.title, "New Note");
    let saved = VaultEngine::save_note(
        &paths,
        &actor,
        &vault_id,
        &created.note_id,
        &snap.content_hash,
        "# New Note\nUpdated body.\n",
        "req-save-1",
    )
    .expect("save note");
    assert_ne!(saved.content_hash, snap.content_hash);

    // Create a referrer note linking to New Note so preview_move reports affected_backlinks
    VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "Projects/Referrer.md",
        "# Referrer\nPoints to [[New Note]].\n",
        "req-create-ref-1",
    )
    .expect("create referrer");

    // Move preview & move
    let plan =
        VaultEngine::preview_move(&paths, &vault_id, &created.note_id, "Archive/Moved Note.md")
            .expect("preview move");
    assert_eq!(plan.affected_backlinks.len(), 1);
    assert_eq!(
        plan.affected_backlinks[0].source_rel_path,
        "Projects/Referrer.md"
    );
    let moved = VaultEngine::move_note(&paths, &actor, &plan, &saved.content_hash, "req-move-1")
        .expect("move note");
    assert!(!vault_dir.join("Projects/New Note.md").exists());
    assert!(vault_dir.join("Archive/Moved Note.md").exists());

    // Trash & restore
    let trashed = VaultEngine::trash_note(
        &paths,
        &actor,
        &vault_id,
        &created.note_id,
        &moved.content_hash,
        "req-trash-1",
    )
    .expect("trash note");
    assert!(!vault_dir.join("Archive/Moved Note.md").exists());
    assert_eq!(
        VaultEngine::read_note(&paths, &vault_id, &created.note_id)
            .expect_err("trashed note not readable")
            .code(),
        ErrorCode::NoteNotFound
    );

    let restored = VaultEngine::restore_trashed_note(
        &paths,
        &actor,
        &vault_id,
        &created.note_id,
        "req-restore-1",
    )
    .expect("restore trashed note");
    assert!(vault_dir.join("Archive/Moved Note.md").exists());
    assert_eq!(restored.content_hash, trashed.content_hash);

    // Restore prior revision
    let rev_id = saved.revision_id.expect("save revision id");
    let rev_restored = VaultEngine::restore_revision(
        &paths,
        &actor,
        &vault_id,
        &rev_id,
        &restored.content_hash,
        "req-rev-restore-1",
    )
    .expect("restore revision");
    assert_eq!(rev_restored.content_hash, snap.content_hash);

    // AC-009: unrelated existing notes remain byte-for-byte identical after all mutations
    assert_eq!(
        sha256_hex(&std::fs::read(&existing_a).unwrap()),
        hash_a_before
    );
    assert_eq!(std::fs::read(&existing_b).unwrap(), raw_b);

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn journal_failpoints_recover_cleanly_and_readonly_files_fail_closed() {
    let (base, paths, vault_dir) = temp_env();
    let actor = ActorContext::desktop("crash-test");
    let rep = VaultEngine::create_vault(&paths, &vault_dir, Some("Failpoint Vault"))
        .expect("create vault");
    let vault_id = rep.vault.vault_id;

    // 1. Crash after create journal prepared (before file write) -> reserved row cleaned up
    let err1 = VaultEngine::create_note_with_failpoint(
        &paths,
        &actor,
        &vault_id,
        "CrashBeforeWrite.md",
        "# Crash 1",
        "req-crash-1",
        JournalFailpoint::AfterJournalPrepared,
    )
    .expect_err("failpoint 1");
    assert_eq!(err1.code(), ErrorCode::IoFailed);
    assert!(!vault_dir.join("CrashBeforeWrite.md").exists());

    // Next vault open/operation recovers cleanly and clears reserved row
    let recovered_after_1 = VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "CrashBeforeWrite.md",
        "# Clean Retry",
        "req-clean-1",
    )
    .expect("retry after aborted reserved create succeeds");
    assert!(vault_dir.join("CrashBeforeWrite.md").exists());

    // 2. Crash after file replaced during save -> recovery finalizes committed revision once
    let err2 = VaultEngine::save_note_with_failpoint(
        &paths,
        &actor,
        &vault_id,
        &recovered_after_1.note_id,
        &recovered_after_1.content_hash,
        "# Post Crash Content",
        "req-crash-save-2",
        JournalFailpoint::AfterFileReplaced,
    )
    .expect_err("failpoint 2");
    assert_eq!(err2.code(), ErrorCode::IoFailed);

    let mut state = VaultStateStore::open_or_init(&paths, &vault_id).unwrap();
    VaultEngine::recover_pending_journal(&vault_dir, &mut state).expect("recover pending save");
    let snap = VaultEngine::read_note(&paths, &vault_id, &recovered_after_1.note_id).unwrap();
    assert_eq!(snap.body, "# Post Crash Content");

    // 3. Read-only file on Windows triggers AccessDenied without truncating file
    let ro_path = vault_dir.join("CrashBeforeWrite.md");
    let mut perms = std::fs::metadata(&ro_path).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&ro_path, perms).unwrap();

    let ro_err = VaultEngine::save_note(
        &paths,
        &actor,
        &vault_id,
        &recovered_after_1.note_id,
        &snap.content_hash,
        "# Should Fail",
        "req-ro-1",
    )
    .expect_err("read-only save must fail");
    assert_eq!(ro_err.code(), ErrorCode::AccessDenied);
    assert_eq!(
        std::fs::read_to_string(&ro_path).unwrap(),
        "# Post Crash Content"
    );

    let mut perms_rw = std::fs::metadata(&ro_path).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    perms_rw.set_readonly(false);
    std::fs::set_permissions(&ro_path, perms_rw).unwrap();

    // 4. External editor modification during an app edit triggers Conflict and saves recovery copy
    let ext_bytes = b"# External Obsidian Edit\nNew external text.\n";
    std::fs::write(&ro_path, ext_bytes).unwrap();
    let conflict_err = VaultEngine::save_note(
        &paths,
        &actor,
        &vault_id,
        &recovered_after_1.note_id,
        &snap.content_hash,
        "# Stale App Edit",
        "req-ext-conflict-1",
    )
    .expect_err("external edit during app save must conflict");
    assert_eq!(conflict_err.code(), ErrorCode::Conflict);
    assert_eq!(std::fs::read(&ro_path).unwrap(), ext_bytes);
    let rec_dir = paths.vault_dir(&vault_id).join("recovery");
    assert!(std::fs::read_dir(&rec_dir).unwrap().count() >= 1);

    let _ = std::fs::remove_dir_all(&base);
}
