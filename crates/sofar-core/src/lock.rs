//! A cross-process mutex for SHORT check-then-append sections — the port of
//! `core/lock.ts` (r1-fixes 1.2; adopted for the Rust core by rust-core D9).
//!
//! The append itself needs no lock: `O_APPEND` makes each line atomic. What it
//! cannot make atomic is a DECISION taken on a read — "is this session
//! registered? no → append `session_started`" — and hosts that fire hooks in
//! parallel hit that window as the common case. Both implementations take
//! the SAME lock file, so a Rust hook and a TypeScript hook contend properly.
//!
//! The lock is an exclusive create (`O_CREAT|O_EXCL`, `File::create_new`),
//! atomic on every local filesystem, with no flock (which cannot be taken on
//! an append-only handle on Windows and would need TypeScript to move
//! first). Three properties shape it:
//!
//! - It DEGRADES rather than blocks: no lock within `wait_ms`, or no lock
//!   file creatable at all → the section runs unlocked. Every caller is on a
//!   path that must never fail the session (BD22); the worst an unlocked
//!   section can do is the duplicate the fold already tolerates.
//! - A lock older than `stale_ms` is STALE and is broken: the sections take
//!   milliseconds, so an old lock means its holder died inside one.
//! - Release is OWNED: the file carries a random token, and a holder only
//!   unlinks a lock that still carries its own — so a holder that overran
//!   `stale_ms` never deletes the lock of whoever broke it.
//!
//! Lock files live in the self-ignoring derived index (`.sofar/.index/`),
//! never beside a log: a crash must not leave one in `git status`.

use std::fs;
use std::io::{ErrorKind, Write as _};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

pub const LOCK_WAIT_MS: u64 = 2_000;
pub const LOCK_STALE_MS: u64 = 10_000;

#[derive(Debug, Clone, Copy)]
pub struct LockOptions {
    pub wait_ms: u64,
    pub stale_ms: u64,
}

impl Default for LockOptions {
    fn default() -> Self {
        Self {
            wait_ms: LOCK_WAIT_MS,
            stale_ms: LOCK_STALE_MS,
        }
    }
}

/// Run `section` holding the lock at `lock_path` when it can be had;
/// unlocked otherwise. Returns whatever `section` returns.
pub fn with_file_lock<T>(lock_path: &Path, options: LockOptions, section: impl FnOnce() -> T) -> T {
    let token = acquire(lock_path, options);
    let result = section();
    if let Some(token) = token {
        release(lock_path, &token);
    }
    result
}

/// The lock's token when held, `None` when the caller proceeds unlocked.
fn acquire(lock_path: &Path, options: LockOptions) -> Option<String> {
    if let Some(dir) = lock_path.parent()
        && fs::create_dir_all(dir).is_err()
    {
        return None;
    }
    let token = format!("{}.{}", std::process::id(), crate::entropy::hex(8));
    let deadline = Instant::now() + Duration::from_millis(options.wait_ms);
    let stale = Duration::from_millis(options.stale_ms);
    let mut pause: u64 = 1;
    loop {
        match fs::File::create_new(lock_path) {
            Ok(mut file) => {
                let _ = file.write_all(token.as_bytes());
                return Some(token);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            // Windows: a lock another holder has just unlinked stays DELETE
            // PENDING while any handle to it is open (a reader in `release`
            // or the stale check), and `create_new` then reports
            // PermissionDenied rather than AlreadyExists. That is contention,
            // not an unwritable directory — retry until the deadline. Unix
            // keeps the immediate degrade: PermissionDenied there means the
            // index dir cannot be written, and waiting would only stall a hook.
            #[cfg(windows)]
            Err(e) if e.kind() == ErrorKind::PermissionDenied => {}
            Err(_) => return None,
        }
        // `Date.now() - mtimeMs > staleMs`: a future mtime is never stale.
        match fs::metadata(lock_path).and_then(|m| m.modified()) {
            Ok(mtime) => {
                if SystemTime::now()
                    .duration_since(mtime)
                    .is_ok_and(|age| age > stale)
                {
                    let _ = fs::remove_file(lock_path);
                    continue;
                }
            }
            Err(_) => continue, // released between the create and the stat — try again at once
        }
        if Instant::now() >= deadline {
            return None;
        }
        #[allow(
            clippy::cast_precision_loss,
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "pause ≤ 16 ms"
        )]
        let jittered = (pause as f64 + crate::entropy::unit_f64() * pause as f64) as u64;
        std::thread::sleep(Duration::from_millis(jittered));
        pause = (pause * 2).min(16);
    }
}

fn release(lock_path: &Path, token: &str) {
    // Already broken as stale, or removed — then there is nothing of ours to release.
    if fs::read_to_string(lock_path).is_ok_and(|held| held == token) {
        let _ = fs::remove_file(lock_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn serialises_sections_across_threads_and_cleans_up() {
        let dir = crate::testing::scratch_dir("lock");
        let lock = dir.join("locks").join("x.lock");
        let inside = Arc::new(AtomicUsize::new(0));
        let overlaps = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (lock, inside, overlaps) = (lock.clone(), inside.clone(), overlaps.clone());
                std::thread::spawn(move || {
                    with_file_lock(&lock, LockOptions::default(), || {
                        if inside.fetch_add(1, Ordering::SeqCst) != 0 {
                            overlaps.fetch_add(1, Ordering::SeqCst);
                        }
                        std::thread::sleep(Duration::from_millis(5));
                        inside.fetch_sub(1, Ordering::SeqCst);
                    });
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(overlaps.load(Ordering::SeqCst), 0);
        assert!(!lock.exists(), "released");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stale_lock_is_broken_and_a_foreign_lock_is_not_released() {
        let dir = crate::testing::scratch_dir("lock-stale");
        let lock = dir.join("y.lock");
        fs::write(&lock, "1.deadbeef").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let ran = with_file_lock(
            &lock,
            LockOptions {
                wait_ms: 200,
                stale_ms: 100,
            },
            || {
                // Held by us now: the file carries our token, not the stale one.
                fs::read_to_string(&lock).unwrap() != "1.deadbeef"
            },
        );
        assert!(ran);
        assert!(!lock.exists());
        // A live foreign lock: the section runs UNLOCKED after wait_ms and
        // the foreign file stays.
        fs::write(&lock, "2.cafebabe").unwrap();
        let started = Instant::now();
        assert_eq!(
            with_file_lock(
                &lock,
                LockOptions {
                    wait_ms: 50,
                    stale_ms: 10_000
                },
                || 7
            ),
            7
        );
        assert!(started.elapsed() >= Duration::from_millis(50));
        assert_eq!(fs::read_to_string(&lock).unwrap(), "2.cafebabe");
        fs::remove_dir_all(&dir).unwrap();
    }
}
