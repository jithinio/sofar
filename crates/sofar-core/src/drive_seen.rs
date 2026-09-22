//! What each session last saw of its initiative's run (`core/drive-seen.ts`,
//! drive-visibility 3.2): the mark that lets the prompt's drive line speak
//! only when the run moved. Per-clone state outside the repo. A mark that
//! cannot be read counts as never seen, and one that cannot be written is
//! news again next prompt: the line repeats, it never goes silent.

use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;
use crate::diagnostics::{clone_key, resolves_inside, state_base};
use crate::json::{self, Json, Object};

/// `DRIVE_SEEN_VERSION` / `DRIVE_SEEN_MAX_MARKS`.
pub const DRIVE_SEEN_VERSION: f64 = 1.0;
pub const DRIVE_SEEN_MAX_MARKS: usize = 64;

/// `driveSeenPath`: `<state base>/drive-seen/<clone key>.json`, or None
/// where that would sit inside the repo.
#[must_use]
pub fn drive_seen_path(root: &Path) -> Option<PathBuf> {
    let path = state_base()
        .join("drive-seen")
        .join(format!("{}.json", clone_key(root)));
    (!resolves_inside(&path, root)).then_some(path)
}

/// `readMarks`: session → (seen, seq), in the file's (JavaScript) order.
fn read_marks(path: &Path) -> Vec<(String, String, f64)> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let Ok(Json::Obj(disk)) = json::parse(&String::from_utf8_lossy(&bytes)) else {
        return Vec::new();
    };
    if disk.get("version") != Some(&Json::Num(DRIVE_SEEN_VERSION)) {
        return Vec::new();
    }
    let Some(Json::Obj(marks)) = disk.get("marks") else {
        return Vec::new();
    };
    marks
        .js_ordered()
        .into_iter()
        .filter_map(|(id, mark)| {
            let m = mark.as_obj()?;
            let seen = m.get("seen")?.as_str()?;
            let seq = m.get("seq")?.as_f64().filter(|n| n.is_finite())?;
            Some((id.to_owned(), seen.to_owned(), seq))
        })
        .collect()
}

/// `noteDriveSeen`: whether `seen` is news to this session, marking it seen
/// when it is. Writes only on news.
pub fn note_drive_seen(root: &Path, session_id: &str, seen: &str) -> bool {
    let Some(path) = drive_seen_path(root) else {
        return true;
    };
    let mut marks = read_marks(&path);
    if marks.iter().any(|(id, s, _)| id == session_id && s == seen) {
        return false;
    }
    let seq = marks.iter().map(|(_, _, q)| *q).fold(0.0_f64, f64::max);
    match marks.iter_mut().find(|(id, _, _)| id == session_id) {
        Some(mark) => {
            seen.clone_into(&mut mark.1);
            mark.2 = seq + 1.0;
        }
        None => marks.push((session_id.to_owned(), seen.to_owned(), seq + 1.0)),
    }
    // Most recently marked first (stable), the least recent evicted.
    marks.sort_by(|a, b| b.2.total_cmp(&a.2));
    marks.truncate(DRIVE_SEEN_MAX_MARKS);
    let mut kept = Object::with_capacity(marks.len());
    for (id, seen, seq) in marks {
        let mut m = Object::with_capacity(2);
        m.insert("seen", Json::Str(seen));
        m.insert("seq", Json::Num(seq));
        kept.insert(id, Json::Obj(m));
    }
    let mut o = Object::with_capacity(2);
    o.insert("version", Json::Num(DRIVE_SEEN_VERSION));
    o.insert("marks", Json::Obj(kept));
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = write_file_atomic(&path, json::stringify(&Json::Obj(o)).as_bytes());
    true
}
