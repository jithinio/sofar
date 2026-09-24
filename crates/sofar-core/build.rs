//! Bakes the sofar.sh package version into the binary as
//! `SOFAR_ENGINE_VERSION` — the `engine` half of a fold snapshot's version
//! (SPEC §Incremental fold, rust-core D14/D22). Read at build time, so the
//! hot path pays nothing for it. No crates: the field is the first
//! `"version"` key of `packages/engine/package.json`, which npm keeps at the
//! top level.

use std::path::Path;

// The crate's own sha256 (no deps), for the projection fingerprint.
#[allow(dead_code, reason = "build.rs uses only hex_digest")]
#[path = "src/sha256.rs"]
mod sha256;

/// Sources whose code renders a session projection (rust-core 4.4, decision
/// 01M39M4B): an edit to any of them changes the fingerprint, which invalidates
/// every projection manifest and forces a full session rebuild.
const PROJECTION_SOURCES: [&str; 3] = ["src/projections.rs", "src/json.rs", "src/text.rs"];

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let package_json = manifest.join("../../packages/engine/package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    let text = std::fs::read_to_string(&package_json)
        .unwrap_or_else(|e| panic!("{}: {e}", package_json.display()));
    let version = version_of(&text)
        .unwrap_or_else(|| panic!("{}: no \"version\" field", package_json.display()));
    println!("cargo:rustc-env=SOFAR_ENGINE_VERSION={version}");

    let mut all = Vec::new();
    for rel in PROJECTION_SOURCES {
        let path = manifest.join(rel);
        println!("cargo:rerun-if-changed={}", path.display());
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        all.extend_from_slice(rel.as_bytes());
        all.push(0);
        all.extend_from_slice(&bytes);
        all.push(0);
    }
    println!(
        "cargo:rustc-env=SOFAR_PROJECTION_FINGERPRINT={}",
        sha256::hex_digest(&all)
    );
}

fn version_of(text: &str) -> Option<&str> {
    let at = text.find("\"version\"")?;
    let rest = &text[at + "\"version\"".len()..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}
