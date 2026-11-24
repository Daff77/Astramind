pub mod ai;
pub mod backup;
pub mod domain;
pub mod index;
pub mod markdown;
pub mod memory;
pub mod paths;
pub mod retrieval;
pub mod state;
pub mod vault;

use domain::errors::CoreError;
use domain::types::AppHealthDto;
use index::probe_sqlite_fts5;
use paths::AppPathsSpec;

/// Runs real foundation diagnostics against `brain-core`: resolves OS app-data paths
/// and executes an in-memory SQLite + FTS5 probe.
pub fn health_check() -> Result<AppHealthDto, CoreError> {
    let paths = AppPathsSpec::resolve_default()?;
    let sqlite = probe_sqlite_fts5()?;
    Ok(AppHealthDto {
        app_name: "Personal Brain".to_string(),
        core_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        paths: paths.to_dto(),
        sqlite,
    })
}
