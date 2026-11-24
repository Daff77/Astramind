use crate::domain::ids::NoteId;
use crate::domain::types::{LinkKind, LinkResolution, ParseStatus};
use crate::vault::paths::path_key;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;
use yaml_rust2::{Yaml, YamlLoader};

const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;
const MAX_YAML_DEPTH: usize = 16;
const MAX_YAML_NODES: usize = 2048;
const MAX_YAML_ALIASES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedLink {
    pub raw_target: String,
    pub display_text: Option<String>,
    pub kind: LinkKind,
    pub line_number: usize,
    pub byte_offset: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTag {
    pub key: String,
    pub display: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAlias {
    pub key: String,
    pub display: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedNote {
    pub parse_status: ParseStatus,
    pub diagnostics: Vec<String>,
    pub has_bom: bool,
    pub line_ending: LineEnding,
    pub embedded_id: Option<NoteId>,
    pub embedded_id_raw: Option<String>,
    pub title: String,
    pub body_plain: String,
    pub tags: Vec<ParsedTag>,
    pub aliases: Vec<ParsedAlias>,
    pub links: Vec<ExtractedLink>,
    pub declared_type: Option<String>,
    pub declared_verification: Option<String>,
    pub declared_supersedes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedLink {
    pub source_note_id: NoteId,
    pub target_note_id: Option<NoteId>,
    pub raw_target: String,
    pub kind: LinkKind,
    pub resolution: LinkResolution,
    pub line_number: usize,
    pub byte_offset: usize,
}

/// Parses raw note bytes non-destructively, preserving BOM/line-ending detection,
/// unknown YAML properties, and unsupported Markdown without rewriting disk bytes.
#[must_use]
pub fn parse_markdown_bytes(rel_path: &str, raw_bytes: &[u8]) -> ParsedNote {
    let has_bom = raw_bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let after_bom = if has_bom { &raw_bytes[3..] } else { raw_bytes };

    let Ok(text) = std::str::from_utf8(after_bom) else {
        return ParsedNote {
            parse_status: ParseStatus::Unsupported,
            diagnostics: vec!["non-UTF-8 encoding is read-only unsupported".to_string()],
            has_bom,
            line_ending: LineEnding::Lf,
            embedded_id: None,
            embedded_id_raw: None,
            title: file_stem_title(rel_path),
            body_plain: String::new(),
            tags: Vec::new(),
            aliases: Vec::new(),
            links: Vec::new(),
            declared_type: None,
            declared_verification: None,
            declared_supersedes: Vec::new(),
        };
    };

    let line_ending = if text.contains("\r\n") {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    };

    let mut parse_status = ParseStatus::Ok;
    let mut diagnostics = Vec::new();
    let line_starts = compute_line_starts(text);

    let (frontmatter_str, body_offset, body) = split_frontmatter(text);

    let mut yaml_title: Option<String> = None;
    let mut embedded_id: Option<NoteId> = None;
    let mut embedded_id_raw: Option<String> = None;
    let mut declared_type: Option<String> = None;
    let mut declared_verification: Option<String> = None;
    let mut declared_supersedes: Vec<String> = Vec::new();
    let mut tag_map: BTreeMap<String, String> = BTreeMap::new();
    let mut alias_map: BTreeMap<String, String> = BTreeMap::new();

    if let Some(fm) = frontmatter_str {
        if fm.len() > MAX_FRONTMATTER_BYTES {
            parse_status = ParseStatus::Warning;
            diagnostics.push("YAML frontmatter exceeds 64 KiB safety limit".to_string());
        } else if count_yaml_alias_tokens(fm) > MAX_YAML_ALIASES {
            parse_status = ParseStatus::Warning;
            diagnostics.push("YAML frontmatter exceeds alias expansion limit".to_string());
        } else {
            match YamlLoader::load_from_str(fm) {
                Ok(docs) => {
                    if let Some(doc) = docs.first() {
                        let mut node_count = 0usize;
                        if validate_yaml_bounds(doc, 0, &mut node_count) {
                            extract_frontmatter_fields(
                                doc,
                                &mut yaml_title,
                                &mut embedded_id,
                                &mut embedded_id_raw,
                                &mut declared_type,
                                &mut declared_verification,
                                &mut declared_supersedes,
                                &mut tag_map,
                                &mut alias_map,
                                &mut parse_status,
                                &mut diagnostics,
                            );
                        } else {
                            parse_status = ParseStatus::Warning;
                            diagnostics
                                .push("YAML frontmatter exceeds depth or node bounds".to_string());
                        }
                    }
                }
                Err(err) => {
                    parse_status = ParseStatus::Warning;
                    diagnostics.push(format!("invalid YAML frontmatter: {err}"));
                }
            }
        }
    }

    let mut code_ranges: Vec<Range<usize>> = Vec::new();
    let mut links: Vec<ExtractedLink> = Vec::new();
    let mut first_h1: Option<String> = None;
    let mut in_h1 = false;
    let mut h1_buf = String::new();
    let mut in_code_block = false;
    let mut code_block_start = 0usize;

    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(body, options).into_offset_iter();

    for (event, range) in parser {
        match event {
            Event::Start(Tag::CodeBlock(_)) => {
                in_code_block = true;
                code_block_start = range.start;
            }
            Event::End(TagEnd::CodeBlock) => {
                if in_code_block {
                    code_ranges.push(code_block_start..range.end);
                    in_code_block = false;
                }
            }
            Event::Code(t) => {
                if in_h1 {
                    h1_buf.push_str(&t);
                }
                code_ranges.push(range);
            }
            Event::Start(Tag::Heading {
                level: HeadingLevel::H1,
                ..
            }) if first_h1.is_none() => {
                in_h1 = true;
                h1_buf.clear();
            }
            Event::End(TagEnd::Heading(HeadingLevel::H1)) if in_h1 => {
                in_h1 = false;
                let trimmed = h1_buf.trim();
                if !trimmed.is_empty() {
                    first_h1 = Some(trimmed.to_string());
                }
            }
            Event::Text(t) if in_h1 => {
                h1_buf.push_str(&t);
            }
            Event::Start(Tag::Link { dest_url, .. })
                if !in_code_block && !overlaps_code(&code_ranges, range.start) =>
            {
                let abs_offset = body_offset + range.start;
                links.push(ExtractedLink {
                    raw_target: dest_url.into_string(),
                    display_text: None,
                    kind: LinkKind::Markdown,
                    line_number: line_for_offset(&line_starts, abs_offset),
                    byte_offset: abs_offset,
                });
            }
            Event::Start(Tag::Image { dest_url, .. })
                if !in_code_block && !overlaps_code(&code_ranges, range.start) =>
            {
                let abs_offset = body_offset + range.start;
                links.push(ExtractedLink {
                    raw_target: dest_url.into_string(),
                    display_text: None,
                    kind: LinkKind::Embed,
                    line_number: line_for_offset(&line_starts, abs_offset),
                    byte_offset: abs_offset,
                });
            }
            _ => {}
        }
    }

    extract_wikilinks_outside_code(body, body_offset, &code_ranges, &line_starts, &mut links);
    extract_inline_tags_outside_code(body, &code_ranges, &mut tag_map);

    // Deduplicate links by byte_offset and sort deterministically.
    links.sort_by_key(|l| l.byte_offset);
    links.dedup_by_key(|l| l.byte_offset);

    let title = yaml_title
        .or(first_h1)
        .unwrap_or_else(|| file_stem_title(rel_path));

    let tags = tag_map
        .into_iter()
        .map(|(key, display)| ParsedTag { key, display })
        .collect();
    let aliases = alias_map
        .into_iter()
        .map(|(key, display)| ParsedAlias { key, display })
        .collect();

    ParsedNote {
        parse_status,
        diagnostics,
        has_bom,
        line_ending,
        embedded_id,
        embedded_id_raw,
        title,
        body_plain: body.to_string(),
        tags,
        aliases,
        links,
        declared_type,
        declared_verification,
        declared_supersedes,
    }
}

/// Validates AI-proposed note frontmatter per `ADR-0006` (`SC-19`):
/// proposals cannot inject `personal_brain_id`, `personal_brain.verification`, or `verified_at`.
#[must_use]
pub fn has_forbidden_proposal_frontmatter(raw_text: &str) -> Option<&'static str> {
    let (Some(fm), _, _) = split_frontmatter(raw_text) else {
        return None;
    };
    let Ok(docs) = YamlLoader::load_from_str(fm) else {
        return None;
    };
    let Some(Yaml::Hash(map)) = docs.first() else {
        return None;
    };
    for (k, v) in map {
        if k.as_str() == Some("personal_brain_id") {
            return Some("personal_brain_id cannot be set by AI proposal");
        }
        if k.as_str() == Some("personal_brain") {
            if let Yaml::Hash(pb) = v {
                for (pk, _) in pb {
                    if pk.as_str() == Some("verification") {
                        return Some("personal_brain.verification cannot be set by AI proposal");
                    }
                    if pk.as_str() == Some("verified_at") {
                        return Some("personal_brain.verified_at cannot be set by AI proposal");
                    }
                }
            }
        }
    }
    None
}

pub struct LinkResolutionCorpus {
    /// path_key("folder/note.md") & path_key("folder/note") -> NoteId
    by_rel_path: HashMap<String, NoteId>,
    /// normalized basename (no .md) -> Vec<NoteId>
    by_basename: HashMap<String, Vec<NoteId>>,
    /// normalized alias -> Vec<NoteId>
    by_alias: HashMap<String, Vec<NoteId>>,
    /// known non-markdown attachments by normalized path_key
    attachments: HashSet<String>,
}

impl LinkResolutionCorpus {
    #[must_use]
    pub fn build(
        notes: &[(NoteId, String, Vec<ParsedAlias>)],
        attachment_rel_paths: &[String],
    ) -> Self {
        let mut by_rel_path = HashMap::new();
        let mut by_basename: HashMap<String, Vec<NoteId>> = HashMap::new();
        let mut by_alias: HashMap<String, Vec<NoteId>> = HashMap::new();

        for (note_id, rel_path, aliases) in notes {
            let full_key = path_key(rel_path);
            by_rel_path.insert(full_key.clone(), note_id.clone());
            if let Some(stripped) = full_key.strip_suffix(".MD") {
                by_rel_path.insert(stripped.to_string(), note_id.clone());
            }

            let base = rel_path
                .rsplit('/')
                .next()
                .unwrap_or(rel_path)
                .strip_suffix(".md")
                .or_else(|| {
                    rel_path
                        .rsplit('/')
                        .next()
                        .unwrap_or(rel_path)
                        .strip_suffix(".MD")
                })
                .unwrap_or_else(|| rel_path.rsplit('/').next().unwrap_or(rel_path));
            by_basename
                .entry(base.to_uppercase())
                .or_default()
                .push(note_id.clone());

            for alias in aliases {
                by_alias
                    .entry(alias.key.to_uppercase())
                    .or_default()
                    .push(note_id.clone());
            }
        }

        let attachments = attachment_rel_paths.iter().map(|p| path_key(p)).collect();

        Self {
            by_rel_path,
            by_basename,
            by_alias,
            attachments,
        }
    }

    /// Resolves all links for `source_note_id` at `source_rel_path` deterministically per `SYSTEM_ARCHITECTURE.md` §5.
    #[must_use]
    pub fn resolve_note_links(
        &self,
        source_note_id: &NoteId,
        source_rel_path: &str,
        links: &[ExtractedLink],
    ) -> Vec<ResolvedLink> {
        let source_dir = source_rel_path
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("");

        links
            .iter()
            .map(|link| {
                let (resolution, target) = match link.kind {
                    LinkKind::Wiki => self.resolve_wiki(source_dir, &link.raw_target),
                    LinkKind::Markdown | LinkKind::Embed => {
                        self.resolve_markdown_or_embed(source_dir, &link.raw_target)
                    }
                };
                ResolvedLink {
                    source_note_id: source_note_id.clone(),
                    target_note_id: target,
                    raw_target: link.raw_target.clone(),
                    kind: link.kind,
                    resolution,
                    line_number: link.line_number,
                    byte_offset: link.byte_offset,
                }
            })
            .collect()
    }

    fn resolve_wiki(&self, source_dir: &str, raw_target: &str) -> (LinkResolution, Option<NoteId>) {
        // Strip `#heading` fragment if present
        let target_no_frag = raw_target
            .split('#')
            .next()
            .unwrap_or(raw_target)
            .trim()
            .replace('\\', "/");
        if target_no_frag.is_empty() {
            return (LinkResolution::Broken, None);
        }

        let key = path_key(&target_no_frag);
        if self.attachments.contains(&key) {
            return (LinkResolution::Attachment, None);
        }

        if target_no_frag.contains('/') {
            // Try vault-relative path first
            if let Some(id) = self.by_rel_path.get(&key) {
                return (LinkResolution::Resolved, Some(id.clone()));
            }
            // Try source-relative qualified path
            if !source_dir.is_empty() {
                if let Some(joined) = normalize_relative_join(source_dir, &target_no_frag) {
                    let jkey = path_key(&joined);
                    if self.attachments.contains(&jkey) {
                        return (LinkResolution::Attachment, None);
                    }
                    if let Some(id) = self.by_rel_path.get(&jkey) {
                        return (LinkResolution::Resolved, Some(id.clone()));
                    }
                }
            }
            return (LinkResolution::Broken, None);
        }

        // Exact basename match first
        let base_key = key.strip_suffix(".MD").unwrap_or(&key);
        if let Some(candidates) = self.by_basename.get(base_key) {
            return match candidates.len() {
                0 => (LinkResolution::Broken, None),
                1 => (LinkResolution::Resolved, Some(candidates[0].clone())),
                _ => (LinkResolution::Ambiguous, None),
            };
        }

        // Alias match only if no basename hit
        if let Some(candidates) = self.by_alias.get(base_key) {
            let mut uniq: Vec<NoteId> = candidates.clone();
            uniq.sort();
            uniq.dedup();
            return match uniq.len() {
                0 => (LinkResolution::Broken, None),
                1 => (LinkResolution::Resolved, Some(uniq[0].clone())),
                _ => (LinkResolution::Ambiguous, None),
            };
        }

        (LinkResolution::Broken, None)
    }

    fn resolve_markdown_or_embed(
        &self,
        source_dir: &str,
        raw_target: &str,
    ) -> (LinkResolution, Option<NoteId>) {
        let trimmed = raw_target.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("mailto:")
        {
            return (LinkResolution::External, None);
        }
        if lower.starts_with("file://")
            || trimmed.starts_with("\\\\")
            || trimmed.starts_with("//")
            || trimmed.starts_with('/')
            || (trimmed.len() >= 2 && trimmed.as_bytes()[1] == b':')
        {
            return (LinkResolution::Unsupported, None);
        }

        let target_no_frag = trimmed.split('#').next().unwrap_or(trimmed);
        if target_no_frag.is_empty() {
            return (LinkResolution::Broken, None);
        }
        let Some(joined) = normalize_relative_join(source_dir, target_no_frag) else {
            return (LinkResolution::Unsupported, None);
        };
        let key = path_key(&joined);
        if self.attachments.contains(&key) {
            return (LinkResolution::Attachment, None);
        }
        if let Some(id) = self.by_rel_path.get(&key) {
            return (LinkResolution::Resolved, Some(id.clone()));
        }
        (LinkResolution::Broken, None)
    }
}

fn normalize_relative_join(base_dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<String> = if base_dir.is_empty() {
        Vec::new()
    } else {
        base_dir.split('/').map(ToString::to_string).collect()
    };
    for seg in rel.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop()?;
        } else {
            parts.push(seg.to_string());
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

fn split_frontmatter(text: &str) -> (Option<&str>, usize, &str) {
    let after_open = if let Some(rest) = text.strip_prefix("---\r\n") {
        (rest, 5usize)
    } else if let Some(rest) = text.strip_prefix("---\n") {
        (rest, 4usize)
    } else {
        return (None, 0, text);
    };

    let (rest, start_offset) = after_open;
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        let line_no_eol = line.trim_end_matches(['\r', '\n']);
        if line_no_eol == "---" {
            let fm = &rest[..offset];
            let body_start = start_offset + offset + line.len();
            return (Some(fm), body_start, &text[body_start..]);
        }
        offset += line.len();
    }
    (None, 0, text)
}

fn count_yaml_alias_tokens(fm: &str) -> usize {
    fm.split_whitespace()
        .filter(|tok| tok.starts_with('*'))
        .count()
}

fn validate_yaml_bounds(yaml: &Yaml, depth: usize, node_count: &mut usize) -> bool {
    if depth > MAX_YAML_DEPTH || *node_count > MAX_YAML_NODES {
        return false;
    }
    *node_count += 1;
    match yaml {
        Yaml::Array(arr) => arr
            .iter()
            .all(|item| validate_yaml_bounds(item, depth + 1, node_count)),
        Yaml::Hash(map) => map.iter().all(|(k, v)| {
            validate_yaml_bounds(k, depth + 1, node_count)
                && validate_yaml_bounds(v, depth + 1, node_count)
        }),
        _ => true,
    }
}

#[allow(clippy::too_many_arguments)]
fn extract_frontmatter_fields(
    doc: &Yaml,
    yaml_title: &mut Option<String>,
    embedded_id: &mut Option<NoteId>,
    embedded_id_raw: &mut Option<String>,
    declared_type: &mut Option<String>,
    declared_verification: &mut Option<String>,
    declared_supersedes: &mut Vec<String>,
    tag_map: &mut BTreeMap<String, String>,
    alias_map: &mut BTreeMap<String, String>,
    parse_status: &mut ParseStatus,
    diagnostics: &mut Vec<String>,
) {
    let Yaml::Hash(map) = doc else {
        return;
    };
    for (k, v) in map {
        let Some(key_name) = k.as_str() else {
            continue;
        };
        match key_name {
            "personal_brain_id" => {
                if let Some(raw) = v.as_str() {
                    let trimmed = raw.trim().to_string();
                    embedded_id_raw.replace(trimmed.clone());
                    match NoteId::parse(&trimmed) {
                        Ok(id) => *embedded_id = Some(id),
                        Err(_) => {
                            *parse_status = ParseStatus::Warning;
                            diagnostics
                                .push("invalid personal_brain_id UUID in frontmatter".to_string());
                        }
                    }
                }
            }
            "title" => {
                if let Some(t) = v.as_str() {
                    let trimmed = t.trim();
                    if !trimmed.is_empty() {
                        *yaml_title = Some(trimmed.to_string());
                    }
                }
            }
            "tags" => collect_string_or_list(v, |raw| {
                let clean = raw.trim().trim_start_matches('#');
                if !clean.is_empty() {
                    tag_map
                        .entry(clean.to_lowercase())
                        .or_insert_with(|| clean.to_string());
                }
            }),
            "aliases" => collect_string_or_list(v, |raw| {
                let clean = raw.trim();
                if !clean.is_empty() {
                    alias_map
                        .entry(clean.to_lowercase())
                        .or_insert_with(|| clean.to_string());
                }
            }),
            "personal_brain" => {
                if let Yaml::Hash(pb) = v {
                    for (pk, pv) in pb {
                        match pk.as_str() {
                            Some("type") => {
                                if let Some(s) = pv.as_str() {
                                    *declared_type = Some(s.trim().to_string());
                                }
                            }
                            Some("verification") => {
                                if let Some(s) = pv.as_str() {
                                    *declared_verification = Some(s.trim().to_string());
                                }
                            }
                            Some("supersedes") => collect_string_or_list(pv, |s| {
                                let clean = s.trim();
                                if !clean.is_empty() {
                                    declared_supersedes.push(clean.to_string());
                                }
                            }),
                            _ => {}
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn collect_string_or_list(val: &Yaml, mut f: impl FnMut(&str)) {
    match val {
        Yaml::String(s) => {
            for part in s.split(',') {
                f(part);
            }
        }
        Yaml::Array(arr) => {
            for item in arr {
                if let Some(s) = item.as_str() {
                    f(s);
                }
            }
        }
        _ => {}
    }
}

fn extract_wikilinks_outside_code(
    body: &str,
    body_offset: usize,
    code_ranges: &[Range<usize>],
    line_starts: &[usize],
    links: &mut Vec<ExtractedLink>,
) {
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i + 3 < bytes.len() {
        let is_embed =
            bytes[i] == b'!' && i + 4 < bytes.len() && bytes[i + 1] == b'[' && bytes[i + 2] == b'[';
        let is_wiki = bytes[i] == b'[' && bytes[i + 1] == b'[';
        if !is_embed && !is_wiki {
            i += 1;
            continue;
        }
        if overlaps_code(code_ranges, i) {
            i += 1;
            continue;
        }
        let open_len = if is_embed { 3 } else { 2 };
        let start = i;
        let mut j = i + open_len;
        while j + 1 < bytes.len() {
            if bytes[j] == b'\n' {
                break;
            }
            if bytes[j] == b']' && bytes[j + 1] == b']' {
                let inner = &body[i + open_len..j];
                let (target_part, display_part) = match inner.split_once('|') {
                    Some((t, d)) => (t.trim(), Some(d.trim().to_string())),
                    None => (inner.trim(), None),
                };
                if !target_part.is_empty() {
                    let abs_offset = body_offset + start;
                    links.push(ExtractedLink {
                        raw_target: target_part.to_string(),
                        display_text: display_part,
                        kind: if is_embed {
                            LinkKind::Embed
                        } else {
                            LinkKind::Wiki
                        },
                        line_number: line_for_offset(line_starts, abs_offset),
                        byte_offset: abs_offset,
                    });
                }
                i = j + 2;
                break;
            }
            j += 1;
        }
        if i == start {
            i += 1;
        }
    }
}

fn extract_inline_tags_outside_code(
    body: &str,
    code_ranges: &[Range<usize>],
    tag_map: &mut BTreeMap<String, String>,
) {
    let bytes = body.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'#' && !overlaps_code(code_ranges, i) {
            let prev_ok = i == 0
                || bytes[i - 1].is_ascii_whitespace()
                || matches!(bytes[i - 1], b'(' | b'[' | b',' | b':');
            if prev_ok && i + 1 < bytes.len() {
                let rest = &body[i + 1..];
                let end_rel = rest
                    .char_indices()
                    .find(|(_, ch)| {
                        !(ch.is_alphanumeric() || *ch == '_' || *ch == '-' || *ch == '/')
                    })
                    .map(|(idx, _)| idx)
                    .unwrap_or(rest.len());
                let candidate = &rest[..end_rel];
                if !candidate.is_empty() && candidate.chars().any(|c| c.is_alphabetic()) {
                    tag_map
                        .entry(candidate.to_lowercase())
                        .or_insert_with(|| candidate.to_string());
                    i += 1 + end_rel;
                    continue;
                }
            }
        }
        i += 1;
    }
}

fn overlaps_code(code_ranges: &[Range<usize>], offset: usize) -> bool {
    code_ranges
        .iter()
        .any(|r| offset >= r.start && offset < r.end)
}

fn compute_line_starts(text: &str) -> Vec<usize> {
    let mut starts = vec![0usize];
    for (idx, b) in text.bytes().enumerate() {
        if b == b'\n' && idx < text.len() {
            starts.push(idx + 1);
        }
    }
    starts
}

fn line_for_offset(line_starts: &[usize], offset: usize) -> usize {
    line_starts.partition_point(|&s| s <= offset).max(1)
}

fn file_stem_title(rel_path: &str) -> String {
    let name = rel_path.rsplit('/').next().unwrap_or(rel_path);
    name.strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))
        .unwrap_or(name)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_bom_crlf_and_ignores_code_links() {
        let raw = b"\xEF\xBB\xBF---\r\ntitle: Spec Note\r\ntags: [Alpha, inline-tag]\r\naliases: [SN]\r\nunknown_prop: keep\r\n---\r\n# Heading\r\n\r\nReal [[Target]] and #Inline-Tag.\r\n\r\n`[[CodeSpan]]` and `#not-a-tag-in-code`:\r\n```md\r\n[[FencedLink]] #fenced-tag\r\n```\r\n";
        let parsed = parse_markdown_bytes("Projects/Spec.md", raw);
        assert!(parsed.has_bom);
        assert_eq!(parsed.line_ending, LineEnding::Crlf);
        assert_eq!(parsed.title, "Spec Note");
        assert_eq!(parsed.links.len(), 1);
        assert_eq!(parsed.links[0].raw_target, "Target");
        assert_eq!(parsed.tags.len(), 2);
        assert_eq!(parsed.aliases.len(), 1);
    }
}
