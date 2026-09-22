//! The run lock's READ side (drive-visibility 2.3, core/run-lock.ts
//! `probeRunLock`): whether a driver on this machine holds a run. The lock is
//! an empty file at `<state base>/runs/<run id>.lock` that a driver holds with
//! flock semantics for as long as it drives the run; the kernel drops it when
//! the driver dies by any path. Only `sofar status` asks, for the latest run
//! with no stop, and nothing here creates, writes or unlinks the file.
//!
//! The probe takes a SHARED lock non-blockingly and drops it at once, so
//! probes never block one another. `File::try_lock_shared` is flock(2) on
//! Unix, which contends with both TypeScript primitives (macOS `O_EXLOCK`, the
//! Linux `flock(1)` child). Where TypeScript has no primitive (Windows) the
//! answer is `absent`, as it is there.

use std::fs::{File, TryLockError};
use std::path::Path;

use crate::diagnostics::{resolves_inside, state_base};
use crate::projections::RunLiveness;

/// `SAFE_RUN_ID`: a run id is a ulid; anything that could name a path
/// outside `runs/` gets no lock.
fn safe_run_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `probeRunLock`: `held` when a driver on this machine runs the run, `free`
/// when one ran it here and is gone, `absent` when none ran it under this
/// state base or no lock can be probed here (never "driver gone").
#[must_use]
pub fn probe_run_lock(root: &Path, run_id: &str) -> RunLiveness {
    if cfg!(not(any(target_os = "macos", target_os = "linux"))) || !safe_run_id(run_id) {
        return RunLiveness::Absent;
    }
    let dir = state_base().join("runs");
    if resolves_inside(&dir, root) {
        return RunLiveness::Absent;
    }
    let Ok(file) = File::open(dir.join(format!("{run_id}.lock"))) else {
        return RunLiveness::Absent;
    };
    match file.try_lock_shared() {
        Ok(()) => RunLiveness::Free,
        Err(TryLockError::WouldBlock) => RunLiveness::Held,
        Err(TryLockError::Error(_)) => RunLiveness::Absent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsafe_ids_name_no_lock() {
        assert!(safe_run_id("01J00000000000000000000000"));
        assert!(!safe_run_id("../x"));
        assert!(!safe_run_id(""));
        assert_eq!(probe_run_lock(Path::new("/"), "a/b"), RunLiveness::Absent);
    }
}
