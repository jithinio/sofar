//! `sofar-core fold` — the port of `cli/fold.ts` (r1-fixes 5.1, D22;
//! rust-core D15): the black-box face of the incremental fold for the shared
//! fold-parity suite. The same command drives the TypeScript engine and this
//! binary, so the cited guarantee is proved on bytes and a command line.
//!
//! ```text
//! fold --events <jsonl> [--take <n>] [--write-snapshot <file>]
//! fold --events <jsonl> --snapshot <file> [--since <n>] [--write-snapshot <file>]
//! fold --events <jsonl> [--take <n>] --write-checkpoint <file>
//! fold --events <jsonl> --checkpoint <file>
//! ```
//!
//! The checkpoint pair (rust-core 4.4, 01M39ED9) drives the edge-free fold
//! checkpoint: the write prints `{ok: true, written}`, the resume `{ok: true,
//! resumed, state, warnings}`, with `resumed` false when the fast path refused
//! and the whole log was refolded, as a hook does.
//!
//! Prints canonical JSON: on success `{ok: true, cursor, version, state,
//! warnings}`; on a refusal `{ok: false, reason, detail}` or `{ok: false,
//! reason: "version", found, expected}`. Exit 0 either way — a refusal is an
//! answer — and 2 for a usage error (`sofar fold: <message>` on stderr).

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use crate::json::{Json, Object};
use crate::snapshot::{
    ParsedSnapshot, Snapshot, canonical_json, fold_all, fold_file_since, parse_snapshot,
    serialize_snapshot, state_of,
};
use crate::text::js_trim;

/// What a command returns; `main` mirrors it to the process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdResult {
    pub exit_code: u8,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Default)]
struct Options {
    events: Option<PathBuf>,
    take: Option<String>,
    snapshot: Option<PathBuf>,
    since: Option<String>,
    write_snapshot: Option<PathBuf>,
    write_checkpoint: Option<PathBuf>,
    checkpoint: Option<PathBuf>,
}

fn usage(message: &str) -> CmdResult {
    CmdResult {
        exit_code: 2,
        stdout: String::new(),
        stderr: format!("sofar fold: {message}"),
    }
}

fn ok(stdout: String) -> CmdResult {
    CmdResult {
        exit_code: 0,
        stdout,
        stderr: String::new(),
    }
}

/// The argv after `fold`: commander's `--opt value` and `--opt=value` forms.
fn parse_options(args: &[OsString]) -> Result<Options, CmdResult> {
    let mut opts = Options::default();
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let text = arg.to_string_lossy();
        let (name, inline) = match text.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_owned(), Some(OsString::from(v))),
            _ => (text.into_owned(), None),
        };
        let mut value = || -> Result<OsString, CmdResult> {
            match inline.clone().or_else(|| it.next().cloned()) {
                Some(v) => Ok(v),
                None => Err(usage(&format!("option '{name}' argument missing"))),
            }
        };
        match name.as_str() {
            "--events" => opts.events = Some(PathBuf::from(value()?)),
            "--take" => opts.take = Some(value()?.to_string_lossy().into_owned()),
            "--snapshot" => opts.snapshot = Some(PathBuf::from(value()?)),
            "--since" => opts.since = Some(value()?.to_string_lossy().into_owned()),
            "--write-snapshot" => opts.write_snapshot = Some(PathBuf::from(value()?)),
            "--write-checkpoint" => opts.write_checkpoint = Some(PathBuf::from(value()?)),
            "--checkpoint" => opts.checkpoint = Some(PathBuf::from(value()?)),
            other => return Err(usage(&format!("unknown option '{other}'"))),
        }
    }
    Ok(opts)
}

/// `Number(text)` narrowed to a non-negative integer: decimal digits, an
/// optional exponent or fraction that still lands on an integer, JS
/// whitespace trimmed, and the empty string as 0.
fn non_negative_integer(text: &str) -> Option<usize> {
    let trimmed = js_trim(text);
    if trimmed.is_empty() {
        return Some(0);
    }
    if !trimmed
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return None;
    }
    let n: f64 = trimmed.parse().ok()?;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked non-negative and integral"
    )]
    (n.is_finite() && n >= 0.0 && n.fract() == 0.0 && n < 9_007_199_254_740_992.0)
        .then_some(n as usize)
}

/// `runFold`.
#[must_use]
pub fn run_fold(args: &[OsString]) -> CmdResult {
    let opts = match parse_options(args) {
        Ok(o) => o,
        Err(result) => return result,
    };
    let Some(events) = opts.events else {
        return usage("--events <jsonl> is required");
    };
    if !events.exists() {
        return usage(&format!("no such file: {}", events.display()));
    }
    let take = match opts.take.as_deref() {
        None => None,
        Some(t) => match non_negative_integer(t) {
            Some(n) => Some(n),
            None => return usage("--take must be a non-negative integer"),
        },
    };
    let since = match opts.since.as_deref() {
        None => None,
        Some(s) => match non_negative_integer(s) {
            Some(n) => Some(n),
            None => return usage("--since must be a non-negative integer"),
        },
    };

    if opts.write_checkpoint.is_some() || opts.checkpoint.is_some() {
        if opts.snapshot.is_some() || opts.write_snapshot.is_some() || since.is_some() {
            return usage("the checkpoint options do not combine with the snapshot ones");
        }
        return match opts.checkpoint {
            Some(file) => resume_checkpoint(&events, &file, take),
            None => write_checkpoint(&events, &opts.write_checkpoint.expect("checked"), take),
        };
    }

    let snapshot: Snapshot = if let Some(snapshot_path) = opts.snapshot {
        if take.is_some() {
            return usage("--take applies to a full fold, not to --snapshot");
        }
        let Ok(text) = fs::read(&snapshot_path) else {
            return usage(&format!(
                "cannot read snapshot: {}",
                snapshot_path.display()
            ));
        };
        let text = String::from_utf8_lossy(&text);
        match parse_snapshot(&text) {
            ParsedSnapshot::Ok(parsed) => match fold_file_since(&parsed, &events, since) {
                Ok(step) => match step.refusal_json() {
                    Some(refusal) => return ok(format!("{}\n", canonical_json(&refusal))),
                    None => match step {
                        crate::snapshot::FoldStep::Ok(next) => next,
                        crate::snapshot::FoldStep::Refused { .. } => unreachable!("handled above"),
                    },
                },
                Err(e) => return usage(&format!("cannot read {}: {e}", events.display())),
            },
            refused => {
                let json = refused.refusal_json().expect("not Ok");
                return ok(format!("{}\n", canonical_json(&json)));
            }
        }
    } else {
        if since.is_some() {
            return usage("--since needs --snapshot");
        }
        let text = match fs::read(&events) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => return usage(&format!("cannot read {}: {e}", events.display())),
        };
        let mut all: Vec<&str> = text.split('\n').collect();
        if all.last() == Some(&"") {
            all.pop();
        }
        let taken = match take {
            Some(n) if n < all.len() => &all[..n],
            _ => &all[..],
        };
        fold_all(taken.iter().copied(), "")
    };
    if let Some(out) = opts.write_snapshot
        && let Err(e) = write_snapshot(&out, &snapshot)
    {
        return usage(&format!("cannot write snapshot {}: {e}", out.display()));
    }
    let result = state_of(&snapshot);
    let mut o = Object::with_capacity(5);
    o.insert("ok", Json::Bool(true));
    o.insert("cursor", Json::Str(snapshot.cursor.clone()));
    o.insert("version", snapshot.version.to_json());
    o.insert("state", result.state.to_json());
    o.insert(
        "warnings",
        Json::Arr(
            result
                .warnings
                .iter()
                .map(|w| Json::Str(w.clone()))
                .collect(),
        ),
    );
    ok(format!("{}\n", canonical_json(&Json::Obj(o))))
}

/// `bytesOfLines`: the byte length of the first `n` lines, each with its newline.
fn bytes_of_lines(buf: &[u8], n: usize) -> Option<usize> {
    let mut at = 0;
    for _ in 0..n {
        at += buf[at..].iter().position(|&b| b == b'\n')? + 1;
    }
    Some(at)
}

fn count_of(lines: &[&str]) -> usize {
    if lines.last() == Some(&"") {
        lines.len() - 1
    } else {
        lines.len()
    }
}

fn state_output(
    extra: (&str, bool),
    state: &crate::fold::InitiativeState,
    warnings: &[String],
) -> CmdResult {
    let mut o = Object::with_capacity(4);
    o.insert("ok", Json::Bool(true));
    o.insert(extra.0, Json::Bool(extra.1));
    o.insert("state", state.to_json());
    o.insert(
        "warnings",
        Json::Arr(warnings.iter().map(|w| Json::Str(w.clone())).collect()),
    );
    ok(format!("{}\n", canonical_json(&Json::Obj(o))))
}

/// `writeCheckpoint`: fold the first `take` lines (or all) and write the checkpoint.
fn write_checkpoint(events: &Path, file: &Path, take: Option<usize>) -> CmdResult {
    let whole = match fs::read(events) {
        Ok(bytes) => bytes,
        Err(e) => return usage(&format!("cannot read {}: {e}", events.display())),
    };
    let text = String::from_utf8_lossy(&whole);
    let all: Vec<&str> = text.split('\n').collect();
    let n = take.unwrap_or_else(|| count_of(&all));
    let Some(end) = bytes_of_lines(&whole, n) else {
        return usage("--take is past the last complete line");
    };
    let buf = &whole[..end];
    let head = String::from_utf8_lossy(buf);
    let lines: Vec<&str> = head.split('\n').collect();
    let cp = crate::fold::replay_decoded(
        crate::log::decode_lines(lines.iter().copied()),
        "",
        count_of(&lines),
    );
    let prefix = crate::fold_checkpoint::prefix_of(buf, cp.line_count);
    if let Some(prefix) = &prefix {
        let mut acc = crate::fold::EdgeAccumulator::default();
        acc.add(&cp.edges);
        crate::fold_checkpoint::write_checkpoint_file(file, "", &cp, &acc, prefix);
    }
    let mut o = Object::with_capacity(2);
    o.insert("ok", Json::Bool(true));
    o.insert("written", Json::Bool(prefix.is_some()));
    ok(format!("{}\n", canonical_json(&Json::Obj(o))))
}

/// `resumeCheckpoint`: resume the checkpoint over the file tail, refolding when it cannot.
fn resume_checkpoint(events: &Path, file: &Path, take: Option<usize>) -> CmdResult {
    if take.is_some() {
        return usage("--take applies to --write-checkpoint, not to --checkpoint");
    }
    if let Some(r) = crate::fold_checkpoint::resume_file(file, "", events) {
        let state = crate::fold::finalize_from(&r.cp, &r.acc);
        return state_output(("resumed", true), &state, &r.cp.warnings);
    }
    let text = match fs::read(events) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) => return usage(&format!("cannot read {}: {e}", events.display())),
    };
    let result = crate::fold::fold_text(&text, "");
    state_output(("resumed", false), &result.state, &result.warnings)
}

fn write_snapshot(path: &Path, snapshot: &Snapshot) -> std::io::Result<()> {
    fs::write(path, serialize_snapshot(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn usage_errors_exit_2_with_the_typescript_text() {
        assert_eq!(run_fold(&args(&[])), usage("--events <jsonl> is required"));
        assert_eq!(
            run_fold(&args(&["--events", "/nonexistent/x.jsonl"])),
            usage("no such file: /nonexistent/x.jsonl")
        );
        let dir = crate::testing::scratch_dir("fold-cli");
        let log = dir.join("events.jsonl");
        fs::write(&log, "").unwrap();
        let log_s = log.to_string_lossy().into_owned();
        assert_eq!(
            run_fold(&args(&["--events", &log_s, "--take", "x"])),
            usage("--take must be a non-negative integer")
        );
        assert_eq!(
            run_fold(&args(&["--events", &log_s, "--since", "1"])),
            usage("--since needs --snapshot")
        );
        assert_eq!(
            run_fold(&args(&[
                "--events",
                &log_s,
                "--snapshot",
                "/nonexistent/s.json",
                "--take",
                "1"
            ])),
            usage("--take applies to a full fold, not to --snapshot")
        );
        assert_eq!(
            run_fold(&args(&[
                "--events",
                &log_s,
                "--snapshot",
                "/nonexistent/s.json"
            ])),
            usage("cannot read snapshot: /nonexistent/s.json")
        );
        let empty = run_fold(&args(&[&format!("--events={log_s}")]));
        assert_eq!(empty.exit_code, 0);
        assert!(
            empty
                .stdout
                .starts_with("{\n  \"cursor\": \"\",\n  \"ok\": true,\n")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn number_narrowing_follows_number() {
        assert_eq!(non_negative_integer("3"), Some(3));
        assert_eq!(non_negative_integer(" 3 "), Some(3));
        assert_eq!(non_negative_integer(""), Some(0));
        assert_eq!(non_negative_integer("1e2"), Some(100));
        assert_eq!(non_negative_integer("1.5"), None);
        assert_eq!(non_negative_integer("-1"), None);
        assert_eq!(non_negative_integer("abc"), None);
    }
}
