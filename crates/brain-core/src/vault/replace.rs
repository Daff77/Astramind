use crate::domain::errors::CoreError;
use crate::vault::paths::{resolve_guarded_existing_file, resolve_guarded_target_for_write};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplacePrimitive {
    MoveFileExWriteThrough,
    ReplaceFile,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceOutcome {
    pub path: PathBuf,
    pub old_hash: Option<String>,
    pub new_hash: String,
    pub bytes_written: usize,
}

#[must_use]
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Safely creates or replaces a guarded note inside `vault_root` using:
/// 1. Guarded path & non-hardlink verification
/// 2. Live SHA-256 check against `expected_hash` (preserving attempted edit on conflict)
/// 3. Same-directory temp file + `sync_all()` + NTFS replacement primitive + read-back verification
pub fn safe_replace_note(
    vault_root: &Path,
    rel_path: &str,
    expected_hash: Option<&str>,
    new_bytes: &[u8],
    recovery_dir: Option<&Path>,
    primitive: ReplacePrimitive,
) -> Result<ReplaceOutcome, CoreError> {
    let (target_path, exists) = resolve_guarded_target_for_write(vault_root, rel_path)?;
    let old_hash = if exists {
        let (_, mut existing_file) = resolve_guarded_existing_file(vault_root, rel_path)?;
        let mut live_bytes = Vec::new();
        existing_file
            .read_to_end(&mut live_bytes)
            .map_err(|err| CoreError::from_io("read live note", &err))?;
        let actual_hash = sha256_hex(&live_bytes);

        match expected_hash {
            None => {
                preserve_recovery_copy(recovery_dir, rel_path, new_bytes)?;
                return Err(CoreError::Conflict(
                    "destination note already exists (create requires empty target)".to_string(),
                ));
            }
            Some(expected) if expected != actual_hash => {
                preserve_recovery_copy(recovery_dir, rel_path, new_bytes)?;
                return Err(CoreError::Conflict(
                    "note was modified on disk since last read; attempted edit preserved in recovery"
                        .to_string(),
                ));
            }
            Some(_) => Some(actual_hash),
        }
    } else {
        if expected_hash.is_some() {
            preserve_recovery_copy(recovery_dir, rel_path, new_bytes)?;
            return Err(CoreError::Conflict(
                "target note no longer exists on disk".to_string(),
            ));
        }
        None
    };

    let parent = target_path.parent().ok_or_else(|| {
        CoreError::InvalidInput("target path has no parent directory".to_string())
    })?;
    fs::create_dir_all(parent).map_err(|err| CoreError::from_io("create note parent dir", &err))?;

    let temp_name = format!(".pb-tmp-{}.tmp", Uuid::new_v4());
    let temp_path = parent.join(temp_name);
    {
        let mut tmp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|err| CoreError::from_io("create temp note file", &err))?;
        tmp_file
            .write_all(new_bytes)
            .map_err(|err| CoreError::from_io("write temp note file", &err))?;
        tmp_file
            .sync_all()
            .map_err(|err| CoreError::from_io("flush temp note file", &err))?;
    }

    let replace_res = if exists {
        match primitive {
            ReplacePrimitive::MoveFileExWriteThrough => win_move_file_ex(&temp_path, &target_path),
            ReplacePrimitive::ReplaceFile => win_replace_file(&target_path, &temp_path),
        }
    } else {
        win_move_file_ex(&temp_path, &target_path)
    };

    if let Err(err) = replace_res {
        let _ = fs::remove_file(&temp_path);
        return Err(err);
    }

    let (_, mut verified_file) = resolve_guarded_existing_file(vault_root, rel_path)?;
    let mut written_bytes = Vec::new();
    verified_file
        .read_to_end(&mut written_bytes)
        .map_err(|err| CoreError::from_io("verify written note", &err))?;
    let expected_new_hash = sha256_hex(new_bytes);
    let actual_new_hash = sha256_hex(&written_bytes);
    if actual_new_hash != expected_new_hash {
        return Err(CoreError::RecoveryRequired(
            "post-replace byte verification mismatch".to_string(),
        ));
    }

    Ok(ReplaceOutcome {
        path: target_path,
        old_hash,
        new_hash: actual_new_hash,
        bytes_written: new_bytes.len(),
    })
}

fn preserve_recovery_copy(
    recovery_dir: Option<&Path>,
    rel_path: &str,
    attempted_bytes: &[u8],
) -> Result<(), CoreError> {
    let Some(dir) = recovery_dir else {
        return Ok(());
    };
    fs::create_dir_all(dir).map_err(|err| CoreError::from_io("create recovery dir", &err))?;
    let sanitized = rel_path.replace(['/', '\\'], "_");
    let rec_path = dir.join(format!("{sanitized}.{}.recovery.md", Uuid::new_v4()));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&rec_path)
        .map_err(|err| CoreError::from_io("create recovery file", &err))?;
    f.write_all(attempted_bytes)
        .map_err(|err| CoreError::from_io("write recovery file", &err))?;
    f.sync_all()
        .map_err(|err| CoreError::from_io("flush recovery file", &err))?;
    Ok(())
}

#[cfg(windows)]
fn to_wide_null(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn win_move_file_ex(src: &Path, dst: &Path) -> Result<(), CoreError> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let src_w = to_wide_null(src);
    let dst_w = to_wide_null(dst);
    // SAFETY: `src_w` and `dst_w` are null-terminated UTF-16 buffers.
    let ok = unsafe {
        MoveFileExW(
            src_w.as_ptr(),
            dst_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok != 0 {
        Ok(())
    } else {
        // SAFETY: reads thread-local last error set by `MoveFileExW`.
        let err = unsafe { GetLastError() };
        Err(CoreError::IoFailed(format!(
            "MoveFileExW failed with OS error {err}"
        )))
    }
}

#[cfg(windows)]
fn win_replace_file(replaced: &Path, replacement: &Path) -> Result<(), CoreError> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let replaced_w = to_wide_null(replaced);
    let replacement_w = to_wide_null(replacement);
    // SAFETY: `replaced_w` and `replacement_w` are valid null-terminated UTF-16 buffers;
    // backup and reserved pointers are intentionally null.
    let ok = unsafe {
        ReplaceFileW(
            replaced_w.as_ptr(),
            replacement_w.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok != 0 {
        Ok(())
    } else {
        // SAFETY: reads thread-local last error set by `ReplaceFileW`.
        let err = unsafe { GetLastError() };
        Err(CoreError::IoFailed(format!(
            "ReplaceFileW failed with OS error {err}"
        )))
    }
}

#[cfg(not(windows))]
fn win_move_file_ex(src: &Path, dst: &Path) -> Result<(), CoreError> {
    fs::rename(src, dst).map_err(|err| CoreError::from_io("rename note", &err))
}

#[cfg(not(windows))]
fn win_replace_file(replaced: &Path, replacement: &Path) -> Result<(), CoreError> {
    fs::rename(replacement, replaced).map_err(|err| CoreError::from_io("replace note", &err))
}
