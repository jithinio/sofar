//! Test-only helpers. No `tempfile` crate: the dev-dependency list is fixed
//! (rust-core D9), and a unique directory under the OS temp dir is enough.

use std::path::PathBuf;

/// A fresh, empty scratch directory the test removes when it is done.
#[must_use]
pub fn scratch_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sofar-core-{tag}-{}-{:016x}",
        std::process::id(),
        crate::entropy::u64()
    ));
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}
