//! `sofar-core` — the native hook binary. Parses the shim argv grammar and
//! dispatches: the six hooks (2.5), the hidden `fold` conformance command
//! (2.3, D15) and plain `status` (2.4, D14); the statusline arrives with 2.6
//! and exits 70 (`EX_SOFTWARE`) until then. A shape the TypeScript CLI owns
//! exits 64 (`EX_USAGE`) so no caller can mistake it for a handled hook.

use std::io::{IsTerminal as _, Write as _};
use std::process::ExitCode;

use sofar_core::cli::Hook;
use sofar_core::cli::{Color, Dispatch, Owned, dispatch};
use sofar_core::fold_cli::{CmdResult, run_fold};
use sofar_core::hook::read_stdin;
use sofar_core::post_tool::{handle_post_tool, handle_post_tool_failure};
use sofar_core::resolve::resolve_root;
use sofar_core::session_start::handle_session_start;
use sofar_core::status_cli::run_status;
use sofar_core::user_prompt::{handle_session_end, handle_stop, handle_user_prompt};

/// `mirror` in cli/index.ts: stdout verbatim, stderr with one trailing newline.
fn mirror(result: &CmdResult) -> ExitCode {
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

/// The stdout colour ladder of `cli/ui/caps.ts` (`stdoutCaps`): `NO_COLOR` >
/// `--no-color` > `FORCE_COLOR` > `--color` > (TTY && `TERM` != dumb). The ambient
/// `CI` clause is dropped for a piped stream, so agents and tests get plain
/// bytes unless they opt in.
fn stdout_color(flag: Color) -> bool {
    let env = |k: &str| std::env::var_os(k);
    let force = env("FORCE_COLOR");
    let no_color = env("NO_COLOR").is_some()
        || flag == Color::Off
        || force.as_deref().is_some_and(|v| v == "0");
    if no_color {
        return false;
    }
    let is_tty = std::io::stdout().is_terminal();
    let term_dumb = env("TERM").is_some_and(|t| t == "dumb");
    force.is_some()
        || flag == Color::Forced
        || (is_tty && !term_dumb)
        || (is_tty && env("CI").is_some())
}

fn main() -> ExitCode {
    match dispatch(std::env::args_os().skip(1)) {
        Dispatch::Owned(Owned::Fold { args }) => mirror(&run_fold(&args)),
        Dispatch::Owned(Owned::Status { slug, root, color }) => {
            if stdout_color(color) {
                // Styled status is the TypeScript layout grammar's (D14).
                eprintln!(
                    "sofar-core: styled `status` is rendered by the `sofar` CLI — pipe it or pass --no-color"
                );
                return ExitCode::from(64);
            }
            mirror(&run_status(&resolve_root(root.as_deref()), slug.as_deref()))
        }
        Dispatch::Owned(Owned::Event {
            hook: Hook::SessionStart,
            root,
        }) => mirror(&handle_session_start(
            &resolve_root(root.as_deref()),
            &read_stdin(),
        )),
        Dispatch::Owned(Owned::Event {
            hook: Hook::PostTool,
            root,
        }) => mirror(&handle_post_tool(
            &resolve_root(root.as_deref()),
            &read_stdin(),
        )),
        Dispatch::Owned(Owned::Event {
            hook: Hook::PostToolFailure,
            root,
        }) => mirror(&handle_post_tool_failure(
            &resolve_root(root.as_deref()),
            &read_stdin(),
        )),
        Dispatch::Owned(Owned::Event {
            hook: Hook::UserPrompt,
            root,
        }) => mirror(&handle_user_prompt(
            &resolve_root(root.as_deref()),
            &read_stdin(),
        )),
        Dispatch::Owned(Owned::Event {
            hook: Hook::Stop,
            root,
        }) => mirror(&handle_stop(&resolve_root(root.as_deref()), &read_stdin())),
        Dispatch::Owned(Owned::Event {
            hook: Hook::SessionEnd,
            root,
        }) => mirror(&handle_session_end(
            &resolve_root(root.as_deref()),
            &read_stdin(),
        )),
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
