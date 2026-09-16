//! Secret redaction for recorded command text (`core/redact.ts`,
//! security-hardening 3.1), ported as hand-written scanners for the five
//! JavaScript regexes — JS NON-unicode semantics throughout (P3): `\b` and
//! `\w` are ASCII, `\s`/`\S` use the P2 whitespace set, the `i` flag folds
//! ASCII only. Proved against `tests/fixtures/js-redact.json`, generated from
//! the engine's own regexes.

use crate::text::is_js_whitespace;

pub const REDACTED: &str = "[redacted]";

const SECRET_WORDS: [&str; 13] = [
    "TOKEN",
    "SECRET",
    "PASSWD",
    "PASSWORD",
    "API_KEY",
    "PRIVATE_KEY",
    "ACCESS_KEY",
    "CREDENTIAL",
    "AUTH",
    "OTP",
    "SESSION",
    "COOKIE",
    "BEARER",
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_name(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `\b` at `i` (ASCII word characters).
fn boundary(s: &[char], i: usize) -> bool {
    let before = i > 0 && is_word(s[i - 1]);
    let after = i < s.len() && is_word(s[i]);
    before != after
}

fn eq_fold(c: char, lower: u8) -> bool {
    c.is_ascii() && (c as u8).eq_ignore_ascii_case(&lower)
}

fn starts_with_fold(s: &[char], at: usize, word: &str) -> bool {
    let w = word.as_bytes();
    at + w.len() <= s.len() && w.iter().enumerate().all(|(k, b)| eq_fold(s[at + k], *b))
}

/// Does the name run `s[from..to]` contain one of the secret words, with
/// `API[_-]?KEY`-style words allowing `_`, `-` or nothing between the halves?
fn contains_secret_word(s: &[char], from: usize, to: usize) -> bool {
    for start in from..to {
        for word in SECRET_WORDS {
            if let Some((a, b)) = word.split_once('_') {
                if !starts_with_fold(s, start, a) {
                    continue;
                }
                let mut j = start + a.len();
                if j < to && (s[j] == '_' || s[j] == '-') {
                    j += 1;
                }
                if j + b.len() <= to && starts_with_fold(s, j, b) {
                    return true;
                }
                // The separator is optional: retry without it when we skipped one.
                let j0 = start + a.len();
                if j0 + b.len() <= to && starts_with_fold(s, j0, b) {
                    return true;
                }
            } else if start + word.len() <= to && starts_with_fold(s, start, word) {
                return true;
            }
        }
    }
    false
}

/// `(?:"[^"]*"|'[^']*'|\S+)` at `i`: the end of the value, or None.
fn value_end(s: &[char], i: usize) -> Option<usize> {
    if i >= s.len() {
        return None;
    }
    for quote in ['"', '\''] {
        if s[i] == quote
            && let Some(rel) = s[i + 1..].iter().position(|c| *c == quote)
        {
            return Some(i + 1 + rel + 1);
        }
    }
    let mut j = i;
    while j < s.len() && !is_js_whitespace(s[j]) {
        j += 1;
    }
    (j > i).then_some(j)
}

fn name_run_end(s: &[char], i: usize) -> usize {
    let mut j = i;
    while j < s.len() && is_name(s[j]) {
        j += 1;
    }
    j
}

fn ws_run_end(s: &[char], i: usize) -> usize {
    let mut j = i;
    while j < s.len() && is_js_whitespace(s[j]) {
        j += 1;
    }
    j
}

/// One global replace: `matcher(s, i)` returns `(end, replacement)` for a
/// match starting at `i`, or None.
fn replace_all(
    s: &[char],
    matcher: impl Fn(&[char], usize) -> Option<(usize, String)>,
) -> Vec<char> {
    let mut out: Vec<char> = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if let Some((end, replacement)) = matcher(s, i)
            && end > i
        {
            out.extend(replacement.chars());
            i = end;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    out
}

/// Rule 1: `\b(NAME)=VALUE` → `$1=[redacted]`.
fn rule_assignment(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) || !is_name(s[i]) {
        return None;
    }
    let name_end = name_run_end(s, i);
    if s.get(name_end) != Some(&'=') || !contains_secret_word(s, i, name_end) {
        return None;
    }
    let end = value_end(s, name_end + 1)?;
    let name: String = s[i..name_end].iter().collect();
    Some((end, format!("{name}={REDACTED}")))
}

/// Rule 2: `(--?NAME)(=|\s+)VALUE` → `$1$2[redacted]`.
fn rule_flag(s: &[char], i: usize) -> Option<(usize, String)> {
    if s[i] != '-' {
        return None;
    }
    let dashes = if s.get(i + 1) == Some(&'-') { 2 } else { 1 };
    let name_start = i + dashes;
    let name_end = name_run_end(s, name_start);
    if name_end == name_start || !contains_secret_word(s, name_start, name_end) {
        return None;
    }
    let (sep_end, sep) = match s.get(name_end) {
        Some('=') => (name_end + 1, "=".to_owned()),
        Some(c) if is_js_whitespace(*c) => {
            let e = ws_run_end(s, name_end);
            (e, s[name_end..e].iter().collect())
        }
        _ => return None,
    };
    let end = value_end(s, sep_end)?;
    let flag: String = s[i..name_end].iter().collect();
    Some((end, format!("{flag}{sep}{REDACTED}")))
}

/// Rule 3: `\b((?:proxy-)?authorization\s*:\s*)(?:(scheme)\s+)?VALUE` → `$1$2 [redacted]`.
fn rule_header(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) {
        return None;
    }
    let mut j = i;
    if starts_with_fold(s, j, "proxy-authorization") {
        j += "proxy-authorization".len();
    } else if starts_with_fold(s, j, "authorization") {
        j += "authorization".len();
    } else {
        return None;
    }
    j = ws_run_end(s, j);
    if s.get(j) != Some(&':') {
        return None;
    }
    j = ws_run_end(s, j + 1);
    let group1: String = s[i..j].iter().collect();
    for scheme in ["bearer", "basic", "token", "digest"] {
        if starts_with_fold(s, j, scheme) {
            let after = j + scheme.len();
            let ws = ws_run_end(s, after);
            if ws > after
                && let Some(end) = value_end(s, ws)
            {
                let scheme_text: String = s[j..after].iter().collect();
                return Some((end, format!("{group1}{scheme_text} {REDACTED}")));
            }
        }
    }
    let end = value_end(s, j)?;
    Some((end, format!("{group1} {REDACTED}")))
}

/// Rule 4: `\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@` → `$1:[redacted]@`.
fn rule_url(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) || !s[i].is_ascii_alphabetic() {
        return None;
    }
    let mut j = i + 1;
    while j < s.len() && (s[j].is_ascii_alphanumeric() || matches!(s[j], '+' | '.' | '-')) {
        j += 1;
    }
    if !(s.get(j) == Some(&':') && s.get(j + 1) == Some(&'/') && s.get(j + 2) == Some(&'/')) {
        return None;
    }
    let user_start = j + 3;
    let mut k = user_start;
    while k < s.len() && !is_js_whitespace(s[k]) && !matches!(s[k], ':' | '/' | '@') {
        k += 1;
    }
    if k == user_start || s.get(k) != Some(&':') {
        return None;
    }
    let pw_start = k + 1;
    let mut m = pw_start;
    while m < s.len() && !is_js_whitespace(s[m]) && !matches!(s[m], '@' | '/') {
        m += 1;
    }
    if m == pw_start || s.get(m) != Some(&'@') {
        return None;
    }
    let group1: String = s[i..k].iter().collect();
    Some((m + 1, format!("{group1}:{REDACTED}@")))
}

fn run_len(s: &[char], from: usize, class: impl Fn(char) -> bool) -> usize {
    let mut j = from;
    while j < s.len() && class(s[j]) {
        j += 1;
    }
    j - from
}

fn lit(s: &[char], at: usize, text: &str) -> bool {
    let t: Vec<char> = text.chars().collect();
    at + t.len() <= s.len() && s[at..at + t.len()] == t[..]
}

/// Rule 5: bare token shapes (case-sensitive) → `[redacted]`.
fn rule_token(s: &[char], i: usize) -> Option<(usize, String)> {
    if !boundary(s, i) {
        return None;
    }
    let b64 = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let alnum = |c: char| c.is_ascii_alphanumeric();
    let end = if lit(s, i, "sk-") {
        let n = run_len(s, i + 3, b64);
        (n >= 16).then_some(i + 3 + n)
    } else if lit(s, i, "sfr_") {
        let n = run_len(s, i + 4, b64);
        (n >= 8).then_some(i + 4 + n)
    } else if lit(s, i, "gh")
        && s.get(i + 2).is_some_and(|c| "pousr".contains(*c))
        && s.get(i + 3) == Some(&'_')
    {
        let n = run_len(s, i + 4, alnum);
        (n >= 16).then_some(i + 4 + n)
    } else if lit(s, i, "github_pat_") {
        let n = run_len(s, i + 11, |c| c.is_ascii_alphanumeric() || c == '_');
        (n >= 20).then_some(i + 11 + n)
    } else if lit(s, i, "xox")
        && s.get(i + 3).is_some_and(|c| "abprs".contains(*c))
        && s.get(i + 4) == Some(&'-')
    {
        let n = run_len(s, i + 5, |c| c.is_ascii_alphanumeric() || c == '-');
        (n >= 10).then_some(i + 5 + n)
    } else if lit(s, i, "AKIA") {
        let n = run_len(s, i + 4, |c| c.is_ascii_digit() || c.is_ascii_uppercase());
        (n >= 16).then_some(i + 4 + 16)
    } else if lit(s, i, "AIza") {
        let n = run_len(s, i + 4, b64);
        (n >= 20).then_some(i + 4 + n)
    } else if lit(s, i, "eyJ") {
        let n1 = run_len(s, i + 3, b64);
        if n1 < 10 || s.get(i + 3 + n1) != Some(&'.') {
            None
        } else {
            let p2 = i + 3 + n1 + 1;
            let n2 = run_len(s, p2, b64);
            if n2 == 0 || s.get(p2 + n2) != Some(&'.') {
                None
            } else {
                let p3 = p2 + n2 + 1;
                let n3 = run_len(s, p3, b64);
                (n3 > 0).then_some(p3 + n3)
            }
        }
    } else {
        None
    }?;
    Some((end, REDACTED.to_owned()))
}

/// `redactCommand`: the five rules in order, each a global replace over the
/// previous rule's output.
#[must_use]
pub fn redact_command(cmd: &str) -> String {
    let mut s: Vec<char> = cmd.chars().collect();
    s = replace_all(&s, rule_assignment);
    s = replace_all(&s, rule_flag);
    s = replace_all(&s, rule_header);
    s = replace_all(&s, rule_url);
    s = replace_all(&s, rule_token);
    s.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::{self, Json};

    #[test]
    fn matches_the_engine_regexes_on_the_node_fixture() {
        let text = include_str!("../tests/fixtures/js-redact.json");
        let Json::Obj(fixture) = json::parse(text).unwrap() else {
            panic!("fixture")
        };
        let rows = fixture.get("rows").unwrap().as_arr().unwrap();
        assert!(rows.len() > 40);
        for row in rows {
            let row = row.as_obj().unwrap();
            let input = row.get("input").unwrap().as_str().unwrap();
            let expected = row.get("output").unwrap().as_str().unwrap();
            assert_eq!(redact_command(input), expected, "{input:?}");
        }
    }
}
