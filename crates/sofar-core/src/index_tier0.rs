//! Tier 0 (`core/index-tier0.ts`, record-index 1.x): slug → session → open
//! files (or null once the session finished), on the default cursor file.

use crate::index_pass::{PassResult, SlugReducer, pass_over_record};
use crate::index_store::{
    DEFAULT_META_FILE, INDEX_SCHEMA_VERSION, read_index_file, tier_initiatives, write_index_file,
};
use crate::index_tail::IndexedEvent;
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::text::cmp_utf16;

const TIER0_FILE: &str = "open.json";
/// `ACTIVITY_LIST_CAP`: `SessionActivity.touched`'s cap, mirrored here.
const ACTIVITY_LIST_CAP: usize = 20;

/// session → files, or None once ended/closed. Insertion-ordered.
pub type SessionFiles = Vec<(String, Option<Vec<String>>)>;

struct Tier0Reducer;
impl SlugReducer for Tier0Reducer {
    type State = SessionFiles;
    fn empty(&self) -> SessionFiles {
        Vec::new()
    }
    fn apply(&self, sessions: &mut SessionFiles, ev: &IndexedEvent, _slug: &str) {
        match ev.event_type.as_str() {
            "session_started" => {
                if ev.session.is_empty() {
                    return;
                }
                if !sessions.iter().any(|(s, _)| *s == ev.session) {
                    sessions.push((ev.session.clone(), Some(Vec::new())));
                }
            }
            "session_ended" => {
                let named = ev.payload.get("session_id").and_then(Json::as_nonempty_str);
                let subject = named.unwrap_or(&ev.session);
                if subject.is_empty() {
                    return;
                }
                match sessions.iter_mut().find(|(s, _)| s == subject) {
                    Some(slot) => slot.1 = None,
                    None => sessions.push((subject.to_owned(), None)),
                }
            }
            "session_closed" => {
                if ev.session.is_empty() {
                    return;
                }
                if let Some(slot) = sessions.iter_mut().find(|(s, _)| *s == ev.session) {
                    slot.1 = None;
                }
            }
            "file_touched" => {
                let Some((_, Some(files))) = sessions.iter_mut().find(|(s, _)| *s == ev.session)
                else {
                    return;
                };
                let Some(path) = ev.payload.get("path").and_then(Json::as_nonempty_str) else {
                    return;
                };
                if files.iter().any(|f| f == path) || files.len() >= ACTIVITY_LIST_CAP {
                    return;
                }
                files.push(path.to_owned());
            }
            _ => {}
        }
    }
}

fn parse_state(v: &Json) -> Option<SessionFiles> {
    let o = v.as_obj()?;
    let mut out = Vec::with_capacity(o.len());
    for (session, files) in o.js_ordered() {
        let files = match files {
            Json::Null => None,
            Json::Arr(items) => Some(
                items
                    .iter()
                    .map(|f| f.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()?,
            ),
            _ => return None,
        };
        out.push((session.to_owned(), files));
    }
    Some(out)
}

fn state_json(state: &SessionFiles) -> Json {
    let mut o = Object::with_capacity(state.len());
    for (session, files) in state {
        o.insert(
            session.clone(),
            files.as_ref().map_or(Json::Null, |f| {
                Json::Arr(f.iter().map(|p| Json::Str(p.clone())).collect())
            }),
        );
    }
    Json::Obj(o)
}

fn refresh_disk(layout: &Layout) -> Vec<(String, SessionFiles)> {
    let prior: Option<Vec<(String, SessionFiles)>> =
        read_index_file(layout, TIER0_FILE).and_then(|disk| {
            let initiatives = tier_initiatives(&disk)?;
            Some(
                initiatives
                    .js_ordered()
                    .into_iter()
                    .filter_map(|(slug, v)| parse_state(v).map(|s| (slug.to_owned(), s)))
                    .collect(),
            )
        });
    let PassResult { states, changed } =
        pass_over_record(layout, DEFAULT_META_FILE, prior.as_deref(), &Tier0Reducer);
    if changed {
        let mut initiatives = Object::with_capacity(states.len());
        for (slug, state) in &states {
            initiatives.insert(slug.clone(), state_json(state));
        }
        let mut o = Object::with_capacity(2);
        o.insert("version", Json::Num(INDEX_SCHEMA_VERSION));
        o.insert("initiatives", Json::Obj(initiatives));
        write_index_file(layout, TIER0_FILE, &Json::Obj(o));
    }
    states
}

/// An open session and the files it holds (`Tier0Session`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tier0Session {
    pub session: String,
    pub initiative: String,
    pub files: Vec<String>,
}

fn by_initiative_then_session(a: (&str, &str), b: (&str, &str)) -> std::cmp::Ordering {
    if a.0 == b.0 {
        cmp_utf16(a.1, b.1)
    } else {
        cmp_utf16(a.0, b.0)
    }
}

/// `refreshTier0`: every open session, sorted by initiative then session.
#[must_use]
pub fn refresh_tier0(layout: &Layout) -> Vec<Tier0Session> {
    let mut out: Vec<Tier0Session> = Vec::new();
    for (initiative, sessions) in refresh_disk(layout) {
        for (session, files) in sessions {
            if let Some(files) = files {
                out.push(Tier0Session {
                    session,
                    initiative: initiative.clone(),
                    files,
                });
            }
        }
    }
    out.sort_by(|a, b| {
        by_initiative_then_session((&a.initiative, &a.session), (&b.initiative, &b.session))
    });
    out
}

/// `Tier0Known`: every session the record knows, open or not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tier0Known {
    pub session: String,
    pub initiative: String,
    pub open: bool,
}

/// `refreshTier0Known`.
#[must_use]
pub fn refresh_tier0_known(layout: &Layout) -> Vec<Tier0Known> {
    let mut out: Vec<Tier0Known> = Vec::new();
    for (initiative, sessions) in refresh_disk(layout) {
        for (session, files) in sessions {
            out.push(Tier0Known {
                session,
                initiative: initiative.clone(),
                open: files.is_some(),
            });
        }
    }
    out.sort_by(|a, b| {
        by_initiative_then_session((&a.initiative, &a.session), (&b.initiative, &b.session))
    });
    out
}
