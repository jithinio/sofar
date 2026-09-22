//! Cheap process-local randomness for lock tokens, temp-file names and
//! back-off jitter — places TypeScript uses `crypto.randomBytes` /
//! `Math.random` for UNIQUENESS, never secrecy. The runtime crate list is
//! closed (rust-core D9), so this draws on `RandomState`, which std seeds
//! from the OS at first use, mixed with the clock and a call counter.

use std::hash::{BuildHasher, Hasher, RandomState};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static STATE: OnceLock<RandomState> = OnceLock::new();
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh 64-bit value, distinct across calls and across processes.
#[must_use]
pub fn u64() -> u64 {
    let state = STATE.get_or_init(RandomState::new);
    let mut hasher = state.build_hasher();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    hasher.write_u128(nanos);
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    hasher.finish()
}

/// `Math.random()`: uniform in `[0, 1)`.
#[must_use]
#[allow(
    clippy::cast_precision_loss,
    reason = "53 random bits fit an f64 mantissa exactly"
)]
pub fn unit_f64() -> f64 {
    (u64() >> 11) as f64 / (1u64 << 53) as f64
}

/// `randomBytes(n).toString('hex')` — `2n` lowercase hex characters.
#[must_use]
pub fn hex(bytes: usize) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes * 2);
    while out.len() < bytes * 2 {
        let _ = write!(out, "{:016x}", u64());
    }
    out.truncate(bytes * 2);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_differ_and_shapes_hold() {
        assert_ne!(u64(), u64());
        let h = hex(8);
        assert_eq!(h.len(), 16);
        assert!(h.bytes().all(|b| b.is_ascii_hexdigit()));
        let f = unit_f64();
        assert!((0.0..1.0).contains(&f));
    }
}
