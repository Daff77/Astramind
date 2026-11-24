use crate::domain::errors::CoreError;
use crate::domain::types::SqliteHealthDto;
use crate::paths::AppPathsSpec;
use rusqlite::{params, Connection, OpenFlags};
use std::path::{Path, PathBuf};

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

/// Quotes arbitrary user input as a literal FTS5 phrase token to prevent FTS syntax injection.
#[must_use]
pub fn literal_fts_query(raw: &str) -> String {
    let escaped = raw.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Builds a generation-named derived index (`index-<gen>.sqlite`) per `ADR-0005` (`SC-14`)
/// so active readers can keep reading the prior snapshot until generation switchover.
pub fn write_generation_index(
    vault_dir: &Path,
    generation: u64,
    docs: &[(&str, &str, &str)],
) -> Result<PathBuf, CoreError> {
    std::fs::create_dir_all(vault_dir)
        .map_err(|err| CoreError::from_io("create index directory", &err))?;
    let path = AppPathsSpec::index_file_in(vault_dir, generation);
    let mut conn = Connection::open(&path)
        .map_err(|err| CoreError::IoFailed(format!("open generation index: {err}")))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA foreign_keys=ON;
         CREATE TABLE IF NOT EXISTS notes (
             row_id INTEGER PRIMARY KEY,
             note_id TEXT NOT NULL UNIQUE,
             title TEXT NOT NULL,
             body TEXT NOT NULL
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(title, body, tokenize='unicode61');",
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
    Ok(path)
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
