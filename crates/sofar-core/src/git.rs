//! Git facts by FILE reads only (`core/git.ts`, `docs/HOTPATH.md` §Record
//! resolution (shared)): the current branch from HEAD, refs from loose files
//! or `packed-refs`, never a spawn. Every failure is `None`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::text::{is_js_whitespace, js_trim};

/// `gitDir`: `.git` when it is a directory, else the `gitdir:` pointer in the
/// `.git` file (relative to the root when not absolute).
#[must_use]
pub fn git_dir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if fs::metadata(&dot_git).ok()?.is_dir() {
        return Some(dot_git);
    }
    let text = fs::read_to_string(&dot_git).ok()?;
    // `/^gitdir:\s*(.+)\s*$/m` — the first line starting `gitdir:`, trimmed.
    let line = text
        .split(['\n', '\r'])
        .find_map(|l| l.strip_prefix("gitdir:"))?;
    let dir = js_trim(line.trim_start_matches(is_js_whitespace));
    if dir.is_empty() {
        return None;
    }
    let dir = PathBuf::from(dir);
    Some(if dir.is_absolute() {
        dir
    } else {
        root.join(dir)
    })
}

/// `commonGitDir`: where refs live — the `commondir` pointer of a linked
/// worktree, else the git dir itself.
#[must_use]
pub fn common_git_dir(root: &Path) -> Option<PathBuf> {
    let dir = git_dir(root)?;
    let Ok(pointer) = fs::read_to_string(dir.join("commondir")) else {
        return Some(dir);
    };
    let pointer = js_trim(&pointer);
    if pointer.is_empty() {
        return Some(dir);
    }
    let p = PathBuf::from(pointer);
    Some(if p.is_absolute() { p } else { dir.join(p) })
}

/// `currentBranch`: `ref: refs/heads/<b>` in HEAD, else None (detached, no repo).
#[must_use]
pub fn current_branch(root: &Path) -> Option<String> {
    let dir = git_dir(root)?;
    let head = fs::read_to_string(dir.join("HEAD")).ok()?;
    let head = js_trim(&head);
    // `/^ref:\s*refs\/heads\/(.+)$/` — no `m` flag, so a second line fails it.
    let rest = head.strip_prefix("ref:")?;
    let rest = rest.trim_start_matches(is_js_whitespace);
    let branch = rest.strip_prefix("refs/heads/")?;
    if branch.is_empty() || branch.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(branch.to_owned())
}

fn is_hex40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `readRef`: a loose ref file holding 40 hex, else the matching `packed-refs` line.
#[must_use]
pub fn read_ref(dir: &Path, reference: &str) -> Option<String> {
    if let Ok(loose) = fs::read_to_string(dir.join(reference)) {
        let loose = js_trim(&loose);
        if is_hex40(loose) {
            return Some(loose.to_owned());
        }
    }
    let packed = fs::read_to_string(dir.join("packed-refs")).ok()?;
    for line in packed.split('\n') {
        let line = js_trim(line);
        // `/^([0-9a-f]{40})\s+(.+)$/i`
        if line.len() < 41 || !is_hex40(&line[..40]) {
            continue;
        }
        let rest = &line[40..];
        let stripped = rest.trim_start_matches(is_js_whitespace);
        if stripped.len() == rest.len() {
            continue;
        }
        if stripped == reference {
            return Some(line[..40].to_owned());
        }
    }
    None
}

/// `GitState` (record-integrity 4.1): derived at render time, never stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitState {
    pub branch: String,
    /// Local branch tip, short (7).
    pub head: String,
    pub head_full: String,
    /// `origin/<branch>` tip, short, or None when the remote ref is absent.
    pub upstream: Option<String>,
    pub upstream_full: Option<String>,
    /// head === upstream.
    pub synced: bool,
}

/// `readGitState`: refs from the common dir, HEAD from the worktree's own.
#[must_use]
pub fn read_git_state(root: &Path) -> Option<GitState> {
    let dir = common_git_dir(root)?;
    let branch = current_branch(root)?;
    let head = read_ref(&dir, &format!("refs/heads/{branch}"))?;
    let upstream = read_ref(&dir, &format!("refs/remotes/origin/{branch}"));
    Some(GitState {
        synced: upstream.as_deref() == Some(head.as_str()),
        head: head[..7].to_owned(),
        head_full: head,
        upstream: upstream.as_ref().map(|u| u[..7].to_owned()),
        upstream_full: upstream,
        branch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_branch_and_refs_from_files() {
        let root = crate::testing::scratch_dir("git");
        let git = root.join(".git");
        fs::create_dir_all(git.join("refs/heads")).unwrap();
        fs::write(git.join("HEAD"), "ref: refs/heads/feat/x\n").unwrap();
        assert_eq!(current_branch(&root).as_deref(), Some("feat/x"));
        assert_eq!(read_git_state(&root), None);
        let sha = "0123456789abcdef0123456789abcdef01234567";
        fs::write(
            git.join("packed-refs"),
            format!("# pack-refs with: peeled\n{sha} refs/heads/feat/x\n"),
        )
        .unwrap();
        let state = read_git_state(&root).unwrap();
        assert_eq!(state.head, "0123456");
        assert_eq!(state.upstream, None);
        assert!(!state.synced);
        fs::create_dir_all(git.join("refs/remotes/origin/feat")).unwrap();
        fs::write(git.join("refs/remotes/origin/feat/x"), format!("{sha}\n")).unwrap();
        assert!(read_git_state(&root).unwrap().synced);
        fs::write(
            git.join("HEAD"),
            "0123456789abcdef0123456789abcdef01234567\n",
        )
        .unwrap();
        assert_eq!(current_branch(&root), None);
        // A worktree pointer file.
        let wt = crate::testing::scratch_dir("git-wt");
        fs::write(wt.join(".git"), format!("gitdir: {}\n", git.display())).unwrap();
        assert_eq!(git_dir(&wt), Some(git.clone()));
        fs::remove_dir_all(&root).unwrap();
        fs::remove_dir_all(&wt).unwrap();
    }
}
