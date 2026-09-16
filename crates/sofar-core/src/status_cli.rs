//! `sofar-core status [slug] [--root D]` — plain `sofar status` (`cli/status.ts`,
//! `docs/HOTPATH.md` §status), owned by the native core under rust-core D14:
//! fold and print the uncapped [`crate::status::render_full_status`] bytes;
//! fold warnings to stderr as `warning: <w>`, exit 0; a resolution failure is
//! `sofar status: <message> (usage: sofar status [slug])`, exit 1. The styled
//! (colour) rendering is the TypeScript CLI's — the caller checks the colour
//! ladder before dispatching here.

use std::path::Path;

use crate::fold::empty_state;
use crate::fold_cli::CmdResult;
use crate::layout::Layout;
use crate::resolve::resolve_initiative;
use crate::snapshot::{fold_file, state_of};
use crate::status::render_full_status;

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
    let resolved = match resolve_initiative(&layout, slug) {
        Ok(slug) => slug,
        Err(e) => {
            return fail(format!(
                "sofar status: {} (usage: sofar status [slug])",
                e.message()
            ));
        }
    };
    let log_path = layout.events_path(&resolved);
    let (mut state, warnings) = if log_path.exists() {
        match fold_file(&log_path, &resolved) {
            Ok(snapshot) => {
                let result = state_of(&snapshot);
                (result.state, result.warnings)
            }
            Err(e) => {
                return fail(format!(
                    "sofar status: failed to read {}: {e}",
                    log_path.display()
                ));
            }
        }
    } else {
        (empty_state(), Vec::new())
    };
    if state.slug.is_empty() {
        state.slug = resolved;
    }
    CmdResult {
        exit_code: 0,
        stdout: render_full_status(&state),
        stderr: warnings
            .iter()
            .map(|w| format!("warning: {w}"))
            .collect::<Vec<_>>()
            .join("\n"),
    }
}
