//! Payload validation RULES — the hand-ported logic of
//! `packages/schema/src/events.ts` (`validatePayload`) and the guard grammar
//! of `guards.ts` (`guardSpecErrors`), at the pinned TypeScript commit
//! (179b8fd, sofar.sh 0.33.0-rc.1). Shapes are generated into
//! `sofar_schema`; rules are logic, so they live here (rust-core D1) and every
//! error string is verbatim: the fold prints them (`syn.corrupt`), and
//! `event append` echoes them.
//!
//! Field tests mirror the TypeScript helpers exactly: `str` is a non-empty
//! string, `optStr` is absent-or-string (empty allowed), `optNonEmptyStr` is
//! absent-or-non-empty; "absent" means the key is missing (a JSON `null` is
//! present and fails the type test).

use crate::json::{Json, Object};
use crate::text::{js_trim, utf16_len};

pub const TASK_STATUSES: [&str; 5] = ["pending", "active", "done", "blocked", "dropped"];
pub const PHASE_STATUSES: [&str; 5] = ["pending", "active", "done", "blocked", "dropped"];
pub const INITIATIVE_STATUSES: [&str; 4] = ["active", "done", "dropped", "superseded"];
pub const REVIEW_VERDICTS: [&str; 3] = ["pass", "findings", "blocked"];
pub const REVIEW_SCOPES: [&str; 2] = ["phase", "final"];
pub const RUN_POLICIES: [&str; 2] = ["task", "threshold"];
pub const HANDOFF_REASONS: [&str; 5] = [
    "task_done",
    "threshold",
    "stall",
    "needs_user",
    "verify_failed",
];
pub const RUN_STOP_REASONS: [&str; 7] = [
    "closed",
    "needs_user",
    "stall",
    "cost_cap",
    "max_sessions",
    "interrupted",
    "error",
];
pub const VERIFICATION_RESULTS: [&str; 5] = ["pass", "fail", "timeout", "error", "refused"];

/// `EVENT_TYPES`, in the schema's order.
pub const EVENT_TYPES: [&str; 21] = [
    "initiative_created",
    "initiative_status_changed",
    "plan_updated",
    "phase_status_changed",
    "task_added",
    "task_status_changed",
    "decision_logged",
    "session_started",
    "session_ended",
    "session_closed",
    "file_touched",
    "command_run",
    "note_added",
    "memory_promoted",
    "review_recorded",
    "run_started",
    "handoff",
    "run_stopped",
    "run_stop_requested",
    "verification_recorded",
    "correction",
];

#[must_use]
pub fn is_known_event_type(event_type: &str) -> bool {
    EVENT_TYPES.contains(&event_type)
}

/// `^[a-z0-9-]+$`.
#[must_use]
pub fn is_initiative_slug(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// `MEMORY_HANDLE_RE = /^([a-z0-9-]+) M([1-9][0-9]*)$/`.
#[must_use]
pub fn is_memory_handle(s: &str) -> bool {
    let Some((slug, n)) = s.split_once(" M") else {
        return false;
    };
    is_initiative_slug(slug)
        && !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit())
        && !n.starts_with('0')
}

/// Validate `payload` against its type's rules. Unknown types are rejected
/// here (the fold turns that into its own warning).
pub fn validate_payload(event_type: &str, payload: &Json) -> Result<(), Vec<String>> {
    if !is_known_event_type(event_type) {
        return Err(vec![format!("unknown event type: {event_type}")]);
    }
    let Some(p) = payload.as_obj() else {
        return Err(vec!["payload: must be a JSON object".to_owned()]);
    };
    let mut e = Vec::new();
    validate_known(event_type, p, &mut e);
    if e.is_empty() { Ok(()) } else { Err(e) }
}

// --- the TypeScript helpers ------------------------------------------------

fn str(v: Option<&Json>) -> bool {
    v.and_then(Json::as_nonempty_str).is_some()
}
fn opt_str(v: Option<&Json>) -> bool {
    v.is_none_or(|v| v.as_str().is_some())
}
fn opt_nonempty_str(v: Option<&Json>) -> bool {
    v.is_none_or(|v| v.as_nonempty_str().is_some())
}
fn one_of(v: Option<&Json>, set: &[&str]) -> bool {
    v.and_then(Json::as_str).is_some_and(|s| set.contains(&s))
}
fn opt_one_of(v: Option<&Json>, set: &[&str]) -> bool {
    v.is_none_or(|v| one_of(Some(v), set))
}
fn array_of_nonempty_str(v: Option<&Json>) -> bool {
    v.and_then(Json::as_arr)
        .is_some_and(|a| a.iter().all(|s| s.as_nonempty_str().is_some()))
}
fn integer(v: Option<&Json>) -> Option<f64> {
    v.filter(|v| v.is_integer()).and_then(Json::as_f64)
}
fn positive_integer(v: Option<&Json>) -> bool {
    integer(v).is_some_and(|n| n > 0.0)
}
fn eq_str(v: Option<&Json>, s: &str) -> bool {
    v.and_then(Json::as_str) == Some(s)
}

fn validate_route(route: Option<&Json>, path: &str, errors: &mut Vec<String>) {
    let Some(route) = route else { return };
    let Some(route) = route.as_obj() else {
        errors.push(format!("{path}: must be an object"));
        return;
    };
    for key in ["agent", "model", "effort"] {
        if !opt_nonempty_str(route.get(key)) {
            errors.push(format!(
                "{path}.{key}: must be a non-empty string when present"
            ));
        }
    }
}

fn validate_verify(verify: Option<&Json>, path: &str, errors: &mut Vec<String>) {
    let Some(verify) = verify else { return };
    let Some(verify) = verify.as_obj() else {
        errors.push(format!("{path}: must be an object"));
        return;
    };
    if !str(verify.get("cmd")) {
        errors.push(format!("{path}.cmd: must be a non-empty string"));
    }
    if !opt_nonempty_str(verify.get("cwd")) {
        errors.push(format!(
            "{path}.cwd: must be a non-empty string when present"
        ));
    }
    if verify.contains_key("timeout_ms") && !positive_integer(verify.get("timeout_ms")) {
        errors.push(format!(
            "{path}.timeout_ms: must be a positive integer when present"
        ));
    }
}

fn validate_plan(plan: Option<&Json>, errors: &mut Vec<String>) {
    let Some(plan) = plan.and_then(Json::as_obj) else {
        errors.push("plan: must be an object".to_owned());
        return;
    };
    if plan.contains_key("goal") && !str(plan.get("goal")) {
        errors.push("plan.goal: must be a non-empty string".to_owned());
    }
    let Some(phases) = plan.get("phases").and_then(Json::as_arr) else {
        errors.push("plan.phases: must be an array".to_owned());
        return;
    };
    for (pi, phase) in phases.iter().enumerate() {
        let Some(phase) = phase.as_obj() else {
            errors.push(format!("plan.phases[{pi}]: must be an object"));
            continue;
        };
        if !str(phase.get("name")) {
            errors.push(format!(
                "plan.phases[{pi}].name: must be a non-empty string"
            ));
        }
        if phase.contains_key("status") && !one_of(phase.get("status"), &PHASE_STATUSES) {
            errors.push(format!(
                "plan.phases[{pi}].status: must be one of {}",
                PHASE_STATUSES.join("|")
            ));
        }
        let Some(tasks) = phase.get("tasks").and_then(Json::as_arr) else {
            errors.push(format!("plan.phases[{pi}].tasks: must be an array"));
            continue;
        };
        for (ti, task) in tasks.iter().enumerate() {
            let Some(task) = task.as_obj() else {
                errors.push(format!("plan.phases[{pi}].tasks[{ti}]: must be an object"));
                continue;
            };
            if !str(task.get("id")) {
                errors.push(format!(
                    "plan.phases[{pi}].tasks[{ti}].id: must be a non-empty string"
                ));
            }
            if !str(task.get("title")) {
                errors.push(format!(
                    "plan.phases[{pi}].tasks[{ti}].title: must be a non-empty string"
                ));
            }
            if !opt_one_of(task.get("status"), &TASK_STATUSES) {
                errors.push(format!(
                    "plan.phases[{pi}].tasks[{ti}].status: must be one of {}",
                    TASK_STATUSES.join("|")
                ));
            }
            validate_route(
                task.get("route"),
                &format!("plan.phases[{pi}].tasks[{ti}].route"),
                errors,
            );
            validate_verify(
                task.get("verify"),
                &format!("plan.phases[{pi}].tasks[{ti}].verify"),
                errors,
            );
        }
    }
}

#[allow(
    clippy::too_many_lines,
    reason = "one arm per event type, in schema order, kept together for diffing against events.ts"
)]
fn validate_known(event_type: &str, p: &Object, e: &mut Vec<String>) {
    let must = |e: &mut Vec<String>, ok: bool, msg: &str| {
        if !ok {
            e.push(msg.to_owned());
        }
    };
    match event_type {
        "initiative_created" => {
            must(e, str(p.get("slug")), "slug: must be a non-empty string");
            must(e, str(p.get("goal")), "goal: must be a non-empty string");
        }
        "initiative_status_changed" => {
            if !one_of(p.get("status"), &INITIATIVE_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    INITIATIVE_STATUSES.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
            if eq_str(p.get("status"), "dropped") && !str(p.get("note")) {
                e.push(
                    "note: required when status is \"dropped\" — say why it was abandoned"
                        .to_owned(),
                );
            }
            if eq_str(p.get("status"), "superseded") {
                if !p
                    .get("successor")
                    .and_then(Json::as_nonempty_str)
                    .is_some_and(is_initiative_slug)
                {
                    e.push("successor: required when status is \"superseded\" — the slug the work continues in ([a-z0-9-]+)".to_owned());
                }
            } else if p.contains_key("successor") {
                e.push("successor: only allowed when status is \"superseded\"".to_owned());
            }
            if p.contains_key("overrides") && !array_of_nonempty_str(p.get("overrides")) {
                e.push("overrides: must be an array of non-empty strings when present".to_owned());
            }
        }
        "plan_updated" => validate_plan(p.get("plan"), e),
        "phase_status_changed" => {
            must(e, str(p.get("phase")), "phase: must be a non-empty string");
            if !one_of(p.get("status"), &PHASE_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    PHASE_STATUSES.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
        }
        "task_added" => {
            must(e, str(p.get("phase")), "phase: must be a non-empty string");
            must(e, str(p.get("id")), "id: must be a non-empty string");
            must(e, str(p.get("title")), "title: must be a non-empty string");
            if !opt_one_of(p.get("status"), &TASK_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    TASK_STATUSES.join("|")
                ));
            }
            validate_verify(p.get("verify"), "verify", e);
        }
        "task_status_changed" => {
            must(e, str(p.get("id")), "id: must be a non-empty string");
            if !one_of(p.get("status"), &TASK_STATUSES) {
                e.push(format!(
                    "status: must be one of {}",
                    TASK_STATUSES.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
        }
        "decision_logged" => {
            must(e, str(p.get("chose")), "chose: must be a non-empty string");
            must(e, str(p.get("over")), "over: must be a non-empty string");
            must(
                e,
                str(p.get("because")),
                "because: must be a non-empty string",
            );
            must(
                e,
                opt_nonempty_str(p.get("rule")),
                "rule: must be a non-empty string when present",
            );
            if let Some(guard) = p.get("guard") {
                must(
                    e,
                    str(p.get("rule")),
                    "guard: requires `rule` — a guard with no clause has nothing to cite",
                );
                e.extend(guard_spec_errors(guard));
            }
        }
        "session_started" => {
            must(e, str(p.get("tool")), "tool: must be a non-empty string");
            must(e, opt_str(p.get("model")), "model: must be a string");
        }
        "session_ended" => {
            must(
                e,
                opt_str(p.get("session_id")),
                "session_id: must be a string",
            );
            must(
                e,
                str(p.get("summary")),
                "summary: must be a non-empty string",
            );
            must(
                e,
                str(p.get("next_action")),
                "next_action: must be a non-empty string",
            );
        }
        "session_closed" => must(
            e,
            str(p.get("reason")),
            "reason: must be a non-empty string",
        ),
        "file_touched" => {
            must(e, str(p.get("path")), "path: must be a non-empty string");
            must(e, str(p.get("op")), "op: must be a non-empty string");
        }
        "command_run" => must(e, str(p.get("cmd")), "cmd: must be a non-empty string"),
        "note_added" => must(e, str(p.get("text")), "text: must be a non-empty string"),
        "memory_promoted" => {
            must(e, str(p.get("text")), "text: must be a non-empty string");
            if p.contains_key("supersedes")
                && !p
                    .get("supersedes")
                    .and_then(Json::as_nonempty_str)
                    .is_some_and(is_memory_handle)
            {
                e.push(
                    "supersedes: must be a qualified memory handle `<slug> M<n>` when present"
                        .to_owned(),
                );
            }
        }
        "review_recorded" => {
            if !one_of(p.get("scope"), &REVIEW_SCOPES) {
                e.push(format!("scope: must be one of {}", REVIEW_SCOPES.join("|")));
            }
            if !one_of(p.get("verdict"), &REVIEW_VERDICTS) {
                e.push(format!(
                    "verdict: must be one of {}",
                    REVIEW_VERDICTS.join("|")
                ));
            }
            if p.contains_key("watermark") && !str(p.get("watermark")) {
                e.push("watermark: must be a non-empty string when present".to_owned());
            }
            if p.contains_key("phase") && !str(p.get("phase")) {
                e.push("phase: must be a non-empty string when present".to_owned());
            }
            if p.contains_key("findings") && !array_of_nonempty_str(p.get("findings")) {
                e.push("findings: must be an array of non-empty strings when present".to_owned());
            }
            if eq_str(p.get("verdict"), "findings")
                && p.get("findings")
                    .and_then(Json::as_arr)
                    .is_none_or(<[Json]>::is_empty)
            {
                e.push("findings: required and non-empty when verdict is `findings`".to_owned());
            }
        }
        "run_started" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            must(
                e,
                str(p.get("adapter")),
                "adapter: must be a non-empty string",
            );
            must(
                e,
                opt_nonempty_str(p.get("verify")),
                "verify: must be a non-empty string when present",
            );
            if !one_of(p.get("policy"), &RUN_POLICIES) {
                e.push(format!("policy: must be one of {}", RUN_POLICIES.join("|")));
            }
            if p.contains_key("threshold_pct")
                && !integer(p.get("threshold_pct")).is_some_and(|n| n > 0.0 && n <= 100.0)
            {
                e.push("threshold_pct: must be an integer from 1 to 100 when present".to_owned());
            }
            if p.contains_key("context_window") && !positive_integer(p.get("context_window")) {
                e.push("context_window: must be a positive integer when present".to_owned());
            }
            if eq_str(p.get("policy"), "threshold") && !p.contains_key("threshold_pct") {
                e.push("threshold_pct: required when policy is `threshold`".to_owned());
            }
            if eq_str(p.get("policy"), "threshold") && !p.contains_key("context_window") {
                e.push("context_window: required when policy is `threshold` — the percentage needs its denominator".to_owned());
            }
            if p.contains_key("max_sessions") && !positive_integer(p.get("max_sessions")) {
                e.push("max_sessions: must be a positive integer when present".to_owned());
            }
            if let Some(surface) = p.get("surface") {
                match surface.as_obj() {
                    None => e.push("surface: must be an object when present".to_owned()),
                    Some(s) => {
                        must(
                            e,
                            str(s.get("permission_mode")),
                            "surface.permission_mode: must be a non-empty string",
                        );
                        must(
                            e,
                            array_of_nonempty_str(s.get("allow")),
                            "surface.allow: must be an array of non-empty strings",
                        );
                        if s.contains_key("deny") && !array_of_nonempty_str(s.get("deny")) {
                            e.push(
                                "surface.deny: must be an array of non-empty strings when present"
                                    .to_owned(),
                            );
                        }
                        if s.contains_key("model") && !str(s.get("model")) {
                            e.push(
                                "surface.model: must be a non-empty string when present".to_owned(),
                            );
                        }
                        if s.contains_key("effort") && !str(s.get("effort")) {
                            e.push(
                                "surface.effort: must be a non-empty string when present"
                                    .to_owned(),
                            );
                        }
                    }
                }
            }
        }
        "handoff" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            must(
                e,
                str(p.get("session_id")),
                "session_id: must be a non-empty string",
            );
            if !one_of(p.get("reason"), &HANDOFF_REASONS) {
                e.push(format!(
                    "reason: must be one of {}",
                    HANDOFF_REASONS.join("|")
                ));
            }
            if p.contains_key("task") && !str(p.get("task")) {
                e.push("task: must be a non-empty string when present".to_owned());
            }
            if p.contains_key("tokens") && !integer(p.get("tokens")).is_some_and(|n| n >= 0.0) {
                e.push("tokens: must be a non-negative integer when present".to_owned());
            }
            if p.contains_key("detail") && !str(p.get("detail")) {
                e.push("detail: must be a non-empty string when present".to_owned());
            }
        }
        "verification_recorded" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            must(e, str(p.get("task")), "task: must be a non-empty string");
            must(
                e,
                integer(p.get("attempt")).is_some_and(|n| n >= 1.0),
                "attempt: must be a positive integer",
            );
            must(
                e,
                str(p.get("command")),
                "command: must be a non-empty string",
            );
            must(e, str(p.get("cwd")), "cwd: must be a non-empty string");
            let checked_ok = p
                .get("checked")
                .and_then(Json::as_obj)
                .is_some_and(|c| str(c.get("head")) && str(c.get("tree")));
            must(
                e,
                checked_ok,
                "checked: must be {head, tree} of non-empty strings",
            );
            must(
                e,
                str(p.get("validator")),
                "validator: must be a non-empty string",
            );
            if !one_of(p.get("result"), &VERIFICATION_RESULTS) {
                e.push(format!(
                    "result: must be one of {}",
                    VERIFICATION_RESULTS.join("|")
                ));
            }
            if p.contains_key("exit_code") && integer(p.get("exit_code")).is_none() {
                e.push("exit_code: must be an integer when present".to_owned());
            }
            must(
                e,
                opt_nonempty_str(p.get("signal")),
                "signal: must be a non-empty string when present",
            );
            must(
                e,
                integer(p.get("duration_ms")).is_some_and(|n| n >= 0.0),
                "duration_ms: must be a non-negative integer",
            );
            must(
                e,
                positive_integer(p.get("timeout_ms")),
                "timeout_ms: must be a positive integer",
            );
            if p.contains_key("diagnostics")
                && p.get("diagnostics")
                    .and_then(Json::as_nonempty_str)
                    .is_none_or(|s| utf16_len(s) > 1024)
            {
                e.push(
                    "diagnostics: must be a non-empty string of at most 1,024 chars when present"
                        .to_owned(),
                );
            }
        }
        "run_stopped" => {
            must(e, str(p.get("run")), "run: must be a non-empty string");
            if !one_of(p.get("reason"), &RUN_STOP_REASONS) {
                e.push(format!(
                    "reason: must be one of {}",
                    RUN_STOP_REASONS.join("|")
                ));
            }
            must(e, opt_str(p.get("note")), "note: must be a string");
            if eq_str(p.get("reason"), "error") && !str(p.get("note")) {
                e.push("note: required when reason is `error` — say what failed".to_owned());
            }
        }
        "run_stop_requested" => must(e, str(p.get("run")), "run: must be a non-empty string"),
        "correction" => {
            must(
                e,
                str(p.get("ref")),
                "ref: must be a non-empty string (target event id)",
            );
            must(e, opt_str(p.get("reason")), "reason: must be a string");
        }
        _ => unreachable!("is_known_event_type checked first"),
    }
}

// --- guard grammar (guards.ts) ----------------------------------------------

pub const GUARD_DOMAINS: [&str; 2] = ["path", "cmd"];
pub const GUARD_MAX_LENGTH: usize = 400;
pub const GUARD_MAX_PATTERNS: usize = 12;

/// Everything wrong with a guard spec, in one pass (`guardSpecErrors`).
#[must_use]
pub fn guard_spec_errors(spec: &Json) -> Vec<String> {
    let Some(spec) = spec.as_nonempty_str() else {
        return vec!["guard: must be a non-empty string".to_owned()];
    };
    if utf16_len(spec) > GUARD_MAX_LENGTH {
        return vec![format!(
            "guard: must be at most {GUARD_MAX_LENGTH} characters"
        )];
    }
    let Some((domain, rest)) = spec.split_once(':') else {
        return vec![format!(
            "guard: must start with a domain — {}",
            GUARD_DOMAINS
                .iter()
                .map(|d| format!("\"{d}:\""))
                .collect::<Vec<_>>()
                .join(" or ")
        )];
    };
    if !GUARD_DOMAINS.contains(&domain) {
        return vec![format!(
            "guard: unknown domain \"{domain}\" — must be {}",
            GUARD_DOMAINS.join(" or ")
        )];
    }
    let mut errors = Vec::new();
    let raw: Vec<&str> = rest.split(',').collect();
    if raw.len() > GUARD_MAX_PATTERNS {
        errors.push(format!("guard: at most {GUARD_MAX_PATTERNS} patterns"));
    }
    let mut positives = 0;
    for entry in raw {
        let trimmed = js_trim(entry);
        let negated = trimmed.starts_with('!');
        let glob = if negated {
            js_trim(&trimmed[1..])
        } else {
            trimmed
        };
        if glob.is_empty() {
            errors.push("guard: empty pattern".to_owned());
            continue;
        }
        if !negated {
            positives += 1;
        }
    }
    if positives == 0 && !errors.iter().any(|m| m == "guard: empty pattern") {
        errors.push("guard: needs at least one pattern that is not an exemption (`!`)".to_owned());
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn check(event_type: &str, payload: &str) -> Vec<String> {
        validate_payload(event_type, &parse(payload).unwrap())
            .err()
            .unwrap_or_default()
    }

    #[test]
    fn unknown_type_and_non_object() {
        assert_eq!(
            check("bogus_event", "{}"),
            ["unknown event type: bogus_event"]
        );
        assert_eq!(
            check("note_added", "[1]"),
            ["payload: must be a JSON object"]
        );
        assert_eq!(
            check("note_added", "null"),
            ["payload: must be a JSON object"]
        );
    }

    #[test]
    fn golden_strings_from_the_conformance_suite() {
        assert_eq!(
            check("decision_logged", "{\"chose\":\"x\"}"),
            [
                "over: must be a non-empty string",
                "because: must be a non-empty string"
            ]
        );
        assert_eq!(
            check("task_status_changed", "{\"status\":\"done\"}"),
            ["id: must be a non-empty string"]
        );
        assert!(check("note_added", "{\"text\":\"after corruption\"}").is_empty());
        assert!(
            check(
                "task_status_changed",
                "{\"id\":\"9.9\",\"status\":\"done\"}"
            )
            .is_empty()
        );
    }

    #[test]
    fn presence_semantics_null_is_present_empty_string_varies() {
        // optStr: an empty note passes; null fails.
        assert!(
            check(
                "task_status_changed",
                "{\"id\":\"1\",\"status\":\"done\",\"note\":\"\"}"
            )
            .is_empty()
        );
        assert_eq!(
            check(
                "task_status_changed",
                "{\"id\":\"1\",\"status\":\"done\",\"note\":null}"
            ),
            ["note: must be a string"]
        );
        // optNonEmptyStr: an empty rule fails.
        assert_eq!(
            check(
                "decision_logged",
                "{\"chose\":\"a\",\"over\":\"b\",\"because\":\"c\",\"rule\":\"\"}"
            ),
            ["rule: must be a non-empty string when present"]
        );
        // Integers: 1.0 is an integer, 1.5 and "1" are not.
        assert!(
            check(
                "handoff",
                "{\"run\":\"r\",\"session_id\":\"s\",\"reason\":\"stall\",\"tokens\":1.0}"
            )
            .is_empty()
        );
        assert_eq!(
            check(
                "handoff",
                "{\"run\":\"r\",\"session_id\":\"s\",\"reason\":\"stall\",\"tokens\":\"1\"}"
            ),
            ["tokens: must be a non-negative integer when present"]
        );
        assert_eq!(
            check(
                "handoff",
                "{\"run\":\"r\",\"session_id\":\"s\",\"reason\":\"nope\",\"tokens\":-1}"
            ),
            [
                "reason: must be one of task_done|threshold|stall|needs_user|verify_failed",
                "tokens: must be a non-negative integer when present",
            ]
        );
    }

    #[test]
    fn conditional_rules() {
        assert_eq!(
            check("initiative_status_changed", "{\"status\":\"dropped\"}"),
            ["note: required when status is \"dropped\" — say why it was abandoned"]
        );
        assert_eq!(
            check(
                "initiative_status_changed",
                "{\"status\":\"superseded\",\"successor\":\"Bad Slug\"}"
            ),
            [
                "successor: required when status is \"superseded\" — the slug the work continues in ([a-z0-9-]+)"
            ]
        );
        assert_eq!(
            check(
                "initiative_status_changed",
                "{\"status\":\"done\",\"successor\":\"x\"}"
            ),
            ["successor: only allowed when status is \"superseded\""]
        );
        assert_eq!(
            check(
                "review_recorded",
                "{\"scope\":\"phase\",\"verdict\":\"findings\",\"findings\":[]}"
            ),
            ["findings: required and non-empty when verdict is `findings`"]
        );
        assert_eq!(
            check(
                "run_started",
                "{\"run\":\"r\",\"adapter\":\"a\",\"policy\":\"threshold\"}"
            ),
            [
                "threshold_pct: required when policy is `threshold`",
                "context_window: required when policy is `threshold` — the percentage needs its denominator",
            ]
        );
        assert_eq!(
            check(
                "run_started",
                "{\"run\":\"r\",\"adapter\":\"a\",\"policy\":\"task\",\"threshold_pct\":101,\"surface\":[]}"
            ),
            [
                "threshold_pct: must be an integer from 1 to 100 when present",
                "surface: must be an object when present",
            ]
        );
        assert_eq!(
            check("run_stopped", "{\"run\":\"r\",\"reason\":\"error\"}"),
            ["note: required when reason is `error` — say what failed"]
        );
        assert_eq!(
            check(
                "memory_promoted",
                "{\"text\":\"t\",\"supersedes\":\"rust-core M0\"}"
            ),
            ["supersedes: must be a qualified memory handle `<slug> M<n>` when present"]
        );
        assert!(
            check(
                "memory_promoted",
                "{\"text\":\"t\",\"supersedes\":\"rust-core M12\"}"
            )
            .is_empty()
        );
        assert!(check("verification_recorded", "{\"run\":\"r\",\"task\":\"1.1\",\"attempt\":1,\"command\":\"npm test\",\"cwd\":\".\",\"checked\":{\"head\":\"h\",\"tree\":\"t\"},\"validator\":\"0.33.0\",\"result\":\"pass\",\"exit_code\":0,\"duration_ms\":1200,\"timeout_ms\":600000}").is_empty());
        let long = "x".repeat(1025);
        assert_eq!(
            check(
                "verification_recorded",
                &format!(
                    "{{\"run\":\"r\",\"task\":\"1.1\",\"attempt\":1,\"command\":\"c\",\"cwd\":\".\",\"checked\":{{\"head\":\"h\",\"tree\":\"t\"}},\"validator\":\"v\",\"result\":\"pass\",\"duration_ms\":0,\"timeout_ms\":1,\"diagnostics\":\"{long}\"}}"
                )
            ),
            ["diagnostics: must be a non-empty string of at most 1,024 chars when present"]
        );
    }

    #[test]
    fn plan_paths_index_every_level() {
        assert_eq!(check("plan_updated", "{}"), ["plan: must be an object"]);
        assert_eq!(
            check("plan_updated", "{\"plan\":{\"goal\":\"\",\"phases\":{}}}"),
            [
                "plan.goal: must be a non-empty string",
                "plan.phases: must be an array"
            ]
        );
        assert_eq!(
            check(
                "plan_updated",
                "{\"plan\":{\"phases\":[1,{\"name\":\"P\",\"status\":\"someday\",\"tasks\":[{\"id\":\"1\",\"title\":\"t\",\"status\":\"wip\",\"route\":{\"agent\":\"\"},\"verify\":{\"cmd\":\"\",\"timeout_ms\":0}},\"x\"]}]}}"
            ),
            [
                "plan.phases[0]: must be an object",
                "plan.phases[1].status: must be one of pending|active|done|blocked|dropped",
                "plan.phases[1].tasks[0].status: must be one of pending|active|done|blocked|dropped",
                "plan.phases[1].tasks[0].route.agent: must be a non-empty string when present",
                "plan.phases[1].tasks[0].verify.cmd: must be a non-empty string",
                "plan.phases[1].tasks[0].verify.timeout_ms: must be a positive integer when present",
                "plan.phases[1].tasks[1]: must be an object",
            ]
        );
    }

    #[test]
    fn guard_grammar() {
        let g = |s: &str| guard_spec_errors(&Json::Str(s.to_owned()));
        assert_eq!(g("path:packages/schema/**"), Vec::<String>::new());
        assert_eq!(
            g("path:**/*.ts,!packages/schema/src/**"),
            Vec::<String>::new()
        );
        assert_eq!(g("cmd:*npm publish*"), Vec::<String>::new());
        assert_eq!(
            g("packages/**"),
            ["guard: must start with a domain — \"path:\" or \"cmd:\""]
        );
        assert_eq!(
            g("file:x"),
            ["guard: unknown domain \"file\" — must be path or cmd"]
        );
        assert_eq!(
            g("path:!a/**"),
            ["guard: needs at least one pattern that is not an exemption (`!`)"]
        );
        assert_eq!(g("path:a,,b"), ["guard: empty pattern"]);
        assert_eq!(g("path: ! "), ["guard: empty pattern"]);
        assert_eq!(g("path:\u{a0}a\u{a0},b"), Vec::<String>::new());
        assert_eq!(
            g(&format!("path:{}", "a,".repeat(12) + "b")),
            ["guard: at most 12 patterns"]
        );
        assert_eq!(
            g(&format!("path:{}", "x".repeat(400))),
            ["guard: must be at most 400 characters"]
        );
        assert_eq!(
            guard_spec_errors(&Json::Null),
            ["guard: must be a non-empty string"]
        );
        assert_eq!(
            check(
                "decision_logged",
                "{\"chose\":\"a\",\"over\":\"b\",\"because\":\"c\",\"guard\":\"path:x\"}"
            ),
            ["guard: requires `rule` — a guard with no clause has nothing to cite"]
        );
    }

    #[test]
    fn every_known_type_has_a_validator() {
        for t in EVENT_TYPES {
            assert!(is_known_event_type(t));
            let _ = check(t, "{}"); // must not panic
        }
        assert!(!check("note_added", "{}").is_empty());
    }
}
