//! File mentions (`core/file-mentions.ts`, memory-lead 2.1, D6): which files a
//! decision's own text names — the derived half of a decision's scope, where
//! a `path:` guard is the declared half. A mention says a decision NAMES a
//! file, never that it governs it (record-index D2).
//!
//! The TypeScript regexes are ASCII classes in non-unicode mode (`\w` is
//! `[A-Za-z0-9_]`, `\d` is `[0-9]`), so they port as byte tests; `\s` is the
//! JavaScript whitespace class (HOTPATH §Text-semantics pins).

use crate::text::is_js_whitespace;

/// `SPLIT_RE`: whitespace, backticks, quotes, brackets, commas, semicolons.
fn is_split(c: char) -> bool {
    is_js_whitespace(c)
        || matches!(
            c,
            '`' | '"'
                | '\u{201C}'
                | '\u{201D}'
                | '\u{2018}'
                | '\u{2019}'
                | '\''
                | '('
                | ')'
                | ','
                | ';'
                | '<'
                | '>'
                | '['
                | ']'
                | '{'
                | '}'
                | '|'
        )
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `[\w-]+` (at least `min` long).
fn word_run(s: &str, min: usize) -> bool {
    s.len() >= min && s.chars().all(|c| is_word(c) || c == '-')
}

/// `[A-Za-z][A-Za-z0-9]{0,4}`.
fn extension(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && s.len() <= 5
        && chars.all(|c| c.is_ascii_alphanumeric())
}

/// `FILE_SEGMENT_RE` (`first_min` 2) and `PATHED_FILE_SEGMENT_RE` (1):
/// `[\w-]{min,}(?:\.[\w-]+)*\.ext`, or a dotfile `\.[\w-][\w.-]*`.
fn file_segment(s: &str, first_min: usize) -> bool {
    if let Some(rest) = s.strip_prefix('.') {
        let mut chars = rest.chars();
        return chars.next().is_some_and(|c| is_word(c) || c == '-')
            && chars.all(|c| is_word(c) || c == '.' || c == '-');
    }
    let parts: Vec<&str> = s.split('.').collect();
    let Some((last, init)) = parts.split_last() else {
        return false;
    };
    !init.is_empty()
        && word_run(init[0], first_min)
        && init[1..].iter().all(|p| word_run(p, 1))
        && extension(last)
}

/// `PATH_SEGMENT_RE`: `^[\w.@+-]+$`.
fn path_segment(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| is_word(c) || matches!(c, '.' | '@' | '+' | '-'))
}

/// `TRAILING_PUNCT_RE`: `/[.:!?]+$/` replaced by nothing.
fn strip_trailing_punct(s: &str) -> &str {
    s.trim_end_matches(['.', ':', '!', '?'])
}

/// `^\d+`: the length of a leading ASCII digit run.
fn digits(s: &str) -> usize {
    s.bytes().take_while(u8::is_ascii_digit).count()
}

/// Whether `s` is wholly `:\d+(?::\d+)?` or `#L\d+(?:-L?\d+)?`.
fn is_location(s: &str) -> bool {
    if let Some(rest) = s.strip_prefix(':') {
        let n = digits(rest);
        if n == 0 {
            return false;
        }
        let rest = &rest[n..];
        return rest.is_empty()
            || rest
                .strip_prefix(':')
                .is_some_and(|r| !r.is_empty() && digits(r) == r.len());
    }
    let Some(rest) = s.strip_prefix("#L") else {
        return false;
    };
    let n = digits(rest);
    if n == 0 {
        return false;
    }
    let rest = &rest[n..];
    if rest.is_empty() {
        return true;
    }
    let Some(rest) = rest.strip_prefix('-') else {
        return false;
    };
    let rest = rest.strip_prefix('L').unwrap_or(rest);
    !rest.is_empty() && digits(rest) == rest.len()
}

/// `LOCATION_RE` replaced by nothing: the leftmost start whose suffix is
/// wholly a location, as a JavaScript search anchored at `$` finds it.
fn strip_location(s: &str) -> &str {
    for (i, c) in s.char_indices() {
        if (c == ':' || c == '#') && is_location(&s[i..]) {
            return &s[..i];
        }
    }
    s
}

/// `fileToken`.
fn file_token(raw: &str) -> Option<&str> {
    let mut token = strip_trailing_punct(strip_location(strip_trailing_punct(raw)));
    let pathed = token.contains('/');
    if let Some(rest) = token.strip_prefix("./") {
        token = rest;
    }
    if token.is_empty()
        || token.contains("://")
        || token.contains(['*', '?', '$'])
        || token.starts_with('~')
    {
        return None;
    }
    let segments: Vec<&str> = token
        .strip_prefix('/')
        .unwrap_or(token)
        .split('/')
        .collect();
    let last = segments.last().copied().unwrap_or("");
    if !file_segment(last, if pathed { 1 } else { 2 }) {
        return None;
    }
    segments.iter().all(|s| path_segment(s)).then_some(token)
}

/// `fileMentions`: the file tokens of `text`, in order, deduplicated.
#[must_use]
pub fn file_mentions(text: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for raw in text.split(is_split) {
        if let Some(token) = file_token(raw)
            && !found.iter().any(|f| f == token)
        {
            found.push(token.to_owned());
        }
    }
    found
}

/// `mentionDepth`: how many path segments of `path` the token names — it IS
/// the path or its tail at a `/` boundary — or 0 when it names none of it.
#[must_use]
pub fn mention_depth(token: &str, path: &str) -> usize {
    let tail = if token.starts_with('/') {
        token.to_owned()
    } else {
        format!("/{token}")
    };
    if path != token && !path.ends_with(&tail) {
        return 0;
    }
    token.split('/').filter(|s| !s.is_empty()).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_as_the_typescript_extractor_finds_them() {
        assert_eq!(
            file_mentions(
                "edit `src/core/fold.ts:42` and README.md, not e.g. or Node.js; see ./a.ts#L10-L12 and .mcp.json"
            ),
            [
                "src/core/fold.ts",
                "README.md",
                "Node.js",
                "a.ts",
                ".mcp.json"
            ]
        );
        assert_eq!(
            file_mentions("a/b/ src/*.ts ~/x.ts http://x.io/a.ts x.toolongext"),
            Vec::<String>::new()
        );
        assert_eq!(file_mentions("a:1:2:3.ts"), Vec::<String>::new());
        assert_eq!(file_mentions("docs/SPEC.md."), ["docs/SPEC.md"]);
    }

    #[test]
    fn depth_counts_the_named_tail() {
        assert_eq!(mention_depth("core/fold.ts", "/repo/src/core/fold.ts"), 2);
        assert_eq!(mention_depth("fold.ts", "/repo/src/core/fold.ts"), 1);
        assert_eq!(mention_depth("old.ts", "/repo/src/core/fold.ts"), 0);
    }
}
