//! Stored relevance, keyed for lookup (`core/index-relevance.ts`, typed-judge
//! 5.1, the D10 contract): one row per (about, subject), the latest
//! `judgement_recorded` with question `relevance` winning. Read where no judge
//! may run — here, the `PostToolUse` notice's reordering within a tier. Two laws
//! live in the reader: a retired subject is never returned (the caller passes
//! the retired handles), and ranking adds or orders, never removes.

use std::collections::HashSet;

use crate::index_pass::{PassResult, SlugReducer, pass_over_record};
use crate::index_tail::IndexedEvent;
use crate::index_tier1::{read_half, write_half};
use crate::json::{Json, Object};
use crate::layout::Layout;
use crate::text::cmp_utf16;

/// `RELEVANCE_CARRY`: a candidate the judge alone found is added at or above this.
pub const RELEVANCE_CARRY: f64 = 0.8;

const RELEVANCE_FILE: &str = "relevance.json";
const RELEVANCE_META: &str = "meta-relevance.json";

/// One stored answer (`RelevanceRow`).
#[derive(Debug, Clone, PartialEq)]
pub struct RelevanceRow {
    pub subject: String,
    pub p: f64,
    pub model: String,
    /// The `judgement_recorded` event id: later ids win.
    pub id: String,
}

/// `SlugRelevanceState`: about → subject → row, each map in insertion order
/// (serialized in JavaScript property order by the JSON layer).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlugRelevanceState {
    pub rows: Vec<(String, Vec<(String, RelevanceRow)>)>,
}

impl SlugRelevanceState {
    fn to_json(&self) -> Json {
        let mut rows = Object::with_capacity(self.rows.len());
        for (about, by_subject) in &self.rows {
            let mut o = Object::with_capacity(by_subject.len());
            for (subject, row) in by_subject {
                let mut r = Object::with_capacity(4);
                r.insert("subject", Json::Str(row.subject.clone()));
                r.insert("p", Json::Num(row.p));
                r.insert("model", Json::Str(row.model.clone()));
                r.insert("id", Json::Str(row.id.clone()));
                o.insert(subject.clone(), Json::Obj(r));
            }
            rows.insert(about.clone(), Json::Obj(o));
        }
        let mut o = Object::with_capacity(1);
        o.insert("rows", Json::Obj(rows));
        Json::Obj(o)
    }

    fn from_json(v: &Json) -> Option<Self> {
        let rows = v.as_obj()?.get("rows")?.as_obj()?;
        let mut out = Vec::with_capacity(rows.len());
        for (about, by_subject) in rows.js_ordered() {
            let mut list = Vec::new();
            for (subject, row) in by_subject.as_obj()?.js_ordered() {
                let r = row.as_obj()?;
                list.push((
                    subject.to_owned(),
                    RelevanceRow {
                        subject: r.get("subject")?.as_str()?.to_owned(),
                        p: r.get("p")?.as_f64()?,
                        model: r.get("model")?.as_str()?.to_owned(),
                        id: r.get("id")?.as_str()?.to_owned(),
                    },
                ));
            }
            out.push((about.to_owned(), list));
        }
        Some(Self { rows: out })
    }
}

/// `qualifySubject`: a bare `D12` names the envelope's own initiative.
#[must_use]
pub fn qualify_subject(subject: &str, slug: &str) -> String {
    let bare = subject
        .strip_prefix('D')
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()));
    if bare {
        format!("{slug} {subject}")
    } else {
        subject.to_owned()
    }
}

struct RelevanceReducer;
impl SlugReducer for RelevanceReducer {
    type State = SlugRelevanceState;
    fn empty(&self) -> SlugRelevanceState {
        SlugRelevanceState::default()
    }
    fn apply(&self, state: &mut SlugRelevanceState, event: &IndexedEvent, slug: &str) {
        if event.event_type != "judgement_recorded" {
            return;
        }
        let p = &event.payload;
        let answer = p.get("answer").and_then(Json::as_obj);
        let (Some("relevance"), Some(about), Some("noul")) = (
            p.get("question").and_then(Json::as_str),
            p.get("about").and_then(Json::as_str),
            answer.and_then(|a| a.get("type")).and_then(Json::as_str),
        ) else {
            return;
        };
        let (Some(subject), Some(model)) = (
            p.get("subject").and_then(Json::as_str),
            p.get("model").and_then(Json::as_str),
        ) else {
            return;
        };
        let subject = qualify_subject(subject, slug);
        let noul = answer
            .and_then(|a| a.get("noul"))
            .and_then(Json::as_f64)
            .unwrap_or(f64::NAN);
        let at = if let Some(i) = state.rows.iter().position(|(a, _)| a == about) {
            i
        } else {
            state.rows.push((about.to_owned(), Vec::new()));
            state.rows.len() - 1
        };
        let rows = &mut state.rows[at].1;
        let row = RelevanceRow {
            subject: subject.clone(),
            p: noul,
            model: model.to_owned(),
            id: event.id.clone(),
        };
        match rows.iter_mut().find(|(s, _)| *s == subject) {
            Some((_, prior)) => {
                if event.id.as_str() > prior.id.as_str() {
                    *prior = row;
                }
            }
            None => rows.push((subject, row)),
        }
    }
}

/// `refreshRelevance`: bring the tier up to date.
#[must_use]
pub fn refresh_relevance(layout: &Layout) -> Vec<(String, SlugRelevanceState)> {
    let prior = read_half(layout, RELEVANCE_FILE, SlugRelevanceState::from_json);
    let PassResult {
        states, changed, ..
    } = pass_over_record(layout, RELEVANCE_META, prior.as_deref(), &RelevanceReducer);
    if changed {
        write_half(layout, RELEVANCE_FILE, &states, SlugRelevanceState::to_json);
    }
    states
}

/// `relevance`: the stored rows about `about`, strongest first, never a
/// retired subject. `task:` rows belong to `initiative`; `file:` rows are
/// repo-wide.
#[must_use]
pub fn relevance<S: std::hash::BuildHasher>(
    index: &[(String, SlugRelevanceState)],
    about: &str,
    initiative: Option<&str>,
    retired: &HashSet<String, S>,
) -> Vec<RelevanceRow> {
    let slugs: Vec<&str> = if about.starts_with("task:") {
        initiative.into_iter().collect()
    } else {
        index.iter().map(|(s, _)| s.as_str()).collect()
    };
    let mut best: Vec<RelevanceRow> = Vec::new();
    for slug in slugs {
        let Some((_, state)) = index.iter().find(|(s, _)| s == slug) else {
            continue;
        };
        let Some((_, rows)) = state.rows.iter().find(|(a, _)| a == about) else {
            continue;
        };
        // Visit order cannot matter: rows dedupe by subject on the id, and
        // the final sort is total.
        for (_, row) in rows {
            if retired.contains(&row.subject) {
                continue;
            }
            match best.iter_mut().find(|b| b.subject == row.subject) {
                Some(prior) => {
                    if row.id > prior.id {
                        *prior = row.clone();
                    }
                }
                None => best.push(row.clone()),
            }
        }
    }
    best.sort_by(|a, b| {
        b.p.partial_cmp(&a.p)
            .filter(|o| o.is_ne())
            .unwrap_or_else(|| {
                if cmp_utf16(&a.subject, &b.subject).is_lt() {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                }
            })
    });
    best
}

/// `rankByRelevance` (D10): every candidate stays, ordered by its stored p
/// (no row is 0.5, ties keep the candidates' order); a row naming a
/// non-candidate is added only at p >= `RELEVANCE_CARRY`.
#[must_use]
pub fn rank_by_relevance(candidates: &[String], rows: &[RelevanceRow]) -> Vec<String> {
    let p_of = |s: &str| -> f64 {
        // `new Map(rows.map(...))`: a later row for the same subject wins.
        rows.iter()
            .rev()
            .find(|r| r.subject == s)
            .map_or(0.5, |r| r.p)
    };
    let mut all: Vec<String> = candidates.to_vec();
    for r in rows {
        if !candidates.contains(&r.subject) && r.p >= RELEVANCE_CARRY {
            all.push(r.subject.clone());
        }
    }
    let position = |s: &str, all: &[String]| all.iter().position(|x| x == s).unwrap_or(0);
    let snapshot = all.clone();
    all.sort_by(|a, b| {
        let d = p_of(b) - p_of(a);
        if d != 0.0 && !d.is_nan() {
            return if d < 0.0 {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        position(a, &snapshot).cmp(&position(b, &snapshot))
    });
    all
}
