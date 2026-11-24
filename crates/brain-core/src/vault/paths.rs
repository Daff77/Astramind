use crate::domain::errors::CoreError;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const INVALID_WIN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Validates a vault-relative UTF-8 `/` path per `DATA_SCHEMA.md` §2 and `SYSTEM_ARCHITECTURE.md` §10.
pub fn validate_relative_path(rel_path: &str) -> Result<Vec<String>, CoreError> {
    if rel_path.is_empty() {
        return Err(CoreError::InvalidInput(
            "relative path cannot be empty".to_string(),
        ));
    }
    if rel_path.starts_with('/') || rel_path.starts_with('\\') || rel_path.contains('\\') {
        return Err(CoreError::AccessDenied(
            "relative path must use forward slashes without leading separator".to_string(),
        ));
    }
    if rel_path.contains(':') {
        return Err(CoreError::AccessDenied(
            "drive prefixes and alternate data streams are prohibited".to_string(),
        ));
    }

    let mut segments = Vec::new();
    for seg in rel_path.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(CoreError::AccessDenied(
                "invalid path segment or directory traversal".to_string(),
            ));
        }
        if seg
            .chars()
            .any(|c| c.is_control() || INVALID_WIN_CHARS.contains(&c))
        {
            return Err(CoreError::InvalidInput(
                "path contains prohibited Windows characters".to_string(),
            ));
        }
        if seg.ends_with('.') || seg.ends_with(' ') {
            return Err(CoreError::InvalidInput(
                "path segment cannot end with a dot or space".to_string(),
            ));
        }
        let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
        if RESERVED_DEVICE_NAMES.contains(&stem.as_str()) {
            return Err(CoreError::InvalidInput(
                "path uses a reserved Windows device name".to_string(),
            ));
        }
        segments.push(seg.to_string());
    }
    Ok(segments)
}

/// Canonicalizes a vault root directory and refuses reparse points on the root itself.
pub fn validate_vault_root(vault_root: &Path) -> Result<PathBuf, CoreError> {
    if !vault_root.exists() {
        return Err(CoreError::VaultUnavailable(
            "vault root directory does not exist".to_string(),
        ));
    }
    let handle = open_reparse_aware_dir(vault_root)?;
    if is_reparse_point_handle(&handle)? {
        return Err(CoreError::AccessDenied(
            "vault root cannot be a symlink, junction, or reparse point".to_string(),
        ));
    }
    final_path_from_handle(&handle)
}

/// Resolves an existing regular file strictly inside `vault_root`, denying reparse hops,
/// escape via junctions/symlinks, and hardlinks (`nNumberOfLinks > 1`).
pub fn resolve_guarded_existing_file(
    vault_root: &Path,
    rel_path: &str,
) -> Result<(PathBuf, File), CoreError> {
    let canonical_root = validate_vault_root(vault_root)?;
    let segments = validate_relative_path(rel_path)?;

    let mut current = canonical_root.clone();
    for (idx, seg) in segments.iter().enumerate() {
        current.push(seg);
        let is_last = idx + 1 == segments.len();
        if !is_last {
            let dir_handle = open_reparse_aware_dir(&current)?;
            if is_reparse_point_handle(&dir_handle)? {
                return Err(CoreError::AccessDenied(
                    "reparse points and junctions inside vault are denied".to_string(),
                ));
            }
            let dir_final = final_path_from_handle(&dir_handle)?;
            ensure_within_root(&canonical_root, &dir_final)?;
        }
    }

    let file = open_reparse_aware_file_read(&current)?;
    verify_regular_non_hardlink_within_root(&canonical_root, &file)?;
    let final_file = final_path_from_handle(&file)?;
    Ok((final_file, file))
}

/// Validates every existing ancestor directory for a target relative path prior to create/replace.
/// If the target file already exists, verifies it is not a reparse point or hardlink.
pub fn resolve_guarded_target_for_write(
    vault_root: &Path,
    rel_path: &str,
) -> Result<(PathBuf, bool), CoreError> {
    let canonical_root = validate_vault_root(vault_root)?;
    let segments = validate_relative_path(rel_path)?;

    let mut current = canonical_root.clone();
    for (idx, seg) in segments.iter().enumerate() {
        current.push(seg);
        let is_last = idx + 1 == segments.len();
        if !is_last && current.exists() {
            let dir_handle = open_reparse_aware_dir(&current)?;
            if is_reparse_point_handle(&dir_handle)? {
                return Err(CoreError::AccessDenied(
                    "reparse points and junctions inside vault are denied".to_string(),
                ));
            }
            let dir_final = final_path_from_handle(&dir_handle)?;
            ensure_within_root(&canonical_root, &dir_final)?;
        }
    }

    if current.exists() {
        let existing = open_reparse_aware_file_read(&current)?;
        verify_regular_non_hardlink_within_root(&canonical_root, &existing)?;
        let final_file = final_path_from_handle(&existing)?;
        Ok((final_file, true))
    } else {
        Ok((current, false))
    }
}

fn ensure_within_root(canonical_root: &Path, candidate: &Path) -> Result<(), CoreError> {
    if candidate.starts_with(canonical_root) {
        Ok(())
    } else {
        Err(CoreError::AccessDenied(
            "resolved path escapes authorized vault root".to_string(),
        ))
    }
}

#[cfg(windows)]
fn open_reparse_aware_dir(path: &Path) -> Result<File, CoreError> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|err| CoreError::from_io("open guarded directory", &err))
}

#[cfg(windows)]
fn open_reparse_aware_file_read(path: &Path) -> Result<File, CoreError> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|err| CoreError::from_io("open guarded file", &err))
}

#[cfg(windows)]
fn is_reparse_point_handle(file: &File) -> Result<bool, CoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    };

    // SAFETY: `BY_HANDLE_FILE_INFORMATION` is POD and overwritten by `GetFileInformationByHandle`.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file.as_raw_handle()` is a valid open handle.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(CoreError::IoFailed(
            "GetFileInformationByHandle failed".to_string(),
        ));
    }
    Ok((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
}

#[cfg(windows)]
fn verify_regular_non_hardlink_within_root(
    canonical_root: &Path,
    file: &File,
) -> Result<(), CoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };

    // SAFETY: `BY_HANDLE_FILE_INFORMATION` is POD and populated by `GetFileInformationByHandle`.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file.as_raw_handle()` is a valid open file handle.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(CoreError::IoFailed(
            "GetFileInformationByHandle failed".to_string(),
        ));
    }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
        return Err(CoreError::AccessDenied(
            "reparse point files are denied".to_string(),
        ));
    }
    if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return Err(CoreError::InvalidInput(
            "target path is a directory, not a regular note file".to_string(),
        ));
    }
    if info.nNumberOfLinks > 1 {
        return Err(CoreError::AccessDenied(
            "hardlinked files are denied for mutation or agent access".to_string(),
        ));
    }

    let final_path = final_path_from_handle(file)?;
    ensure_within_root(canonical_root, &final_path)
}

#[cfg(windows)]
fn final_path_from_handle(file: &File) -> Result<PathBuf, CoreError> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: `file.as_raw_handle()` is valid and `buf` provides `buf.len()` writable `u16` elements.
        let needed = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buf.as_mut_ptr(),
                buf.len() as u32,
                flags,
            )
        };
        if needed == 0 {
            return Err(CoreError::IoFailed(
                "GetFinalPathNameByHandleW failed".to_string(),
            ));
        }
        let needed = needed as usize;
        if needed < buf.len() {
            return Ok(PathBuf::from(OsString::from_wide(&buf[..needed])));
        }
        buf.resize(needed + 1, 0);
    }
}

#[cfg(not(windows))]
fn open_reparse_aware_dir(path: &Path) -> Result<File, CoreError> {
    File::open(path).map_err(|err| CoreError::from_io("open dir", &err))
}

#[cfg(not(windows))]
fn open_reparse_aware_file_read(path: &Path) -> Result<File, CoreError> {
    File::open(path).map_err(|err| CoreError::from_io("open file", &err))
}

#[cfg(not(windows))]
fn is_reparse_point_handle(_file: &File) -> Result<bool, CoreError> {
    Ok(false)
}

#[cfg(not(windows))]
fn verify_regular_non_hardlink_within_root(
    _canonical_root: &Path,
    _file: &File,
) -> Result<(), CoreError> {
    Ok(())
}

#[cfg(not(windows))]
fn final_path_from_handle(_file: &File) -> Result<PathBuf, CoreError> {
    Err(CoreError::IoFailed("unsupported platform".to_string()))
}
