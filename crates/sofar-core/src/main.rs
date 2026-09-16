//! `sofar-core` — the native hook binary. Parses the shim argv grammar and
//! dispatches; the hook handlers arrive with tasks 2.5 and 2.6, the hidden
//! `fold` conformance command is here (2.3, D15). Until then an owned hook
//! shape exits 70 (`EX_SOFTWARE`) with a one-line reason, and a shape the
//! TypeScript CLI owns exits 64 (`EX_USAGE`) so no caller can mistake either
//! for a handled hook.

use std::io::Write as _;
use std::process::ExitCode;

use sofar_core::cli::{Dispatch, Owned, dispatch};
use sofar_core::fold_cli::run_fold;

fn main() -> ExitCode {
    match dispatch(std::env::args_os().skip(1)) {
        Dispatch::Owned(Owned::Fold { args }) => {
            // `mirror` in cli/index.ts: stdout verbatim, stderr with one trailing newline.
            let result = run_fold(&args);
            if !result.stdout.is_empty() {
                let mut out = std::io::stdout().lock();
                if out
                    .write_all(result.stdout.as_bytes())
                    .and_then(|()| out.flush())
                    .is_err()
                {
                    return ExitCode::from(74);
                }
            }
            if !result.stderr.is_empty() {
                let mut err = std::io::stderr().lock();
                let _ = err.write_all(result.stderr.as_bytes());
                if !result.stderr.ends_with('\n') {
                    let _ = err.write_all(b"\n");
                }
            }
            ExitCode::from(result.exit_code)
        }
        Dispatch::Owned(Owned::Event { hook, .. }) => {
            eprintln!(
                "sofar-core: `event {}` is not implemented yet (rust-core 2.5)",
                hook.name()
            );
            ExitCode::from(70)
        }
        Dispatch::Owned(Owned::Statusline { .. }) => {
            eprintln!("sofar-core: `statusline` is not implemented yet (rust-core 2.6)");
            ExitCode::from(70)
        }
        Dispatch::NotOurs => {
            eprintln!("sofar-core: not a hook shape this binary owns — use the `sofar` CLI");
            ExitCode::from(64)
        }
    }
}
