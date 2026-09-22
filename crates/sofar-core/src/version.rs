//! The engine version (`packages/engine/package.json`), single-sourced: the
//! diagnostics rows and the update notice both name it.

use std::sync::OnceLock;

use crate::json::{self, Json};

const PACKAGE_JSON: &str = include_str!("../../../packages/engine/package.json");

/// `version` of `packages/engine/package.json`.
#[must_use]
pub fn engine_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        json::parse(PACKAGE_JSON)
            .ok()
            .and_then(|v| match v {
                Json::Obj(o) => o.get("version").and_then(Json::as_str).map(str::to_owned),
                _ => None,
            })
            .unwrap_or_default()
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_a_semver() {
        let v = super::engine_version();
        assert!(v.split('.').count() >= 3, "{v}");
    }
}
