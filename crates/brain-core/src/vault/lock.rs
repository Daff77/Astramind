use crate::domain::errors::CoreError;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

/// Exclusive cross-process per-vault lock backed by Windows `LockFileEx` (ADR-0001).
#[derive(Debug)]
pub struct VaultLock {
    file: File,
    path: PathBuf,
}

impl VaultLock {
    pub fn acquire(lock_path: &Path, timeout: Duration) -> Result<Self, CoreError> {
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| CoreError::from_io_dir("create lock directory", &err))?;
        }

        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|err| CoreError::from_io("open vault lock file", &err))?;

        let deadline = Instant::now() + timeout;
        loop {
            if try_lock_exclusive(&file)? {
                return Ok(Self {
                    file,
                    path: lock_path.to_path_buf(),
                });
            }
            if Instant::now() >= deadline {
                return Err(CoreError::Busy(
                    "vault is currently locked by another Personal Brain operation".to_string(),
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for VaultLock {
    fn drop(&mut self) {
        let _ = unlock_exclusive(&self.file);
    }
}

#[cfg(windows)]
fn try_lock_exclusive(file: &File) -> Result<bool, CoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_LOCK_VIOLATION};
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    // SAFETY: `OVERLAPPED` is POD; zero-initialization specifies byte offset 0.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let handle = file.as_raw_handle();
    // SAFETY: `handle` is an open file handle owned by `file` for the duration of this call.
    let ok = unsafe {
        LockFileEx(
            handle,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    };
    if ok != 0 {
        return Ok(true);
    }

    // SAFETY: `GetLastError` reads thread-local Win32 last error set by `LockFileEx`.
    let err = unsafe { GetLastError() };
    if err == ERROR_LOCK_VIOLATION {
        Ok(false)
    } else {
        Err(CoreError::IoFailed(format!(
            "LockFileEx failed with OS error {err}"
        )))
    }
}

#[cfg(windows)]
fn unlock_exclusive(file: &File) -> Result<(), CoreError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    use windows_sys::Win32::System::IO::OVERLAPPED;

    // SAFETY: `OVERLAPPED` is POD; zero-initialization specifies byte offset 0.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let handle = file.as_raw_handle();
    // SAFETY: `handle` is owned by `file` and matches the 1-byte lock at offset 0.
    let ok = unsafe { UnlockFileEx(handle, 0, 1, 0, &mut overlapped) };
    if ok != 0 {
        Ok(())
    } else {
        Err(CoreError::IoFailed("UnlockFileEx failed".to_string()))
    }
}

#[cfg(not(windows))]
fn try_lock_exclusive(_file: &File) -> Result<bool, CoreError> {
    Ok(true)
}

#[cfg(not(windows))]
fn unlock_exclusive(_file: &File) -> Result<(), CoreError> {
    Ok(())
}
