//! The private diagnostics store (`core/diagnostics.ts`, self-improve D3,
//! SPEC §Diagnostics store): rows OUTSIDE the repo under the XDG state dir,
//! keyed by clone hash; every write best-effort and never recursive.

use std::fs;
use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;
use crate::date::{js_date_parse, js_round, now_ms};
use crate::envelope::iso_from_epoch_ms;
use crate::json::{self, Json, Object};
use crate::text::js_trim;
use crate::version::engine_version;

pub const DIAGNOSTIC_RETENTION_DAYS: f64 = 90.0;
pub const DIAGNOSTIC_SWEEP_INTERVAL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
pub const DIAGNOSTIC_FILE_BYTE_CAP: u64 = 8 * 1024 * 1024;
pub const UNBOUND_INITIATIVE: &str = "_unbound";
const META_FILE: &str = "meta.json";

/// `stateBase`: `$XDG_STATE_HOME/sofar` or `~/.local/state/sofar`.
#[must_use]
pub fn state_base() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map_or_else(
            || {
                std::env::var_os("HOME")
                    .map_or_else(|| PathBuf::from("/"), PathBuf::from)
                    .join(".local")
                    .join("state")
            },
            PathBuf::from,
        );
    base.join("sofar")
}

/// `cloneRealPath`: symlinks resolved, else the path as given.
#[must_use]
pub fn clone_real_path(root: &Path) -> PathBuf {
    fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())
}

/// `cloneKey`: 32 hex chars of sha256(real clone path).
#[must_use]
pub fn clone_key(root: &Path) -> String {
    let real = clone_real_path(root);
    let hex = crate::sha256::hex_digest(real.to_string_lossy().as_bytes());
    hex[..32].to_owned()
}

fn realpath_of_nearest_ancestor(path: &Path) -> PathBuf {
    let mut probe = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        if let Ok(real) = fs::canonicalize(&probe) {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        let Some(parent) = probe.parent().map(Path::to_path_buf) else {
            return path.to_path_buf();
        };
        if parent == probe {
            return path.to_path_buf();
        }
        if let Some(name) = probe.file_name() {
            tail.push(name.to_owned());
        }
        probe = parent;
    }
}

fn is_inside(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// `diagnosticsDir`: this clone's row directory, or None when it would sit
/// INSIDE the repo (`XDG_STATE_HOME` pointing there).
#[must_use]
pub fn diagnostics_dir(root: &Path) -> Option<PathBuf> {
    diagnostics_dir_under(&state_base(), root)
}

fn diagnostics_dir_under(state_base: &Path, root: &Path) -> Option<PathBuf> {
    let dir = state_base.join("diagnostics").join(clone_key(root));
    if resolves_inside(&dir, root) {
        return None;
    }
    Some(dir)
}

/// `resolvesInside` (core/state-dir.ts): whether `dir` would sit INSIDE the
/// clone at `root`, both sides compared as typed AND with symlinks resolved.
#[must_use]
pub fn resolves_inside(dir: &Path, root: &Path) -> bool {
    let roots = [root.to_path_buf(), clone_real_path(root)];
    let dirs = [dir.to_path_buf(), realpath_of_nearest_ancestor(dir)];
    roots.iter().any(|r| dirs.iter().any(|d| is_inside(d, r)))
}

fn safe_name(name: &str) -> String {
    name.encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') => c,
            _ => '_',
        })
        .collect()
}

/// What a row records (`RowInput`).
#[derive(Debug, Clone, PartialEq)]
pub struct RowInput {
    pub kind: &'static str,
    pub data: Object,
    pub initiative: Option<String>,
    pub session: Option<String>,
    pub host_tool: Option<String>,
}

/// `makeDiagnosticRow` — the row's JSON in the TypeScript key order.
fn make_row(root: &Path, input: &RowInput, now: f64) -> Json {
    let mut o = Object::with_capacity(9);
    o.insert("d", Json::Num(1.0));
    #[allow(clippy::cast_possible_truncation, reason = "epoch ms fit i64")]
    o.insert("ts", Json::Str(iso_from_epoch_ms(now as i64)));
    o.insert("engine", Json::Str(engine_version().to_owned()));
    if let Some(tool) = &input.host_tool {
        let mut host = Object::with_capacity(1);
        host.insert("tool", Json::Str(tool.clone()));
        o.insert("host", Json::Obj(host));
    }
    o.insert("clone", Json::Str(clone_key(root)));
    o.insert(
        "initiative",
        Json::Str(
            input
                .initiative
                .clone()
                .unwrap_or_else(|| UNBOUND_INITIATIVE.to_owned()),
        ),
    );
    o.insert(
        "session",
        Json::Str(input.session.clone().unwrap_or_else(|| "cli".to_owned())),
    );
    o.insert("kind", Json::Str(input.kind.to_owned()));
    o.insert("data", Json::Obj(input.data.clone()));
    Json::Obj(o)
}

/// `recordDiagnostic`: build and append one row; true when it landed.
#[must_use]
pub fn record_diagnostic(root: &Path, input: &RowInput) -> bool {
    record_diagnostic_under(&state_base(), root, input)
}

fn record_diagnostic_under(state_base: &Path, root: &Path, input: &RowInput) -> bool {
    let Some(dir) = diagnostics_dir_under(state_base, root) else {
        return false;
    };
    let initiative = input
        .initiative
        .clone()
        .unwrap_or_else(|| UNBOUND_INITIATIVE.to_owned());
    let file = dir.join(format!("{}.jsonl", safe_name(&initiative)));
    let now = now_ms();
    let row = make_row(root, input, now);
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let line = format!("{}\n", json::stringify(&row));
    let appended = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&file)
        .and_then(|mut f| {
            use std::io::Write as _;
            f.write_all(line.as_bytes())
        });
    if appended.is_err() {
        return false;
    }
    maintain(&dir, &file, now);
    true
}

fn row_ts(line: &str) -> Option<f64> {
    let Json::Obj(o) = json::parse(line).ok()? else {
        return None;
    };
    js_date_parse(o.get("ts")?.as_str()?)
}

fn read_lines(path: &Path) -> Vec<String> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&bytes)
        .split('\n')
        .filter(|l| !js_trim(l).is_empty())
        .map(str::to_owned)
        .collect()
}

fn write_lines(path: &Path, lines: &[String]) {
    let text = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    let _ = write_file_atomic(path, text.as_bytes());
}

fn cutoff(now: f64) -> f64 {
    now - DIAGNOSTIC_RETENTION_DAYS * 24.0 * 60.0 * 60.0 * 1000.0
}

/// `sweepDir`: drop rows past retention in every row file of the clone.
pub fn sweep_dir(dir: &Path, now: f64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let cut = cutoff(now);
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(".jsonl") {
            continue;
        }
        let path = dir.join(&name);
        let lines = read_lines(&path);
        let kept: Vec<String> = lines
            .iter()
            .filter(|l| row_ts(l).is_none_or(|ts| ts >= cut))
            .cloned()
            .collect();
        if kept.len() != lines.len() {
            write_lines(&path, &kept);
        }
    }
}

fn compact_file(path: &Path, now: f64) {
    let cut = cutoff(now);
    let mut lines: Vec<String> = read_lines(path)
        .into_iter()
        .filter(|l| row_ts(l).is_none_or(|ts| ts >= cut))
        .collect();
    let target = (DIAGNOSTIC_FILE_BYTE_CAP / 2) as usize;
    let mut bytes: usize = lines.iter().map(|l| l.len() + 1).sum();
    let mut drop = 0;
    while bytes > target && drop < lines.len() {
        bytes -= lines[drop].len() + 1;
        drop += 1;
    }
    if drop > 0 {
        lines.drain(..drop);
    }
    write_lines(path, &lines);
}

fn maintain(dir: &Path, file: &Path, now: f64) {
    if fs::metadata(file).is_ok_and(|m| m.len() > DIAGNOSTIC_FILE_BYTE_CAP) {
        compact_file(file, now);
    }
    let meta_path = dir.join(META_FILE);
    let last = fs::read(&meta_path).ok().and_then(|bytes| {
        let Json::Obj(o) = json::parse(&String::from_utf8_lossy(&bytes)).ok()? else {
            return None;
        };
        if o.get("version") != Some(&Json::Num(1.0)) {
            return None;
        }
        js_date_parse(o.get("last_sweep")?.as_str()?)
    });
    if let Some(last) = last
        && now - last < DIAGNOSTIC_SWEEP_INTERVAL_MS
    {
        return;
    }
    sweep_dir(dir, now);
    #[allow(clippy::cast_possible_truncation, reason = "epoch ms fit i64")]
    let stamp = iso_from_epoch_ms(js_round(now) as i64);
    let _ = fs::write(
        &meta_path,
        format!("{{\"version\":1,\"last_sweep\":\"{stamp}\"}}\n"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_land_under_the_state_dir_with_the_typescript_shape() {
        let state = crate::testing::scratch_dir("diag-state");
        let root = crate::testing::scratch_dir("diag-root");
        let mut data = Object::new();
        data.insert("hook", Json::Str("SessionStart".into()));
        data.insert("bytes", Json::Num(42.0));
        let ok = record_diagnostic_under(
            &state,
            &root,
            &RowInput {
                kind: "injection",
                data,
                initiative: Some("demo".into()),
                session: Some("s".into()),
                host_tool: Some("claude-code".into()),
            },
        );
        assert!(ok);
        let dir = state.join("diagnostics").join(clone_key(&root));
        let text = fs::read_to_string(dir.join("demo.jsonl")).unwrap();
        assert!(text.starts_with("{\"d\":1,\"ts\":\""), "{text}");
        assert!(text.contains("\"host\":{\"tool\":\"claude-code\"},\"clone\":\""));
        assert!(text.ends_with(
            "\"kind\":\"injection\",\"data\":{\"hook\":\"SessionStart\",\"bytes\":42}}\n"
        ));
        assert!(dir.join("meta.json").exists());
        // A state dir inside the repo is refused.
        assert_eq!(diagnostics_dir_under(&root.join("state"), &root), None);
        fs::remove_dir_all(&state).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
