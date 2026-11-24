use brain_core::index::{
    open_readonly_generation_index, query_generation_index, write_generation_index,
};
use brain_core::paths::AppPathsSpec;
use uuid::Uuid;

#[test]
fn generation_named_index_avoids_windows_sharing_violation() {
    let vault_dir = std::env::temp_dir().join(format!("pb-idx-gen-{}", Uuid::new_v4()));

    // Generation 1 written and held open by an active reader
    let gen1_path = write_generation_index(
        &vault_dir,
        1,
        &[("note-1", "Alpha", "Initial indexed content")],
    )
    .expect("write generation 1 index");
    let reader1 =
        open_readonly_generation_index(&gen1_path).expect("open generation 1 readonly reader");
    assert_eq!(
        query_generation_index(&reader1, "Initial").expect("query gen1"),
        vec!["note-1".to_string()]
    );

    // While reader1 still holds index-1.sqlite open, write generation 2 without touching index-1.sqlite
    let gen2_path = write_generation_index(
        &vault_dir,
        2,
        &[
            ("note-1", "Alpha", "Initial indexed content"),
            ("note-2", "Beta", "Second generation FTS5 entry"),
        ],
    )
    .expect("write generation 2 index while gen1 is open");
    assert!(gen2_path.ends_with("index-2.sqlite"));

    // New reader on generation 2 sees updated data immediately
    let reader2 =
        open_readonly_generation_index(&gen2_path).expect("open generation 2 readonly reader");
    assert_eq!(
        query_generation_index(&reader2, "Second").expect("query gen2"),
        vec!["note-2".to_string()]
    );

    // Old reader still works cleanly until it switches generation and drops reader1
    assert_eq!(
        query_generation_index(&reader1, "Initial").expect("query gen1 still alive"),
        vec!["note-1".to_string()]
    );
    drop(reader1);
    drop(reader2);

    // Once old reader drops handle, old generation file unlinks cleanly
    std::fs::remove_file(AppPathsSpec::index_file_in(&vault_dir, 1))
        .expect("unlink old index-1.sqlite after reader drops");

    // Temp-staged exclusive publish must fail with Conflict if generation already exists
    let dup = write_generation_index(&vault_dir, 2, &[("note-3", "Gamma", "Should fail")]);
    assert!(matches!(
        dup.expect_err("duplicate generation must fail closed")
            .code(),
        brain_core::domain::errors::ErrorCode::Conflict
    ));

    let _ = std::fs::remove_dir_all(&vault_dir);
}
