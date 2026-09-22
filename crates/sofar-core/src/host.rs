//! Hook hosts (r1-fixes 6.3–6.6, D34) — the port of `cli/host.ts`: ONE set
//! of shims serves Claude Code and Cursor, and this module is the whole
//! difference. The handlers speak Claude Code's dialect; a Cursor payload
//! (any with a string `cursor_version`) is converted on the way in and the
//! result on the way out; a Claude Code invocation passes straight through.

use crate::cli::Hook;
use crate::fold_cli::CmdResult;
use crate::json::{self, Json, Object, stringify};
use crate::text::{js_trim, utf16_len};

/// Which agent fired a hook — recorded on session registration and diagnostics rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookHost {
    pub tool: &'static str,
    pub version: Option<String>,
}

pub const CLAUDE_CODE: &str = "claude-code";
pub const CURSOR: &str = "cursor";

/// Cursor's per-carrier cap on injected context (UTF-16 units, after trimming).
pub const CURSOR_CONTEXT_MAX: usize = 10_000;

/// `hookHost`: from STDIN only — `cursor_version` is on every Cursor payload.
#[must_use]
pub fn hook_host(hook: &Object) -> HookHost {
    match hook.get("cursor_version").and_then(Json::as_str) {
        None => HookHost {
            tool: CLAUDE_CODE,
            version: None,
        },
        Some(v) => HookHost {
            tool: CURSOR,
            version: if v.is_empty() {
                None
            } else {
                Some(v.to_owned())
            },
        },
    }
}

/// `fromCursor`: a Cursor payload in the field names the handlers read; every
/// original field kept, an alias added only where the Claude name is absent.
#[must_use]
pub fn from_cursor(hook: &Object) -> Object {
    let mut out = hook.clone();
    if hook.get("session_id").and_then(Json::as_str).is_none()
        && let Some(id) = hook.get("conversation_id").and_then(Json::as_str)
    {
        out.insert("session_id", Json::Str(id.to_owned()));
    }
    if hook.get("tool_name").and_then(Json::as_str) == Some("Shell") {
        out.insert("tool_name", Json::Str("Bash".to_owned()));
    }
    if let Some(message) = hook.get("error_message").and_then(Json::as_str)
        && hook.get("error").is_none()
    {
        out.insert("error", Json::Str(message.to_owned()));
    }
    if let Some(output) = hook.get("tool_output").and_then(Json::as_str)
        && hook.get("tool_response").is_none()
    {
        let mut response = Object::with_capacity(1);
        response.insert("stdout", Json::Str(output.to_owned()));
        out.insert("tool_response", Json::Obj(response));
    }
    if let Some(Json::Num(count)) = hook.get("loop_count")
        && hook.get("stop_hook_active").is_none()
    {
        out.insert("stop_hook_active", Json::Bool(*count > 0.0));
    }
    out
}

/// `contextOf`: the context a handler's stdout carries.
fn context_of(name: Hook, stdout: &str) -> Option<String> {
    let text = js_trim(stdout);
    if text.is_empty() {
        return None;
    }
    if name != Hook::PostTool {
        return Some(text.to_owned());
    }
    let Json::Obj(decoded) = json::parse(text).ok()? else {
        return None;
    };
    let context = decoded
        .get("hookSpecificOutput")
        .and_then(Json::as_obj)?
        .get("additionalContext")
        .and_then(Json::as_str)?;
    if js_trim(context).is_empty() {
        None
    } else {
        Some(context.to_owned())
    }
}

fn json_line(key: &str, value: &str) -> String {
    let mut o = Object::with_capacity(1);
    o.insert(key, Json::Str(value.to_owned()));
    format!("{}\n", stringify(&Json::Obj(o)))
}

/// `toCursor`: a handler's Claude Code result, as Cursor reads it.
#[must_use]
pub fn to_cursor(name: Hook, result: CmdResult) -> CmdResult {
    if name == Hook::Stop {
        if result.exit_code != 2 {
            return result;
        }
        let message = js_trim(&result.stderr);
        return CmdResult {
            exit_code: 0,
            stdout: if message.is_empty() {
                String::new()
            } else {
                json_line("followup_message", message)
            },
            stderr: String::new(),
        };
    }
    let Some(context) = context_of(name, &result.stdout) else {
        return CmdResult {
            stdout: String::new(),
            ..result
        };
    };
    let clipped = if name == Hook::SessionStart || utf16_len(&context) <= CURSOR_CONTEXT_MAX {
        context
    } else {
        let head: String = char::decode_utf16(context.encode_utf16().take(CURSOR_CONTEXT_MAX - 1))
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        format!("{head}…")
    };
    CmdResult {
        stdout: json_line("additional_context", &clipped),
        ..result
    }
}

/// `forHost`: serve a handler to whichever host fired it.
pub fn for_host(name: Hook, input: &str, handler: impl Fn(&str) -> CmdResult) -> CmdResult {
    if !input.contains("\"cursor_version\"") {
        return handler(input);
    }
    let Ok(Json::Obj(hook)) = json::parse(input) else {
        return handler(input);
    };
    if hook_host(&hook).tool != CURSOR {
        return handler(input);
    }
    to_cursor(name, handler(&stringify(&Json::Obj(from_cursor(&hook)))))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(text: &str) -> Object {
        match json::parse(text).unwrap() {
            Json::Obj(o) => o,
            _ => panic!("object"),
        }
    }

    #[test]
    fn cursor_payloads_are_aliased_never_overwritten() {
        let hook = obj(
            r#"{"cursor_version":"2026.09.10","conversation_id":"c1","tool_name":"Shell","error_message":"boom","tool_output":"out","loop_count":1}"#,
        );
        assert_eq!(hook_host(&hook).tool, CURSOR);
        let out = from_cursor(&hook);
        assert_eq!(out.get("session_id").and_then(Json::as_str), Some("c1"));
        assert_eq!(out.get("tool_name").and_then(Json::as_str), Some("Bash"));
        assert_eq!(out.get("error").and_then(Json::as_str), Some("boom"));
        assert_eq!(out.get("stop_hook_active"), Some(&Json::Bool(true)));
        assert_eq!(
            stringify(&Json::Obj(out)),
            r#"{"cursor_version":"2026.09.10","conversation_id":"c1","tool_name":"Bash","error_message":"boom","tool_output":"out","loop_count":1,"session_id":"c1","error":"boom","tool_response":{"stdout":"out"},"stop_hook_active":true}"#
        );
        assert_eq!(hook_host(&obj(r#"{"session_id":"s"}"#)).tool, CLAUDE_CODE);
    }

    #[test]
    fn results_speak_cursor() {
        let stop = CmdResult {
            exit_code: 2,
            stdout: String::new(),
            stderr: "write back\n".into(),
        };
        assert_eq!(
            to_cursor(Hook::Stop, stop).stdout,
            "{\"followup_message\":\"write back\"}\n"
        );
        let post = CmdResult { exit_code: 0, stdout: "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"ctx\"}}\n".into(), stderr: String::new() };
        assert_eq!(
            to_cursor(Hook::PostTool, post).stdout,
            "{\"additional_context\":\"ctx\"}\n"
        );
        let empty = CmdResult {
            exit_code: 0,
            stdout: "  \n".into(),
            stderr: String::new(),
        };
        assert_eq!(to_cursor(Hook::UserPrompt, empty).stdout, "");
        let claude = for_host(Hook::Stop, "{\"session_id\":\"s\"}", |i| CmdResult {
            exit_code: 2,
            stdout: i.to_owned(),
            stderr: String::new(),
        });
        assert_eq!(claude.exit_code, 2);
    }
}
