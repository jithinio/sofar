//! Commit attribution by trailer (`core/attribution.ts`, SPEC §Commit
//! attribution): ONE bounded `git log` walk on `SessionStart` (allowed by
//! commit-attribution D6), the `rev-list` shipping check, and the derivations
//! the shipping and commits notices render. Spawns are exactly the
//! TypeScript ones: same argv, 5 s timeout, 16 MiB cap, any failure → None.

use std::collections::HashSet;
use std::io::Read as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::atomic::write_file_atomic;
use crate::git::{current_branch, head_sha};
use crate::json::{self, Json, Object};
use crate::layout::Layout;
use crate::text::{is_js_whitespace, js_trim};

pub const TRAILER_KEY: &str = "Sofar-Initiative";
pub const DEFAULT_MAX_COUNT: usize = 200;
const RS: char = '\x1e';
const US: char = '\x1f';
const MAX_BUFFER: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitAttribution {
    pub sha: String,
    pub initiatives: Vec<String>,
    pub subject: Option<String>,
}

fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// `execFileSync('git', args, {cwd, timeout: 5000, maxBuffer: 16 MiB})`: stdout
/// on success, None on a non-zero exit, a timeout, an oversized output or a
/// missing git.
fn run_git(cwd: &Path, args: &[String]) -> Option<String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                if !status.success() || out.len() > MAX_BUFFER {
                    return None;
                }
                return Some(String::from_utf8_lossy(&out).into_owned());
            }
            Ok(None) => {
                if started.elapsed() > Duration::from_secs(5) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(_) => return None,
        }
    }
}

/// `AttributionQuery`: the window, an optional range, and the first-push form.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttributionQuery {
    pub range: Option<String>,
    pub max_count: Option<usize>,
    pub first_push_of: Option<String>,
}

/// `readAttribution(rootDir, {maxCount})`.
#[must_use]
pub fn read_attribution(root: &Path, max_count: usize) -> Option<Vec<CommitAttribution>> {
    read_attribution_query(
        root,
        &AttributionQuery {
            max_count: Some(max_count),
            ..AttributionQuery::default()
        },
    )
}

/// `readAttribution(rootDir, query)`: a range is a rev, never a flag; the
/// first-push form subtracts every other origin ref.
#[must_use]
pub fn read_attribution_query(
    root: &Path,
    query: &AttributionQuery,
) -> Option<Vec<CommitAttribution>> {
    let max_count = query.max_count.unwrap_or(DEFAULT_MAX_COUNT);
    if max_count == 0 {
        return None;
    }
    let mut args = vec![
        "log".to_owned(),
        "--no-color".to_owned(),
        format!("--max-count={max_count}"),
        format!("--format={RS}%H{US}%(trailers:key={TRAILER_KEY},valueonly,separator=%x2C){US}%B"),
    ];
    if let Some(range) = &query.range {
        if range.is_empty() || range.starts_with('-') {
            return None;
        }
        args.push(range.clone());
    }
    if let Some(branch) = &query.first_push_of {
        if branch.is_empty()
            || branch.starts_with('-')
            || branch
                .chars()
                .any(|c| crate::text::is_js_whitespace(c) || matches!(c, '*' | '?' | '[' | ']'))
        {
            return None;
        }
        args.push("--not".to_owned());
        args.push(format!("--exclude=origin/{branch}"));
        args.push("--remotes=origin".to_owned());
    }
    run_git(root, &args).map(|out| parse_attribution(&out))
}

/// `parseSlugs`: comma-separated, trimmed, slug-shaped, deduplicated in order.
fn parse_slugs(raw: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let slug = js_trim(part);
        if is_slug(slug) && !seen.iter().any(|s| s == slug) {
            seen.push(slug.to_owned());
        }
    }
    seen
}

/// `squashedSlugs`: `^[ \t]+Sofar-Initiative:(.*)$` per line of a squash body.
fn squashed_slugs(body: &str) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for line in body.split(['\n', '\r', '\u{2028}', '\u{2029}']) {
        let stripped = line.trim_start_matches([' ', '\t']);
        if stripped.len() == line.len() {
            continue;
        }
        let Some(rest) = stripped.strip_prefix("Sofar-Initiative:") else {
            continue;
        };
        for slug in parse_slugs(rest) {
            if !seen.contains(&slug) {
                seen.push(slug);
            }
        }
    }
    seen
}

/// `parseAttribution`.
#[must_use]
pub fn parse_attribution(out: &str) -> Vec<CommitAttribution> {
    let mut commits = Vec::new();
    for record in out.split(RS) {
        if record.is_empty() {
            continue;
        }
        let Some(sep) = record.find(US) else { continue };
        let sha = js_trim(&record[..sep]);
        if !is_full_sha(sha) {
            continue;
        }
        let after = &record[sep + 1..];
        let (trailers, body) = match after.find(US) {
            Some(i) => (&after[..i], &after[i + 1..]),
            None => (after, ""),
        };
        let mut initiatives = parse_slugs(trailers);
        if initiatives.is_empty() {
            initiatives = squashed_slugs(body);
        }
        let subject = js_trim(body.split('\n').next().unwrap_or(""));
        commits.push(CommitAttribution {
            sha: sha.to_owned(),
            initiatives,
            subject: (!subject.is_empty()).then(|| subject.to_owned()),
        });
    }
    commits
}

pub const ATTRIBUTION_CACHE_VERSION: f64 = 1.0;
const ATTRIBUTION_FILE: &str = "attribution.json";

/// `cachedAttribution` (rust-core 4.4, L1): the `SessionStart` walk keyed by
/// the FULL sha HEAD names plus the bound, in `.sofar/.index/attribution.json`
/// — derived only. Any mismatch, a corrupt file or a mis-shaped one re-walks
/// and rewrites; the walk names the sha as its rev, so what is cached is
/// exactly the key's history. No sha from files: the plain walk, uncached. A
/// failed walk is never cached. The file is shared with the TypeScript engine
/// byte for byte.
#[must_use]
pub fn cached_attribution(layout: &Layout, max_count: usize) -> Option<Vec<CommitAttribution>> {
    let root = &layout.root;
    let Some(head) = head_sha(root) else {
        return read_attribution(root, max_count);
    };
    let path = layout.index_dir().join(ATTRIBUTION_FILE);
    #[allow(
        clippy::cast_precision_loss,
        reason = "walk bounds are small integers, exact in f64"
    )]
    let bound = max_count as f64;
    if let Ok(bytes) = std::fs::read(&path)
        && let Ok(Json::Obj(raw)) = json::parse_bytes_fast(&bytes)
        && raw.get("v").and_then(Json::as_f64) == Some(ATTRIBUTION_CACHE_VERSION)
        && raw.get("head").and_then(Json::as_str) == Some(head.as_str())
        && raw.get("maxCount").and_then(Json::as_f64) == Some(bound)
        && let Some(commits) = raw.get("commits").and_then(commits_from_json)
    {
        return Some(commits);
    }
    let commits = read_attribution_query(
        root,
        &AttributionQuery {
            range: Some(head.clone()),
            max_count: Some(max_count),
            first_push_of: None,
        },
    )?;
    let _ = write_attribution(layout, &path, &head, bound, &commits);
    Some(commits)
}

/// Trusted only in the shape the walk itself returns (`isCommitList`).
fn commits_from_json(v: &Json) -> Option<Vec<CommitAttribution>> {
    let Json::Arr(items) = v else { return None };
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let o = item.as_obj()?;
        let sha = o.get("sha")?.as_str().filter(|s| is_full_sha(s))?;
        let Json::Arr(slugs) = o.get("initiatives")? else {
            return None;
        };
        let initiatives = slugs
            .iter()
            .map(|s| s.as_str().filter(|s| is_slug(s)).map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        let subject = match o.get("subject") {
            None => None,
            Some(Json::Str(s)) if !s.is_empty() => Some(s.clone()),
            Some(_) => return None,
        };
        out.push(CommitAttribution {
            sha: sha.to_owned(),
            initiatives,
            subject,
        });
    }
    Some(out)
}

fn write_attribution(
    layout: &Layout,
    path: &Path,
    head: &str,
    bound: f64,
    commits: &[CommitAttribution],
) -> std::io::Result<()> {
    layout.ensure_index_dir()?;
    let list = commits
        .iter()
        .map(|c| {
            let mut o = Object::with_capacity(3);
            o.insert(
                "initiatives",
                Json::Arr(c.initiatives.iter().cloned().map(Json::Str).collect()),
            );
            o.insert("sha", Json::Str(c.sha.clone()));
            if let Some(subject) = &c.subject {
                o.insert("subject", Json::Str(subject.clone()));
            }
            Json::Obj(o)
        })
        .collect();
    let mut o = Object::with_capacity(4);
    o.insert("commits", Json::Arr(list));
    o.insert("head", Json::Str(head.to_owned()));
    o.insert("maxCount", Json::Num(bound));
    o.insert("v", Json::Num(ATTRIBUTION_CACHE_VERSION));
    let mut text = json::stringify_canonical(&Json::Obj(o));
    text.push('\n');
    write_file_atomic(path, text.as_bytes())
}

/// `readUnpushed`: shas of `<upstream>..HEAD`, or None when the ref is unanswerable.
#[must_use]
pub fn read_unpushed(root: &Path, upstream_ref: &str) -> Option<HashSet<String>> {
    if upstream_ref.is_empty() || upstream_ref.starts_with('-') {
        return None;
    }
    let out = run_git(
        root,
        &["rev-list".to_owned(), format!("{upstream_ref}..HEAD")],
    )?;
    Some(
        out.split('\n')
            .map(js_trim)
            .filter(|s| is_full_sha(s))
            .map(str::to_owned)
            .collect(),
    )
}

/// `InitiativeShipping`: this record's commits by ship state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InitiativeShipping {
    pub pushed: Vec<String>,
    pub local: Vec<String>,
    pub unknown: Vec<String>,
}

/// `shippingBySlug`, keyed in first-seen order.
#[must_use]
#[allow(clippy::implicit_hasher, reason = "one call site, the default hasher")]
pub fn shipping_by_slug(
    commits: &[CommitAttribution],
    unpushed: Option<&HashSet<String>>,
) -> Vec<(String, InitiativeShipping)> {
    let mut out: Vec<(String, InitiativeShipping)> = Vec::new();
    for commit in commits {
        for slug in &commit.initiatives {
            let i = if let Some(i) = out.iter().position(|(s, _)| s == slug) {
                i
            } else {
                out.push((slug.clone(), InitiativeShipping::default()));
                out.len() - 1
            };
            let entry = &mut out[i].1;
            match unpushed {
                None => entry.unknown.push(commit.sha.clone()),
                Some(set) if set.contains(&commit.sha) => entry.local.push(commit.sha.clone()),
                Some(_) => entry.pushed.push(commit.sha.clone()),
            }
        }
    }
    out
}

/// `readShippingFrom`: the second spawn only when something is attributed.
#[must_use]
pub fn read_shipping_from(
    root: &Path,
    commits: &[CommitAttribution],
) -> Vec<(String, InitiativeShipping)> {
    if !commits.iter().any(|c| !c.initiatives.is_empty()) {
        return Vec::new();
    }
    let unpushed = current_branch(root).and_then(|b| read_unpushed(root, &format!("origin/{b}")));
    shipping_by_slug(commits, unpushed.as_ref())
}

/// `taskOfSubject`: `/^(\d+(?:\.\d+)*):\s/`.
#[must_use]
pub fn task_of_subject(subject: &str) -> Option<&str> {
    let bytes = subject.as_bytes();
    let mut i = 0;
    loop {
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return None;
        }
        if bytes.get(i) == Some(&b'.') {
            i += 1;
            continue;
        }
        break;
    }
    if bytes.get(i) != Some(&b':') {
        return None;
    }
    let rest = &subject[i + 1..];
    rest.chars().next().filter(|c| is_js_whitespace(*c))?;
    Some(&subject[..i])
}

/// `commitsByTask`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitsByTask {
    pub total: usize,
    pub by_task: Vec<(String, u64)>,
    pub newest: Option<(String, String)>,
}

#[must_use]
pub fn commits_by_task(commits: &[CommitAttribution], slug: &str) -> CommitsByTask {
    let mut out = CommitsByTask::default();
    for c in commits {
        if !c.initiatives.iter().any(|s| s == slug) {
            continue;
        }
        out.total += 1;
        let subject = c.subject.clone().unwrap_or_default();
        if out.newest.is_none() {
            out.newest = Some((c.sha.clone(), subject.clone()));
        }
        let key = task_of_subject(&subject).unwrap_or("other").to_owned();
        match out.by_task.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 += 1,
            None => out.by_task.push((key, 1)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_records_trailers_and_squash_bodies() {
        let out = format!(
            "{RS}{}{US}rust-core,r1-fixes{US}2.4: digest\n\nbody\n{RS}{}{US}{US}Squash\n\n  Sofar-Initiative: speed\n\tSofar-Initiative: speed, cli-ui\n{RS}bad{US}x{US}y",
            "a".repeat(40),
            "b".repeat(40)
        );
        let commits = parse_attribution(&out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].initiatives, ["rust-core", "r1-fixes"]);
        assert_eq!(commits[0].subject.as_deref(), Some("2.4: digest"));
        assert_eq!(commits[1].initiatives, ["speed", "cli-ui"]);
        assert_eq!(commits[1].subject.as_deref(), Some("Squash"));
        let by = commits_by_task(&commits, "rust-core");
        assert_eq!(by.total, 1);
        assert_eq!(by.by_task, [("2.4".to_owned(), 1)]);
        assert_eq!(task_of_subject("1.2.3: x"), Some("1.2.3"));
        assert_eq!(task_of_subject("1.: x"), None);
        assert_eq!(task_of_subject("12:x"), None);
    }
}
