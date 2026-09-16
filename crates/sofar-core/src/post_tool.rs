//! `sofar-core event post-tool` and `post-tool-failure` (rust-core 2.5):
//! `handlePostTool` / `handlePostToolFailure` in `cli/event.ts`,
//! `docs/HOTPATH.md` §post-tool. Exit 0 always; stdout is the nudge and guard
//! lines as ONE `hookSpecificOutput` JSON line, or nothing.

use std::path::Path;

use crate::append::{append_and_project, ensure_lane, register_lazily};
use crate::diagnostics::{RowInput, record_diagnostic};
use crate::fold_cli::CmdResult;
use crate::guards::GuardDomain;
use crate::home::resolve_session_first;
use crate::hook::{clip_to, parse_hook, str_field};
use crate::index_tier1::{
    GuardedDecision, guards_for_subject, last_touch, refresh_files, refresh_guards,
};
use crate::json::{self, Json, Object};
use crate::layout::Layout;
use crate::nudge::{nudge_line, read_nudge};
use crate::redact::redact_command;
use crate::resolve::posix_relative;
use crate::shell::is_self_recording_command;
use crate::text::{cmp_utf16, is_js_whitespace, js_trim, utf16_len, utf16_prefix};

const HOOK_TOOL: &str = "claude-code";
pub const GUARD_RULES_MAX: usize = 2;
pub const GUARD_CMD_BUDGET: usize = 60;
/// Bound on a command's leading token as stored in `head` (`DIAGNOSTIC_HEAD_CLIP`).
pub const DIAGNOSTIC_HEAD_CLIP: usize = 64;
/// Bound on stored error text (`DIAGNOSTIC_ERROR_CLIP`).
pub const DIAGNOSTIC_ERROR_CLIP: usize = 512;

fn ok(stdout: String) -> CmdResult {
    CmdResult {
        exit_code: 0,
        stdout,
        stderr: String::new(),
    }
}

fn silent() -> CmdResult {
    ok(String::new())
}

/// `clipDiagnosticText`: a marked clip to `max` code units.
#[must_use]
pub fn clip_diagnostic_text(text: &str, max: usize) -> String {
    if utf16_len(text) <= max {
        return text.to_owned();
    }
    let marker = "…[clipped]";
    format!(
        "{}{marker}",
        utf16_prefix(text, max.saturating_sub(utf16_len(marker)))
    )
}

/// `postToolContext`: the one JSON line Claude Code reads as additional context.
#[must_use]
pub fn post_tool_context(lines: &[String]) -> String {
    let mut inner = Object::with_capacity(2);
    inner.insert("hookEventName", Json::Str("PostToolUse".to_owned()));
    inner.insert("additionalContext", Json::Str(lines.join("\n")));
    let mut o = Object::with_capacity(1);
    o.insert("hookSpecificOutput", Json::Obj(inner));
    format!("{}\n", json::stringify(&Json::Obj(o)))
}

/// What a tool call is to the record (`ClassifiedCall`).
#[derive(Debug, Clone, PartialEq)]
pub struct ClassifiedCall {
    pub tool_name: String,
    pub event_type: &'static str,
    /// The mechanical payload WITHOUT outcome fields.
    pub payload: Object,
    pub domain: GuardDomain,
    pub subject: String,
    pub exempt: bool,
    pub head: Option<String>,
}

/// `classifyToolCall`.
#[must_use]
pub fn classify_tool_call(hook: &Object) -> Option<ClassifiedCall> {
    let tool_name = str_field(hook, "tool_name")?;
    let empty = Object::new();
    let tool_input = hook
        .get("tool_input")
        .and_then(Json::as_obj)
        .unwrap_or(&empty);
    match tool_name {
        "Edit" | "MultiEdit" | "Write" => {
            let path = str_field(tool_input, "file_path")?;
            let mut payload = Object::with_capacity(2);
            payload.insert("path", Json::Str(path.to_owned()));
            payload.insert(
                "op",
                Json::Str(
                    if tool_name == "Write" {
                        "write"
                    } else {
                        "edit"
                    }
                    .to_owned(),
                ),
            );
            Some(ClassifiedCall {
                tool_name: tool_name.to_owned(),
                event_type: "file_touched",
                payload,
                domain: GuardDomain::Path,
                subject: path.to_owned(),
                exempt: false,
                head: None,
            })
        }
        "Bash" => {
            let cmd = str_field(tool_input, "command")?;
            let redacted = redact_command(cmd);
            let head = cmd
                .trim_start_matches(is_js_whitespace)
                .split(is_js_whitespace)
                .next()
                .unwrap_or("");
            let mut payload = Object::with_capacity(1);
            payload.insert("cmd", Json::Str(redacted.clone()));
            Some(ClassifiedCall {
                tool_name: tool_name.to_owned(),
                event_type: "command_run",
                payload,
                domain: GuardDomain::Cmd,
                subject: redacted,
                exempt: is_self_recording_command(cmd),
                head: (!head.is_empty()).then(|| utf16_prefix(head, DIAGNOSTIC_HEAD_CLIP)),
            })
        }
        _ => None,
    }
}

/// `renderSubject`: a path relative to the root when it is inside it, a
/// command clipped to its budget.
#[must_use]
pub fn render_subject(domain: GuardDomain, subject: &str, root: &Path) -> String {
    match domain {
        GuardDomain::Cmd => clip_to(subject, GUARD_CMD_BUDGET),
        GuardDomain::Path => {
            let rel = posix_relative(&root.to_string_lossy(), subject);
            if !rel.is_empty() && !rel.starts_with("..") {
                rel
            } else {
                subject.to_owned()
            }
        }
    }
}

/// `guardNoticeLines`: this record's rules last, ≤2 rules, the rest counted.
#[must_use]
pub fn guard_notice_lines(
    hits: &[&GuardedDecision],
    domain: GuardDomain,
    subject: &str,
    slug: &str,
    root: &Path,
) -> Vec<String> {
    if hits.is_empty() {
        return Vec::new();
    }
    let mut ordered: Vec<&GuardedDecision> = hits.to_vec();
    ordered.sort_by(|a, b| {
        let a_mine = a.initiative == slug;
        let b_mine = b.initiative == slug;
        if a_mine != b_mine {
            return if a_mine {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            };
        }
        if a.initiative == b.initiative {
            a.ordinal
                .partial_cmp(&b.ordinal)
                .unwrap_or(std::cmp::Ordering::Equal)
        } else {
            cmp_utf16(&a.initiative, &b.initiative)
        }
    });
    let rendered = render_subject(domain, subject, root);
    let mut lines: Vec<String> = ordered
        .iter()
        .take(GUARD_RULES_MAX)
        .map(|d| {
            let ordinal = json::number_to_string(d.ordinal);
            let handle = if d.initiative == slug {
                format!("D{ordinal}")
            } else {
                format!("{} D{ordinal}", d.initiative)
            };
            format!(
                "sofar: [{handle}] standing rule guards {rendered} — \"{}\" (guard: {}) — obey it verbatim, or log a decision that supersedes it.",
                d.rule, d.guard
            )
        })
        .collect();
    let dropped = &ordered[ordered.len().min(GUARD_RULES_MAX)..];
    if !dropped.is_empty() {
        let mut wheres: Vec<&str> = Vec::new();
        for d in dropped {
            if !wheres.contains(&d.initiative.as_str()) {
                wheres.push(&d.initiative);
            }
        }
        lines.push(format!(
            "sofar: …and {} more standing rule(s) guard this, in {} — read their decisions.md.",
            dropped.len(),
            wheres.join(", ")
        ));
    }
    lines
}

/// `guardNotice`: computed BEFORE the append.
fn guard_notice(
    layout: &Layout,
    slug: &str,
    session: &str,
    domain: GuardDomain,
    subject: &str,
) -> Vec<String> {
    let declared = refresh_guards(layout);
    if declared.guards.is_empty() {
        return Vec::new();
    }
    let mut hits = guards_for_subject(&declared, domain, subject);
    if hits.is_empty() {
        return Vec::new();
    }
    if domain == GuardDomain::Path
        && session != "cli"
        && let Some(since) = last_touch(&refresh_files(layout), subject, session)
    {
        hits.retain(|d| cmp_utf16(&d.ts, &since).is_gt());
    }
    guard_notice_lines(&hits, domain, subject, slug, &layout.root)
}

fn resolve_bound(layout: &Layout, session: &str) -> Option<String> {
    resolve_session_first(layout, Some(session)).map(|(slug, _)| slug)
}

fn bound_or_lane(layout: &Layout, session: &str) -> Option<String> {
    match resolve_bound(layout, session) {
        Some(slug) => Some(slug),
        None if ensure_lane(layout) => resolve_bound(layout, session),
        None => None,
    }
}

/// `handlePostTool`.
#[must_use]
pub fn handle_post_tool(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let hook = parse_hook(input);
    let session = str_field(&hook, "session_id").unwrap_or("cli");
    let driven: Vec<String> = read_nudge()
        .map(|n| vec![nudge_line(&n)])
        .unwrap_or_default();
    let injected = |lines: Vec<String>| {
        if lines.is_empty() {
            silent()
        } else {
            ok(post_tool_context(&lines))
        }
    };
    let Some(slug) = bound_or_lane(&layout, session) else {
        return injected(driven);
    };
    let Some(call) = classify_tool_call(&hook) else {
        return injected(driven);
    };
    let response = hook.get("tool_response").and_then(Json::as_obj);
    let interrupted = response.is_some_and(|r| {
        r.get("interrupted").is_some_and(Json::is_true)
            || r.get("timed_out").is_some_and(Json::is_true)
    });
    let exit = response
        .and_then(|r| r.get("exit_code"))
        .and_then(Json::as_f64);
    let is_ok = !interrupted;
    let mut payload = call.payload.clone();
    payload.insert("ok", Json::Bool(is_ok));
    if call.event_type == "command_run"
        && let Some(code) = exit
    {
        payload.insert("exit", Json::Num(code));
    }
    let notice = guard_notice(&layout, &slug, session, call.domain, &call.subject);
    if !call.exempt {
        register_lazily(&layout, &slug, session);
        let _ = append_and_project(&layout, &slug, call.event_type, payload, session, "hook");
    }
    let out_bytes = response.map(|r| {
        let len = |key: &str| r.get(key).and_then(Json::as_str).map_or(0, utf16_len);
        len("stdout") + len("stderr")
    });
    let mut data = Object::with_capacity(7);
    data.insert("tool", Json::Str(call.tool_name.clone()));
    data.insert("ok", Json::Bool(is_ok));
    data.insert("exit", exit.map_or(Json::Null, Json::Num));
    if let Some(head) = &call.head {
        data.insert("head", Json::Str(head.clone()));
    }
    if call.exempt {
        data.insert("exempt", Json::Bool(true));
    }
    if interrupted {
        data.insert("interrupted", Json::Bool(true));
    }
    if let Some(n) = out_bytes {
        #[allow(clippy::cast_precision_loss, reason = "output sizes are small")]
        data.insert("out_bytes", Json::Num(n as f64));
    }
    let _ = record_diagnostic(
        root,
        &RowInput {
            kind: "tool_outcome",
            data,
            initiative: Some(slug),
            session: Some(session.to_owned()),
            host_tool: Some(HOOK_TOOL.to_owned()),
        },
    );
    let mut lines = driven;
    lines.extend(notice);
    injected(lines)
}

/// `handlePostToolFailure` (r1-fixes 2.5 / self-improve 1.2).
#[must_use]
pub fn handle_post_tool_failure(root: &Path, input: &str) -> CmdResult {
    let layout = Layout::new(root);
    let hook = parse_hook(input);
    let session = str_field(&hook, "session_id").unwrap_or("cli");
    let Some(slug) = bound_or_lane(&layout, session) else {
        return silent();
    };
    let Some(call) = classify_tool_call(&hook) else {
        return silent();
    };
    let exit = hook.get("exit_code").and_then(Json::as_f64);
    let interrupt = match hook.get("is_interrupt") {
        Some(Json::Bool(b)) => Json::Bool(*b),
        _ => Json::Null,
    };
    if !call.exempt {
        register_lazily(&layout, &slug, session);
        let mut payload = call.payload.clone();
        payload.insert("ok", Json::Bool(false));
        if call.event_type == "command_run"
            && let Some(code) = exit
        {
            payload.insert("exit", Json::Num(code));
        }
        let _ = append_and_project(&layout, &slug, call.event_type, payload, session, "hook");
    }
    let stderr = hook
        .get("stderr")
        .and_then(Json::as_str)
        .map_or("", js_trim);
    let summary = hook.get("error").and_then(Json::as_str).map_or("", js_trim);
    let text = if stderr.is_empty() {
        summary.to_owned()
    } else if summary.is_empty() {
        stderr.to_owned()
    } else {
        format!("{summary}\n{stderr}")
    };
    let mut data = Object::with_capacity(5);
    data.insert("tool", Json::Str(call.tool_name.clone()));
    if let Some(head) = &call.head {
        data.insert("head", Json::Str(head.clone()));
    }
    if call.exempt {
        data.insert("exempt", Json::Bool(true));
    }
    data.insert(
        "error",
        Json::Str(clip_diagnostic_text(
            &redact_command(&text),
            DIAGNOSTIC_ERROR_CLIP,
        )),
    );
    data.insert("interrupt", interrupt);
    let _ = record_diagnostic(
        root,
        &RowInput {
            kind: "tool_failure",
            data,
            initiative: Some(slug),
            session: Some(session.to_owned()),
            host_tool: Some(HOOK_TOOL.to_owned()),
        },
    );
    silent()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification_follows_the_contract() {
        let hook = parse_hook(r#"{"tool_name":"Write","tool_input":{"file_path":"/r/a.ts"}}"#);
        let call = classify_tool_call(&hook).unwrap();
        assert_eq!(call.event_type, "file_touched");
        assert_eq!(call.payload.get("op"), Some(&Json::Str("write".into())));
        let hook =
            parse_hook(r#"{"tool_name":"Bash","tool_input":{"command":"  GH_TOKEN=x git push"}}"#);
        let call = classify_tool_call(&hook).unwrap();
        assert_eq!(call.subject, "  GH_TOKEN=[redacted] git push");
        assert!(call.exempt, "an env prefix on git is still self-recording");
        assert_eq!(call.head.as_deref(), Some("GH_TOKEN=x"));
        assert!(
            classify_tool_call(&parse_hook(r#"{"tool_name":"Read","tool_input":{}}"#)).is_none()
        );
        assert_eq!(
            post_tool_context(&["a".into(), "b\"c".into()]),
            "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"a\\nb\\\"c\"}}\n"
        );
        assert_eq!(clip_diagnostic_text("abcdef", 4), "…[clipped]".to_owned());
    }
}
