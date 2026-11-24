use crate::domain::errors::CoreError;
use crate::domain::ids::VaultId;
use crate::domain::types::AppPathsDto;
use std::path::{Path, PathBuf};

/// Resolves the shared OS per-user application data directory (`%LOCALAPPDATA%\PersonalBrain`)
/// via Windows Known Folder APIs so desktop and `brain-mcp` agree on registry and vault paths.
pub fn resolve_app_data_root() -> Result<PathBuf, CoreError> {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        use std::ptr;
        use windows_sys::Win32::System::Com::CoTaskMemFree;
        use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath};

        let mut raw_ptr: *mut u16 = ptr::null_mut();
        // SAFETY: `FOLDERID_LocalAppData` is a valid static GUID, `raw_ptr` is stack-allocated
        // out-pointer, and if `SHGetKnownFolderPath` allocates it, `CoTaskMemFree` frees it below.
        let hr = unsafe {
            SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, ptr::null_mut(), &mut raw_ptr)
        };
        if hr != 0 || raw_ptr.is_null() {
            if !raw_ptr.is_null() {
                // SAFETY: `raw_ptr` was allocated by `SHGetKnownFolderPath`.
                unsafe { CoTaskMemFree(raw_ptr.cast()) };
            }
            return Err(CoreError::StateUnavailable(
                "failed to resolve Windows LocalAppData folder".to_string(),
            ));
        }

        let wide_len = {
            let mut len = 0usize;
            // SAFETY: `SHGetKnownFolderPath` returns a null-terminated UTF-16 string on success.
            while unsafe { *raw_ptr.add(len) } != 0 {
                len += 1;
            }
            len
        };
        // SAFETY: `raw_ptr` points to `wide_len` valid `u16` code units.
        let slice = unsafe { std::slice::from_raw_parts(raw_ptr, wide_len) };
        let base = OsString::from_wide(slice);
        // SAFETY: `raw_ptr` was allocated by `SHGetKnownFolderPath` and is no longer used after copy.
        unsafe { CoTaskMemFree(raw_ptr.cast()) };

        Ok(PathBuf::from(base).join("PersonalBrain"))
    }

    #[cfg(not(windows))]
    {
        let home = std::env::var_os("HOME").ok_or_else(|| {
            CoreError::StateUnavailable("unable to resolve application data root".to_string())
        })?;
        Ok(PathBuf::from(home).join(".local/share/PersonalBrain"))
    }
}

#[derive(Debug, Clone)]
pub struct AppPathsSpec {
    pub app_data_dir: PathBuf,
    pub registry_db: PathBuf,
    pub vaults_dir: PathBuf,
}

impl AppPathsSpec {
    pub fn resolve_default() -> Result<Self, CoreError> {
        Ok(Self::from_root(resolve_app_data_root()?))
    }

    #[must_use]
    pub fn from_root(app_data_dir: PathBuf) -> Self {
        let registry_db = app_data_dir.join("registry.sqlite");
        let vaults_dir = app_data_dir.join("vaults");
        Self {
            app_data_dir,
            registry_db,
            vaults_dir,
        }
    }

    #[must_use]
    pub fn vault_dir(&self, vault_id: &VaultId) -> PathBuf {
        self.vaults_dir.join(vault_id.as_str())
    }

    #[must_use]
    pub fn vault_state_db(&self, vault_id: &VaultId) -> PathBuf {
        self.vault_dir(vault_id).join("state.sqlite")
    }

    #[must_use]
    pub fn vault_lock_file(&self, vault_id: &VaultId) -> PathBuf {
        self.vault_dir(vault_id).join("vault.lock")
    }

    #[must_use]
    pub fn vault_index_db(&self, vault_id: &VaultId, generation: u64) -> PathBuf {
        Self::index_file_in(&self.vault_dir(vault_id), generation)
    }

    #[must_use]
    pub fn index_file_in(dir: &Path, generation: u64) -> PathBuf {
        dir.join(format!("index-{generation}.sqlite"))
    }

    #[must_use]
    pub fn to_dto(&self) -> AppPathsDto {
        AppPathsDto {
            app_data_dir: self.app_data_dir.to_string_lossy().into_owned(),
            registry_db: self.registry_db.to_string_lossy().into_owned(),
            vaults_dir: self.vaults_dir.to_string_lossy().into_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_personal_brain_app_data_dir() {
        let paths = AppPathsSpec::resolve_default().expect("LocalAppData resolves");
        assert!(paths.app_data_dir.ends_with("PersonalBrain"));
        assert!(paths.registry_db.ends_with("registry.sqlite"));
        let vault_id = VaultId::new_v4();
        assert!(paths
            .vault_index_db(&vault_id, 3)
            .ends_with("index-3.sqlite"));
    }
}
