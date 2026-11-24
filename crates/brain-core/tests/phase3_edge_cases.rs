use brain_core::domain::errors::ErrorCode;
use brain_core::domain::types::{ActorContext, ParseStatus, SearchFilters, WatcherEventDto};
use brain_core::markdown::parse_markdown_bytes;
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::search_notes;
use brain_core::vault::engine::VaultEngine;
use brain_core::vault::paths::{
    is_cloud_placeholder_attrs, WIN_ATTR_OFFLINE, WIN_ATTR_RECALL_ON_DATA_ACCESS,
    WIN_ATTR_RECALL_ON_OPEN,
};
use brain_core::vault::scan::scan_vault;
use brain_core::vault::watcher::VaultWatcher;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

#[test]
fn handles_non_utf8_unsupported_and_cursor_invalidation_and_pin_revisions() {
    let base = std::env::temp_dir().join(format!("pb-p3-edge-{}", Uuid::new_v4()));
    let paths = AppPathsSpec::from_root(base.join("app_data"));
    let vault = base.join("vault");
    std::fs::create_dir_all(&vault).unwrap();

    // 1. Non-UTF-8 file must parse as Unsupported without crashing or modifying disk bytes
    let raw_latin1 = b"\xFF\xFEInvalid UTF-8 content\n";
    let parsed = parse_markdown_bytes("BinaryLike.md", raw_latin1);
    assert_eq!(parsed.parse_status, ParseStatus::Unsupported);
    assert!(!parsed.diagnostics.is_empty());

    std::fs::write(vault.join("BinaryLike.md"), raw_latin1).unwrap();
    let rep = VaultEngine::open_vault(&paths, &vault).expect("open vault with non-UTF-8 file");
    let vault_id = rep.vault.vault_id;
    let notes = VaultEngine::list_notes(&paths, &vault_id).unwrap();
    let bin_note = notes
        .iter()
        .find(|n| n.rel_path == "BinaryLike.md")
        .unwrap();
    assert_eq!(bin_note.parse_status, ParseStatus::Unsupported);

    // 2. Search cursor invalidation when index generation advances
    let actor = ActorContext::desktop("qa-edge");
    let mut first_note_id = None;
    for i in 0..5 {
        let res = VaultEngine::create_note(
            &paths,
            &actor,
            &vault_id,
            &format!("PageNote_{i}.md"),
            "# Page Note\nShared keyword cursor_probe.\n",
            &format!("req-page-{i}"),
        )
        .unwrap();
        if first_note_id.is_none() {
            first_note_id = Some(res.note_id);
        }
    }
    let page1 = search_notes(
        &paths,
        &vault_id,
        "cursor_probe",
        &SearchFilters::default(),
        Some(2),
        None,
    )
    .unwrap();
    assert_eq!(page1.items.len(), 2);
    let cursor = page1.next_cursor.expect("expected next_cursor");

    // Advance active index generation via rebuild
    let rec = VaultEngine::rebuild_index(&paths, &vault_id).unwrap();
    assert!(rec.index_generation > page1.generation);

    // Using cursor from old generation must return ErrorCode::Conflict
    let stale_err = search_notes(
        &paths,
        &vault_id,
        "cursor_probe",
        &SearchFilters::default(),
        Some(2),
        Some(&cursor),
    )
    .expect_err("stale generation cursor must conflict");
    assert_eq!(stale_err.code(), ErrorCode::Conflict);

    // 3. set_pinned, list_revisions, list_trashed_notes
    let target_id = first_note_id.unwrap();
    assert!(VaultEngine::set_pinned(&paths, &vault_id, &target_id, true).unwrap());
    let listed = VaultEngine::list_notes(&paths, &vault_id).unwrap();
    assert!(
        listed
            .iter()
            .find(|n| n.note_id == target_id)
            .unwrap()
            .pinned
    );

    let revs = VaultEngine::list_revisions(&paths, &vault_id, &target_id).unwrap();
    assert_eq!(revs.len(), 1);

    let snap = VaultEngine::read_note(&paths, &vault_id, &target_id).unwrap();
    VaultEngine::trash_note(
        &paths,
        &actor,
        &vault_id,
        &target_id,
        &snap.content_hash,
        "req-tr-1",
    )
    .unwrap();
    let trashed = VaultEngine::list_trashed_notes(&paths, &vault_id).unwrap();
    assert_eq!(trashed.len(), 1);
    assert_eq!(trashed[0].note_id, target_id);

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn watcher_callback_emits_on_reconcile() {
    let base = std::env::temp_dir().join(format!("pb-watch-cb-{}", Uuid::new_v4()));
    let paths = AppPathsSpec::from_root(base.join("app_data"));
    let vault = base.join("vault");
    let rep = VaultEngine::create_vault(&paths, &vault, Some("Callback Vault")).unwrap();
    let vault_id = rep.vault.vault_id;

    let events: Arc<Mutex<Vec<WatcherEventDto>>> = Arc::new(Mutex::new(Vec::new()));
    let events_cb = Arc::clone(&events);
    let watcher = VaultWatcher::start_with_callback(
        paths,
        vault_id.clone(),
        vault.clone(),
        Duration::from_millis(80),
        Some(Arc::new(move |ev| {
            events_cb.lock().unwrap().push(ev);
        })),
    )
    .unwrap();

    std::fs::write(vault.join("Triggered.md"), "# Triggered\nHello.\n").unwrap();
    watcher.trigger_reconcile();

    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if !events.lock().unwrap().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let recorded = events.lock().unwrap();
    assert!(!recorded.is_empty());
    assert_eq!(recorded[0].vault_id, vault_id);
    drop(recorded);
    watcher.stop();

    let _ = std::fs::remove_dir_all(&base);
}

#[cfg(windows)]
#[test]
fn skips_windows_offline_cloud_placeholder_attributes() {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_OFFLINE};

    assert!(is_cloud_placeholder_attrs(WIN_ATTR_OFFLINE));
    assert!(is_cloud_placeholder_attrs(WIN_ATTR_RECALL_ON_OPEN));
    assert!(is_cloud_placeholder_attrs(WIN_ATTR_RECALL_ON_DATA_ACCESS));
    assert!(!is_cloud_placeholder_attrs(0x20)); // FILE_ATTRIBUTE_ARCHIVE

    let base = std::env::temp_dir().join(format!("pb-offline-attr-{}", Uuid::new_v4()));
    let vault = base.join("vault");
    std::fs::create_dir_all(&vault).unwrap();
    let normal = vault.join("Local.md");
    let placeholder = vault.join("CloudOnly.md");
    std::fs::write(&normal, b"# Local").unwrap();
    std::fs::write(&placeholder, b"# Cloud placeholder").unwrap();

    let wide: Vec<u16> = placeholder
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a valid null-terminated UTF-16 path.
    let ok = unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_OFFLINE) };
    assert_ne!(
        ok, 0,
        "SetFileAttributesW FILE_ATTRIBUTE_OFFLINE should succeed"
    );

    let scan = scan_vault(&vault).expect("scan_vault skips offline placeholder cleanly");
    assert_eq!(scan.notes.len(), 1);
    assert_eq!(scan.notes[0].rel_path, "Local.md");
    assert!(scan
        .diagnostics
        .iter()
        .any(|d| d.rel_path == "CloudOnly.md" && d.kind == "file_skipped"));

    let _ = unsafe { SetFileAttributesW(wide.as_ptr(), 0x80) };
    let _ = std::fs::remove_dir_all(&base);
}
