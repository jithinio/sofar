//! Where a record lives — `createToolContext`'s paths (SPEC §Record layout,
//! `docs/HOTPATH.md` §Record resolution (shared)) and the derived index
//! directory (`ensureIndexDir` in `core/index-store.ts`) that holds lock
//! files. Resolution (branch → binding → slug) arrives with 2.5.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub root: PathBuf,
    pub sofar_dir: PathBuf,
}

impl Layout {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let sofar_dir = root.join(".sofar");
        Self { root, sofar_dir }
    }

    #[must_use]
    pub fn bindings_path(&self) -> PathBuf {
        self.sofar_dir.join("bindings.json")
    }

    #[must_use]
    pub fn initiatives_root(&self) -> PathBuf {
        self.sofar_dir.join("initiatives")
    }

    #[must_use]
    pub fn initiative_dir(&self, slug: &str) -> PathBuf {
        self.initiatives_root().join(slug)
    }

    #[must_use]
    pub fn events_path(&self, slug: &str) -> PathBuf {
        self.initiative_dir(slug).join("events.jsonl")
    }

    /// `.sofar/.index/` — derived, self-ignoring, never committed.
    #[must_use]
    pub fn index_dir(&self) -> PathBuf {
        self.sofar_dir.join(".index")
    }

    /// Create the index dir and its `.gitignore` (`*`) when missing.
    pub fn ensure_index_dir(&self) -> io::Result<PathBuf> {
        let dir = self.index_dir();
        fs::create_dir_all(&dir)?;
        let ignore = dir.join(".gitignore");
        if !ignore.exists() {
            write_file_atomic(&ignore, b"*\n")?;
        }
        Ok(dir)
    }

    /// The session-registration lock: `locks/<slug>.<sha256(session)[..24]>.lock`
    /// under the index dir — the same name TypeScript's `registerSession`
    /// takes, so mixed writers contend on one file. `None` when the index
    /// dir cannot be created (the caller then runs unlocked, as TypeScript does).
    #[must_use]
    pub fn register_lock_path(&self, slug: &str, session: &str) -> Option<PathBuf> {
        let dir = self.ensure_index_dir().ok()?;
        let key = crate::sha256::hex_digest(session.as_bytes());
        Some(
            dir.join("locks")
                .join(format!("{slug}.{}.lock", &key[..24])),
        )
    }
}

/// `.sofar/initiatives/<slug>` directories, sorted (`initiativeSlugs`):
/// entries not starting with `.`, directories only.
pub fn initiative_slugs(layout: &Layout) -> Vec<String> {
    let Ok(entries) = fs::read_dir(layout.initiatives_root()) else {
        return Vec::new();
    };
    let mut slugs: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();
    slugs.sort_by(|a, b| crate::text::cmp_utf16(a, b));
    slugs
}

#[must_use]
pub fn is_dir(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_index_dir() {
        let dir = crate::testing::scratch_dir("layout");
        let layout = Layout::new(&dir);
        assert_eq!(
            layout.events_path("x"),
            dir.join(".sofar/initiatives/x/events.jsonl")
        );
        let lock = layout.register_lock_path("x", "sess-a").unwrap();
        assert_eq!(
            fs::read_to_string(layout.index_dir().join(".gitignore")).unwrap(),
            "*\n"
        );
        // sha256("sess-a") = 5a1c6c7c... — pinned so a TypeScript writer computes the same name.
        assert_eq!(
            lock,
            layout.index_dir().join("locks").join(format!(
                "x.{}.lock",
                &crate::sha256::hex_digest(b"sess-a")[..24]
            ))
        );
        assert_eq!(
            lock.file_name().unwrap().to_str().unwrap().len(),
            "x.".len() + 24 + ".lock".len()
        );
        fs::create_dir_all(layout.initiative_dir("b")).unwrap();
        fs::create_dir_all(layout.initiative_dir("a")).unwrap();
        fs::create_dir_all(layout.initiative_dir(".hidden")).unwrap();
        fs::write(layout.initiatives_root().join("file"), "").unwrap();
        assert_eq!(initiative_slugs(&layout), ["a", "b"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
