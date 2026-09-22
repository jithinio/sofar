//! Per-session ref-movement marks (`core/shipwatch.ts`, commit-attribution
//! 3.4, D11): `shipwatch.json` in the index dir, version 2, ≤64 marks by `seq`.

use crate::index_store::{read_index_file, write_index_file};
use crate::json::{Json, Object};
use crate::layout::Layout;

pub const SHIPWATCH_FILE: &str = "shipwatch.json";
pub const SHIPWATCH_VERSION: f64 = 2.0;
pub const SHIPWATCH_MAX_MARKS: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct WatchMark {
    pub branch: String,
    pub upstream: Option<String>,
    pub engine: Option<String>,
    pub seq: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WatchLook<'a> {
    pub previous: Option<&'a str>,
    pub moved: bool,
}

fn is_full_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `readMarks`: the clean marks, in file order.
fn read_marks(layout: &Layout) -> Vec<(String, WatchMark)> {
    let Some(disk) = read_index_file(layout, SHIPWATCH_FILE) else {
        return Vec::new();
    };
    let Some(o) = disk.as_obj() else {
        return Vec::new();
    };
    if o.get("version") != Some(&Json::Num(SHIPWATCH_VERSION)) {
        return Vec::new();
    }
    let Some(marks) = o.get("marks").and_then(Json::as_obj) else {
        return Vec::new();
    };
    let mut clean = Vec::new();
    for (id, mark) in marks.js_ordered() {
        let Some(m) = mark.as_obj() else { continue };
        let Some(branch) = m.get("branch").and_then(Json::as_str) else {
            continue;
        };
        let upstream = match m.get("upstream") {
            Some(Json::Null) => None,
            Some(Json::Str(s)) if is_full_sha(s) => Some(s.clone()),
            _ => continue,
        };
        let Some(seq) = m
            .get("seq")
            .and_then(Json::as_f64)
            .filter(|s| s.is_finite())
        else {
            continue;
        };
        let engine = m
            .get("engine")
            .and_then(Json::as_nonempty_str)
            .map(str::to_owned);
        clean.push((
            id.to_owned(),
            WatchMark {
                branch: branch.to_owned(),
                upstream,
                engine,
                seq,
            },
        ));
    }
    clean
}

fn next_seq(marks: &[(String, WatchMark)]) -> f64 {
    marks.iter().map(|(_, m)| m.seq).fold(0.0, f64::max) + 1.0
}

fn evict(mut marks: Vec<(String, WatchMark)>) -> Vec<(String, WatchMark)> {
    if marks.len() <= SHIPWATCH_MAX_MARKS {
        return marks;
    }
    // `ids.sort((a, b) => marks[b].seq - marks[a].seq)` — stable, seq descending.
    marks.sort_by(|a, b| {
        b.1.seq
            .partial_cmp(&a.1.seq)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    marks.truncate(SHIPWATCH_MAX_MARKS);
    marks
}

fn write_marks(layout: &Layout, marks: Vec<(String, WatchMark)>) {
    let mut obj = Object::with_capacity(marks.len());
    for (id, m) in evict(marks) {
        let mut mo = Object::with_capacity(4);
        mo.insert("branch", Json::Str(m.branch));
        mo.insert("upstream", m.upstream.map_or(Json::Null, Json::Str));
        mo.insert("seq", Json::Num(m.seq));
        if let Some(engine) = m.engine {
            mo.insert("engine", Json::Str(engine));
        }
        obj.insert(id, Json::Obj(mo));
    }
    let mut o = Object::with_capacity(2);
    o.insert("version", Json::Num(SHIPWATCH_VERSION));
    o.insert("marks", Json::Obj(obj));
    write_index_file(layout, SHIPWATCH_FILE, &Json::Obj(o));
}

fn set_mark(marks: &mut Vec<(String, WatchMark)>, id: &str, mark: WatchMark) {
    match marks.iter_mut().find(|(i, _)| i == id) {
        Some(slot) => slot.1 = mark,
        None => marks.push((id.to_owned(), mark)),
    }
}

/// `noteUpstream`: record where `origin/<branch>` stands for this session and
/// report what moved since it last looked. Writes on every look.
pub fn note_upstream(
    layout: &Layout,
    session_id: &str,
    branch: &str,
    upstream: Option<&str>,
) -> (Option<String>, bool) {
    if session_id.is_empty() || branch.is_empty() {
        return (None, false);
    }
    if upstream.is_some_and(|u| !is_full_sha(u)) {
        return (None, false);
    }
    let mut marks = read_marks(layout);
    let prior = marks
        .iter()
        .find(|(i, _)| i == session_id)
        .map(|(_, m)| m.clone());
    let usable = prior.as_ref().filter(|p| p.branch == branch).cloned();
    let seq = next_seq(&marks);
    set_mark(
        &mut marks,
        session_id,
        WatchMark {
            branch: branch.to_owned(),
            upstream: upstream.map(str::to_owned),
            engine: prior.and_then(|p| p.engine),
            seq,
        },
    );
    write_marks(layout, marks);
    match usable {
        None => (None, false),
        Some(u) if u.upstream.as_deref() == upstream => (upstream.map(str::to_owned), false),
        Some(u) => (u.upstream, true),
    }
}

/// `noteEngine`: mark the engine this session runs against; the version it saw
/// last when that differs.
pub fn note_engine(layout: &Layout, session_id: &str, engine: &str) -> Option<String> {
    if session_id.is_empty() || engine.is_empty() {
        return None;
    }
    let mut marks = read_marks(layout);
    let prior = marks
        .iter()
        .find(|(i, _)| i == session_id)
        .map(|(_, m)| m.clone());
    let was = prior
        .as_ref()
        .and_then(|p| p.engine.as_deref())
        .filter(|e| *e != engine)
        .map(str::to_owned);
    if prior.as_ref().and_then(|p| p.engine.as_deref()) == Some(engine) {
        return None;
    }
    let seq = next_seq(&marks);
    set_mark(
        &mut marks,
        session_id,
        WatchMark {
            branch: prior.as_ref().map(|p| p.branch.clone()).unwrap_or_default(),
            upstream: prior.and_then(|p| p.upstream),
            engine: Some(engine.to_owned()),
            seq,
        },
    );
    write_marks(layout, marks);
    was
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_are_edge_triggered_and_written_on_every_look() {
        let dir = crate::testing::scratch_dir("shipwatch");
        let layout = Layout::new(&dir);
        let sha_a = "a".repeat(40);
        let sha_b = "b".repeat(40);
        assert_eq!(note_upstream(&layout, "s", "main", None), (None, false));
        assert_eq!(
            std::fs::read_to_string(layout.index_dir().join(SHIPWATCH_FILE)).unwrap(),
            "{\"version\":2,\"marks\":{\"s\":{\"branch\":\"main\",\"upstream\":null,\"seq\":1}}}\n"
        );
        assert_eq!(
            note_upstream(&layout, "s", "main", Some(&sha_a)),
            (None, true)
        );
        assert_eq!(
            note_upstream(&layout, "s", "main", Some(&sha_a)),
            (Some(sha_a.clone()), false)
        );
        assert_eq!(
            note_upstream(&layout, "s", "main", Some(&sha_b)),
            (Some(sha_a.clone()), true)
        );
        assert_eq!(
            note_upstream(&layout, "s", "other", Some(&sha_b)),
            (None, false)
        );
        assert_eq!(note_engine(&layout, "s", "1.0.0"), None);
        assert_eq!(note_engine(&layout, "s", "1.0.0"), None);
        assert_eq!(note_engine(&layout, "s", "1.1.0"), Some("1.0.0".into()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
