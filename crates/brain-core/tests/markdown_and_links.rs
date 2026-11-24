use brain_core::domain::types::{ActorContext, LinkResolution, ParseStatus, SearchFilters};
use brain_core::paths::AppPathsSpec;
use brain_core::retrieval::{get_backlinks, get_broken_links, get_graph, search_notes};
use brain_core::vault::engine::VaultEngine;
use uuid::Uuid;

#[test]
fn handles_duplicate_ids_malformed_yaml_ambiguous_links_and_search() {
    let base = std::env::temp_dir().join(format!("pb-md-test-{}", Uuid::new_v4()));
    let paths = AppPathsSpec::from_root(base.join("app_data"));
    let vault = base.join("vault");
    std::fs::create_dir_all(vault.join("FolderA")).unwrap();
    std::fs::create_dir_all(vault.join("FolderB")).unwrap();
    std::fs::create_dir_all(vault.join("assets")).unwrap();
    std::fs::write(vault.join("assets/arch.png"), b"PNGDATA").unwrap();

    let dup_uuid = "11111111-1111-4111-8111-111111111111";

    // Duplicate personal_brain_id in two files + malformed YAML in another + ambiguous wikilinks + attachment embed
    std::fs::write(
        vault.join("FolderA/Alpha.md"),
        format!(
            "---\npersonal_brain_id: {dup_uuid}\ntags: [Architecture, Core]\naliases: [PrimaryAlpha]\n---\n# Alpha\nLinks to [[Shared]], [[FolderB/Shared]], [[MissingNote]], `[[IgnoredInCode]]`, and ![diagram](../assets/arch.png).\n"
        ),
    )
    .unwrap();

    std::fs::write(
        vault.join("FolderB/Beta.md"),
        format!(
            "---\npersonal_brain_id: {dup_uuid}\n---\n# Beta\nBack to [[PrimaryAlpha]] and [rel](../FolderA/Alpha.md).\n"
        ),
    )
    .unwrap();

    // Ambiguous basename "Shared" in two folders
    std::fs::write(vault.join("FolderA/Shared.md"), "# Shared A\nContent A\n").unwrap();
    std::fs::write(vault.join("FolderB/Shared.md"), "# Shared B\nContent B\n").unwrap();

    // Malformed YAML frontmatter (must still parse body and surface ParseStatus::Warning)
    std::fs::write(
        vault.join("BrokenYaml.md"),
        "---\ntitle: [unclosed bracket\n---\n# Broken YAML Body\nSearchable keyword quantum_lattice.\n",
    )
    .unwrap();

    let report = VaultEngine::open_vault(&paths, &vault).expect("open vault with diagnostics");
    assert_eq!(report.notes_discovered, 5);
    assert!(report.broken_links >= 1);
    assert!(report.ambiguous_links >= 1);
    assert!(report
        .diagnostics
        .iter()
        .any(|d| d.kind == "duplicate_note_id"));
    assert!(report.diagnostics.iter().any(|d| d.kind == "parse_warning"));

    let vault_id = report.vault.vault_id;
    let notes = VaultEngine::list_notes(&paths, &vault_id).unwrap();
    // Duplicate embedded IDs must NOT produce duplicate NoteIds in state/index
    let mut ids: Vec<_> = notes.iter().map(|n| n.note_id.clone()).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 5);

    let broken_yaml_note = notes
        .iter()
        .find(|n| n.rel_path == "BrokenYaml.md")
        .unwrap();
    assert_eq!(broken_yaml_note.parse_status, ParseStatus::Warning);

    // FTS5 search finds body inside note with malformed YAML + handles literal syntax safely
    let search_res = search_notes(
        &paths,
        &vault_id,
        "quantum_lattice",
        &SearchFilters::default(),
        None,
        None,
    )
    .unwrap();
    assert_eq!(search_res.items.len(), 1);
    assert_eq!(search_res.items[0].rel_path, "BrokenYaml.md");

    // Folder + tag filter search
    let filtered = search_notes(
        &paths,
        &vault_id,
        "Shared",
        &SearchFilters {
            folder_prefix: Some("FolderA".to_string()),
            tag: Some("architecture".to_string()),
        },
        None,
        None,
    )
    .unwrap();
    assert_eq!(filtered.items.len(), 1);
    assert_eq!(filtered.items[0].rel_path, "FolderA/Alpha.md");

    // Backlinks & broken links & graph DTO
    let shared_b_id = VaultEngine::lookup_note_id_by_path(&paths, &vault_id, "FolderB/Shared.md")
        .unwrap()
        .unwrap();
    let backlinks = get_backlinks(&paths, &vault_id, &shared_b_id).unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_rel_path, "FolderA/Alpha.md");

    let broken = get_broken_links(&paths, &vault_id).unwrap();
    assert!(broken
        .iter()
        .any(|b| b.raw_target == "MissingNote" && b.resolution == LinkResolution::Broken));
    assert!(broken
        .iter()
        .any(|b| b.raw_target == "Shared" && b.resolution == LinkResolution::Ambiguous));

    let graph = get_graph(&paths, &vault_id).unwrap();
    assert_eq!(graph.nodes.len(), 5);
    assert!(!graph.edges.is_empty());

    // FTS5 syntax-injection strings must be treated as literal tokens without FTS syntax errors
    for injection in ["OR", "NEAR", "\"quote\"", "*", "title:foo AND OR NOT"] {
        let res = search_notes(
            &paths,
            &vault_id,
            injection,
            &SearchFilters::default(),
            None,
            None,
        )
        .expect("literal FTS5 query must not error");
        assert!(res.items.is_empty());
    }

    // Creating a new note (incremental_sync_note) must preserve existing Attachment link resolutions
    let actor = ActorContext::desktop("qa");
    VaultEngine::create_note(
        &paths,
        &actor,
        &vault_id,
        "FolderA/Gamma.md",
        "# Gamma\nIncremental note.\n",
        "req-att-preserve-1",
    )
    .expect("create gamma note");
    let broken_after_inc = get_broken_links(&paths, &vault_id).unwrap();
    assert!(
        !broken_after_inc
            .iter()
            .any(|b| b.raw_target.contains("arch.png")),
        "attachment link must not regress to broken after incremental sync"
    );

    let _ = std::fs::remove_dir_all(&base);
}
