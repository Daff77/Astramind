use brain_core::backup::create_backup;
use brain_core::domain::types::{ActorContext, SearchFilters};
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::{get_graph, search_notes};
use brain_core::vault::engine::VaultEngine;
use std::path::{Path, PathBuf};
use std::time::Instant;
use uuid::Uuid;

struct ScratchDir(PathBuf);
impl ScratchDir {
    fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }
    fn range(&mut self, max: usize) -> usize {
        ((self.next() >> 16) as usize) % max.max(1)
    }
}

fn populate_synthetic_vault(root: &Path, count: usize, edge_target: usize) {
    let folders = ["projects", "research", "daily", "architecture", "reading"];
    let topics = [
        "rust",
        "sqlite",
        "graph",
        "security",
        "windows",
        "performance",
        "markdown",
        "design",
    ];
    let mut rng = Lcg(0xDEAD_BEEF_CAFE_0001);

    for f in folders {
        std::fs::create_dir_all(root.join(f)).unwrap();
    }

    let edges_per_note = edge_target.checked_div(count).unwrap_or(0);
    for i in 0..count {
        let folder = folders[i % folders.len()];
        let topic = topics[(i / folders.len()) % topics.len()];
        let mut body = format!(
            "---\ntags:\n  - {topic}\n  - batch{}\n---\n\n# Note {i:04} — {topic}\n\nSynthetic knowledge entry {i} covering {topic} and local-first architecture.\n\n",
            i % 10
        );
        if count > 1 {
            let links_for_note = if edge_target < count {
                usize::from(i < edge_target)
            } else {
                edges_per_note
            };
            for e in 0..links_for_note {
                let target_idx = (i + 1 + rng.range(count - 1) + e) % count;
                if target_idx != i {
                    let target_folder = folders[target_idx % folders.len()];
                    body.push_str(&format!(
                        "- Related: [[{target_folder}/note-{target_idx:04}]]\n"
                    ));
                }
            }
        }
        if i % 10 == 0 && count > 0 {
            body.push_str(&format!("- Unresolved ref: [[missing/missing-{i:04}]]\n"));
        }
        std::fs::write(root.join(folder).join(format!("note-{i:04}.md")), body).unwrap();
    }
}

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (((sorted.len() - 1) as f64) * pct).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn bench_fixture(label: &str, count: usize, edge_target: usize) {
    let tmp = ScratchDir::new(&format!("pb-bench-{label}"));
    let paths = AppPathsSpec::from_root(tmp.path().join("appdata"));
    let root = tmp.path().join(label);
    std::fs::create_dir_all(&root).unwrap();
    populate_synthetic_vault(&root, count, edge_target);

    let t_open = Instant::now();
    let report = VaultEngine::open_vault(&paths, &root).unwrap();
    let open_ms = t_open.elapsed().as_secs_f64() * 1000.0;
    let vid = report.vault.vault_id;

    let t_graph = Instant::now();
    let graph = get_graph(&paths, &vid).unwrap();
    let graph_ms = t_graph.elapsed().as_secs_f64() * 1000.0;

    let notes = VaultEngine::list_notes(&paths, &vid).unwrap();
    let mut read_ms = 0.0;
    let mut save_ms = 0.0;
    if let Some(first) = notes.first() {
        let t_read = Instant::now();
        let snap = VaultEngine::read_note(&paths, &vid, &first.note_id).unwrap();
        read_ms = t_read.elapsed().as_secs_f64() * 1000.0;

        let t_save = Instant::now();
        VaultEngine::save_note(
            &paths,
            &ActorContext::desktop("bench"),
            &vid,
            &first.note_id,
            &snap.content_hash,
            &format!("{}\n\nBenchmark edit line.\n", snap.body),
            "bench-save-1",
        )
        .unwrap();
        save_ms = t_save.elapsed().as_secs_f64() * 1000.0;
    }

    let queries = [
        "architecture",
        "rust",
        "sqlite",
        "performance",
        "security",
        "Note 0050",
        "design",
        "windows",
    ];
    let mut search_latencies = Vec::with_capacity(120);
    for r in 0..120 {
        let q = if count == 0 {
            ""
        } else {
            queries[r % queries.len()]
        };
        let t_s = Instant::now();
        let _ = search_notes(&paths, &vid, q, &SearchFilters::default(), Some(20), None).unwrap();
        search_latencies.push(t_s.elapsed().as_secs_f64() * 1000.0);
    }
    search_latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let search_p50 = percentile(&search_latencies, 0.50);
    let search_p95 = percentile(&search_latencies, 0.95);

    let t_rebuild = Instant::now();
    let _ = VaultEngine::rebuild_index(&paths, &vid).unwrap();
    let rebuild_ms = t_rebuild.elapsed().as_secs_f64() * 1000.0;

    let backup_dest = tmp.path().join("backups");
    let t_backup = Instant::now();
    let _ = create_backup(&paths, &vid, &backup_dest).unwrap();
    let backup_ms = t_backup.elapsed().as_secs_f64() * 1000.0;

    println!(
        "{label}: notes={} edges={} open_ms={:.2} read_ms={:.2} save_ms={:.2} search_p50_ms={:.2} search_p95_ms={:.2} graph_ms={:.2} rebuild_ms={:.2} backup_ms={:.2}",
        graph.nodes.len(),
        graph.edges.len(),
        open_ms,
        read_ms,
        save_ms,
        search_p50,
        search_p95,
        graph_ms,
        rebuild_ms,
        backup_ms,
    );
}

fn main() {
    bench_fixture("F0", 0, 0);
    bench_fixture("F100", 100, 250);
    bench_fixture("F1000", 1000, 2500);
    bench_fixture("F2507", 2507, 173);
}
