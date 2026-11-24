use brain_core::domain::types::{ActorContext, SearchFilters};
use brain_core::index::store::incremental_sync_note;
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::search_notes;
use brain_core::state::vault_state::VaultStateStore;
use brain_core::vault::engine::VaultEngine;
use brain_core::vault::scan::scan_vault;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;

#[derive(Serialize)]
struct FixtureBench {
    fixture: String,
    notes: usize,
    cold_open_ms: f64,
    warm_scan_ms: f64,
    warm_rebuild_ms: f64,
    incremental_sync_ms: f64,
    note_create_ms: f64,
    note_read_ms: f64,
    note_save_ms: f64,
    search_queries: usize,
    search_p50_ms: f64,
    search_p95_ms: f64,
    rss_mb: f64,
}

fn main() {
    let base_fixtures = PathBuf::from("tests/fixtures/.generated");
    if !base_fixtures.join("F1000").exists() {
        eprintln!("Missing fixtures under tests/fixtures/.generated; run `node scripts/generate-fixtures.mjs` first.");
        std::process::exit(1);
    }

    let mut results = Vec::new();
    for name in ["F0", "F100", "F1000"] {
        results.push(bench_fixture(name, &base_fixtures.join(name)));
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&results).expect("serialize benchmark json")
    );
}

fn bench_fixture(name: &str, src_fixture: &Path) -> FixtureBench {
    let sandbox = std::env::temp_dir().join(format!("pb-bench-{name}-{}", Uuid::new_v4()));
    let vault_dir = sandbox.join("vault");
    copy_dir_recursive(src_fixture, &vault_dir);
    let paths = AppPathsSpec::from_root(sandbox.join("app_data"));
    let actor = ActorContext::desktop("bench");

    let t0 = Instant::now();
    let rep = VaultEngine::open_vault(&paths, &vault_dir).expect("cold open_vault");
    let cold_open_ms = t0.elapsed().as_secs_f64() * 1000.0;
    let vault_id = rep.vault.vault_id;

    let t_scan = Instant::now();
    let scan = scan_vault(&vault_dir).expect("warm scan");
    let warm_scan_ms = t_scan.elapsed().as_secs_f64() * 1000.0;

    let t_reb = Instant::now();
    let _ = VaultEngine::rebuild_index(&paths, &vault_id).expect("warm rebuild");
    let warm_rebuild_ms = t_reb.elapsed().as_secs_f64() * 1000.0;

    let t_create = Instant::now();
    let created = VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "BenchScratch.md",
        "# Bench Scratch\nLatency measurement body.\n",
        "bench-create-1",
    )
    .expect("bench create");
    let note_create_ms = t_create.elapsed().as_secs_f64() * 1000.0;

    let t_read = Instant::now();
    let snap = VaultEngine::read_note(&paths, &vault_id, &created.note_id).expect("bench read");
    let note_read_ms = t_read.elapsed().as_secs_f64() * 1000.0;

    let t_save = Instant::now();
    let saved = VaultEngine::save_note(
        &paths,
        &actor,
        &vault_id,
        &created.note_id,
        &snap.content_hash,
        "# Bench Scratch\nUpdated measurement body.\n",
        "bench-save-1",
    )
    .expect("bench save");
    let note_save_ms = t_save.elapsed().as_secs_f64() * 1000.0;

    let t_inc = Instant::now();
    {
        let mut state = VaultStateStore::open_or_init(&paths, &vault_id).unwrap();
        let _ = incremental_sync_note(
            &vault_id,
            &vault_dir,
            &mut state,
            &created.note_id,
            Some("BenchScratch.md"),
            Some(b"# Bench Scratch\nIncremental sync pass.\n"),
            Some(&saved.content_hash),
        );
    }
    let incremental_sync_ms = t_inc.elapsed().as_secs_f64() * 1000.0;

    // Warm up query cache before 120 representative queries
    let queries = [
        "benchmark",
        "Synthetic",
        "knowledge",
        "Note-0010",
        "profiling",
        "cluster-2",
        "entry",
        "Fixture",
        "Links",
        "Note-0500",
    ];
    for q in &queries {
        let _ = search_notes(
            &paths,
            &vault_id,
            q,
            &SearchFilters::default(),
            Some(20),
            None,
        );
    }

    let total_queries = 120usize;
    let mut latencies_ms = Vec::with_capacity(total_queries);
    for i in 0..total_queries {
        let q = queries[i % queries.len()];
        let t_q = Instant::now();
        let _ = search_notes(
            &paths,
            &vault_id,
            q,
            &SearchFilters::default(),
            Some(20),
            None,
        )
        .expect("search benchmark query");
        latencies_ms.push(t_q.elapsed().as_secs_f64() * 1000.0);
    }
    latencies_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let search_p50_ms = percentile(&latencies_ms, 0.50);
    let search_p95_ms = percentile(&latencies_ms, 0.95);
    let rss_mb = current_rss_mb();

    let _ = std::fs::remove_dir_all(&sandbox);

    FixtureBench {
        fixture: name.to_string(),
        notes: scan.notes.len(),
        cold_open_ms: round2(cold_open_ms),
        warm_scan_ms: round2(warm_scan_ms),
        warm_rebuild_ms: round2(warm_rebuild_ms),
        incremental_sync_ms: round2(incremental_sync_ms),
        note_create_ms: round2(note_create_ms),
        note_read_ms: round2(note_read_ms),
        note_save_ms: round2(note_save_ms),
        search_queries: total_queries,
        search_p50_ms: round2(search_p50_ms),
        search_p95_ms: round2(search_p95_ms),
        rss_mb: round2(rss_mb),
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((sorted.len() as f64 * p).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[idx]
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn copy_dir_recursive(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap();
    for entry in std::fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let ty = entry.file_type().unwrap();
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}

#[cfg(windows)]
fn current_rss_mb() -> f64 {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: `PROCESS_MEMORY_COUNTERS` is POD and `cb` is initialized to its exact byte size.
    let mut pmc: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: `GetCurrentProcess()` returns a valid pseudo-handle.
    let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) };
    if ok != 0 {
        pmc.WorkingSetSize as f64 / (1024.0 * 1024.0)
    } else {
        0.0
    }
}

#[cfg(not(windows))]
fn current_rss_mb() -> f64 {
    0.0
}
