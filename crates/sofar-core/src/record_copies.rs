//! Record copies across branches (`core/record-copies.ts`, branch-visibility
//! D1; SPEC §Record copies across branches). Every branch carries its own copy
//! of every events.jsonl, and a checkout that folds only its own copy reports
//! whatever that branch last saw. The fix is read-side only: folding the union
//! of the copies, duplicate ids dropped, is exactly what merging every branch
//! with `merge=union` would give.
//!
//! This module holds the `SessionStart` half (3.3, `worktreeLeads`): files
//! only, no subprocess, inside the hook budget.

use std::collections::HashSet;
use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use crate::git::common_git_dir;
use crate::json::{self, Json};
use crate::resolve::posix_resolve;
use crate::text::{is_js_whitespace, js_trim};

/// Which kind of copy (`CopyKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyKind {
    Worktree,
    Branch,
    Remote,
}

impl CopyKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            CopyKind::Worktree => "worktree",
            CopyKind::Branch => "branch",
            CopyKind::Remote => "remote",
        }
    }
}

/// One copy of the record (`RecordCopy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordCopy {
    pub kind: CopyKind,
    /// The worktree's checked-out branch (None when detached), or the short ref name.
    pub reference: Option<String>,
    /// Checkout root for a worktree; None for a ref.
    pub path: Option<String>,
}

/// `WorktreeLead`: another checkout's copy holds events this one lacks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeLead {
    pub copy: RecordCopy,
    pub unseen: usize,
}

/// A checkout of this repo (`Checkout`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkout {
    pub root: String,
    pub branch: Option<String>,
}

fn is_slug(s: &str) -> bool {
    crate::payload::is_initiative_slug(s)
}

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|b| js_trim(&String::from_utf8_lossy(&b)).to_owned())
}

/// `branchOfHead`: `/^ref:\s*refs\/heads\/(.+)$/` on the trimmed HEAD.
fn branch_of_head(head: Option<&str>) -> Option<String> {
    let rest = head?.strip_prefix("ref:")?;
    let branch = rest
        .trim_start_matches(is_js_whitespace)
        .strip_prefix("refs/heads/")?;
    (!branch.is_empty() && !branch.contains(['\n', '\r', '\u{2028}', '\u{2029}']))
        .then(|| branch.to_owned())
}

/// The common git dir as `resolve` spells it: absolute and normalized.
#[must_use]
pub fn common_dir(root: &Path) -> Option<String> {
    let dir = common_git_dir(root)?;
    Some(posix_resolve(
        &root.to_string_lossy(),
        &dir.to_string_lossy(),
    ))
}

fn dirname(path: &str) -> String {
    match path.rfind('/') {
        Some(0) => "/".to_owned(),
        Some(i) => path[..i].to_owned(),
        None => ".".to_owned(),
    }
}

/// `listCheckouts`: every checkout of this repo, from the common git dir
/// alone — the main checkout (a non-bare `<root>/.git`) plus each linked
/// worktree whose directory still exists.
#[must_use]
pub fn list_checkouts(common: &str) -> Vec<Checkout> {
    let mut checkouts = Vec::new();
    let common_path = Path::new(common);
    if common.rsplit('/').next() == Some(".git") {
        checkouts.push(Checkout {
            root: dirname(common),
            branch: branch_of_head(read_trimmed(&common_path.join("HEAD")).as_deref()),
        });
    }
    let mut names: Vec<String> = fs::read_dir(common_path.join("worktrees"))
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| crate::text::cmp_utf16(a, b));
    for name in names {
        let admin = common_path.join("worktrees").join(&name);
        let Some(pointer) = read_trimmed(&admin.join("gitdir")) else {
            continue;
        };
        if pointer.is_empty() {
            continue;
        }
        let dot_git = posix_resolve(&admin.to_string_lossy(), &pointer);
        let root = dirname(&dot_git);
        if !Path::new(&root).exists() {
            continue;
        }
        checkouts.push(Checkout {
            root,
            branch: branch_of_head(read_trimmed(&admin.join("HEAD")).as_deref()),
        });
    }
    checkouts
}

fn realpath(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

/// `CANONICAL_ID`: canonical lines lead with `{"v":N,"id":"…"`.
fn canonical_id(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("{\"v\":")?;
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let rest = rest[digits..].strip_prefix(",\"id\":\"")?;
    let end = rest.find('"')?;
    (end > 0).then(|| &rest[..end])
}

/// `lineId`: the event id of one log line, or None when the fold could not use it.
#[must_use]
pub fn line_id(line: &str) -> Option<String> {
    if let Some(id) = canonical_id(line) {
        return Some(id.to_owned());
    }
    match json::parse(line) {
        Ok(Json::Obj(o)) => o
            .get("id")
            .and_then(Json::as_nonempty_str)
            .map(str::to_owned),
        _ => None,
    }
}

fn ids_of(text: &str) -> HashSet<String> {
    text.split('\n')
        .map(js_trim)
        .filter(|l| !l.is_empty())
        .filter_map(line_id)
        .collect()
}

/// `PREFIX_PROBE_BYTES`: the tail window compared to call a copy an older prefix.
const PREFIX_PROBE_BYTES: u64 = 4096;

fn read_window(path: &Path, offset: u64, length: u64) -> Option<Vec<u8>> {
    let mut f = fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; usize::try_from(length).ok()?];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn read_text(path: &Path) -> Option<String> {
    fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// `worktreeLeads`: which OTHER worktrees hold events of this record that
/// this checkout's copy lacks, most first (ties keep checkout order). A copy
/// that is an older prefix of this log is proved so by one tail window.
#[must_use]
pub fn worktree_leads(root: &Path, slug: &str, local_path: &Path) -> Vec<WorktreeLead> {
    if !is_slug(slug) {
        return Vec::new();
    }
    let Some(common) = common_dir(root) else {
        return Vec::new();
    };
    let me = realpath(root);
    let local_size = fs::metadata(local_path).map_or(0, |m| m.len());
    let mut local_ids: Option<HashSet<String>> = None;
    let mut leads = Vec::new();
    for checkout in list_checkouts(&common) {
        if me.is_some() && realpath(Path::new(&checkout.root)) == me {
            continue;
        }
        let path = Path::new(&checkout.root)
            .join(".sofar")
            .join("initiatives")
            .join(slug)
            .join("events.jsonl");
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let size = meta.len();
        if size == 0 {
            continue;
        }
        if size <= local_size {
            let width = PREFIX_PROBE_BYTES.min(size);
            let theirs = read_window(&path, size - width, width);
            let ours = read_window(local_path, size - width, width);
            if theirs.is_some() && theirs == ours {
                continue;
            }
        }
        let Some(text) = read_text(&path) else {
            continue;
        };
        let local = local_ids.get_or_insert_with(|| {
            if local_size > 0 {
                read_text(local_path)
                    .map(|t| ids_of(&t))
                    .unwrap_or_default()
            } else {
                HashSet::new()
            }
        });
        let unseen = ids_of(&text)
            .iter()
            .filter(|id| !local.contains(*id))
            .count();
        if unseen > 0 {
            leads.push(WorktreeLead {
                copy: RecordCopy {
                    kind: CopyKind::Worktree,
                    reference: checkout.branch,
                    path: Some(checkout.root),
                },
                unseen,
            });
        }
    }
    leads.sort_by_key(|l| std::cmp::Reverse(l.unseen));
    leads
}

// ---------------------------------------------------------------------------
// The templates (`projections/templates/copies.ts`).

/// How many contributing copies a one-line summary names before "+N more".
const SUMMARY_NAMES: usize = 2;

/// `tildify`.
#[must_use]
pub fn tildify(path: &str, home: Option<&str>) -> String {
    let Some(home) = home.filter(|h| !h.is_empty()) else {
        return path.to_owned();
    };
    if path == home {
        return "~".to_owned();
    }
    match path.strip_prefix(home).filter(|rest| rest.starts_with('/')) {
        Some(rest) => format!("~{rest}"),
        None => path.to_owned(),
    }
}

fn copy_name(copy: &RecordCopy) -> &str {
    copy.reference.as_deref().unwrap_or("detached")
}

/// `copyLabel`: `r1-fixes (worktree ~/IO/sofar-r1-fixes)`, `x (branch)`, `origin/x (remote)`.
#[must_use]
pub fn copy_label(copy: &RecordCopy, home: Option<&str>) -> String {
    if copy.kind == CopyKind::Worktree {
        return format!(
            "{} (worktree {})",
            copy_name(copy),
            tildify(copy.path.as_deref().unwrap_or("?"), home)
        );
    }
    format!("{} ({})", copy_name(copy), copy.kind.as_str())
}

/// `WORKTREE_LEADS_BUDGET`.
pub const WORKTREE_LEADS_BUDGET: usize = 360;

/// `worktreeLeadsNotice`: the `SessionStart` line naming other worktrees whose
/// copy of this record holds events this checkout lacks; None when none does.
#[must_use]
pub fn worktree_leads_notice(leads: &[WorktreeLead], home: Option<&str>) -> Option<String> {
    if leads.is_empty() {
        return None;
    }
    let total: usize = leads.iter().map(|l| l.unseen).sum();
    let named: Vec<String> = leads
        .iter()
        .take(SUMMARY_NAMES)
        .map(|l| format!("+{} on {}", l.unseen, copy_label(&l.copy, home)))
        .collect();
    let more = if leads.len() > SUMMARY_NAMES {
        format!(", +{} more", leads.len() - SUMMARY_NAMES)
    } else {
        String::new()
    };
    Some(crate::projections::clip(
        &format!(
            "⚠ {total} event(s) of this record live on other worktrees, not on this checkout: {}{more}. This block folds this checkout's copy alone; `sofar status` folds them in. They reach this branch only by a merge.",
            named.join(", ")
        ),
        WORKTREE_LEADS_BUDGET,
    ))
}

/// `os.homedir()` as Node reads it on POSIX: `$HOME` when set.
#[must_use]
pub fn home_dir() -> Option<String> {
    std::env::var("HOME").ok().filter(|h| !h.is_empty())
}
