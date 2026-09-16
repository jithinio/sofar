//! Initiative resolution (`createToolContext.resolveInitiative` in
//! `mcp/context.ts`, `docs/HOTPATH.md` §Record resolution (shared)): explicit
//! slug wins; else the current branch → `.sofar/bindings.json`; else the
//! quick-work lane when it exists and is open (r1-fixes 2.6, D14); then
//! containment and existence. Error text is the TypeScript engine's, byte for
//! byte, because `sofar status` prints it.

use std::path::{Path, PathBuf};

use crate::git::current_branch;
use crate::json::{self, Json};
use crate::layout::{Layout, initiative_slugs};
use crate::snapshot::{fold_file, state_of};
use crate::status::{QUICK_LANE, is_closed_initiative_status};

/// A `ToolError` the resolution raises: the code and the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    UnknownInitiative(String),
    IoError(String),
}

impl ResolveError {
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            ResolveError::UnknownInitiative(m) | ResolveError::IoError(m) => m,
        }
    }
}

/// Node's `path.posix.normalize`: `.` and `..` resolved, empty segments
/// dropped, a trailing slash kept only when asked (`join` keeps it, `resolve`
/// does not).
#[must_use]
pub fn posix_normalize(path: &str, keep_trailing: bool) -> String {
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let mut out = if absolute {
        "/".to_owned()
    } else {
        String::new()
    };
    out.push_str(&parts.join("/"));
    if out.is_empty() {
        out.push('.');
    }
    if keep_trailing && trailing && !out.ends_with('/') {
        out.push('/');
    }
    out
}

/// `path.resolve(--root ?? cwd)`: absolute and normalised.
#[must_use]
pub fn resolve_root(root: Option<&Path>) -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let raw = match root {
        Some(r) if r.is_absolute() => r.to_path_buf(),
        Some(r) => cwd.join(r),
        None => cwd,
    };
    PathBuf::from(posix_normalize(&raw.to_string_lossy(), false))
}

const MAX_LISTED: usize = 10;

/// `knownInitiatives`: the suffix every unknown-initiative message carries.
#[must_use]
pub fn known_initiatives(layout: &Layout) -> String {
    let slugs = initiative_slugs(layout);
    if slugs.is_empty() {
        return "no initiatives exist yet — create one with `sofar new <slug>`".to_owned();
    }
    let listed = slugs
        .iter()
        .take(MAX_LISTED)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    let more = if slugs.len() > MAX_LISTED {
        format!(", …+{} more", slugs.len() - MAX_LISTED)
    } else {
        String::new()
    };
    format!("available initiatives: {listed}{more} (details: sofar list)")
}

/// `readBindings`: branch → slug, string values only; invalid JSON or a
/// non-object is an `io_error`.
pub fn read_bindings(layout: &Layout) -> Result<Vec<(String, String)>, ResolveError> {
    let path = layout.bindings_path();
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(Vec::new());
    };
    let text = String::from_utf8_lossy(&bytes);
    // V8's SyntaxError text is not reproduced (json.rs claims no message
    // parity); no conformance case reaches this branch.
    let decoded = json::parse(&text).map_err(|e| {
        ResolveError::IoError(format!(
            ".sofar/bindings.json is not valid JSON: parse error at offset {}",
            e.offset
        ))
    })?;
    let Json::Obj(obj) = decoded else {
        return Err(ResolveError::IoError(
            ".sofar/bindings.json must be a JSON object of branch → slug".to_owned(),
        ));
    };
    Ok(obj
        .js_ordered()
        .into_iter()
        .filter_map(|(branch, slug)| slug.as_str().map(|s| (branch.to_owned(), s.to_owned())))
        .collect())
}

/// `assertContained`: a slug becomes a path, so it must never be able to name one.
pub fn assert_contained(layout: &Layout, slug: &str) -> Result<(), ResolveError> {
    let root = posix_normalize(&layout.initiatives_root().to_string_lossy(), false);
    let joined = if slug.is_empty() {
        root.clone()
    } else {
        posix_normalize(&format!("{root}/{slug}"), true)
    };
    let dir = posix_normalize(&joined, false);
    if dir != joined || !dir.starts_with(&format!("{root}/")) {
        return Err(ResolveError::UnknownInitiative(format!(
            "invalid initiative \"{slug}\" — slugs are lowercase letters, digits, and hyphens ([a-z0-9-]+), never a path"
        )));
    }
    Ok(())
}

/// `laneOpen`: the quick lane exists and its folded status is not closed.
#[must_use]
pub fn lane_open(layout: &Layout) -> bool {
    if !layout.initiative_dir(QUICK_LANE).exists() {
        return false;
    }
    match fold_file(&layout.events_path(QUICK_LANE), QUICK_LANE) {
        Ok(snapshot) => !is_closed_initiative_status(&state_of(&snapshot).state.status),
        Err(_) => false,
    }
}

/// `resolveInitiative(explicit?)`.
pub fn resolve_initiative(layout: &Layout, explicit: Option<&str>) -> Result<String, ResolveError> {
    let slug = if let Some(s) = explicit {
        s.to_owned()
    } else {
        let Some(branch) = current_branch(&layout.root) else {
            return Err(ResolveError::UnknownInitiative(format!(
                "no current git branch found under {} (not a repo, or detached HEAD) — pass `initiative` explicitly; {}",
                layout.root.display(),
                known_initiatives(layout)
            )));
        };
        let bindings = read_bindings(layout)?;
        if let Some((_, bound)) = bindings.into_iter().find(|(b, _)| *b == branch) {
            bound
        } else {
            if !lane_open(layout) {
                return Err(ResolveError::UnknownInitiative(format!(
                    "no initiative bound to branch \"{branch}\" in .sofar/bindings.json — pass `initiative` explicitly or bind the branch; {}",
                    known_initiatives(layout)
                )));
            }
            QUICK_LANE.to_owned()
        }
    };
    assert_contained(layout, &slug)?;
    if !layout.initiative_dir(&slug).exists() {
        return Err(ResolveError::UnknownInitiative(format!(
            "initiative \"{slug}\" not found under .sofar/initiatives/; {}",
            known_initiatives(layout)
        )));
    }
    Ok(slug)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn normalize_follows_node() {
        assert_eq!(posix_normalize("/a/b/../c/", true), "/a/c/");
        assert_eq!(posix_normalize("/a/b/../c/", false), "/a/c");
        assert_eq!(posix_normalize("/a//b/./c", false), "/a/b/c");
        assert_eq!(posix_normalize("/a/../../b", false), "/b");
        assert_eq!(posix_normalize("a/../..", false), "..");
        assert_eq!(posix_normalize("", false), ".");
    }

    #[test]
    fn containment_rejects_paths_and_resolution_reports_like_typescript() {
        let root = crate::testing::scratch_dir("resolve");
        let layout = Layout::new(&root);
        fs::create_dir_all(layout.initiative_dir("alpha")).unwrap();
        fs::create_dir_all(layout.initiative_dir("beta")).unwrap();
        assert!(assert_contained(&layout, "alpha").is_ok());
        // `join` collapses the doubled separator, so Node accepts this too.
        assert!(assert_contained(&layout, "/alpha").is_ok());
        for bad in ["../alpha", "", ".", "alpha/", "a/../../x"] {
            assert!(assert_contained(&layout, bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            resolve_initiative(&layout, Some("gamma")),
            Err(ResolveError::UnknownInitiative(
                "initiative \"gamma\" not found under .sofar/initiatives/; available initiatives: alpha, beta (details: sofar list)".into()
            ))
        );
        assert_eq!(
            resolve_initiative(&layout, Some("alpha")),
            Ok("alpha".into())
        );
        let git = root.join(".git");
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(matches!(
            resolve_initiative(&layout, None),
            Err(ResolveError::UnknownInitiative(m)) if m.starts_with("no initiative bound to branch \"main\"")
        ));
        fs::write(layout.bindings_path(), "{\"main\":\"beta\",\"x\":1}").unwrap();
        assert_eq!(resolve_initiative(&layout, None), Ok("beta".into()));
        fs::write(layout.bindings_path(), "[]").unwrap();
        assert_eq!(
            resolve_initiative(&layout, None),
            Err(ResolveError::IoError(
                ".sofar/bindings.json must be a JSON object of branch → slug".into()
            ))
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
