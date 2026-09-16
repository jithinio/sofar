//! The relevant-lessons line (`core/lessons.ts`, r1-fixes 3.3, D16): the
//! decisions and stall handoffs a prompt's own words reach, ranked lexically.

use crate::fold::InitiativeState;
use crate::lexicon::{LexicalDoc, lexical_counts, rank_lexical};
use crate::projections::retired_ordinals;
use crate::text::{js_trim, utf16_prefix};

pub const LESSON_MIN_TERMS: usize = 2;
pub const LESSON_MIN_SCORE: f64 = 1.5;
pub const LESSON_SMALL_RECORD: usize = 5;
pub const LESSON_MIN_TERMS_SMALL: usize = 3;
pub const LESSON_MAX: usize = 2;
pub const LESSON_RUNNER_UP_RATIO: f64 = 0.6;
pub const LESSON_PROMPT_CHARS: usize = 2_000;
pub const LESSON_DOC_CAP: usize = 60;
pub const LESSON_DOC_CHARS: usize = 1_200;

#[derive(Debug, Clone, PartialEq)]
pub struct Lesson {
    pub handle: String,
    pub text: String,
    pub terms: Vec<String>,
    pub score: f64,
}

struct LessonDoc {
    doc: LexicalDoc,
    handle: String,
    text: String,
}

/// `lessonsEnabled`: `SOFAR_LESSONS=off` (also `0`, `false`).
#[must_use]
pub fn lessons_enabled() -> bool {
    let Some(raw) = std::env::var_os("SOFAR_LESSONS") else {
        return true;
    };
    let v = raw.to_string_lossy();
    let v = js_trim(&v).to_lowercase();
    !(v == "off" || v == "0" || v == "false")
}

fn doc(id: String, ts: &str, prose: &str, handle: String, text: String) -> LessonDoc {
    let terms = lexical_counts(&utf16_prefix(prose, LESSON_DOC_CHARS));
    let tokens = terms.iter().map(|(_, n)| n).sum();
    LessonDoc {
        doc: LexicalDoc {
            id,
            ts: ts.to_owned(),
            terms,
            tokens,
        },
        handle,
        text,
    }
}

fn lesson_docs(state: &InitiativeState, retire: bool) -> Vec<LessonDoc> {
    let retired = if retire {
        retired_ordinals(state)
    } else {
        Vec::new()
    };
    let live: Vec<(usize, &crate::fold::DecisionState)> = state
        .decisions
        .iter()
        .enumerate()
        .map(|(i, d)| (i + 1, d))
        .filter(|(ordinal, _)| !retired.contains(ordinal))
        .collect();
    let mut docs = Vec::new();
    for (ordinal, d) in &live[live.len().saturating_sub(LESSON_DOC_CAP)..] {
        docs.push(doc(
            format!("decision:{ordinal}"),
            &d.ts,
            &format!("{} {} {}", d.chose, d.over, d.because),
            format!("D{ordinal}"),
            d.over.clone(),
        ));
    }
    for s in &state.sessions {
        let Some(h) = &s.handoff else { continue };
        let Some(detail) = &h.detail else { continue };
        if js_trim(detail).is_empty() || h.reason != "stall" {
            continue;
        }
        docs.push(doc(
            format!("failure:{}", s.id),
            &h.ts,
            detail,
            format!("session {} ({})", s.id, h.reason),
            detail.clone(),
        ));
    }
    docs
}

/// `relevantLessons`.
#[must_use]
pub fn relevant_lessons(state: &InitiativeState, prompt: &str, retire: bool) -> Vec<Lesson> {
    let query = utf16_prefix(prompt, LESSON_PROMPT_CHARS);
    if js_trim(&query).is_empty() {
        return Vec::new();
    }
    let docs = lesson_docs(state, retire);
    if docs.is_empty() {
        return Vec::new();
    }
    let lexical: Vec<LexicalDoc> = docs.iter().map(|d| d.doc.clone()).collect();
    let ranked = rank_lexical(&lexical, &query, docs.len());
    let small = docs.len() < LESSON_SMALL_RECORD;
    let min_terms = if small {
        LESSON_MIN_TERMS_SMALL
    } else {
        LESSON_MIN_TERMS
    };
    let min_score = if small { 0.0 } else { LESSON_MIN_SCORE };
    let mut out: Vec<Lesson> = Vec::new();
    for m in ranked {
        if m.terms.len() < min_terms || m.score < min_score {
            continue;
        }
        if let Some(first) = out.first()
            && m.score < first.score * LESSON_RUNNER_UP_RATIO
        {
            break;
        }
        let Some(d) = docs.iter().find(|d| d.doc.id == m.id) else {
            continue;
        };
        out.push(Lesson {
            handle: d.handle.clone(),
            text: d.text.clone(),
            terms: m.terms.clone(),
            score: m.score,
        });
        if out.len() >= LESSON_MAX {
            break;
        }
    }
    out
}
