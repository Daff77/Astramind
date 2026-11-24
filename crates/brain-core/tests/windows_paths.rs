use brain_core::domain::errors::ErrorCode;
use brain_core::vault::paths::{
    resolve_guarded_existing_file, resolve_guarded_target_for_write, validate_relative_path,
};
use std::process::Command;
use uuid::Uuid;

#[test]
fn rejects_traversal_ads_reserved_and_trailing_names() {
    let invalid_cases = [
        "",
        "../outside.md",
        "folder/../../escape.md",
        "/leading/slash.md",
        "folder\\backslash.md",
        "C:/Windows/win.ini",
        "//server/share/note.md",
        "note.md:hidden_stream",
        "CON.md",
        "folder/nul",
        "COM1.md",
        "trailing_dot.",
        "trailing_space ",
        "a//b.md",
    ];
    for case in invalid_cases {
        let res = validate_relative_path(case);
        assert!(
            res.is_err(),
            "expected relative path `{case}` to be rejected"
        );
    }

    assert!(validate_relative_path("Projects/Alpha/Decision 01.md").is_ok());
}

#[cfg(windows)]
#[test]
fn denies_ntfs_junction_escape_and_hardlinks() {
    let sandbox = std::env::temp_dir().join(format!("pb-path-sec-{}", Uuid::new_v4()));
    let vault = sandbox.join("vault");
    let outside = sandbox.join("outside");
    std::fs::create_dir_all(&vault).expect("create vault");
    std::fs::create_dir_all(&outside).expect("create outside");

    let secret_outside = outside.join("secret.md");
    std::fs::write(&secret_outside, b"outside secret").expect("write outside file");

    let normal_note = vault.join("normal.md");
    std::fs::write(&normal_note, b"inside vault").expect("write normal note");

    // 1. Valid normal note succeeds
    let (_, file) = resolve_guarded_existing_file(&vault, "normal.md")
        .expect("normal inside-vault file should succeed");
    drop(file);

    // 2. NTFS Directory Junction inside vault pointing outside must be denied
    let junction = vault.join("escape_link");
    let status = Command::new("cmd")
        .args([
            "/C",
            "mklink",
            "/J",
            &junction.to_string_lossy(),
            &outside.to_string_lossy(),
        ])
        .status()
        .expect("run mklink /J");
    assert!(status.success(), "mklink /J should succeed on NTFS");

    let j_err = resolve_guarded_existing_file(&vault, "escape_link/secret.md")
        .expect_err("junction escape must be denied");
    assert_eq!(j_err.code(), ErrorCode::AccessDenied);

    let j_write_err = resolve_guarded_target_for_write(&vault, "escape_link/new.md")
        .expect_err("write through junction must be denied");
    assert_eq!(j_write_err.code(), ErrorCode::AccessDenied);

    // 3. Hardlinked file pointing outside vault must be denied (nNumberOfLinks > 1)
    let hardlink = vault.join("hardlink.md");
    std::fs::hard_link(&secret_outside, &hardlink).expect("create hardlink");

    let hl_err = resolve_guarded_existing_file(&vault, "hardlink.md")
        .expect_err("hardlinked file read must be denied");
    assert_eq!(hl_err.code(), ErrorCode::AccessDenied);

    let hl_write_err = resolve_guarded_target_for_write(&vault, "hardlink.md")
        .expect_err("hardlinked file write must be denied");
    assert_eq!(hl_write_err.code(), ErrorCode::AccessDenied);

    // Clean up junction before removing sandbox
    let _ = Command::new("cmd")
        .args(["/C", "rmdir", &junction.to_string_lossy()])
        .status();
    let _ = std::fs::remove_dir_all(&sandbox);
}
