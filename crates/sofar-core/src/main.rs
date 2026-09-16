//! `sofar-core` — the native hook binary. Parses the shim argv grammar and
//! dispatches; the handlers arrive with tasks 2.5 and 2.6. Until then an
//! owned shape exits 70 (`EX_SOFTWARE`) with a one-line reason, and a shape the
//! TypeScript CLI owns exits 64 (`EX_USAGE`) so no caller can mistake either
//! for a handled hook.

use std::process::ExitCode;

use sofar_core::cli::{Dispatch, Owned, dispatch};

fn main() -> ExitCode {
    match dispatch(std::env::args_os().skip(1)) {
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
