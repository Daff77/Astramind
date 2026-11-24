pub mod store;

use crate::domain::errors::CoreError;
use crate::domain::types::SqliteHealthDto;
use crate::paths::AppPathsSpec;
use rusqlite::{params, Connection, OpenFlags};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Verifies that the bundled SQLite engine compiles with FTS5 enabled and executes
/// parameterized queries cleanly.
pub fn probe_sqlite_fts5() -> Result<SqliteHealthDto, CoreError> {
    let conn = Connection::open_in_memory()
        .map_err(|err| CoreError::StateUnavailable(format!("open sqlite memory db: {err}")))?;
    let sqlite_version: String = conn
        .query_row("SELECT sqlite_version()", [], |row| row.get(0))
        .map_err(|err| CoreError::StateUnavailable(format!("query sqlite version: {err}")))?;

    conn.execute_batch(
        "CREATE VIRTUAL TABLE probe_fts USING fts5(title, body, tokenize='unicode61');",
    )
    .map_err(|err| CoreError::StateUnavailable(format!("create fts5 virtual table: {err}")))?;

    conn.execute(
        "INSERT INTO probe_fts(title, body) VALUES (?1, ?2)",
        params![
            "Personal Brain Foundation",
            "Local-first Markdown vault and SQLite FTS5 verification"
        ],
    )
    .map_err(|err| CoreError::StateUnavailable(format!("insert fts5 probe row: {err}")))?;

    let query = literal_fts_query("FTS5");
    let mut stmt = conn
        .prepare("SELECT rowid FROM probe_fts WHERE probe_fts MATCH ?1")
        .map_err(|err| CoreError::StateUnavailable(format!("prepare fts5 query: {err}")))?;
    let hits: Vec<i64> = stmt
        .query_map(params![query], |row| row.get(0))
        .map_err(|err| CoreError::StateUnavailable(format!("execute fts5 query: {err}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CoreError::StateUnavailable(format!("collect fts5 probe hits: {err}")))?;

    Ok(SqliteHealthDto {
        sqlite_version,
        fts5_enabled: !hits.is_empty(),
        fts5_probe_hits: hits.len(),
    })
}

/// Quotes arbitrary user input as literal FTS5 phrase tokens to prevent FTS syntax injection.
#[must_use]
pub fn literal_fts_query(raw: &str) -> String {
    let tokens: Vec<String> = raw
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|tok| {
            let escaped = tok.replace('"', "\"\"");
            format!("\"{escaped}\"")
        })
        .collect();
    if tokens.is_empty() {
        String::new()
    } else {
        tokens.join(" ")
    }
}

/// Stages a generation-named derived index (`index-<gen>.sqlite`) via a temp file and
/// publishes it without overwriting an existing generation (`MoveFileExW` without `REPLACE_EXISTING`).
pub fn write_generation_index(
    vault_dir: &Path,
    generation: u64,
    docs: &[(&str, &str, &str)],
) -> Result<PathBuf, CoreError> {
    std::fs::create_dir_all(vault_dir)
        .map_err(|err| CoreError::from_io_dir("create index directory", &err))?;
    let target_path = AppPathsSpec::index_file_in(vault_dir, generation);
    if target_path.exists() {
        return Err(CoreError::Conflict(format!(
            "index generation {generation} already exists"
        )));
    }
    let temp_path = vault_dir.join(format!("index-{generation}.sqlite.tmp-{}", Uuid::new_v4()));

    let build_res = (|| -> Result<(), CoreError> {
        let mut conn = Connection::open(&temp_path)
            .map_err(|err| CoreError::IoFailed(format!("open staged index: {err}")))?;
        conn.execute_batch(
            "PRAGMA journal_mode=DELETE;
             PRAGMA synchronous=NORMAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE notes (
                 row_id INTEGER PRIMARY KEY,
                 note_id TEXT NOT NULL UNIQUE,
                 title TEXT NOT NULL,
                 body TEXT NOT NULL
             );
             CREATE VIRTUAL TABLE note_fts USING fts5(title, body, tokenize='unicode61');",
        )
        .map_err(|err| CoreError::IoFailed(format!("init generation index schema: {err}")))?;

        let tx = conn
            .transaction()
            .map_err(|err| CoreError::IoFailed(format!("begin index tx: {err}")))?;
        for (note_id, title, body) in docs {
            tx.execute(
                "INSERT INTO notes(note_id, title, body) VALUES (?1, ?2, ?3)",
                params![note_id, title, body],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert note row: {err}")))?;
            let row_id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO note_fts(rowid, title, body) VALUES (?1, ?2, ?3)",
                params![row_id, title, body],
            )
            .map_err(|err| CoreError::IoFailed(format!("insert fts row: {err}")))?;
        }
        tx.commit()
            .map_err(|err| CoreError::IoFailed(format!("commit generation index: {err}")))?;
        Ok(())
    })();

    if let Err(err) = build_res {
        let _ = std::fs::remove_file(&temp_path);
        return Err(err);
    }

    publish_staged_file_exclusive(&temp_path, &target_path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp_path);
    })?;
    Ok(target_path)
}

pub(crate) fn publish_staged_file_exclusive(src: &Path, dst: &Path) -> Result<(), CoreError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

        let src_w: Vec<u16> = src
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let dst_w: Vec<u16> = dst
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: `src_w` and `dst_w` are null-terminated UTF-16 buffers; omitting
        // `MOVEFILE_REPLACE_EXISTING` enforces fail-closed non-overwrite publish.
        let ok = unsafe { MoveFileExW(src_w.as_ptr(), dst_w.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if ok != 0 {
            Ok(())
        } else {
            // SAFETY: reads thread-local Win32 error set by `MoveFileExW`.
            let err = unsafe { GetLastError() };
            if err == 183 || err == 80 {
                Err(CoreError::Conflict(
                    "staged destination file already exists".to_string(),
                ))
            } else {
                Err(CoreError::IoFailed(format!(
                    "MoveFileExW exclusive publish failed with OS error {err}"
                )))
            }
        }
    }
    #[cfg(not(windows))]
    {
        if dst.exists() {
            return Err(CoreError::Conflict(
                "staged destination file already exists".to_string(),
            ));
        }
        std::fs::rename(src, dst).map_err(|err| CoreError::from_io_dir("publish index", &err))
    }
}

pub fn open_readonly_generation_index(index_path: &Path) -> Result<Connection, CoreError> {
    Connection::open_with_flags(
        index_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| CoreError::IoFailed(format!("open readonly generation index: {err}")))
}

pub fn query_generation_index(
    conn: &Connection,
    raw_query: &str,
) -> Result<Vec<String>, CoreError> {
    let literal = literal_fts_query(raw_query);
    if literal.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT n.note_id
             FROM note_fts f
             JOIN notes n ON n.row_id = f.rowid
             WHERE note_fts MATCH ?1
             ORDER BY n.note_id ASC",
        )
        .map_err(|err| CoreError::IoFailed(format!("prepare generation search: {err}")))?;
    let rows = stmt
        .query_map(params![literal], |row| row.get::<_, String>(0))
        .map_err(|err| CoreError::IoFailed(format!("execute generation search: {err}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| CoreError::IoFailed(format!("read generation search hits: {err}")))?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_fts5_probe_succeeds() {
        let health = probe_sqlite_fts5().expect("sqlite fts5 probe should pass");
        assert!(health.fts5_enabled);
        assert_eq!(health.fts5_probe_hits, 1);
        assert!(!health.sqlite_version.is_empty());
    }
}
