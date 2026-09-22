//! Decision checks (`core/checks.ts`, memory-lead 2.3, D9) — the executable
//! half of a rule, as the Stop block runs them. A check is text an agent wrote
//! into a shared record, so it runs only once the operator approved that exact
//! command on this clone (the approval lives in the state dir, never in the
//! repo); everything else is named with the approval command. At Stop a check
//! only ever WARNS: it rides the write-back block, never causes one (D10).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::diagnostics::{clone_key, resolves_inside, state_base};
use crate::guards::{GuardDomain, guard_matches, parse_guard};
use crate::index_tier1::GuardIndex;
use crate::json::{self, Json};
use crate::text::{cmp_utf16, js_trim, one_line, utf16_len};

/// `DEFAULT_CHECK_TIMEOUT_MS`: a check's bound when its decision sets none.
pub const DEFAULT_CHECK_TIMEOUT_MS: f64 = 120_000.0;
/// Stop's bounds (`STOP_CHECK_BUDGET_MS`, `STOP_CHECK_MAX_MS`).
pub const STOP_CHECK_BUDGET_MS: f64 = 45_000.0;
pub const STOP_CHECK_MAX_MS: f64 = 30_000.0;
/// `DIAGNOSTICS_MAX` (driver/verify.ts): the kept tail of a check's output.
const DIAGNOSTICS_MAX: usize = 1_024;

/// One in-force check, repo-wide (`InForceCheck`).
#[derive(Debug, Clone, PartialEq)]
pub struct InForceCheck {
    /// `<slug> D<n>`.
    pub handle: String,
    pub initiative: String,
    pub ordinal: f64,
    pub rule: String,
    pub quote: Option<String>,
    pub guard: Option<String>,
    pub cmd: String,
    pub hint: Option<String>,
    pub timeout_ms: Option<f64>,
}

/// `checksInForce`: ruled scope-tier entries carrying `check` that no later
/// rule of their own record replaced; by initiative, then ordinal.
#[must_use]
pub fn checks_in_force(index: &GuardIndex) -> Vec<InForceCheck> {
    let mut out: Vec<InForceCheck> = index
        .scoped
        .iter()
        .filter(|d| d.superseded_by.is_none())
        .filter_map(|d| {
            let check = d.check.as_ref()?.as_obj()?;
            let rule = d.rule.clone()?;
            Some(InForceCheck {
                handle: format!("{} D{}", d.initiative, json::number_to_string(d.ordinal)),
                initiative: d.initiative.clone(),
                ordinal: d.ordinal,
                rule,
                quote: d.quote.clone(),
                guard: d.guard.clone(),
                cmd: check.get("cmd").map(json::js_to_string).unwrap_or_default(),
                hint: check.get("hint").map(json::js_to_string),
                timeout_ms: check.get("timeout_ms").and_then(Json::as_f64),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        if a.initiative == b.initiative {
            a.ordinal.total_cmp(&b.ordinal)
        } else {
            cmp_utf16(&a.initiative, &b.initiative)
        }
    });
    out
}

/// `applicableChecks`: a check whose decision has a `path:` guard applies
/// when it matches one of the changed paths; any other applies to any
/// change. With no changed paths nothing applies.
#[must_use]
pub fn applicable_checks<'a>(
    checks: &'a [InForceCheck],
    paths: &[String],
) -> Vec<&'a InForceCheck> {
    if paths.is_empty() {
        return Vec::new();
    }
    checks
        .iter()
        .filter(|c| {
            let Some(guard) = c.guard.as_deref().and_then(parse_guard) else {
                return true;
            };
            guard.domain != GuardDomain::Path || paths.iter().any(|p| guard_matches(&guard, p))
        })
        .collect()
}

/// `trustPath`: `<state>/checks/<key>.json`, keyed by the clone's COMMON git
/// dir so every worktree of one clone shares its approvals; None when the
/// state dir would sit inside the clone.
#[must_use]
pub fn trust_path(root: &Path) -> Option<PathBuf> {
    let base = state_base();
    if resolves_inside(&base, root) {
        return None;
    }
    let keyed = crate::git::common_git_dir(root).unwrap_or_else(|| root.to_path_buf());
    Some(
        base.join("checks")
            .join(format!("{}.json", clone_key(&keyed))),
    )
}

/// `isApproved`: whether the operator approved this exact command on this
/// clone. An unreadable file approves nothing.
#[must_use]
pub fn is_approved(root: &Path, cmd: &str) -> bool {
    let Some(path) = trust_path(root) else {
        return false;
    };
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(Json::Obj(trust)) = json::parse(&String::from_utf8_lossy(&bytes)) else {
        return false;
    };
    let digest = crate::sha256::hex_digest(cmd.as_bytes());
    match trust.get("approved") {
        Some(Json::Obj(approved)) => approved.contains_key(&digest),
        _ => false,
    }
}

/// How one check ended (`CheckOutcome`).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckOutcome {
    pub result: &'static str,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: f64,
    pub diagnostics: Option<String>,
}

/// `Math.round(ms / 1000)` for a non-negative duration (half up).
fn round_seconds(ms: f64) -> f64 {
    (ms / 1000.0 + 0.5).floor()
}

/// `describeOutcome`: how a non-passing outcome ended, in a few words.
#[must_use]
pub fn describe_outcome(outcome: &CheckOutcome) -> String {
    match outcome.result {
        "timeout" => format!(
            "timed out after {}s",
            json::number_to_string(round_seconds(outcome.duration_ms))
        ),
        "error" => "could not run".to_owned(),
        "refused" => {
            "refused — not approved on this clone and not inside the run's permission surface"
                .to_owned()
        }
        result => {
            if let Some(code) = outcome.exit_code {
                format!("exit {code}")
            } else if let Some(signal) = &outcome.signal {
                format!("killed by {signal}")
            } else if result == "pass" {
                "passed".to_owned()
            } else {
                "failed".to_owned()
            }
        }
    }
}

fn last_line(text: Option<&str>) -> Option<String> {
    text?
        .split('\n')
        .map(js_trim)
        .rfind(|l| !l.is_empty())
        .map(str::to_owned)
}

/// `checkFailureLine`: which decision, how it ended, the last thing the
/// command said, the rule, and the fix.
#[must_use]
pub fn check_failure_line(check: &InForceCheck, outcome: &CheckOutcome) -> String {
    let last = last_line(outcome.diagnostics.as_deref());
    let fix = match &check.hint {
        Some(hint) => one_line(hint),
        None => format!(
            "make the work hold the rule{}, or log a decision that supersedes {}",
            check
                .quote
                .as_deref()
                .map(|q| format!(" (the operator: \"{}\")", one_line(q)))
                .unwrap_or_default(),
            check.handle
        ),
    };
    format!(
        "sofar: check for [{}] failed ({}){} — rule: \"{}\" — fix: {fix}",
        check.handle,
        describe_outcome(outcome),
        last.map(|l| format!(": {l}")).unwrap_or_default(),
        one_line(&check.rule)
    )
}

/// `unapprovedLine`: the checks that bear on the work but that nothing approved.
#[must_use]
pub fn unapproved_line(checks: &[&InForceCheck]) -> Option<String> {
    if checks.is_empty() {
        return None;
    }
    let named: Vec<String> = checks
        .iter()
        .take(3)
        .map(|c| format!("[{}] `{}`", c.handle, c.cmd))
        .collect();
    let more = if checks.len() > 3 {
        format!(", +{} more", checks.len() - 3)
    } else {
        String::new()
    };
    Some(format!(
        "sofar: {} decision check(s) bear on this work but are not approved on this clone, so none ran: {}{more} — the operator approves one with `sofar check --approve \"<handle>\"`",
        checks.len(),
        named.join(", ")
    ))
}

/// `\x1b\[[0-9;]*[A-Za-z]` removed.
fn strip_ansi(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\u{1b}' && chars.get(i + 1) == Some(&'[') {
            let mut j = i + 2;
            while j < chars.len() && (chars[j].is_ascii_digit() || chars[j] == ';') {
                j += 1;
            }
            if j < chars.len() && chars[j].is_ascii_alphabetic() {
                i = j + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `text.slice(-n)` in UTF-16 units; a cut inside a pair leaves Node a lone
/// low surrogate, written as U+FFFD.
fn utf16_suffix(text: &str, n: usize) -> String {
    let total = utf16_len(text);
    if total <= n {
        return text.to_owned();
    }
    let mut skip = total - n;
    let mut out = String::new();
    for c in text.chars() {
        let w = c.len_utf16();
        if skip == 0 {
            out.push(c);
        } else if skip >= w {
            skip -= w;
        } else {
            out.push('\u{FFFD}');
            skip = 0;
        }
    }
    out
}

/// `tail` (driver/verify.ts): ANSI-stripped, CRLF-normalised, redacted,
/// trimmed, the last `DIAGNOSTICS_MAX` units; None when empty.
#[must_use]
pub fn tail(text: &str) -> Option<String> {
    let stripped = strip_ansi(text).replace("\r\n", "\n").replace('\r', "\n");
    let redacted = crate::redact::redact_command(&stripped);
    let clean = js_trim(&redacted);
    if clean.is_empty() {
        return None;
    }
    if utf16_len(clean) > DIAGNOSTICS_MAX {
        return Some(format!("…{}", utf16_suffix(clean, DIAGNOSTICS_MAX - 1)));
    }
    Some(clean.to_owned())
}

#[cfg(unix)]
fn signal_name(status: std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt as _;
    let n = status.signal()?;
    let name = match n {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        #[cfg(target_os = "linux")]
        7 => "SIGBUS",
        #[cfg(target_os = "linux")]
        10 => "SIGUSR1",
        #[cfg(target_os = "linux")]
        12 => "SIGUSR2",
        #[cfg(not(target_os = "linux"))]
        10 => "SIGBUS",
        #[cfg(not(target_os = "linux"))]
        30 => "SIGUSR1",
        #[cfg(not(target_os = "linux"))]
        31 => "SIGUSR2",
        _ => return Some(n.to_string()),
    };
    Some(name.to_owned())
}

#[cfg(not(unix))]
fn signal_name(_status: std::process::ExitStatus) -> Option<String> {
    None
}

fn drain(mut pipe: impl std::io::Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    })
}

/// Node's `spawnSync(cmd, { shell: true })` command.
fn shell_command(cmd: &str) -> Command {
    if cfg!(windows) {
        let mut c = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned()));
        c.args(["/d", "/s", "/c", &format!("\"{cmd}\"")]);
        c
    } else {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", cmd]);
        c
    }
}

/// Ask the child to stop as Node's timeout does (SIGTERM), and make sure.
fn terminate(child: &mut std::process::Child) {
    if cfg!(unix) {
        let _ = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let deadline = Instant::now() + Duration::from_millis(1_000);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// `runVerification` (driver/verify.ts): run the command through the shell
/// in `cwd`, bounded by `timeout_ms`, and say how it ended.
#[must_use]
#[allow(clippy::too_many_lines, reason = "a verbatim port of one runner")]
pub fn run_verification(cmd: &str, cwd: &Path, timeout_ms: f64) -> CheckOutcome {
    if !cwd.exists() {
        return CheckOutcome {
            result: "error",
            exit_code: None,
            signal: None,
            duration_ms: 0.0,
            diagnostics: Some(format!(
                "verification cwd does not exist: {}",
                cwd.display()
            )),
        };
    }
    let t0 = Instant::now();
    // Whole milliseconds, as `Date.now()` differences are.
    let elapsed = |t0: Instant| (t0.elapsed().as_secs_f64() * 1000.0).floor();
    let spawned = shell_command(cmd)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            return CheckOutcome {
                result: "error",
                exit_code: None,
                signal: None,
                duration_ms: elapsed(t0),
                diagnostics: tail(&format!("\nspawnSync /bin/sh {e}")),
            };
        }
    };
    let out = child.stdout.take().expect("piped");
    let err = child.stderr.take().expect("piped");
    // Both pipes drained on their own threads, so a chatty check cannot
    // block on a full pipe while this waits for it.
    let out_thread = drain(out);
    let err_thread = drain(err);
    let deadline = Duration::from_secs_f64(timeout_ms.max(0.0) / 1000.0);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if t0.elapsed() >= deadline {
            timed_out = true;
            terminate(&mut child);
            break None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    let duration_ms = elapsed(t0);
    let diagnostics = tail(&format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ));
    if timed_out {
        return CheckOutcome {
            result: "timeout",
            exit_code: None,
            signal: Some("SIGTERM".to_owned()),
            duration_ms,
            diagnostics,
        };
    }
    let Some(status) = status else {
        return CheckOutcome {
            result: "error",
            exit_code: None,
            signal: None,
            duration_ms,
            diagnostics,
        };
    };
    if status.code() == Some(0) {
        return CheckOutcome {
            result: "pass",
            exit_code: Some(0),
            signal: None,
            duration_ms,
            diagnostics,
        };
    }
    CheckOutcome {
        result: "fail",
        exit_code: status.code(),
        signal: if status.code().is_none() {
            signal_name(status)
        } else {
            None
        },
        duration_ms,
        diagnostics,
    }
}

/// One run check (`CheckRun`).
#[derive(Debug, Clone, PartialEq)]
pub struct CheckRun<'a> {
    pub check: &'a InForceCheck,
    pub outcome: CheckOutcome,
}

/// `runChecks`: each check runs for min(its timeout, the per-check cap, what
/// the budget has left); once under a second is left the rest are skipped.
#[must_use]
pub fn run_checks<'a>(
    checks: &[&'a InForceCheck],
    cwd: &Path,
    per_check_ms: f64,
    budget_ms: f64,
) -> (Vec<CheckRun<'a>>, Vec<&'a InForceCheck>) {
    let mut ran = Vec::new();
    let mut skipped = Vec::new();
    let mut left = budget_ms;
    for check in checks {
        let bound = check
            .timeout_ms
            .unwrap_or(DEFAULT_CHECK_TIMEOUT_MS)
            .min(per_check_ms)
            .min(left);
        if bound < 1_000.0 {
            skipped.push(*check);
            continue;
        }
        let outcome = run_verification(&check.cmd, cwd, bound);
        left -= outcome.duration_ms;
        ran.push(CheckRun { check, outcome });
    }
    (ran, skipped)
}

/// `stopCheckLines`: the decision checks bearing on what this session
/// touched, run and reported for the write-back block. A session whose file
/// list overflowed its cap touched too much to scope, so every check applies.
#[must_use]
pub fn stop_check_lines(root: &Path, index: &GuardIndex, files: &[String]) -> Vec<String> {
    let checks = checks_in_force(index);
    if checks.is_empty() {
        return Vec::new();
    }
    let overflow = files.iter().any(|f| f.starts_with('+'));
    let applicable: Vec<&InForceCheck> = if overflow {
        checks.iter().collect()
    } else {
        applicable_checks(&checks, files)
    };
    let approved: Vec<&InForceCheck> = applicable
        .iter()
        .copied()
        .filter(|c| is_approved(root, &c.cmd))
        .collect();
    let (ran, skipped) = run_checks(&approved, root, STOP_CHECK_MAX_MS, STOP_CHECK_BUDGET_MS);
    let mut lines: Vec<String> = ran
        .iter()
        .filter(|r| r.outcome.result != "pass")
        .map(|r| check_failure_line(r.check, &r.outcome))
        .collect();
    let unapproved: Vec<&InForceCheck> = applicable
        .iter()
        .copied()
        .filter(|c| !approved.iter().any(|a| std::ptr::eq(*a, *c)))
        .collect();
    lines.extend(unapproved_line(&unapproved));
    if !skipped.is_empty() {
        lines.push(format!(
            "sofar: {} decision check(s) did not run — Stop's {}s budget was spent; `sofar check` runs them all",
            skipped.len(),
            json::number_to_string(STOP_CHECK_BUDGET_MS / 1000.0)
        ));
    }
    lines
}
