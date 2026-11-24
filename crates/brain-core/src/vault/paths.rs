use crate::domain::errors::CoreError;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

const RESERVED_DEVICE_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const INVALID_WIN_CHARS: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows cloud-placeholder attributes (OneDrive Files On-Demand).
pub const WIN_ATTR_OFFLINE: u32 = 0x0000_1000;
pub const WIN_ATTR_RECALL_ON_OPEN: u32 = 0x0004_0000;
pub const WIN_ATTR_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;

#[must_use]
pub fn is_cloud_placeholder_attrs(attrs: u32) -> bool {
    (attrs & (WIN_ATTR_OFFLINE | WIN_ATTR_RECALL_ON_OPEN | WIN_ATTR_RECALL_ON_DATA_ACCESS)) != 0
}

#[must_use]
pub fn is_excluded_entry(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".obsidian"
        || lower == ".git"
        || lower == ".ds_store"
        || lower == "thumbs.db"
        || lower.starts_with(".pb-tmp-")
        || lower.starts_with("~$")
}

/// Normalized comparison key for vault-relative paths (`/`-separated, simple Unicode uppercase).
#[must_use]
pub fn path_key(rel_path: &str) -> String {
    rel_path.to_uppercase()
}

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

/// Canonicalizes a vault root directory via an OS handle, refusing reparse points and non-directories.
pub fn validate_vault_root(vault_root: &Path) -> Result<PathBuf, CoreError> {
    let handle = open_reparse_aware_dir(vault_root)
        .map_err(|err| CoreError::from_io_vault("open vault root", &err))?;
    let info = file_info_from_handle(&handle)?;
    if info.is_reparse_point {
        return Err(CoreError::AccessDenied(
            "vault root cannot be a symlink, junction, or reparse point".to_string(),
        ));
    }
    if !info.is_directory {
        return Err(CoreError::InvalidInput(
            "vault root path must be a directory".to_string(),
        ));
    }
    final_path_from_handle(&handle)
}

/// Stable OS root identity combining canonical normalized path key + volume serial number.
pub fn canonical_root_identity(vault_root: &Path) -> Result<(PathBuf, String), CoreError> {
    let handle = open_reparse_aware_dir(vault_root)
        .map_err(|err| CoreError::from_io_vault("open vault root", &err))?;
    let info = file_info_from_handle(&handle)?;
    if info.is_reparse_point {
        return Err(CoreError::AccessDenied(
            "vault root cannot be a symlink, junction, or reparse point".to_string(),
        ));
    }
    if !info.is_directory {
        return Err(CoreError::InvalidInput(
            "vault root path must be a directory".to_string(),
        ));
    }
    let final_path = final_path_from_handle(&handle)?;
    let norm = final_path.to_string_lossy().to_uppercase();
    let identity = format!("vol:{:08x}:{}", info.volume_serial, norm);
    Ok((final_path, identity))
}

/// Non-portable OS file identity hint `(volume_serial:index_high:index_low)` from an open handle.
pub fn file_identity_from_handle(file: &File) -> Result<String, CoreError> {
    let info = file_info_from_handle(file)?;
    Ok(format!(
        "{:08x}:{:08x}:{:08x}",
        info.volume_serial, info.index_high, info.index_low
    ))
}

/// Opens a regular directory handle with reparse-point awareness, verifying it is a real directory
/// inside `canonical_root` (used by vault scanner and directory checks).
pub fn open_guarded_dir(canonical_root: &Path, dir_path: &Path) -> Result<File, CoreError> {
    let handle = open_reparse_aware_dir(dir_path)
        .map_err(|err| CoreError::from_io_dir("open guarded directory", &err))?;
    let info = file_info_from_handle(&handle)?;
    if info.is_reparse_point {
        return Err(CoreError::AccessDenied(
            "reparse points and junctions inside vault are denied".to_string(),
        ));
    }
    if !info.is_directory {
        return Err(CoreError::InvalidInput(
            "expected directory inside vault".to_string(),
        ));
    }
    let final_path = final_path_from_handle(&handle)?;
    ensure_within_root(canonical_root, &final_path)?;
    Ok(handle)
}

/// Resolves an existing regular file strictly inside `vault_root`, denying reparse hops,
/// non-directory intermediate hops, escape via junctions/symlinks, and hardlinks (`nNumberOfLinks > 1`).
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
            open_guarded_dir(&canonical_root, &current)?;
        }
    }

    let file = open_reparse_aware_file_read(&current)
        .map_err(|err| CoreError::from_io("open guarded file", &err))?;
    verify_regular_non_hardlink_within_root(&canonical_root, &file)?;
    let final_file = final_path_from_handle(&file)?;
    Ok((final_file, file))
}

/// Hardened TOCTOU-resistant target validator for write/create/move:
/// - Never calls `Path::exists()` prior to handle inspection (catches dangling junctions/symlinks).
/// - Opens every intermediate segment directly with `FILE_FLAG_OPEN_REPARSE_POINT` and asserts
///   `FILE_ATTRIBUTE_DIRECTORY` + `!FILE_ATTRIBUTE_REPARSE_POINT` + root containment.
/// - Opens the final target directly with `FILE_FLAG_OPEN_REPARSE_POINT`:
///   `NotFound` -> `(current, false)`; existing -> verifies regular non-reparse non-hardlink file inside root.
pub fn resolve_guarded_target_for_write(
    vault_root: &Path,
    rel_path: &str,
) -> Result<(PathBuf, bool), CoreError> {
    let canonical_root = validate_vault_root(vault_root)?;
    let segments = validate_relative_path(rel_path)?;

    let mut current = canonical_root.clone();
    let mut missing_ancestor = false;
    for (idx, seg) in segments.iter().enumerate() {
        current.push(seg);
        let is_last = idx + 1 == segments.len();
        if !is_last {
            if missing_ancestor {
                continue;
            }
            match open_reparse_aware_dir(&current) {
                Ok(dir_handle) => {
                    let info = file_info_from_handle(&dir_handle)?;
                    if info.is_reparse_point {
                        return Err(CoreError::AccessDenied(
                            "reparse points and dangling junctions inside vault are denied"
                                .to_string(),
                        ));
                    }
                    if !info.is_directory {
                        return Err(CoreError::InvalidInput(
                            "intermediate path segment is a file, not a directory".to_string(),
                        ));
                    }
                    let dir_final = final_path_from_handle(&dir_handle)?;
                    ensure_within_root(&canonical_root, &dir_final)?;
                }
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    missing_ancestor = true;
                }
                Err(err) => {
                    return Err(CoreError::from_io_dir("inspect parent directory", &err));
                }
            }
        }
    }

    if missing_ancestor {
        return Ok((current, false));
    }

    match open_reparse_aware_file_read(&current) {
        Ok(existing) => {
            verify_regular_non_hardlink_within_root(&canonical_root, &existing)?;
            let final_file = final_path_from_handle(&existing)?;
            Ok((final_file, true))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok((current, false)),
        Err(err) => Err(CoreError::from_io("inspect target file", &err)),
    }
}

/// Safely verifies an already-opened child entry (used during vault scanning) is a regular,
/// non-reparse, non-hardlinked, non-placeholder file inside `canonical_root`.
pub fn inspect_scanned_file(
    canonical_root: &Path,
    file_path: &Path,
) -> Result<(File, ScannedFileMeta), CoreError> {
    let file = open_reparse_aware_file_read(file_path)
        .map_err(|err| CoreError::from_io("open scanned file", &err))?;
    let info = file_info_from_handle(&file)?;
    if info.is_reparse_point {
        return Err(CoreError::AccessDenied(
            "reparse point files are skipped".to_string(),
        ));
    }
    if info.is_directory {
        return Err(CoreError::InvalidInput(
            "expected file, found directory".to_string(),
        ));
    }
    if is_cloud_placeholder_attrs(info.raw_attributes) {
        return Err(CoreError::VaultUnavailable(
            "cloud placeholder file skipped without hydration".to_string(),
        ));
    }
    let final_path = final_path_from_handle(&file)?;
    ensure_within_root(canonical_root, &final_path)?;
    let identity = format!(
        "{:08x}:{:08x}:{:08x}",
        info.volume_serial, info.index_high, info.index_low
    );
    Ok((
        file,
        ScannedFileMeta {
            file_identity: identity,
            link_count: info.link_count,
        },
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScannedFileMeta {
    pub file_identity: String,
    pub link_count: u32,
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

#[derive(Debug, Clone, Copy)]
struct HandleFileInfo {
    is_reparse_point: bool,
    is_directory: bool,
    link_count: u32,
    volume_serial: u32,
    index_high: u32,
    index_low: u32,
    raw_attributes: u32,
}

#[cfg(windows)]
fn open_reparse_aware_dir(path: &Path) -> Result<File, std::io::Error> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(windows)]
fn open_reparse_aware_file_read(path: &Path) -> Result<File, std::io::Error> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

#[cfg(windows)]
fn file_info_from_handle(file: &File) -> Result<HandleFileInfo, CoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };

    // SAFETY: `BY_HANDLE_FILE_INFORMATION` is POD and populated by `GetFileInformationByHandle`.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: `file.as_raw_handle()` is a valid open handle.
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
    if ok == 0 {
        return Err(CoreError::IoFailed(
            "GetFileInformationByHandle failed".to_string(),
        ));
    }
    Ok(HandleFileInfo {
        is_reparse_point: (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0,
        is_directory: (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0,
        link_count: info.nNumberOfLinks,
        volume_serial: info.dwVolumeSerialNumber,
        index_high: info.nFileIndexHigh,
        index_low: info.nFileIndexLow,
        raw_attributes: info.dwFileAttributes,
    })
}

#[cfg(windows)]
fn verify_regular_non_hardlink_within_root(
    canonical_root: &Path,
    file: &File,
) -> Result<(), CoreError> {
    let info = file_info_from_handle(file)?;
    if info.is_reparse_point {
        return Err(CoreError::AccessDenied(
            "reparse point files are denied".to_string(),
        ));
    }
    if info.is_directory {
        return Err(CoreError::InvalidInput(
            "target path is a directory, not a regular note file".to_string(),
        ));
    }
    if is_cloud_placeholder_attrs(info.raw_attributes) {
        return Err(CoreError::VaultUnavailable(
            "cloud placeholder files are unsupported without local hydration".to_string(),
        ));
    }
    if info.link_count > 1 {
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
fn open_reparse_aware_dir(path: &Path) -> Result<File, std::io::Error> {
    File::open(path)
}

#[cfg(not(windows))]
fn open_reparse_aware_file_read(path: &Path) -> Result<File, std::io::Error> {
    File::open(path)
}

#[cfg(not(windows))]
fn file_info_from_handle(file: &File) -> Result<HandleFileInfo, CoreError> {
    let meta = file
        .metadata()
        .map_err(|err| CoreError::from_io("stat file", &err))?;
    Ok(HandleFileInfo {
        is_reparse_point: meta.file_type().is_symlink(),
        is_directory: meta.is_dir(),
        link_count: 1,
        volume_serial: 0,
        index_high: 0,
        index_low: 0,
        raw_attributes: 0,
    })
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
