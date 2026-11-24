use brain_core::domain::errors::ErrorCode;
use brain_core::vault::replace::{safe_replace_note, sha256_hex, ReplacePrimitive};
use uuid::Uuid;

#[test]
fn safe_replace_protects_against_conflicts_and_verifies_bytes() {
    let sandbox = std::env::temp_dir().join(format!("pb-replace-test-{}", Uuid::new_v4()));
    let vault = sandbox.join("vault");
    let recovery = sandbox.join("recovery");
    std::fs::create_dir_all(&vault).expect("create vault");

    // 1. Create new note (no-overwrite)
    let v1 = b"# Note\nInitial content.\n";
    let create_out = safe_replace_note(
        &vault,
        "Projects/Spec.md",
        None,
        v1,
        Some(&recovery),
        ReplacePrimitive::MoveFileExWriteThrough,
    )
    .expect("initial create succeeds");
    assert_eq!(create_out.old_hash, None);
    assert_eq!(create_out.new_hash, sha256_hex(v1));

    // Creating again at same path without expected_hash must fail with Conflict
    let dup_err = safe_replace_note(
        &vault,
        "Projects/Spec.md",
        None,
        b"overwrite attempt",
        Some(&recovery),
        ReplacePrimitive::MoveFileExWriteThrough,
    )
    .expect_err("duplicate create must conflict");
    assert_eq!(dup_err.code(), ErrorCode::Conflict);

    // 2. Update via MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)
    let v2 = b"# Note\nUpdated via MoveFileExW.\n";
    let upd_out = safe_replace_note(
        &vault,
        "Projects/Spec.md",
        Some(&create_out.new_hash),
        v2,
        Some(&recovery),
        ReplacePrimitive::MoveFileExWriteThrough,
    )
    .expect("MoveFileExW update succeeds");
    assert_eq!(
        upd_out.old_hash.as_deref(),
        Some(create_out.new_hash.as_str())
    );

    // 3. Update via ReplaceFileW for ADR-0002 comparison
    let v3 = b"# Note\nUpdated via ReplaceFileW.\n";
    let rf_out = safe_replace_note(
        &vault,
        "Projects/Spec.md",
        Some(&upd_out.new_hash),
        v3,
        Some(&recovery),
        ReplacePrimitive::ReplaceFile,
    )
    .expect("ReplaceFileW update succeeds");
    assert_eq!(rf_out.new_hash, sha256_hex(v3));

    // 4. Simulate competing external editor (Obsidian) modifying the note on disk
    let external_bytes = b"# Note\nEdited externally in Obsidian.\n";
    std::fs::write(vault.join("Projects/Spec.md"), external_bytes).expect("external edit");

    // App tries to save with stale hash -> must return Conflict, keep external edit, and save recovery copy
    let attempted = b"# Note\nUnsaved desktop edit.\n";
    let conflict_err = safe_replace_note(
        &vault,
        "Projects/Spec.md",
        Some(&rf_out.new_hash),
        attempted,
        Some(&recovery),
        ReplacePrimitive::MoveFileExWriteThrough,
    )
    .expect_err("stale hash must return Conflict");
    assert_eq!(conflict_err.code(), ErrorCode::Conflict);

    let disk_after = std::fs::read(vault.join("Projects/Spec.md")).expect("read disk after");
    assert_eq!(disk_after, external_bytes);

    let rec_files: Vec<_> = std::fs::read_dir(&recovery)
        .expect("read recovery dir")
        .collect::<Result<Vec<_>, _>>()
        .expect("list recovery entries");
    assert!(
        rec_files.len() >= 2,
        "conflict recovery copies must be preserved"
    );

    let _ = std::fs::remove_dir_all(&sandbox);
}
