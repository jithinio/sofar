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

/// A decision that declared which work it governs (rule + guard) — the
/// scope-tier entries carrying both, superseded ones included and marked.
#[derive(Debug, Clone, PartialEq)]
pub struct GuardedDecision {
    pub id: String,
    pub initiative: String,
    pub ordinal: f64,
    pub ts: String,
    pub rule: String,
    pub guard: String,
    pub chose: String,
    pub superseded_by: Option<f64>,
}

/// A decision in the decision-scope tier (memory-lead 2.1, D6): one that
/// declares the work it governs (rule + guard), names a file in its chose,
/// over, rule or check command, or carries a rule at all (memory-lead 2.2,
/// D8). Its fields are what a notice renders, so a hook never folds.
#[derive(Debug, Clone, PartialEq)]
pub struct ScopedDecision {
    pub id: String,
    pub initiative: String,
    pub ordinal: f64,
    pub ts: String,
    /// `headSource`: whitespace-collapsed, trimmed, first 120 UTF-16 units.
    pub chose: String,
    pub over: String,
    pub rule: Option<String>,
    pub quote: Option<String>,
    /// Only alongside `rule`.
    pub guard: Option<String>,
    /// Only alongside `rule` (memory-lead 2.3, D9): `{cmd, hint?, timeout_ms?}`.
    pub check: Option<Json>,
    pub until: Option<String>,
    pub superseded_by: Option<f64>,
    /// File tokens of chose, over, rule and the check's command.
    pub mentions: Vec<String>,
}

/// One initiative's scope-tier state (`SlugGuardState`), in the TypeScript
/// key order the index file holds.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlugGuardState {
    /// `decision_logged` events applied so far — the `D<n>` base.
    pub decisions: f64,
    /// `'1'` where that ordinal carries a rule, else `'0'`, for EVERY decision.
    pub ruled: String,
    /// The event id of EVERY decision, by ordinal − 1 (memory-lead 2.8, D12).
    pub ids: Vec<String>,
    /// Ordinals a later decision superseded, ascending.
    pub superseded: Vec<f64>,
    /// Ordinals scoped by `until`.
    pub until: Vec<f64>,
    pub entries: Vec<ScopedDecision>,
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

impl ScopedDecision {
    fn to_json(&self) -> Json {
        let mut d = Object::with_capacity(13);
        d.insert("id", Json::Str(self.id.clone()));
        d.insert("initiative", Json::Str(self.initiative.clone()));
        d.insert("ordinal", Json::Num(self.ordinal));
        d.insert("ts", Json::Str(self.ts.clone()));
        d.insert("chose", Json::Str(self.chose.clone()));
        d.insert("over", Json::Str(self.over.clone()));
        let opt = |d: &mut Object, k: &str, v: &Option<String>| {
            if let Some(v) = v {
                d.insert(k, Json::Str(v.clone()));
            }
        };
        opt(&mut d, "rule", &self.rule);
        opt(&mut d, "quote", &self.quote);
        opt(&mut d, "guard", &self.guard);
        if let Some(check) = &self.check {
            d.insert("check", check.clone());
        }
        opt(&mut d, "until", &self.until);
        d.insert(
            "mentions",
            Json::Arr(self.mentions.iter().map(|m| Json::Str(m.clone())).collect()),
        );
        // Set after the push, so it follows `mentions` in the TypeScript object.
        if let Some(by) = self.superseded_by {
            d.insert("superseded_by", Json::Num(by));
        }
        Json::Obj(d)
    }

    fn from_json(v: &Json) -> Option<Self> {
        let g = v.as_obj()?;
        let s = |k: &str| g.get(k)?.as_str().map(str::to_owned);
        let opt = |k: &str| match g.get(k) {
            None => Some(None),
            Some(v) => v.as_str().map(|s| Some(s.to_owned())),
        };
        Some(ScopedDecision {
            id: s("id")?,
            initiative: s("initiative")?,
            ordinal: g.get("ordinal")?.as_f64()?,
            ts: s("ts")?,
            chose: s("chose")?,
            over: s("over")?,
            rule: opt("rule")?,
            quote: opt("quote")?,
            guard: opt("guard")?,
            check: g.get("check").cloned(),
            until: opt("until")?,
            superseded_by: match g.get("superseded_by") {
                None => None,
                Some(v) => Some(v.as_f64()?),
            },
            mentions: g
                .get("mentions")?
                .as_arr()?
                .iter()
                .map(|m| m.as_str().map(str::to_owned))
                .collect::<Option<_>>()?,
        })
    }
}

fn nums(v: &[f64]) -> Json {
    Json::Arr(v.iter().map(|n| Json::Num(*n)).collect())
}

fn read_nums(v: Option<&Json>) -> Option<Vec<f64>> {
    v?.as_arr()?.iter().map(Json::as_f64).collect()
}

impl SlugGuardState {
    fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(6);
        o.insert("decisions", Json::Num(self.decisions));
        o.insert("ruled", Json::Str(self.ruled.clone()));
        o.insert(
            "ids",
            Json::Arr(self.ids.iter().map(|i| Json::Str(i.clone())).collect()),
        );
        o.insert("superseded", nums(&self.superseded));
        o.insert("until", nums(&self.until));
        o.insert(
            "entries",
            Json::Arr(self.entries.iter().map(ScopedDecision::to_json).collect()),
        );
        Json::Obj(o)
    }

    fn from_json(v: &Json) -> Option<Self> {
        let o = v.as_obj()?;
        Some(Self {
            decisions: o.get("decisions")?.as_f64()?,
            ruled: o.get("ruled")?.as_str()?.to_owned(),
            ids: o
                .get("ids")?
                .as_arr()?
                .iter()
                .map(|i| i.as_str().map(str::to_owned))
                .collect::<Option<_>>()?,
            superseded: read_nums(o.get("superseded"))?,
            until: read_nums(o.get("until"))?,
            entries: o
                .get("entries")?
                .as_arr()?
                .iter()
                .map(ScopedDecision::from_json)
                .collect::<Option<_>>()?,
        })
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

/// `SCOPE_HEAD_SOURCE`: how much of a decision's chose and over the tier
/// keeps — every head a notice renders (`minutiaeHead`, ≤ 90) depends only on
/// the first 90 units and on whether the text runs past them.
pub const SCOPE_HEAD_SOURCE: usize = 120;

/// `headSource`.
fn head_source(text: &str) -> String {
    crate::text::utf16_prefix(&crate::text::one_line(text), SCOPE_HEAD_SOURCE)
}

/// `supersededOrdinal`: the ordinal a `supersedes` retires, as the fold
/// resolves it — where the stamped id sits among the decisions before this
/// one (memory-lead 2.8, D12), never the handle; else the handle's own.
pub(crate) fn superseded_ordinal(
    p: &Object,
    handle: &str,
    ordinal: usize,
    ids: &[String],
) -> Option<f64> {
    if let Some(id) = p.get("supersedes_id").and_then(Json::as_str) {
        return ids[..ordinal - 1]
            .iter()
            .rposition(|i| i == id)
            .map(|i| crate::json::usize_to_f64(i + 1));
    }
    let digits = handle.strip_prefix('D')?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    // Number(m[1]): a huge handle is still an integer, and never below `ordinal`.
    Some(digits.parse::<f64>().unwrap_or(f64::INFINITY))
}

struct GuardReducer;
impl SlugReducer for GuardReducer {
    type State = SlugGuardState;
    fn empty(&self) -> SlugGuardState {
        SlugGuardState::default()
    }
    /// `applyGuard`: the decision-scope half, mirroring the fold's own
    /// bookkeeping — the same ordinals and the same supersession marks.
    fn apply(&self, state: &mut SlugGuardState, event: &IndexedEvent, slug: &str) {
        if event.event_type != "decision_logged" {
            return;
        }
        let p = &event.payload;
        // Counted BEFORE the scope test: `D<n>` is a position among all decisions.
        state.decisions += 1.0;
        let ordinal = state.decisions;
        let rule = p.get("rule").and_then(Json::as_str);
        let ruled = rule.is_some();
        state.ruled.push(if ruled { '1' } else { '0' });
        state.ids.push(event.id.clone());

        // Supersession, exactly as the fold resolves it: inert when it points
        // forward or at itself, or when a rule-less decision names a rule.
        // The last superseder wins the mark, as it does in the fold.
        if let Some(handle) = p.get("supersedes").and_then(Json::as_str)
            && let Some(n) = superseded_ordinal(p, handle, state.ids.len(), &state.ids)
            && n.fract() == 0.0
            && n >= 1.0
            && n < ordinal
        {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "1 <= n < ordinal"
            )]
            let at = n as usize - 1;
            if state.ruled.as_bytes().get(at) != Some(&b'1') || ruled {
                if !state.superseded.contains(&n) {
                    state.superseded.push(n);
                    state.superseded.sort_by(f64::total_cmp);
                }
                if let Some(target) = state
                    .entries
                    .iter_mut()
                    .find(|e| e.ordinal.total_cmp(&n).is_eq())
                {
                    target.superseded_by = Some(ordinal);
                }
            }
        }
        let until = p.get("until").and_then(Json::as_str);
        if until.is_some() {
            state.until.push(ordinal);
        }

        let text = |k: &str| {
            p.get(k)
                .map_or_else(|| "undefined".to_owned(), crate::json::js_to_string)
        };
        let guard = rule.and(p.get("guard").and_then(Json::as_str));
        let check = rule
            .and(p.get("check").and_then(Json::as_obj))
            .filter(|c| c.get("cmd").and_then(Json::as_str).is_some());
        let cmd = check
            .and_then(|c| c.get("cmd").and_then(Json::as_str))
            .unwrap_or("");
        let mentions = crate::file_mentions::file_mentions(
            &[
                text("chose"),
                text("over"),
                rule.unwrap_or("").to_owned(),
                cmd.to_owned(),
            ]
            .join("\n"),
        );
        if !ruled && mentions.is_empty() {
            return;
        }
        state.entries.push(ScopedDecision {
            id: event.id.clone(),
            initiative: slug.to_owned(),
            ordinal,
            ts: event.ts.clone(),
            chose: head_source(&text("chose")),
            over: head_source(&text("over")),
            rule: rule.map(str::to_owned),
            quote: rule
                .and(p.get("quote").and_then(Json::as_str))
                .map(str::to_owned),
            guard: guard.map(str::to_owned),
            check: check.map(|c| {
                let mut o = Object::with_capacity(3);
                for key in ["cmd", "hint", "timeout_ms"] {
                    if let Some(v) = c.get(key) {
                        o.insert(key, v.clone());
                    }
                }
                Json::Obj(o)
            }),
            until: until.map(str::to_owned),
            superseded_by: None,
            mentions,
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

pub(crate) fn read_half<S>(
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

pub(crate) fn write_half<S>(
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
    let PassResult {
        states, changed, ..
    } = pass_over_record(layout, GUARDS_META, prior.as_deref(), &GuardReducer);
    if changed {
        write_half(layout, GUARDS_FILE, &states, SlugGuardState::to_json);
    }
    states
}

/// `refreshHalf` for the derived tier.
fn refresh_file_states(layout: &Layout) -> Vec<(String, SlugFileState)> {
    let prior = read_half(layout, FILES_FILE, SlugFileState::from_json);
    let PassResult {
        states, changed, ..
    } = pass_over_record(layout, FILES_META, prior.as_deref(), &FileReducer);
    if changed {
        write_half(layout, FILES_FILE, &states, SlugFileState::to_json);
    }
    states
}

/// The declared half, repo-wide (`GuardIndex`): the guarded entries and every
/// scope-tier entry, each by initiative then ordinal; the retired handles;
/// decision counts per slug.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GuardIndex {
    pub guards: Vec<GuardedDecision>,
    pub scoped: Vec<ScopedDecision>,
    /// `<slug> D<n>` of every superseded or until-scoped decision.
    pub retired: std::collections::HashSet<String>,
    pub decisions: Vec<(String, f64)>,
}

fn by_initiative_then_ordinal(a: (&str, f64), b: (&str, f64)) -> std::cmp::Ordering {
    if a.0 == b.0 {
        a.1.total_cmp(&b.1)
    } else {
        cmp_utf16(a.0, b.0)
    }
}

fn declared_view(states: &[(String, SlugGuardState)]) -> GuardIndex {
    let mut slugs: Vec<&(String, SlugGuardState)> = states.iter().collect();
    slugs.sort_by(|a, b| cmp_utf16(&a.0, &b.0));
    let mut index = GuardIndex::default();
    for (slug, state) in slugs {
        index.decisions.push((slug.clone(), state.decisions));
        for n in state.superseded.iter().chain(&state.until) {
            index
                .retired
                .insert(format!("{slug} D{}", crate::json::number_to_string(*n)));
        }
        for entry in &state.entries {
            index.scoped.push(entry.clone());
            if let (Some(rule), Some(guard)) = (&entry.rule, &entry.guard) {
                index.guards.push(GuardedDecision {
                    id: entry.id.clone(),
                    initiative: entry.initiative.clone(),
                    ordinal: entry.ordinal,
                    ts: entry.ts.clone(),
                    rule: rule.clone(),
                    guard: guard.clone(),
                    chose: entry.chose.clone(),
                    superseded_by: entry.superseded_by,
                });
            }
        }
    }
    index.guards.sort_by(|a, b| {
        by_initiative_then_ordinal((&a.initiative, a.ordinal), (&b.initiative, b.ordinal))
    });
    index.scoped.sort_by(|a, b| {
        by_initiative_then_ordinal((&a.initiative, a.ordinal), (&b.initiative, b.ordinal))
    });
    index
}

/// `refreshGuards`: bring the declared half up to date — every decision in
/// the repo that guards or names a file, or carries a rule.
#[must_use]
pub fn refresh_guards(layout: &Layout) -> GuardIndex {
    declared_view(&refresh_guard_states(layout))
}

/// One other record's standing rule, as the digest renders it (memory-lead
/// 2.2, D8).
#[derive(Debug, Clone, PartialEq)]
pub struct RepoRule {
    pub initiative: String,
    pub ordinal: f64,
    pub ts: String,
    pub rule: String,
    pub quote: Option<String>,
}

/// `repoRules`: every other record's standing rules — the ruled scope entries
/// outside `slug`, minus those a later rule of their own record replaced,
/// unless `retire` is off (`SOFAR_RETIRE`, r1-fixes D25).
#[must_use]
pub fn repo_rules(index: &GuardIndex, slug: &str, retire: bool) -> Vec<RepoRule> {
    index
        .scoped
        .iter()
        .filter(|d| d.initiative != slug && !(retire && d.superseded_by.is_some()))
        .filter_map(|d| {
            Some(RepoRule {
                initiative: d.initiative.clone(),
                ordinal: d.ordinal,
                ts: d.ts.clone(),
                rule: d.rule.clone()?,
                quote: d.quote.clone(),
            })
        })
        .collect()
}

/// How one in-scope decision bears on one subject (`ScopeHit`).
#[derive(Debug, Clone, PartialEq)]
pub struct ScopeHit<'a> {
    pub decision: &'a ScopedDecision,
    /// Its guard matches the subject: relevance the author DECLARED.
    pub guarded: bool,
    /// Segments of the path the decision's best file token names; 0 when none does.
    pub depth: usize,
}

/// `scopeHitsForSubject`: every in-scope decision that guards or names this
/// subject. A path is matched against guards and mentions, a command against
/// `cmd:` guards only. Retirement is the caller's to apply.
#[must_use]
pub fn scope_hits_for_subject<'a>(
    index: &'a GuardIndex,
    domain: crate::guards::GuardDomain,
    subject: &str,
) -> Vec<ScopeHit<'a>> {
    let mut hits = Vec::new();
    for decision in &index.scoped {
        let guarded = decision.guard.as_deref().is_some_and(|guard| {
            crate::guards::parse_guard(guard)
                .is_some_and(|g| g.domain == domain && crate::guards::guard_matches(&g, subject))
        });
        let depth = if domain == crate::guards::GuardDomain::Path {
            decision
                .mentions
                .iter()
                .map(|t| crate::file_mentions::mention_depth(t, subject))
                .max()
                .unwrap_or(0)
        } else {
            0
        };
        if guarded || depth > 0 {
            hits.push(ScopeHit {
                decision,
                guarded,
                depth,
            });
        }
    }
    hits
}

/// `refreshNeighbours` (record-index 3.3): the records that have worked this
/// one's files, densest first.
#[must_use]
pub fn refresh_neighbours(
    layout: &Layout,
    slug: &str,
    declared: &GuardIndex,
) -> Vec<NeighbourRecord> {
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
        let n = refresh_neighbours(&layout, "a", &refresh_guards(&layout));
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
        assert_eq!(
            refresh_neighbours(&layout, "a", &refresh_guards(&layout)),
            n
        );
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
        assert_eq!(
            refresh_neighbours(&layout, "a", &refresh_guards(&layout))[0].paths,
            2
        );
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
