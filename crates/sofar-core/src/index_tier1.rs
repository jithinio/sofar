//! Tier 1 (`core/index-tier1.ts`, record-index 3.1–3.3): the declared half
//! (every guarded decision, plus decision counts per slug) and the DERIVED
//! half (path → session → [ts, touches]) on two cursors, and the adjacency
//! derivation the `SessionStart` block renders.

use std::collections::HashMap;

use crate::index_pass::{PassResult, SlugReducer, pass_over_record};
use crate::index_store::{
    INDEX_SCHEMA_VERSION, read_index_file, tier_initiatives, write_index_file,
};
use crate::index_tail::IndexedEvent;
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::status::NeighbourRecord;
use crate::text::cmp_utf16;

pub const GUARDS_FILE: &str = "guards.json";
pub const GUARDS_META: &str = "meta-guards.json";
pub const FILES_FILE: &str = "graph.json";
pub const FILES_META: &str = "meta-graph.json";

/// A decision that declared which work it governs (rule + guard).
#[derive(Debug, Clone, PartialEq)]
pub struct GuardedDecision {
    pub id: String,
    pub initiative: String,
    pub ordinal: f64,
    pub ts: String,
    pub rule: String,
    pub guard: String,
    pub chose: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlugGuardState {
    pub decisions: f64,
    pub guards: Vec<GuardedDecision>,
}

/// session id → (most recent ts, touch count), insertion-ordered.
pub type PathSessions = Vec<(String, (String, f64))>;

/// path → sessions, insertion-ordered.
#[derive(Debug, Clone, Default)]
pub struct SlugFileState {
    pub files: Vec<(String, PathSessions)>,
    /// The paths in `files`. Rebuilt on demand, never serialized or compared.
    index: PathIndex,
}

impl PartialEq for SlugFileState {
    fn eq(&self, other: &Self) -> bool {
        self.files == other.files
    }
}

/// What `files.iter().position(|(p, _)| p == path)` answers, in O(1): the
/// TypeScript `state.files[path]` lookup. `applyFile` asks once per
/// `file_touched` event, so the scan made the index pass O(file events ×
/// paths), 1.5 turn 1's shape: ~1.5 s of a 7 s cold session-start at team100.
///
/// Exact for the same reason as `fold::FileIndex`: the reducer only PUSHES
/// to `files`, with paths unique in it, so indexing the vec's new tail on each
/// call sees every path a scan would. A state read back from disk starts empty
/// and indexes on first use.
#[derive(Debug, Clone, Default)]
struct PathIndex {
    indexed: usize,
    by_path: HashMap<String, usize>,
}

impl PathIndex {
    fn position(&mut self, files: &[(String, PathSessions)], path: &str) -> Option<usize> {
        for (i, (p, _)) in files.iter().enumerate().skip(self.indexed) {
            self.by_path.entry(p.clone()).or_insert(i);
        }
        self.indexed = files.len();
        self.by_path.get(path).copied()
    }
}

impl SlugGuardState {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(2);
        o.insert("decisions", Json::Num(self.decisions));
        o.insert(
            "guards",
            Json::Arr(
                self.guards
                    .iter()
                    .map(|g| {
                        let mut d = Object::with_capacity(7);
                        d.insert("id", Json::Str(g.id.clone()));
                        d.insert("initiative", Json::Str(g.initiative.clone()));
                        d.insert("ordinal", Json::Num(g.ordinal));
                        d.insert("ts", Json::Str(g.ts.clone()));
                        d.insert("rule", Json::Str(g.rule.clone()));
                        d.insert("guard", Json::Str(g.guard.clone()));
                        d.insert("chose", Json::Str(g.chose.clone()));
                        Json::Obj(d)
                    })
                    .collect(),
            ),
        );
        Json::Obj(o)
    }

    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        let decisions = o.get("decisions")?.as_f64()?;
        let guards = o
            .get("guards")?
            .as_arr()?
            .iter()
            .map(|g| {
                let g = g.as_obj()?;
                let s = |k: &str| g.get(k)?.as_str().map(str::to_owned);
                Some(GuardedDecision {
                    id: s("id")?,
                    initiative: s("initiative")?,
                    ordinal: g.get("ordinal")?.as_f64()?,
                    ts: s("ts")?,
                    rule: s("rule")?,
                    guard: s("guard")?,
                    chose: s("chose")?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self { decisions, guards })
    }
}

impl SlugFileState {
    fn to_json(&self) -> Json {
        let mut files = Object::with_capacity(self.files.len());
        for (path, sessions) in &self.files {
            let mut by_session = Object::with_capacity(sessions.len());
            for (session, (ts, n)) in sessions {
                by_session.insert(
                    session.clone(),
                    Json::Arr(vec![Json::Str(ts.clone()), Json::Num(*n)]),
                );
            }
            // Unique by construction: from_json reads an object's keys, and
            // the reducer pushes only a path its index does not hold.
            files.push_unique(path.clone(), Json::Obj(by_session));
        }
        let mut o = Object::with_capacity(1);
        o.insert("files", Json::Obj(files));
        Json::Obj(o)
    }

    fn from_json(v: &Json) -> Option<Self> {
        let files = v.as_obj()?.get("files")?.as_obj()?;
        let mut out = Vec::with_capacity(files.len());
        for (path, sessions) in files.js_ordered() {
            let sessions = sessions.as_obj()?;
            let mut by_session = Vec::with_capacity(sessions.len());
            for (session, entry) in sessions.js_ordered() {
                let arr = entry.as_arr()?;
                let ts = arr.first()?.as_str()?.to_owned();
                let n = arr.get(1)?.as_f64()?;
                by_session.push((session.to_owned(), (ts, n)));
            }
            out.push((path.to_owned(), by_session));
        }
        Some(Self {
            files: out,
            index: PathIndex::default(),
        })
    }
}

struct GuardReducer;
impl SlugReducer for GuardReducer {
    type State = SlugGuardState;
    fn empty(&self) -> SlugGuardState {
        SlugGuardState::default()
    }
    /// `applyGuard`: counted BEFORE the guard test — `D<n>` is a position among all decisions.
    fn apply(&self, state: &mut SlugGuardState, event: &IndexedEvent, slug: &str) {
        if event.event_type != "decision_logged" {
            return;
        }
        state.decisions += 1.0;
        let (Some(rule), Some(guard)) = (
            event.payload.get("rule").and_then(Json::as_str),
            event.payload.get("guard").and_then(Json::as_str),
        ) else {
            return;
        };
        state.guards.push(GuardedDecision {
            id: event.id.clone(),
            initiative: slug.to_owned(),
            ordinal: state.decisions,
            ts: event.ts.clone(),
            rule: rule.to_owned(),
            guard: guard.to_owned(),
            chose: event
                .payload
                .get("chose")
                .map_or_else(|| "undefined".to_owned(), crate::json::js_to_string),
        });
    }
}

struct FileReducer;
impl SlugReducer for FileReducer {
    type State = SlugFileState;
    fn empty(&self) -> SlugFileState {
        SlugFileState::default()
    }
    /// `applyFile`: `cli` anchors no touched edge.
    fn apply(&self, state: &mut SlugFileState, event: &IndexedEvent, _slug: &str) {
        if event.event_type != "file_touched" || event.session == "cli" || event.session.is_empty()
        {
            return;
        }
        let Some(path) = event.payload.get("path").and_then(Json::as_str) else {
            return;
        };
        let i = if let Some(i) = state.index.position(&state.files, path) {
            i
        } else {
            state.files.push((path.to_owned(), Vec::new()));
            state.files.len() - 1
        };
        let sessions = &mut state.files[i].1;
        match sessions.iter_mut().find(|(s, _)| *s == event.session) {
            Some((_, (ts, n))) => {
                *n += 1.0;
                if cmp_utf16(&event.ts, ts).is_gt() {
                    ts.clone_from(&event.ts);
                }
            }
            None => sessions.push((event.session.clone(), (event.ts.clone(), 1.0))),
        }
    }
}

fn read_half<S>(
    layout: &Layout,
    file: &str,
    parse: impl Fn(&Json) -> Option<S>,
) -> Option<Vec<(String, S)>> {
    let disk = read_index_file(layout, file)?;
    let initiatives = tier_initiatives(&disk)?;
    let mut out = Vec::with_capacity(initiatives.len());
    for (slug, value) in initiatives.js_ordered() {
        // A malformed entry cold-starts that slug alone (a full read), never the tier.
        if let Some(state) = parse(value) {
            out.push((slug.to_owned(), state));
        }
    }
    Some(out)
}

fn write_half<S>(
    layout: &Layout,
    file: &str,
    states: &[(String, S)],
    to_json: impl Fn(&S) -> Json,
) {
    let mut initiatives = Object::with_capacity(states.len());
    for (slug, state) in states {
        initiatives.insert(slug.clone(), to_json(state));
    }
    let mut o = Object::with_capacity(2);
    o.insert("version", Json::Num(INDEX_SCHEMA_VERSION));
    o.insert("initiatives", Json::Obj(initiatives));
    write_index_file(layout, file, &Json::Obj(o));
}

/// `refreshHalf` for the declared tier.
fn refresh_guard_states(layout: &Layout) -> Vec<(String, SlugGuardState)> {
    let prior = read_half(layout, GUARDS_FILE, SlugGuardState::from_json);
    let PassResult { states, changed } =
        pass_over_record(layout, GUARDS_META, prior.as_deref(), &GuardReducer);
    if changed {
        write_half(layout, GUARDS_FILE, &states, SlugGuardState::to_json);
    }
    states
}

/// `refreshHalf` for the derived tier.
fn refresh_file_states(layout: &Layout) -> Vec<(String, SlugFileState)> {
    let prior = read_half(layout, FILES_FILE, SlugFileState::from_json);
    let PassResult { states, changed } =
        pass_over_record(layout, FILES_META, prior.as_deref(), &FileReducer);
    if changed {
        write_half(layout, FILES_FILE, &states, SlugFileState::to_json);
    }
    states
}

/// The declared half, repo-wide (`GuardIndex`): guards sorted by initiative then
/// ordinal, and decision counts per slug.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GuardIndex {
    pub guards: Vec<GuardedDecision>,
    pub decisions: Vec<(String, f64)>,
}

fn declared_view(states: &[(String, SlugGuardState)]) -> GuardIndex {
    let mut slugs: Vec<&(String, SlugGuardState)> = states.iter().collect();
    slugs.sort_by(|a, b| cmp_utf16(&a.0, &b.0));
    let mut guards = Vec::new();
    let mut decisions = Vec::new();
    for (slug, state) in slugs {
        guards.extend(state.guards.iter().cloned());
        decisions.push((slug.clone(), state.decisions));
    }
    guards.sort_by(|a, b| {
        if a.initiative == b.initiative {
            a.ordinal
                .partial_cmp(&b.ordinal)
                .unwrap_or(std::cmp::Ordering::Equal)
        } else {
            cmp_utf16(&a.initiative, &b.initiative)
        }
    });
    GuardIndex { guards, decisions }
}

/// `refreshGuards`: bring the declared half up to date.
#[must_use]
pub fn refresh_guards(layout: &Layout) -> GuardIndex {
    declared_view(&refresh_guard_states(layout))
}

/// `refreshNeighbours` (record-index 3.3): the records that have worked this
/// one's files, densest first.
#[must_use]
pub fn refresh_neighbours(layout: &Layout, slug: &str) -> Vec<NeighbourRecord> {
    let declared = refresh_guards(layout);
    let states = refresh_file_states(layout);
    let Some((_, mine)) = states.iter().find(|(s, _)| s == slug) else {
        return Vec::new();
    };
    if mine.files.is_empty() {
        return Vec::new();
    }
    let my_paths: std::collections::HashSet<&str> =
        mine.files.iter().map(|(p, _)| p.as_str()).collect();
    let mut found: Vec<NeighbourRecord> = Vec::new();
    for (initiative, state) in &states {
        if initiative == slug {
            continue;
        }
        let paths = state
            .files
            .iter()
            .filter(|(p, _)| my_paths.contains(p.as_str()))
            .count();
        if paths > 0 {
            let decisions = declared
                .decisions
                .iter()
                .find(|(s, _)| s == initiative)
                .map_or(0.0, |(_, n)| *n);
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "counts"
            )]
            found.push(NeighbourRecord {
                initiative: initiative.clone(),
                paths: paths as u64,
                decisions: decisions as u64,
            });
        }
    }
    rank_neighbours(found)
}

/// `rankNeighbours`: paths desc, decisions desc, then name — total.
fn rank_neighbours(mut found: Vec<NeighbourRecord>) -> Vec<NeighbourRecord> {
    found.sort_by(|a, b| {
        b.paths
            .cmp(&a.paths)
            .then(b.decisions.cmp(&a.decisions))
            .then_with(|| cmp_utf16(&a.initiative, &b.initiative))
    });
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn line(id: &str, slug: &str, session: &str, ty: &str, payload: &str) -> String {
        format!(
            "{{\"v\":1,\"id\":\"{id}\",\"ts\":\"2026-01-01T00:00:00.000Z\",\"initiative\":\"{slug}\",\"session\":\"{session}\",\"source\":\"hook\",\"actor\":\"agent\",\"type\":\"{ty}\",\"payload\":{payload}}}\n"
        )
    }

    #[test]
    fn neighbours_count_shared_paths_and_decisions_and_resume_from_cursors() {
        use std::io::Write as _;
        let dir = crate::testing::scratch_dir("tier1");
        let layout = Layout::new(&dir);
        fs::create_dir_all(layout.initiative_dir("a")).unwrap();
        fs::create_dir_all(layout.initiative_dir("b")).unwrap();
        fs::write(
            layout.events_path("a"),
            line(
                "01ARZ3NDEKTSV4RRFFQ69G5FA1",
                "a",
                "s1",
                "file_touched",
                "{\"path\":\"x.ts\",\"op\":\"edit\"}",
            ) + &line(
                "01ARZ3NDEKTSV4RRFFQ69G5FA2",
                "a",
                "s1",
                "file_touched",
                "{\"path\":\"y.ts\",\"op\":\"edit\"}",
            ),
        )
        .unwrap();
        fs::write(
            layout.events_path("b"),
            line("01ARZ3NDEKTSV4RRFFQ69G5FB1", "b", "s2", "file_touched", "{\"path\":\"x.ts\",\"op\":\"edit\"}")
                + &line("01ARZ3NDEKTSV4RRFFQ69G5FB2", "b", "s2", "decision_logged", "{\"chose\":\"c\",\"over\":\"o\",\"because\":\"b\",\"rule\":\"r\",\"guard\":\"path:x.ts\"}")
                + &line("01ARZ3NDEKTSV4RRFFQ69G5FB3", "b", "cli", "file_touched", "{\"path\":\"y.ts\",\"op\":\"edit\"}"),
        )
        .unwrap();
        let n = refresh_neighbours(&layout, "a");
        assert_eq!(
            n,
            vec![NeighbourRecord {
                initiative: "b".into(),
                paths: 1,
                decisions: 1
            }]
        );
        assert!(layout.index_dir().join(GUARDS_FILE).exists());
        assert!(layout.index_dir().join(FILES_META).exists());
        // A second refresh resumes from the cursors and answers the same.
        assert_eq!(refresh_neighbours(&layout, "a"), n);
        // An append is picked up incrementally.
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(layout.events_path("b"))
            .unwrap();
        f.write_all(
            line(
                "01ARZ3NDEKTSV4RRFFQ69G5FB4",
                "b",
                "s2",
                "file_touched",
                "{\"path\":\"y.ts\",\"op\":\"edit\"}",
            )
            .as_bytes(),
        )
        .unwrap();
        drop(f);
        assert_eq!(refresh_neighbours(&layout, "a")[0].paths, 2);
        assert_eq!(refresh_guards(&layout).guards.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_file_reducer_keeps_first_positions_across_a_restored_state() {
        let touch = |id: &str, session: &str, path: &str| {
            let mut payload = Object::new();
            payload.insert("path", Json::Str(path.to_owned()));
            IndexedEvent {
                id: id.to_owned(),
                event_type: "file_touched".to_owned(),
                session: session.to_owned(),
                initiative: "a".to_owned(),
                payload,
                ts: "2026-01-01T00:00:00.000Z".to_owned(),
            }
        };
        let mut state = FileReducer.empty();
        FileReducer.apply(
            &mut state,
            &touch("01ARZ3NDEKTSV4RRFFQ69G5FA1", "s1", "b.ts"),
            "a",
        );
        FileReducer.apply(
            &mut state,
            &touch("01ARZ3NDEKTSV4RRFFQ69G5FA2", "s1", "a.ts"),
            "a",
        );
        // Written and read back, as a warm start does: the index starts empty.
        let mut state = SlugFileState::from_json(&state.to_json()).unwrap();
        FileReducer.apply(
            &mut state,
            &touch("01ARZ3NDEKTSV4RRFFQ69G5FA3", "s2", "b.ts"),
            "a",
        );
        FileReducer.apply(
            &mut state,
            &touch("01ARZ3NDEKTSV4RRFFQ69G5FA4", "s1", "c.ts"),
            "a",
        );
        FileReducer.apply(
            &mut state,
            &touch("01ARZ3NDEKTSV4RRFFQ69G5FA5", "s1", "a.ts"),
            "a",
        );
        let ts = "2026-01-01T00:00:00.000Z".to_owned();
        assert_eq!(
            state.files,
            vec![
                (
                    "b.ts".to_owned(),
                    vec![
                        ("s1".to_owned(), (ts.clone(), 1.0)),
                        ("s2".to_owned(), (ts.clone(), 1.0))
                    ]
                ),
                (
                    "a.ts".to_owned(),
                    vec![("s1".to_owned(), (ts.clone(), 2.0))]
                ),
                ("c.ts".to_owned(), vec![("s1".to_owned(), (ts, 1.0))]),
            ]
        );
    }
}

// ---------------------------------------------------------------------------
// Lookups the PostToolUse hook makes (guardsForSubject, resolvePaths, lastTouch).

/// `guardsForSubject`: every decision whose guard claims this subject — a
/// malformed guard compiles to nothing and never matches.
#[must_use]
pub fn guards_for_subject<'a>(
    index: &'a GuardIndex,
    domain: crate::guards::GuardDomain,
    subject: &str,
) -> Vec<&'a GuardedDecision> {
    index
        .guards
        .iter()
        .filter(|d| {
            crate::guards::parse_guard(&d.guard)
                .is_some_and(|g| g.domain == domain && crate::guards::guard_matches(&g, subject))
        })
        .collect()
}

/// The derived half, unioned repo-wide (`FileIndex`): path → session → (ts, touches).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileIndex {
    pub files: Vec<(String, PathSessions)>,
}

/// `unionFiles` over the slugs in code-unit order.
fn union_files(states: &[(String, SlugFileState)]) -> FileIndex {
    let mut slugs: Vec<&(String, SlugFileState)> = states.iter().collect();
    slugs.sort_by(|a, b| cmp_utf16(&a.0, &b.0));
    let mut files: Vec<(String, PathSessions)> = Vec::new();
    for (_, state) in slugs {
        for (path, sessions) in &state.files {
            let i = if let Some(i) = files.iter().position(|(p, _)| p == path) {
                i
            } else {
                files.push((path.clone(), Vec::new()));
                files.len() - 1
            };
            let by_session = &mut files[i].1;
            for (session, (ts, touches)) in sessions {
                match by_session.iter_mut().find(|(s, _)| s == session) {
                    Some((_, (existing_ts, existing_touches))) => {
                        *existing_touches += touches;
                        if cmp_utf16(ts, existing_ts).is_gt() {
                            existing_ts.clone_from(ts);
                        }
                    }
                    None => by_session.push((session.clone(), (ts.clone(), *touches))),
                }
            }
        }
    }
    FileIndex { files }
}

/// `refreshFiles`: bring the derived half up to date and union it.
#[must_use]
pub fn refresh_files(layout: &Layout) -> FileIndex {
    union_files(&refresh_file_states(layout))
}

/// `resolvePaths` (`matchRecordedPaths`): the exact recorded path, else every
/// recorded path ending in `/<query>`, sorted.
#[must_use]
pub fn resolve_paths(index: &FileIndex, path: &str) -> Vec<String> {
    let query = path.strip_prefix("./").unwrap_or(path);
    if index.files.iter().any(|(p, _)| p == query) {
        return vec![query.to_owned()];
    }
    let suffix = format!("/{query}");
    let mut matches: Vec<String> = index
        .files
        .iter()
        .filter(|(p, _)| p.ends_with(&suffix))
        .map(|(p, _)| p.clone())
        .collect();
    matches.sort_by(|a, b| cmp_utf16(a, b));
    matches
}

/// `lastTouch`: when this session last touched the path, as the index recorded it.
#[must_use]
pub fn last_touch(index: &FileIndex, path: &str, session: &str) -> Option<String> {
    let mut latest: Option<String> = None;
    for recorded in resolve_paths(index, path) {
        let Some((_, sessions)) = index.files.iter().find(|(p, _)| *p == recorded) else {
            continue;
        };
        let Some((_, (ts, _))) = sessions.iter().find(|(s, _)| s == session) else {
            continue;
        };
        if latest.as_deref().is_none_or(|l| cmp_utf16(ts, l).is_gt()) {
            latest = Some(ts.clone());
        }
    }
    latest
}
