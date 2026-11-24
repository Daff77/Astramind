use crate::domain::errors::CoreError;
use crate::domain::types::ScanDiagnostic;
use crate::vault::paths::{
    inspect_scanned_file, is_excluded_entry, matches_exclusion_pattern, open_guarded_dir,
    validate_vault_root,
};
use crate::vault::replace::sha256_hex;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ScannedNote {
    pub rel_path: String,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub size_bytes: u64,
    pub file_identity: String,
    pub is_hardlinked: bool,
}

#[derive(Debug, Clone, Default)]
pub struct VaultScanResult {
    pub notes: Vec<ScannedNote>,
    pub attachments: Vec<String>,
    pub diagnostics: Vec<ScanDiagnostic>,
}

/// Non-destructively scans regular `.md` files and attachment paths inside `vault_root`.
/// Never modifies vault files; skips `.obsidian`, `.git`, `.pb-tmp-*`, reparse points, and cloud placeholders.
pub fn scan_vault(vault_root: &Path) -> Result<VaultScanResult, CoreError> {
    scan_vault_with_exclusions(vault_root, &[])
}

/// Non-destructively scans regular `.md` files and attachment paths while also skipping
/// persistent indexing exclusion patterns (e.g., `node_modules`, `target`, `dist`).
pub fn scan_vault_with_exclusions(
    vault_root: &Path,
    exclusion_patterns: &[String],
) -> Result<VaultScanResult, CoreError> {
    let canonical_root = validate_vault_root(vault_root)?;
    let mut result = VaultScanResult::default();
    walk_dir_recursive(
        &canonical_root,
        &canonical_root,
        "",
        exclusion_patterns,
        &mut result,
    )?;
    result.notes.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    result.attachments.sort();
    Ok(result)
}

fn walk_dir_recursive(
    canonical_root: &Path,
    dir_path: &Path,
    rel_prefix: &str,
    exclusion_patterns: &[String],
    out: &mut VaultScanResult,
) -> Result<(), CoreError> {
    let entries = std::fs::read_dir(dir_path)
        .map_err(|err| CoreError::from_io_dir("read vault directory", &err))?;

    let mut children = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| CoreError::from_io_dir("read vault entry", &err))?;
        children.push(entry);
    }
    children.sort_by_key(|e| e.file_name());

    for entry in children {
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_excluded_entry(&name) {
            continue;
        }
        let rel_path = if rel_prefix.is_empty() {
            name.clone()
        } else {
            format!("{rel_prefix}/{name}")
        };
        if !exclusion_patterns.is_empty()
            && matches_exclusion_pattern(&rel_path, &name, exclusion_patterns)
        {
            continue;
        }
        let child_path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(err) => {
                out.diagnostics.push(ScanDiagnostic {
                    rel_path,
                    kind: "io_warning".to_string(),
                    message: format!("skipped unreadable entry: {err}"),
                });
                continue;
            }
        };

        if file_type.is_symlink() {
            out.diagnostics.push(ScanDiagnostic {
                rel_path,
                kind: "reparse_skipped".to_string(),
                message: "symlink or junction skipped".to_string(),
            });
            continue;
        }

        if file_type.is_dir() {
            match open_guarded_dir(canonical_root, &child_path) {
                Ok(_) => walk_dir_recursive(
                    canonical_root,
                    &child_path,
                    &rel_path,
                    exclusion_patterns,
                    out,
                )?,
                Err(err) => {
                    out.diagnostics.push(ScanDiagnostic {
                        rel_path,
                        kind: "dir_skipped".to_string(),
                        message: err.to_string(),
                    });
                }
            }
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let is_markdown = name.to_ascii_lowercase().ends_with(".md");
        if !is_markdown {
            // Attachments are inventoried by relative path only; contents not parsed in MVP.
            out.attachments.push(rel_path);
            continue;
        }

        match inspect_scanned_file(canonical_root, &child_path) {
            Ok((mut file, meta)) => {
                let mut bytes = Vec::new();
                if let Err(err) = file.read_to_end(&mut bytes) {
                    out.diagnostics.push(ScanDiagnostic {
                        rel_path,
                        kind: "read_warning".to_string(),
                        message: format!("failed to read note: {err}"),
                    });
                    continue;
                }
                let sha256 = sha256_hex(&bytes);
                let size_bytes = bytes.len() as u64;
                if meta.link_count > 1 {
                    out.diagnostics.push(ScanDiagnostic {
                        rel_path: rel_path.clone(),
                        kind: "hardlink_warning".to_string(),
                        message: "hardlinked note is read-only for indexing; mutations denied"
                            .to_string(),
                    });
                }
                out.notes.push(ScannedNote {
                    rel_path,
                    bytes,
                    sha256,
                    size_bytes,
                    file_identity: meta.file_identity,
                    is_hardlinked: meta.link_count > 1,
                });
            }
            Err(err) => {
                out.diagnostics.push(ScanDiagnostic {
                    rel_path,
                    kind: "file_skipped".to_string(),
                    message: err.to_string(),
                });
            }
        }
    }

    Ok(())
}
