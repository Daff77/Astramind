use crate::domain::errors::CoreError;
use crate::domain::ids::VaultId;
use crate::domain::types::ReconcileSummary;
use crate::paths::AppPathsSpec;
use crate::vault::engine::VaultEngine;
use crate::vault::paths::{is_excluded_entry, path_key};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct WatcherStats {
    pub reconcile_runs: usize,
    pub last_generation: u64,
    pub missed_or_overflow_events: usize,
}

enum ControlMsg {
    FsEvent(Result<Event, notify::Error>),
    ForceReconcile,
    Stop,
}

/// Debounced native Windows filesystem watcher with self-write suppression and overflow
/// fallback to full vault reconciliation (`PB-013`).
pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
    tx: Sender<ControlMsg>,
    worker: Option<JoinHandle<()>>,
    suppressed: Arc<Mutex<HashMap<String, (String, Instant)>>>,
    stats: Arc<Mutex<WatcherStats>>,
}

impl VaultWatcher {
    pub fn start(
        paths: AppPathsSpec,
        vault_id: VaultId,
        vault_root: PathBuf,
        debounce: Duration,
    ) -> Result<Self, CoreError> {
        let (tx, rx) = mpsc::channel::<ControlMsg>();
        let event_tx = tx.clone();

        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = event_tx.send(ControlMsg::FsEvent(res));
        })
        .map_err(|err| CoreError::IoFailed(format!("create filesystem watcher: {err}")))?;

        watcher
            .watch(&vault_root, RecursiveMode::Recursive)
            .map_err(|err| CoreError::IoFailed(format!("watch vault root: {err}")))?;

        let suppressed: Arc<Mutex<HashMap<String, (String, Instant)>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let stats = Arc::new(Mutex::new(WatcherStats {
            reconcile_runs: 0,
            last_generation: 0,
            missed_or_overflow_events: 0,
        }));

        let suppressed_bg = Arc::clone(&suppressed);
        let stats_bg = Arc::clone(&stats);
        let root_bg = vault_root.clone();

        let worker = thread::spawn(move || {
            let mut dirty = false;
            let mut last_event_at = Instant::now();

            loop {
                let wait = if dirty {
                    debounce
                } else {
                    Duration::from_millis(500)
                };

                match rx.recv_timeout(wait) {
                    Ok(ControlMsg::Stop) => break,
                    Ok(ControlMsg::ForceReconcile) => {
                        run_reconcile(&paths, &vault_id, &stats_bg, false);
                        dirty = false;
                    }
                    Ok(ControlMsg::FsEvent(Ok(ev))) => {
                        if should_trigger_reconcile(&root_bg, &ev, &suppressed_bg) {
                            dirty = true;
                            last_event_at = Instant::now();
                        }
                    }
                    Ok(ControlMsg::FsEvent(Err(_))) => {
                        // Overflow / watcher gap: force full reconcile.
                        run_reconcile(&paths, &vault_id, &stats_bg, true);
                        dirty = false;
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if dirty && last_event_at.elapsed() >= debounce {
                            run_reconcile(&paths, &vault_id, &stats_bg, false);
                            dirty = false;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        Ok(Self {
            _watcher: watcher,
            tx,
            worker: Some(worker),
            suppressed,
            stats,
        })
    }

    /// Suppresses immediate self-write feedback loops for `(rel_path, content_hash)` for 2 seconds.
    pub fn record_self_write(&self, rel_path: &str, content_hash: &str) {
        if let Ok(mut guard) = self.suppressed.lock() {
            let now = Instant::now();
            guard.retain(|_, (_, ts)| now.duration_since(*ts) < Duration::from_secs(5));
            guard.insert(path_key(rel_path), (content_hash.to_string(), now));
        }
    }

    pub fn trigger_reconcile(&self) {
        let _ = self.tx.send(ControlMsg::ForceReconcile);
    }

    #[must_use]
    pub fn stats(&self) -> WatcherStats {
        self.stats
            .lock()
            .map(|g| g.clone())
            .unwrap_or(WatcherStats {
                reconcile_runs: 0,
                last_generation: 0,
                missed_or_overflow_events: 0,
            })
    }

    pub fn stop(mut self) {
        let _ = self.tx.send(ControlMsg::Stop);
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        let _ = self.tx.send(ControlMsg::Stop);
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

fn should_trigger_reconcile(
    vault_root: &Path,
    ev: &Event,
    suppressed: &Arc<Mutex<HashMap<String, (String, Instant)>>>,
) -> bool {
    if matches!(ev.kind, EventKind::Access(_)) {
        return false;
    }
    if ev.paths.is_empty() {
        return true;
    }
    for abs in &ev.paths {
        let Ok(rel) = abs.strip_prefix(vault_root) else {
            return true;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.split('/').any(is_excluded_entry) {
            continue;
        }
        // Check self-write suppression cache using guarded handle read (never raw unvalidated read).
        if let Ok(guard) = suppressed.lock() {
            if let Some((expected_hash, ts)) = guard.get(&path_key(&rel_str)) {
                if ts.elapsed() < Duration::from_secs(2) {
                    if let Ok((_, mut f)) =
                        crate::vault::paths::resolve_guarded_existing_file(vault_root, &rel_str)
                    {
                        use std::io::Read;
                        let mut bytes = Vec::new();
                        if f.read_to_end(&mut bytes).is_ok()
                            && crate::vault::replace::sha256_hex(&bytes) == *expected_hash
                        {
                            continue;
                        }
                    }
                }
            }
        }
        return true;
    }
    false
}

fn run_reconcile(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
    stats: &Arc<Mutex<WatcherStats>>,
    from_overflow: bool,
) {
    let summary: Result<ReconcileSummary, CoreError> = VaultEngine::rebuild_index(paths, vault_id);
    if let Ok(mut guard) = stats.lock() {
        if from_overflow {
            guard.missed_or_overflow_events += 1;
        }
        if let Ok(s) = summary {
            guard.reconcile_runs += 1;
            guard.last_generation = s.index_generation;
        }
    }
}
