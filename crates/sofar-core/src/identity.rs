//! Author identity for the envelope's optional `user` field — the port of
//! `core/identity.ts`: `git config user.email` through the git binary, so
//! git's own precedence (env > local > global > system) applies (rust-core
//! D7 keeps the subprocess for parity; a file-read implementation needs its
//! own Decision). Cached per process; best-effort by contract — no git, no
//! repo, no email, a timeout → `None`, and an append NEVER fails for it.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::text::js_trim;

/// `execFileSync`'s `timeout: 2000`.
pub const IDENTITY_TIMEOUT: Duration = Duration::from_millis(2000);

static CACHE: OnceLock<Option<String>> = OnceLock::new();

/// The configured email, looked up once per process.
#[must_use]
pub fn git_user_email() -> Option<&'static str> {
    CACHE.get_or_init(|| lookup(None)).as_deref()
}

/// One uncached lookup, in `cwd` (or the process cwd); the test seam.
#[must_use]
pub fn lookup(cwd: Option<&Path>) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["config", "user.email"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().ok()?;
    // Wait with a deadline, as execFileSync's timeout does (SIGTERM on
    // expiry). The output is a single line, far below the pipe buffer, so it
    // is safe to read after exit.
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < IDENTITY_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let email = js_trim(&out);
    (!email.is_empty()).then(|| email.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_configured_email_and_degrades_to_none() {
        let dir = crate::testing::scratch_dir("identity");
        // A repo of its own so the lookup never sees this checkout's config.
        assert!(
            Command::new("git")
                .args(["init", "-q"])
                .current_dir(&dir)
                .status()
                .unwrap()
                .success()
        );
        assert!(
            Command::new("git")
                .args(["config", "user.email", "conformance@example.invalid"])
                .current_dir(&dir)
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(
            lookup(Some(&dir)).as_deref(),
            Some("conformance@example.invalid")
        );
        assert!(
            Command::new("git")
                .args(["config", "user.email", "  "])
                .current_dir(&dir)
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(lookup(Some(&dir)), None, "a blank email is absent");
        std::fs::remove_dir_all(&dir).unwrap();
        // The cache is a plain memo of the first answer.
        let first = git_user_email();
        assert_eq!(git_user_email(), first);
    }
}
