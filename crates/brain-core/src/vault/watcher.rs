use crate::domain::errors::{CoreError, ErrorCode};
use crate::domain::ids::VaultId;
use crate::domain::types::{ReconcileSummary, WatcherEventDto};
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

pub type ReconcileCallback = Arc<dyn Fn(WatcherEventDto) + Send + Sync>;

const DEFAULT_RETRY_BASE_MS: u64 = 200;
const DEFAULT_MAX_RETRIES: usize = 5;
const DEFAULT_WATCHER_LOCK_TIMEOUT_MS: u64 = 300;

#[derive(Debug, Clone)]
pub struct WatcherStats {
    pub reconcile_runs: usize,
    pub last_generation: u64,
    pub missed_or_overflow_events: usize,
    pub consecutive_failures: usize,
    pub retry_attempts: usize,
    pub is_stale: bool,
}

enum ControlMsg {
    FsEvent(Result<Event, notify::Error>),
    ForceReconcile,
    SimulatedOverflow,
    Stop,
}

/// Debounced native Windows filesystem watcher with self-write suppression, transient failure
/// retention with bounded exponential backoff (`REM-042`), overflow fallback to full vault
/// reconciliation (`REM-046`), and optional UI event callback (`PB-013`, `REM-047`).
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
        Self::start_with_callback(paths, vault_id, vault_root, debounce, None)
    }

    pub fn start_with_callback(
        paths: AppPathsSpec,
        vault_id: VaultId,
        vault_root: PathBuf,
        debounce: Duration,
        on_reconciled: Option<ReconcileCallback>,
    ) -> Result<Self, CoreError> {
        Self::start_with_options(
            paths,
            vault_id,
            vault_root,
            debounce,
            Duration::from_millis(DEFAULT_RETRY_BASE_MS),
            DEFAULT_MAX_RETRIES,
            Duration::from_millis(DEFAULT_WATCHER_LOCK_TIMEOUT_MS),
            on_reconciled,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn start_with_options(
        paths: AppPathsSpec,
        vault_id: VaultId,
        vault_root: PathBuf,
        debounce: Duration,
        retry_base_backoff: Duration,
        max_retries: usize,
        lock_timeout: Duration,
        on_reconciled: Option<ReconcileCallback>,
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
            consecutive_failures: 0,
            retry_attempts: 0,
            is_stale: false,
        }));

        let suppressed_bg = Arc::clone(&suppressed);
        let stats_bg = Arc::clone(&stats);
        let root_bg = vault_root.clone();

        let worker = thread::spawn(move || {
            let mut state = WorkerLoopState {
                dirty: false,
                pending_overflow: false,
                last_event_at: Instant::now(),
                next_retry_at: None,
                failures: 0,
            };

            loop {
                let wait = compute_wait(&state, debounce);

                match rx.recv_timeout(wait) {
                    Ok(ControlMsg::Stop) => break,
                    Ok(ControlMsg::ForceReconcile) => {
                        state.failures = 0;
                        state.next_retry_at = None;
                        run_reconcile_with_retention(
                            &paths,
                            &vault_id,
                            &stats_bg,
                            state.pending_overflow,
                            retry_base_backoff,
                            max_retries,
                            lock_timeout,
                            on_reconciled.as_ref(),
                            &mut state,
                        );
                    }
                    Ok(ControlMsg::SimulatedOverflow) | Ok(ControlMsg::FsEvent(Err(_))) => {
                        state.dirty = true;
                        state.pending_overflow = true;
                        state.failures = 0;
                        state.next_retry_at = None;
                        run_reconcile_with_retention(
                            &paths,
                            &vault_id,
                            &stats_bg,
                            true,
                            retry_base_backoff,
                            max_retries,
                            lock_timeout,
                            on_reconciled.as_ref(),
                            &mut state,
                        );
                    }
                    Ok(ControlMsg::FsEvent(Ok(ev))) => {
                        if should_trigger_reconcile(&root_bg, &ev, &suppressed_bg) {
                            state.dirty = true;
                            state.last_event_at = Instant::now();
                            // Clear exhausted stale retry counter when a fresh filesystem change arrives.
                            if state.next_retry_at.is_none() && state.failures > max_retries {
                                state.failures = 0;
                            }
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        let ready_debounce = state.dirty
                            && state.next_retry_at.is_none()
                            && state.last_event_at.elapsed() >= debounce;
                        let ready_retry = state
                            .next_retry_at
                            .is_some_and(|deadline| Instant::now() >= deadline);
                        if ready_debounce || ready_retry {
                            run_reconcile_with_retention(
                                &paths,
                                &vault_id,
                                &stats_bg,
                                state.pending_overflow,
                                retry_base_backoff,
                                max_retries,
                                lock_timeout,
                                on_reconciled.as_ref(),
                                &mut state,
                            );
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

    /// Injects a deterministic overflow message into the watcher worker queue so
    /// overflow-recovery paths can be verified without provoking OS ring-buffer drops.
    pub fn simulate_overflow(&self) {
        let _ = self.tx.send(ControlMsg::SimulatedOverflow);
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
                consecutive_failures: 0,
                retry_attempts: 0,
                is_stale: false,
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

struct WorkerLoopState {
    dirty: bool,
    pending_overflow: bool,
    last_event_at: Instant,
    next_retry_at: Option<Instant>,
    failures: usize,
}

fn compute_wait(state: &WorkerLoopState, debounce: Duration) -> Duration {
    if let Some(deadline) = state.next_retry_at {
        return deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(5));
    }
    if state.dirty {
        debounce
    } else {
        Duration::from_millis(500)
    }
}

fn strip_extended_prefix(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    PathBuf::from(s.strip_prefix("\\\\?\\").unwrap_or(&s))
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
    let clean_root = strip_extended_prefix(vault_root);
    for abs in &ev.paths {
        let clean_abs = strip_extended_prefix(abs);
        let Ok(rel) = clean_abs.strip_prefix(&clean_root) else {
            return true;
        };
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if rel_str.split('/').any(is_excluded_entry) {
            continue;
        }
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

#[allow(clippy::too_many_arguments)]
fn run_reconcile_with_retention(
    paths: &AppPathsSpec,
    vault_id: &VaultId,
    stats: &Arc<Mutex<WatcherStats>>,
    from_overflow: bool,
    retry_base_backoff: Duration,
    max_retries: usize,
    lock_timeout: Duration,
    on_reconciled: Option<&ReconcileCallback>,
    state: &mut WorkerLoopState,
) {
    let summary: Result<ReconcileSummary, CoreError> =
        VaultEngine::rebuild_index_with_timeout(paths, vault_id, lock_timeout);
    match summary {
        Ok(s) => {
            if let Ok(mut guard) = stats.lock() {
                if from_overflow {
                    guard.missed_or_overflow_events += 1;
                }
                guard.reconcile_runs += 1;
                guard.last_generation = s.index_generation;
                guard.consecutive_failures = 0;
                guard.is_stale = false;
            }
            state.dirty = false;
            state.pending_overflow = false;
            state.failures = 0;
            state.next_retry_at = None;

            if let Some(cb) = on_reconciled {
                cb(WatcherEventDto {
                    vault_id: vault_id.clone(),
                    index_generation: s.index_generation,
                    indexed_notes: s.indexed_notes,
                    removed_notes: s.removed_notes,
                    from_overflow,
                    stale: false,
                    error_code: None,
                    error_message: None,
                });
            }
        }
        Err(err) => {
            state.failures += 1;
            let shift = (state.failures.saturating_sub(1)).min(5) as u32;
            let exhausted = state.failures > max_retries;
            let mut last_gen = 0;

            if let Ok(mut guard) = stats.lock() {
                if from_overflow && exhausted {
                    guard.missed_or_overflow_events += 1;
                }
                guard.consecutive_failures = state.failures;
                guard.retry_attempts += 1;
                guard.is_stale = exhausted;
                last_gen = guard.last_generation;
            }

            if exhausted {
                // Keep dirty/stale visibility until explicit ForceReconcile or a new filesystem event.
                state.dirty = false;
                state.next_retry_at = None;
                if let Some(cb) = on_reconciled {
                    cb(WatcherEventDto {
                        vault_id: vault_id.clone(),
                        index_generation: last_gen,
                        indexed_notes: 0,
                        removed_notes: 0,
                        from_overflow,
                        stale: true,
                        error_code: Some(err.code()),
                        error_message: Some(redact_watcher_error(&err)),
                    });
                }
            } else {
                state.dirty = true;
                state.pending_overflow = from_overflow;
                let delay = retry_base_backoff
                    .checked_mul(1u32 << shift)
                    .unwrap_or(Duration::from_secs(5));
                state.next_retry_at = Some(Instant::now() + delay);
            }
        }
    }
}

fn redact_watcher_error(err: &CoreError) -> String {
    match err.code() {
        ErrorCode::Busy => "Vault lock busy during reconciliation".to_string(),
        ErrorCode::VaultUnavailable => "Vault directory unavailable".to_string(),
        ErrorCode::RecoveryRequired => "Vault state recovery required".to_string(),
        _ => "Background reconciliation failed; manual resync required".to_string(),
    }
}
