//! `sofar-core status [slug] [--root D]` — plain `sofar status` (`cli/status.ts`,
//! `docs/HOTPATH.md` §status), owned by the native core under rust-core D14:
//! fold and print the uncapped [`crate::status::render_full_status`] bytes;
//! fold warnings to stderr as `warning: <w>`, exit 0; a resolution failure is
//! `sofar status: <message> (usage: sofar status [slug])`, exit 1. The styled
//! (colour) rendering is the TypeScript CLI's — the caller checks the colour
//! ladder before dispatching here. The stderr update notice
//! (`withUpdateNotice`, rust-core 3.1) is appended from the cache the same
//! way the TypeScript surface appends it; the refresh claim-and-spawn stays
//! with the `sofar` stub (O2 ruling — this binary only ever reads the cache).

use std::path::Path;

use crate::fold::empty_state;
use crate::fold_cli::CmdResult;
use crate::git::current_branch;
use crate::layout::Layout;
use crate::projections::retire_enabled;
use crate::record_copies::{ForeignLog, home_dir, scan_record_copies, union_fold};
use crate::resolve::{ResolveError, resolve_initiative, unbound_status_applies};
use crate::run_lock::probe_run_lock;
use crate::snapshot::{fold_file, state_of};
use crate::status::{CopiesView, render_full_status};
use crate::ui::Style;
use crate::update_cache::{UpdateNotice, notice_from, notice_line, read_update_cache};

fn fail(message: String) -> CmdResult {
    CmdResult {
        exit_code: 1,
        stdout: String::new(),
        stderr: message,
    }
}

/// `runStatus` with colour off.
#[must_use]
pub fn run_status(root: &Path, slug: Option<&str>) -> CmdResult {
    let layout = Layout::new(root);
    match resolve_initiative(&layout, slug) {
        Ok(resolved) => status_of(root, &layout, &resolved, None),
        Err(e) => {
            // An initiative that exists only on another branch still has a
            // status (branch-visibility D1): look for it there first.
            if let Some(slug) = slug.filter(|s| crate::payload::is_initiative_slug(s)) {
                let copies = scan_record_copies(root, slug);
                if !copies.is_empty() {
                    return status_of(root, &layout, slug, Some(copies));
                }
            }
            // An unbound branch orients instead of failing (r1-fixes L10,
            // D28): the most recently active initiative's status plus the
            // listing — rendered by the TypeScript CLI, which owns `sofar
            // list`; exit 64 hands the whole call back (rust-core D31).
            if matches!(e, ResolveError::UnknownInitiative(_))
                && slug.is_none()
                && unbound_status_applies(&layout)
            {
                return CmdResult {
                    exit_code: 64,
                    stdout: String::new(),
                    stderr: String::new(),
                };
            }
            fail(format!(
                "sofar status: {} (usage: sofar status [slug])",
                e.message()
            ))
        }
    }
}

/// `statusOf`: one initiative's status, folded across the record's other
/// copies (branch-visibility D1); `scan` when resolution already had to look.
fn status_of(
    root: &Path,
    layout: &Layout,
    resolved: &str,
    scan: Option<Vec<ForeignLog>>,
) -> CmdResult {
    let copies = scan.unwrap_or_else(|| scan_record_copies(root, resolved));
    let log_path = layout.events_path(resolved);
    let (mut state, warnings, provenance) = if !copies.is_empty() {
        let local = if log_path.exists() {
            match std::fs::read(&log_path) {
                Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
                Err(e) => {
                    return fail(format!(
                        "sofar status: failed to read {}: {e}",
                        log_path.display()
                    ));
                }
            }
        } else {
            None
        };
        let (result, provenance) =
            union_fold(resolved, local.as_deref(), &copies, current_branch(root));
        (result.state, result.warnings, provenance)
    } else if log_path.exists() {
        match fold_file(&log_path, resolved) {
            Ok(snapshot) => {
                let result = state_of(&snapshot);
                (result.state, result.warnings, None)
            }
            Err(e) => {
                return fail(format!(
                    "sofar status: failed to read {}: {e}",
                    log_path.display()
                ));
            }
        }
    } else {
        (empty_state(), Vec::new(), None)
    };
    if state.slug.is_empty() {
        resolved.clone_into(&mut state.slug);
    }
    // The run lock on the latest run with no stop (drive-visibility 2.3): a
    // record no driver is running probes nothing.
    let liveness = state
        .runs
        .last()
        .filter(|run| run.stopped.is_none())
        .map(|run| probe_run_lock(root, &run.id));
    let home = home_dir();
    CmdResult {
        exit_code: 0,
        stdout: render_full_status(
            &state,
            retire_enabled(),
            liveness,
            &CopiesView {
                provenance: provenance.as_ref(),
                home: home.as_deref(),
            },
        ),
        stderr: warnings
            .iter()
            .map(|w| format!("warning: {w}"))
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// `withUpdateNotice`: append the notice to STDERR, leaving every stdout byte
/// and the exit code untouched. `styled` and `unicode` are the stderr caps
/// (`stderrCaps()`): cyan is the colour law's info tone, `ℹ` / `i` its glyph.
#[must_use]
pub fn with_update_notice(result: CmdResult, styled: bool, unicode: bool) -> CmdResult {
    let Some(notice) = notice_from(
        read_update_cache().as_ref(),
        crate::version::engine_version(),
    ) else {
        return result;
    };
    append_notice(result, &notice, styled, unicode)
}

fn append_notice(
    mut result: CmdResult,
    notice: &UpdateNotice,
    styled: bool,
    unicode: bool,
) -> CmdResult {
    let style = Style::new(styled);
    let glyph = if unicode { "ℹ" } else { "i" };
    let line = format!("{} {}", style.info(glyph), style.info(&notice_line(notice)));
    if result.stderr.is_empty() {
        result.stderr = line;
    } else {
        // `stderr.replace(/\n*$/, '\n')` + line.
        let trimmed = result.stderr.trim_end_matches('\n');
        result.stderr = format!("{trimmed}\n{line}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice() -> UpdateNotice {
        UpdateNotice {
            latest: "99.0.0".into(),
            current: "0.33.0-rc.1".into(),
            installed: false,
        }
    }

    fn result(stderr: &str) -> CmdResult {
        CmdResult {
            exit_code: 0,
            stdout: "# slug\n".into(),
            stderr: stderr.into(),
        }
    }

    #[test]
    fn notice_lands_on_stderr_only() {
        let r = append_notice(result(""), &notice(), false, true);
        assert_eq!(r.stdout, "# slug\n");
        assert_eq!(r.exit_code, 0);
        assert_eq!(
            r.stderr,
            "ℹ sofar 99.0.0 is available (you have 0.33.0-rc.1) — run `sofar upgrade`."
        );
    }

    #[test]
    fn notice_follows_existing_stderr_after_exactly_one_newline() {
        let r = append_notice(
            result("warning: a\nwarning: b\n\n"),
            &notice(),
            false,
            false,
        );
        assert_eq!(
            r.stderr,
            "warning: a\nwarning: b\ni sofar 99.0.0 is available (you have 0.33.0-rc.1) — run `sofar upgrade`."
        );
        let r = append_notice(result("warning: a"), &notice(), false, false);
        assert!(r.stderr.starts_with("warning: a\ni sofar"));
    }

    #[test]
    fn styled_notice_is_cyan_twice() {
        let r = append_notice(result(""), &notice(), true, true);
        assert_eq!(
            r.stderr,
            "\x1b[36mℹ\x1b[39m \x1b[36msofar 99.0.0 is available (you have 0.33.0-rc.1) — run `sofar upgrade`.\x1b[39m"
        );
    }
}
