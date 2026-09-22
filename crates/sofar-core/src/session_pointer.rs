//! The live-session pointer (r1-fixes 4.1.3, L09, D29/D30) — the port of
//! `core/session-pointer.ts`: which session id a CLI append with no
//! `--session` belongs to. `.sofar/.index/session.json` = {session, writer,
//! ts}; derived, never truth; last writer wins. Every function is
//! best-effort: a hook must never fail on it.

use crate::atomic::write_file_atomic;
use crate::envelope::to_iso_string;
use crate::json::{self, Json};
use crate::layout::Layout;

const POINTER_FILE: &str = "session.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPointer {
    pub session: String,
    /// `hook` — registered by a host hook; `cli` — minted by a `session_started` with no `--session`.
    pub writer: String,
    pub ts: String,
}

/// `readSessionPointer`.
#[must_use]
pub fn read_session_pointer(layout: &Layout) -> Option<SessionPointer> {
    let path = layout.index_dir().join(POINTER_FILE);
    let bytes = std::fs::read(path).ok()?;
    let Json::Obj(o) = json::parse(&String::from_utf8_lossy(&bytes)).ok()? else {
        return None;
    };
    let session = o.get("session")?.as_nonempty_str()?.to_owned();
    let writer = o.get("writer")?.as_str()?;
    if writer != "hook" && writer != "cli" {
        return None;
    }
    let ts = o.get("ts").and_then(Json::as_str).unwrap_or("").to_owned();
    Some(SessionPointer {
        session,
        writer: writer.to_owned(),
        ts,
    })
}

/// `writeSessionPointer`: only in a repo that carries `.sofar/`, and only when
/// the session or the writer changed.
#[must_use]
pub fn write_session_pointer(layout: &Layout, session: &str, writer: &str) -> bool {
    if session.is_empty() || !layout.sofar_dir.exists() {
        return false;
    }
    if let Some(current) = read_session_pointer(layout)
        && current.session == session
        && current.writer == writer
    {
        return true;
    }
    let Ok(dir) = layout.ensure_index_dir() else {
        return false;
    };
    let mut text = String::from("{\"session\":");
    json::write_string(&mut text, session);
    text.push_str(",\"writer\":");
    json::write_string(&mut text, writer);
    text.push_str(",\"ts\":");
    json::write_string(&mut text, &to_iso_string(std::time::SystemTime::now()));
    text.push_str("}\n");
    write_file_atomic(&dir.join(POINTER_FILE), text.as_bytes()).is_ok()
}

/// `clearSessionPointer`: remove the pointer when it still names `session`.
pub fn clear_session_pointer(layout: &Layout, session: &str) {
    if read_session_pointer(layout).is_some_and(|p| p.session == session) {
        let _ = std::fs::remove_file(layout.index_dir().join(POINTER_FILE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_reads_and_clears_only_its_own_session() {
        let dir = crate::testing::scratch_dir("session-pointer");
        let layout = Layout::new(&dir);
        assert!(
            !write_session_pointer(&layout, "s1", "hook"),
            "no .sofar yet"
        );
        std::fs::create_dir_all(&layout.sofar_dir).unwrap();
        assert!(write_session_pointer(&layout, "s1", "hook"));
        let p = read_session_pointer(&layout).unwrap();
        assert_eq!((p.session.as_str(), p.writer.as_str()), ("s1", "hook"));
        assert!(p.ts.ends_with('Z'));
        clear_session_pointer(&layout, "other");
        assert!(read_session_pointer(&layout).is_some());
        clear_session_pointer(&layout, "s1");
        assert!(read_session_pointer(&layout).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
