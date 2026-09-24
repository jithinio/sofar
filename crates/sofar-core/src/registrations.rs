//! Each session's LATEST registration per log (`core/registrations.ts`,
//! rust-core 4.4, D35; latest since binding-follows-session D5, so a `rehome`
//! repeat moves the session's home back), kept current by reading only what the log grew by:
//! exactly [`crate::home::registration_in`]'s answer, re-checked against the
//! log on every read (size and mtimeMs; when grown, the first `HEAD_BYTES`
//! and the last consumed line hashing the same) and rescanned on any doubt.
//! Covers complete lines only; the unterminated last line is scanned live.
//! The file is shared with the TypeScript engine byte for byte.

use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::atomic::write_file_atomic;
use crate::index_store::log_stat;
use crate::json::{self, Json, Object};
use crate::layout::Layout;
use crate::sha256::hex_digest;

const REG_DIR: &str = "registrations";
const REGISTRATIONS_VERSION: f64 = 2.0;
/// How much of the log's head a grown log must still match.
const HEAD_BYTES: u64 = 4096;

/// `(id, ts)` of a session's registration.
pub type Registration = (String, String);

#[derive(Debug, Clone)]
struct RegFile {
    size: u64,
    mtime_ms: f64,
    offset: u64,
    last: Option<(u64, String)>,
    head: String,
    /// Session → its latest registration, keys in first-seen order (the TypeScript Map's).
    latest: Object,
    seen: HashSet<String>,
}

/// `mayRegister`: the type value decodes to `session_started` literally or
/// through a `\u` escape; a line with neither is skipped unparsed.
fn may_register(line: &str) -> bool {
    line.contains("session_started") || line.contains("\\u")
}

/// `registrationOf`: one line's registration, as `registrationIn` accepts it.
fn registration_of(line: &str) -> Option<(String, Registration)> {
    if line.is_empty() || !may_register(line) {
        return None;
    }
    let Ok(Json::Obj(e)) = json::parse(line) else {
        return None;
    };
    if e.get("type").and_then(Json::as_str) != Some("session_started") {
        return None;
    }
    let session = e.get("session").and_then(Json::as_str)?;
    let id = e.get("id").and_then(Json::as_str)?;
    let ts = e.get("ts").and_then(Json::as_str)?;
    if !line.contains(session) {
        return None;
    }
    Some((session.to_owned(), (id.to_owned(), ts.to_owned())))
}

fn scan_into(file: &mut RegFile, text: &str) {
    for line in text.split('\n') {
        if let Some((session, (id, ts))) = registration_of(line) {
            let mut r = Object::with_capacity(2);
            r.insert("id", Json::Str(id));
            r.insert("ts", Json::Str(ts));
            if file.seen.insert(session.clone()) {
                file.latest.push_unique(session, Json::Obj(r));
            } else {
                // A later registration overwrites in place, as a Map.set does.
                file.latest.insert(session, Json::Obj(r));
            }
        }
    }
}

fn read_range(path: &Path, start: u64, end: u64) -> Option<Vec<u8>> {
    if end <= start {
        return Some(Vec::new());
    }
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(start)).ok()?;
    let len = usize::try_from(end - start).ok()?;
    let mut buf = vec![0; len];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

fn offset_of(v: Option<&Json>) -> Option<u64> {
    let n = v?.as_f64()?;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "checked a non-negative integer first"
    )]
    (n.is_finite() && n >= 0.0 && n.fract() == 0.0).then_some(n as u64)
}

/// `parseRegFile`: trusted only in full shape.
#[allow(clippy::float_cmp, reason = "the version is an exact integer")]
fn parse_reg_file(bytes: &[u8]) -> Option<RegFile> {
    let Ok(Json::Obj(raw)) = json::parse_bytes_fast(bytes) else {
        return None;
    };
    if raw.get("v").and_then(Json::as_f64) != Some(REGISTRATIONS_VERSION) {
        return None;
    }
    let size = offset_of(raw.get("size"))?;
    let mtime_ms = raw.get("mtimeMs")?.as_f64()?;
    let offset = offset_of(raw.get("offset"))?;
    if offset > size {
        return None;
    }
    let last = match raw.get("last")? {
        Json::Null => None,
        Json::Obj(l) => {
            let start = offset_of(l.get("start"))?;
            if start >= offset {
                return None;
            }
            Some((start, l.get("sha256")?.as_str()?.to_owned()))
        }
        _ => return None,
    };
    let head = raw.get("head")?.as_str()?.to_owned();
    let latest = raw.get("latest")?.as_obj()?.clone();
    let mut seen = HashSet::new();
    for (k, r) in latest.iter() {
        let r = r.as_obj()?;
        r.get("id")?.as_str()?;
        r.get("ts")?.as_str()?;
        seen.insert(k.to_owned());
    }
    Some(RegFile {
        size,
        mtime_ms,
        offset,
        last,
        head,
        latest,
        seen,
    })
}

fn to_text(f: &RegFile) -> String {
    #[allow(
        clippy::cast_precision_loss,
        reason = "log sizes fit f64 exactly below 2^53"
    )]
    let num = |n: u64| Json::Num(n as f64);
    let mut o = Object::with_capacity(7);
    o.insert("v", Json::Num(REGISTRATIONS_VERSION));
    o.insert("size", num(f.size));
    o.insert("mtimeMs", Json::Num(f.mtime_ms));
    o.insert("offset", num(f.offset));
    o.insert(
        "last",
        f.last.as_ref().map_or(Json::Null, |(start, sha)| {
            let mut l = Object::with_capacity(2);
            l.insert("start", num(*start));
            l.insert("sha256", Json::Str(sha.clone()));
            Json::Obj(l)
        }),
    );
    o.insert("head", Json::Str(f.head.clone()));
    o.insert("latest", Json::Obj(f.latest.clone()));
    let mut text = json::stringify(&Json::Obj(o));
    text.push('\n');
    text
}

fn reg_path(layout: &Layout, slug: &str) -> PathBuf {
    layout
        .index_dir()
        .join(REG_DIR)
        .join(format!("{slug}.json"))
}

/// `consume`: fold `buf`'s complete lines (it begins at a line start at
/// `base`) into `file`, returning the unterminated remainder.
fn consume(file: &mut RegFile, buf: &[u8], base: u64) -> Vec<u8> {
    let Some(end) = buf.iter().rposition(|&b| b == b'\n') else {
        file.offset = base;
        return buf.to_vec();
    };
    scan_into(file, &String::from_utf8_lossy(&buf[..end]));
    let line_start = buf[..end]
        .iter()
        .rposition(|&b| b == b'\n')
        .map_or(0, |i| i + 1);
    file.offset = base + end as u64 + 1;
    file.last = Some((base + line_start as u64, hex_digest(&buf[line_start..end])));
    buf[end + 1..].to_vec()
}

/// `cachedRegistrationIn`: `registration_in(log, session_id)` through the
/// cache for `slug`; the plain scan whenever the log cannot be stat'd.
#[allow(
    clippy::float_cmp,
    reason = "exact equality of a stored stat IS the contract"
)]
pub fn cached_registration_in(
    layout: &Layout,
    slug: &str,
    log: &Path,
    session_id: &str,
    scan: impl Fn(&Path, &str) -> Option<Registration>,
) -> Option<Registration> {
    let Some(stat) = log_stat(log) else {
        return scan(log, session_id);
    };
    let path = reg_path(layout, slug);
    let cached = std::fs::read(&path).ok().and_then(|b| parse_reg_file(&b));

    let (file, rest, changed) = match cached {
        Some(c) if c.size == stat.size && c.mtime_ms == stat.mtime_ms => {
            let Some(rest) = read_range(log, c.offset, stat.size) else {
                return scan(log, session_id);
            };
            (c, rest, false)
        }
        cached => {
            // Only growth can be an append; the same size under a new mtime is a rewrite.
            let base = cached.filter(|c| {
                if stat.size <= c.size || stat.size < c.offset {
                    return false;
                }
                let head_ok = read_range(log, 0, HEAD_BYTES.min(c.offset))
                    .is_some_and(|h| hex_digest(&h) == c.head);
                match &c.last {
                    _ if !head_ok => false,
                    None => c.offset == 0,
                    Some((line_at, sha)) => read_range(log, *line_at, c.offset - 1)
                        .is_some_and(|l| hex_digest(&l) == *sha),
                }
            });
            let from = base.as_ref().map_or(0, |b| b.offset);
            let Some(buf) = read_range(log, from, stat.size) else {
                return scan(log, session_id);
            };
            let base_head = base
                .as_ref()
                .map(|b| (HEAD_BYTES.min(b.offset), b.head.clone()));
            let mut file = base.unwrap_or_else(|| RegFile {
                size: 0,
                mtime_ms: 0.0,
                offset: 0,
                last: None,
                head: String::new(),
                latest: Object::new(),
                seen: HashSet::new(),
            });
            let rest = consume(&mut file, &buf, from);
            let head_len = HEAD_BYTES.min(file.offset);
            file.head = match base_head {
                Some((len, head)) if len == head_len => head,
                _ if from == 0 => hex_digest(&buf[..usize::try_from(head_len).unwrap_or(0)]),
                _ => hex_digest(&read_range(log, 0, head_len).unwrap_or_default()),
            };
            file.size = stat.size;
            file.mtime_ms = stat.mtime_ms;
            (file, rest, true)
        }
    };

    // Written only when the log still measures what was read.
    if changed && log_stat(log) == Some(stat) {
        let _ = layout.ensure_index_dir().and_then(|_| {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            write_file_atomic(&path, to_text(&file).as_bytes())
        });
    }

    // The unterminated last line, scanned live exactly as registration_in would —
    // and it is the latest line of all, so it wins over the cached answer.
    if let Some((_, r)) =
        registration_of(&String::from_utf8_lossy(&rest)).filter(|(s, _)| s == session_id)
    {
        return Some(r);
    }
    let r = file.latest.get(session_id).and_then(Json::as_obj)?;
    Some((
        r.get("id")?.as_str()?.to_owned(),
        r.get("ts")?.as_str()?.to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::registration_in;
    use std::io::Write;
    use std::time::{Duration, UNIX_EPOCH};

    fn repo(tag: &str) -> (Layout, PathBuf) {
        let dir = crate::testing::scratch_dir(tag);
        let layout = Layout::new(&dir);
        let log = layout.events_path("x");
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        std::fs::write(&log, "").unwrap();
        (layout, log)
    }

    fn append(log: &Path, text: &str) {
        let mut f = std::fs::OpenOptions::new().append(true).open(log).unwrap();
        f.write_all(text.as_bytes()).unwrap();
    }

    fn touch(log: &Path, secs: u64) {
        let f = std::fs::OpenOptions::new().append(true).open(log).unwrap();
        f.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
            .unwrap();
    }

    const SESSIONS: [&str; 6] = ["s-1", "s-2", "é-3", "__proto__", "constructor", "s-1x"];

    fn line(r: &mut u32, n: usize) -> String {
        let mut next = || {
            *r = r.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            *r
        };
        let session = SESSIONS[next() as usize % SESSIONS.len()];
        let id = format!("01M{n:023}");
        let ts = format!("2026-09-23T00:00:{:02}.000Z", n % 60);
        let reg = format!(
            r#"{{"id":"{id}","ts":"{ts}","type":"session_started","session":"{session}"}}"#
        );
        match next() % 9 {
            0 => "not json {".into(),
            1 => {
                format!(r#"{{"id":"{id}","ts":"{ts}","type":"note_added","session":"{session}"}}"#)
            }
            2 => reg.replace("session_started", "session\\u005fstarted"),
            3 => reg.replace(
                &format!(r#""session":"{session}""#),
                &format!(
                    r#""session":"\u0073{}""#,
                    session.chars().skip(1).collect::<String>()
                ),
            ),
            4 => reg.replace(&format!(r#""id":"{id}""#), r#""id":7"#),
            5 => format!(r#"["{id}","session_started"]"#),
            6 => String::new(),
            _ => reg,
        }
    }

    #[test]
    fn equals_registration_in_under_appends_torn_tails_and_rewrites() {
        for seed in 1..=8u32 {
            let (layout, log) = repo(&format!("reg-{seed}"));
            let mut r = seed;
            let mut n = 0;
            for step in 0..60u64 {
                r = r.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                match r % 100 {
                    0..60 => {
                        let k = 1 + (r as usize / 7) % 4;
                        let lines: Vec<String> = (0..k)
                            .map(|_| {
                                n += 1;
                                line(&mut r, n)
                            })
                            .collect();
                        append(&log, &format!("{}\n", lines.join("\n")));
                    }
                    60..75 => {
                        n += 1;
                        let l = line(&mut r, n);
                        append(&log, &l);
                    }
                    75..85 => append(&log, "\n"),
                    85..93 => {
                        let text = std::fs::read_to_string(&log).unwrap();
                        std::fs::write(&log, text.replacen("s-1", "s-2", 1)).unwrap();
                    }
                    _ => {
                        n += 1;
                        std::fs::write(&log, format!("{}\n", line(&mut r, n))).unwrap();
                    }
                }
                touch(&log, 1_700_000_000 + step);
                for s in SESSIONS.iter().copied().chain(["missing", "toString"]) {
                    assert_eq!(
                        cached_registration_in(&layout, "x", &log, s, registration_in),
                        registration_in(&log, s),
                        "seed {seed} step {step} {s}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_corrupt_cache_file_is_a_rescan() {
        let (layout, log) = repo("reg-corrupt");
        append(
            &log,
            "{\"id\":\"A\",\"ts\":\"t1\",\"type\":\"session_started\",\"session\":\"s-1\"}\n",
        );
        let want = Some(("A".to_owned(), "t1".to_owned()));
        assert_eq!(
            cached_registration_in(&layout, "x", &log, "s-1", registration_in),
            want
        );
        let cache = reg_path(&layout, "x");
        let good = std::fs::read_to_string(&cache).unwrap();
        for bad in [
            "nope".to_owned(),
            good.replace("\"v\":2", "\"v\":3"),
            good.replace("\"latest\":", "\"first\":"),
            good.replace("\"offset\":", "\"offset\":1000000000,\"x\":"),
            good.replace("\"id\":\"A\"", "\"id\":1"),
            good.replace("\"head\":", "\"head\":1,\"y\":"),
        ] {
            assert_ne!(bad, good);
            std::fs::write(&cache, &bad).unwrap();
            assert_eq!(
                cached_registration_in(&layout, "x", &log, "s-1", registration_in),
                want,
                "{bad}"
            );
        }
    }

    /// binding-follows-session D5: a later registration in the same log wins,
    /// through the cache and the plain scan alike, cached or live.
    #[test]
    fn the_latest_registration_wins() {
        let (layout, log) = repo("reg-latest");
        append(
            &log,
            "{\"id\":\"A\",\"ts\":\"t1\",\"type\":\"session_started\",\"session\":\"s-1\"}\n",
        );
        let first = Some(("A".to_owned(), "t1".to_owned()));
        assert_eq!(
            cached_registration_in(&layout, "x", &log, "s-1", registration_in),
            first
        );
        // A rehome repeat, still unterminated: the live line wins over the cache.
        append(
            &log,
            "{\"id\":\"B\",\"ts\":\"t3\",\"type\":\"session_started\",\"session\":\"s-1\",\"payload\":{\"tool\":\"t\",\"rehome\":true}}",
        );
        let later = Some(("B".to_owned(), "t3".to_owned()));
        assert_eq!(registration_in(&log, "s-1"), later);
        assert_eq!(
            cached_registration_in(&layout, "x", &log, "s-1", registration_in),
            later
        );
        // Terminated and consumed into the cache: still the latest.
        append(&log, "\n");
        assert_eq!(
            cached_registration_in(&layout, "x", &log, "s-1", registration_in),
            later
        );
        assert!(
            std::fs::read_to_string(reg_path(&layout, "x"))
                .unwrap()
                .contains("\"latest\":{\"s-1\":{\"id\":\"B\"")
        );
    }
}
