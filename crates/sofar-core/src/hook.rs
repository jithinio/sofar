//! Hook input (`docs/HOTPATH.md` §Hook input): Claude Code's JSON on stdin,
//! parsed defensively — unparseable or non-object is `{}`, and a field counts
//! only when it is a NON-EMPTY string (`strField`).

use std::io::{IsTerminal as _, Read as _};

use crate::json::{self, Json, Object};

/// `parseHook`.
#[must_use]
pub fn parse_hook(input: &str) -> Object {
    match json::parse(input) {
        Ok(Json::Obj(o)) => o,
        _ => Object::new(),
    }
}

/// `strField`: the field when it is a non-empty string.
#[must_use]
pub fn str_field<'a>(hook: &'a Object, key: &str) -> Option<&'a str> {
    hook.get(key).and_then(Json::as_nonempty_str)
}

/// stdin to EOF as UTF-8; a TTY reads as empty (`readStdin` in cli/fast.ts).
#[must_use]
pub fn read_stdin() -> String {
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return String::new();
    }
    let mut bytes = Vec::new();
    let _ = stdin.lock().read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `clipTo` (cli/event.ts): a hard UTF-16 cap with the ellipsis inside it, no
/// whitespace normalisation.
#[must_use]
pub fn clip_to(text: &str, max: usize) -> String {
    if crate::text::utf16_len(text) <= max {
        return text.to_owned();
    }
    format!(
        "{}…",
        crate::text::utf16_prefix(text, max.saturating_sub(1))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_fields_are_non_empty_strings_only() {
        let h = parse_hook(r#"{"session_id":"","source":"resume","n":1}"#);
        assert_eq!(str_field(&h, "session_id"), None);
        assert_eq!(str_field(&h, "source"), Some("resume"));
        assert_eq!(str_field(&h, "n"), None);
        assert!(parse_hook("[1,2]").is_empty());
        assert!(parse_hook("not json").is_empty());
    }
}
