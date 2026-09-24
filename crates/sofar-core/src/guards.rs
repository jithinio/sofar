//! Decision guards — the matcher half of `packages/schema/src/guards.ts`
//! (`parseGuard`, `guardMatches`); the grammar half (`guardSpecErrors`) lives
//! in [`crate::payload`] beside the other payload rules.
//!
//! TypeScript compiles a glob to a `RegExp` and tests it. There is no regex
//! crate here (rust-core D9), so the glob is compiled to the SAME automaton
//! the regex would be and run directly, over UTF-16 code units because that
//! is what a JS regex in non-unicode mode matches one at a time
//! (`docs/HOTPATH.md` §Text-semantics pins, P3):
//!
//! | glob        | path domain                         | cmd domain |
//! | ----------- | ----------------------------------- | ---------- |
//! | `*`         | `[^/]*`                             | `.*`       |
//! | `**`        | `.*`                                | `.*`       |
//! | `**/`       | `(?:.*/)?`                          | `(?:.*/)?` |
//! | `?`         | `[^/]`                              | `.`        |
//! | other       | literal                             | literal    |
//!
//! `.` excludes the four line terminators (`\n`, `\r`, U+2028, U+2029). A
//! path pattern is anchored `(?:^|/)…$`; a cmd pattern is an unanchored
//! substring search. A trailing `/` on a path glob reads as `/**`.

use std::collections::HashSet;

use crate::payload::guard_spec_errors;
use crate::text::js_trim;

/// The event a guard domain watches: `path` → `file_touched`, `cmd` → `command_run`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GuardDomain {
    Path,
    Cmd,
}

impl GuardDomain {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            GuardDomain::Path => "path",
            GuardDomain::Cmd => "cmd",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    /// One code unit, verbatim.
    Lit(u16),
    /// `[^/]*`
    Segment,
    /// `.*`
    Any,
    /// `(?:.*/)?`
    OptDirs,
    /// `[^/]`
    OneInSegment,
    /// `.`
    One,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuardPattern {
    /// A leading `!` — this pattern exempts rather than fires.
    pub negated: bool,
    /// The glob as written.
    pub source: String,
    tokens: Vec<Token>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompiledGuard {
    pub domain: GuardDomain,
    pub patterns: Vec<GuardPattern>,
}

/// Compile a guard spec; `None` when it is malformed (`parseGuard`).
#[must_use]
pub fn parse_guard(spec: &str) -> Option<CompiledGuard> {
    if !guard_spec_errors(&crate::json::Json::Str(spec.to_owned())).is_empty() {
        return None;
    }
    let (domain, rest) = spec.split_once(':')?;
    let domain = match domain {
        "path" => GuardDomain::Path,
        "cmd" => GuardDomain::Cmd,
        _ => return None,
    };
    let patterns = rest
        .split(',')
        .map(|entry| {
            let trimmed = js_trim(entry);
            let negated = trimmed.starts_with('!');
            let glob = if negated {
                js_trim(&trimmed[1..])
            } else {
                trimmed
            };
            GuardPattern {
                negated,
                source: glob.to_owned(),
                tokens: compile(glob, domain),
            }
        })
        .collect();
    Some(CompiledGuard { domain, patterns })
}

/// `globBody` + `compilePattern`, as tokens.
fn compile(glob: &str, domain: GuardDomain) -> Vec<Token> {
    let normalized = if domain == GuardDomain::Path && glob.ends_with('/') {
        format!("{glob}**")
    } else {
        glob.to_owned()
    };
    let units: Vec<u16> = normalized.encode_utf16().collect();
    let mut tokens = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let c = units[i];
        if c == u16::from(b'*') {
            if units.get(i + 1) == Some(&u16::from(b'*')) {
                i += 1;
                if units.get(i + 1) == Some(&u16::from(b'/')) {
                    i += 1;
                    tokens.push(Token::OptDirs);
                } else {
                    tokens.push(Token::Any);
                }
            } else {
                tokens.push(match domain {
                    GuardDomain::Path => Token::Segment,
                    GuardDomain::Cmd => Token::Any,
                });
            }
        } else if c == u16::from(b'?') {
            tokens.push(match domain {
                GuardDomain::Path => Token::OneInSegment,
                GuardDomain::Cmd => Token::One,
            });
        } else {
            tokens.push(Token::Lit(c));
        }
        i += 1;
    }
    tokens
}

/// Does this subject violate the guard? At least one positive pattern
/// matches and no exemption does — exemptions win (`guardMatches`).
#[must_use]
pub fn guard_matches(guard: &CompiledGuard, subject: &str) -> bool {
    let units: Vec<u16> = subject.encode_utf16().collect();
    let mut hit = false;
    for pattern in &guard.patterns {
        if !pattern_tests(pattern, guard.domain, &units) {
            continue;
        }
        if pattern.negated {
            return false;
        }
        hit = true;
    }
    hit
}

/// `pattern.re.test(subject)`.
fn pattern_tests(pattern: &GuardPattern, domain: GuardDomain, subject: &[u16]) -> bool {
    let slash = u16::from(b'/');
    let mut failed = HashSet::new();
    match domain {
        GuardDomain::Path => {
            // `(?:^|/)body$`: the body starts at 0 or just after a `/`, and must reach the end.
            let starts = std::iter::once(0).chain(
                subject
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| **c == slash)
                    .map(|(i, _)| i + 1),
            );
            for start in starts {
                if matches_at(&pattern.tokens, subject, 0, start, true, &mut failed) {
                    return true;
                }
            }
            false
        }
        GuardDomain::Cmd => {
            // Unanchored: the body may start and end anywhere.
            (0..=subject.len())
                .any(|start| matches_at(&pattern.tokens, subject, 0, start, false, &mut failed))
        }
    }
}

fn is_line_terminator(c: u16) -> bool {
    matches!(c, 0x000A | 0x000D | 0x2028 | 0x2029)
}

/// Backtracking match of `tokens[ti..]` against `subject[si..]`; `failed`
/// memoizes states that cannot complete, so the search is bounded by
/// tokens × units even for a hostile pattern.
fn matches_at(
    tokens: &[Token],
    subject: &[u16],
    ti: usize,
    si: usize,
    must_end: bool,
    failed: &mut HashSet<(usize, usize)>,
) -> bool {
    if ti == tokens.len() {
        return !must_end || si == subject.len();
    }
    if failed.contains(&(ti, si)) {
        return false;
    }
    let slash = u16::from(b'/');
    let ok = match tokens[ti] {
        Token::Lit(c) => {
            subject.get(si) == Some(&c)
                && matches_at(tokens, subject, ti + 1, si + 1, must_end, failed)
        }
        Token::OneInSegment => {
            subject.get(si).is_some_and(|&c| c != slash)
                && matches_at(tokens, subject, ti + 1, si + 1, must_end, failed)
        }
        Token::One => {
            subject.get(si).is_some_and(|&c| !is_line_terminator(c))
                && matches_at(tokens, subject, ti + 1, si + 1, must_end, failed)
        }
        Token::Segment => {
            let mut end = si;
            loop {
                if matches_at(tokens, subject, ti + 1, end, must_end, failed) {
                    break true;
                }
                match subject.get(end) {
                    Some(&c) if c != slash => end += 1,
                    _ => break false,
                }
            }
        }
        Token::Any => {
            let mut end = si;
            loop {
                if matches_at(tokens, subject, ti + 1, end, must_end, failed) {
                    break true;
                }
                match subject.get(end) {
                    Some(&c) if !is_line_terminator(c) => end += 1,
                    _ => break false,
                }
            }
        }
        Token::OptDirs => {
            // Zero directories, or `.*` (no line terminators) up to a `/`.
            if matches_at(tokens, subject, ti + 1, si, must_end, failed) {
                true
            } else {
                let mut end = si;
                loop {
                    match subject.get(end) {
                        Some(&c) if c == slash => {
                            if matches_at(tokens, subject, ti + 1, end + 1, must_end, failed) {
                                break true;
                            }
                            end += 1;
                        }
                        Some(&c) if !is_line_terminator(c) => end += 1,
                        _ => break false,
                    }
                }
            }
        }
    };
    if !ok {
        failed.insert((ti, si));
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile and match in one step; a malformed spec fails the test loudly.
    fn fires(spec: &str, subject: &str) -> bool {
        let guard = parse_guard(spec).unwrap_or_else(|| panic!("spec did not compile: {spec}"));
        guard_matches(&guard, subject)
    }

    #[test]
    fn grammar_rejections_from_guards_test_ts() {
        assert!(parse_guard("path:!src/**").is_none());
        assert!(parse_guard("src/**").is_none());
        assert!(parse_guard("glob:src/**").is_none());
        assert!(parse_guard("path:a,,b").is_none());
        assert!(parse_guard("path:src/**").is_some());
        assert!(parse_guard("cmd:*npm publish*").is_some());
    }

    #[test]
    fn path_domain_from_guards_test_ts() {
        assert!(fires(
            "path:packages/schema/**",
            "/Users/x/repo/packages/schema/src/events.ts"
        ));
        assert!(fires(
            "path:packages/schema/**",
            "packages/schema/src/events.ts"
        ));
        assert!(!fires(
            "path:packages/schema/**",
            "/Users/x/repo/packages/engine/src/events.ts"
        ));
        assert!(!fires("path:src/**", "/repo/mysrc/a.ts"));
        assert!(fires("path:src/**", "/repo/src/a.ts"));
        assert!(fires("path:src/*.ts", "/repo/src/a.ts"));
        assert!(!fires("path:src/*.ts", "/repo/src/nested/a.ts"));
        assert!(fires("path:src/**/*.ts", "/repo/src/nested/deep/a.ts"));
        assert!(fires("path:**/*.ts", "/a.ts"));
        assert!(!fires("path:**/*.ts", "/repo/src/a.tsx"));
        assert!(fires("path:.sofar/", "/repo/.sofar/initiatives/x/plan.md"));
        assert!(fires("path:src/a?.ts", "/repo/src/ab.ts"));
        assert!(!fires("path:src/a?.ts", "/repo/src/abc.ts"));
        assert!(!fires("path:src/a?.ts", "/repo/src/a/.ts"));
        let spec = "path:**/*.ts,!packages/schema/src/**";
        assert!(fires(spec, "/repo/packages/engine/src/fold.ts"));
        assert!(!fires(spec, "/repo/packages/schema/src/events.ts"));
        // `**/` matches zero directories at the segment boundary, and `**` alone crosses slashes.
        assert!(fires("path:a/**/b", "/r/a/b"));
        assert!(fires("path:a/**/b", "/r/a/x/y/b"));
        assert!(fires("path:a/**", "/r/a/x/y"));
        assert!(!fires("path:a/**", "/r/xa/x"));
    }

    #[test]
    fn cmd_domain_from_guards_test_ts() {
        assert!(fires(
            "cmd:npm publish",
            "npm publish -w sofar.sh --otp 123"
        ));
        assert!(!fires("cmd:npm publish", "npm test"));
        assert!(fires("cmd:git*--force", "git push origin main --force"));
        let spec = "cmd:npm publish,!--dry-run";
        assert!(fires(spec, "npm publish -w sofar.sh"));
        assert!(!fires(spec, "npm publish -w sofar.sh --dry-run"));
        assert!(fires("cmd:rm -rf .", "rm -rf ."));
        assert!(!fires("cmd:rm -rf .", "rm -rf x"));
        assert!(fires("cmd:*git push*", "git push origin main"));
        assert!(fires("cmd:a?c", "xxabcxx"));
    }

    #[test]
    fn dot_excludes_line_terminators_and_counts_code_units() {
        // `.*` cannot cross a newline, so the substring search fails here…
        assert!(!fires("cmd:a*b", "a\nb"));
        // …while `[^/]*` (path `*`) may cross one.
        assert!(fires("path:a*b", "/a\nb"));
        // One `?` is one UTF-16 unit: an astral character needs two.
        assert!(!fires("cmd:a?b", "a\u{1F600}b"));
        assert!(fires("cmd:a??b", "a\u{1F600}b"));
    }

    #[test]
    fn pathological_pattern_stays_bounded() {
        let spec = format!("cmd:{}z", "*a".repeat(30));
        let subject = "a".repeat(400);
        assert!(!fires(&spec, &subject));
    }
}
