//! Bakes the sofar.sh package version into the binary as
//! `SOFAR_ENGINE_VERSION` — the `engine` half of a fold snapshot's version
//! (SPEC §Incremental fold, rust-core D14/D22). Read at build time, so the
//! hot path pays nothing for it. No crates: the field is the first
//! `"version"` key of `packages/engine/package.json`, which npm keeps at the
//! top level.

use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let package_json = manifest.join("../../packages/engine/package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    let text = std::fs::read_to_string(&package_json)
        .unwrap_or_else(|e| panic!("{}: {e}", package_json.display()));
    let version = version_of(&text)
        .unwrap_or_else(|| panic!("{}: no \"version\" field", package_json.display()));
    println!("cargo:rustc-env=SOFAR_ENGINE_VERSION={version}");
}

fn version_of(text: &str) -> Option<&str> {
    let at = text.find("\"version\"")?;
    let rest = &text[at + "\"version\"".len()..];
    let rest = rest.trim_start().strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(&rest[..end])
}
