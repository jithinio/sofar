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

/// The quiet read (rust-core 4.4, 4b): [`parse_reg_file`]'s verdict and one
/// session's entry, streamed from the bytes without building the `latest`
/// tree. Every field is validated exactly as there — duplicate keys resolve
/// last-wins, as `JSON.parse` does, so an invalid value a later duplicate
/// replaces never counts — but only the asked session's `{id, ts}` is kept.
mod quiet {
    use std::borrow::Cow;
    use std::collections::HashSet;

    use serde::de::{DeserializeSeed, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};

    use super::{REGISTRATIONS_VERSION, Registration};

    /// A JSON value, classified: only what the checks read is kept.
    enum Kind<'de> {
        Num(f64),
        Str(Cow<'de, str>),
        Null,
        Other,
    }

    struct KindV;
    impl<'de> Visitor<'de> for KindV {
        type Value = Kind<'de>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("any JSON value")
        }
        fn visit_unit<E>(self) -> Result<Kind<'de>, E> {
            Ok(Kind::Null)
        }
        fn visit_bool<E>(self, _: bool) -> Result<Kind<'de>, E> {
            Ok(Kind::Other)
        }
        #[allow(
            clippy::cast_precision_loss,
            reason = "JSON numbers are doubles, as in json.rs"
        )]
        fn visit_i64<E>(self, n: i64) -> Result<Kind<'de>, E> {
            Ok(Kind::Num(n as f64))
        }
        #[allow(
            clippy::cast_precision_loss,
            reason = "JSON numbers are doubles, as in json.rs"
        )]
        fn visit_u64<E>(self, n: u64) -> Result<Kind<'de>, E> {
            Ok(Kind::Num(n as f64))
        }
        fn visit_f64<E>(self, n: f64) -> Result<Kind<'de>, E> {
            Ok(Kind::Num(n))
        }
        fn visit_borrowed_str<E>(self, s: &'de str) -> Result<Kind<'de>, E> {
            Ok(Kind::Str(Cow::Borrowed(s)))
        }
        fn visit_str<E>(self, s: &str) -> Result<Kind<'de>, E> {
            Ok(Kind::Str(Cow::Owned(s.to_owned())))
        }
        fn visit_string<E>(self, s: String) -> Result<Kind<'de>, E> {
            Ok(Kind::Str(Cow::Owned(s)))
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Kind<'de>, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(Kind::Other)
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Kind<'de>, A::Error> {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            Ok(Kind::Other)
        }
    }
    struct AnyKind;
    impl<'de> DeserializeSeed<'de> for AnyKind {
        type Value = Kind<'de>;
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Kind<'de>, D::Error> {
            d.deserialize_any(KindV)
        }
    }

    /// An object key, borrowed when it holds no escape.
    struct KeyV;
    impl<'de> Visitor<'de> for KeyV {
        type Value = Cow<'de, str>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a key")
        }
        fn visit_borrowed_str<E>(self, s: &'de str) -> Result<Cow<'de, str>, E> {
            Ok(Cow::Borrowed(s))
        }
        fn visit_str<E>(self, s: &str) -> Result<Cow<'de, str>, E> {
            Ok(Cow::Owned(s.to_owned()))
        }
        fn visit_string<E>(self, s: String) -> Result<Cow<'de, str>, E> {
            Ok(Cow::Owned(s))
        }
    }
    struct Key;
    impl<'de> DeserializeSeed<'de> for Key {
        type Value = Cow<'de, str>;
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Cow<'de, str>, D::Error> {
            d.deserialize_str(KeyV)
        }
    }

    /// An object whose named fields are classified, last duplicate winning;
    /// None when the value is not an object.
    struct Fields<const N: usize>(&'static [&'static str; N]);
    struct FieldsV<const N: usize>(&'static [&'static str; N]);
    impl<'de, const N: usize> Visitor<'de> for FieldsV<N> {
        type Value = Option<[Option<Kind<'de>>; N]>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("any JSON value")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out: [Option<Kind<'de>>; N] = std::array::from_fn(|_| None);
            while let Some(k) = map.next_key_seed(Key)? {
                match self.0.iter().position(|n| *n == k) {
                    Some(i) => out[i] = Some(map.next_value_seed(AnyKind)?),
                    None => {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
            }
            Ok(Some(out))
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }
    impl<'de, const N: usize> DeserializeSeed<'de> for Fields<N> {
        type Value = Option<[Option<Kind<'de>>; N]>;
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
            d.deserialize_any(FieldsV(self.0))
        }
    }

    const ENTRY: &[&str; 2] = &["id", "ts"];
    const LAST: &[&str; 2] = &["start", "sha256"];

    /// `latest`: whether every FINAL entry is `{id: string, ts: string}`, and
    /// the asked session's final entry. None when it is not an object.
    struct Latest<'s>(&'s str);
    struct LatestV<'s>(&'s str);
    type LatestOut = Option<(bool, Option<Registration>)>;
    impl<'de> Visitor<'de> for LatestV<'_> {
        type Value = LatestOut;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("any JSON value")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<LatestOut, A::Error> {
            // Keys whose latest value is invalid; a later valid duplicate clears one.
            let mut bad: HashSet<Cow<'de, str>> = HashSet::new();
            let mut found: Option<Registration> = None;
            while let Some(k) = map.next_key_seed(Key)? {
                let entry = map.next_value_seed(Fields(ENTRY))?;
                let valid = if let Some([Some(Kind::Str(id)), Some(Kind::Str(ts))]) = entry {
                    if k == self.0 {
                        found = Some((id.into_owned(), ts.into_owned()));
                    }
                    true
                } else {
                    if k == self.0 {
                        found = None;
                    }
                    false
                };
                if valid {
                    if !bad.is_empty() {
                        bad.remove(&k);
                    }
                } else {
                    bad.insert(k);
                }
            }
            Ok(Some((bad.is_empty(), found)))
        }
        fn visit_unit<E>(self) -> Result<LatestOut, E> {
            Ok(None)
        }
        fn visit_bool<E>(self, _: bool) -> Result<LatestOut, E> {
            Ok(None)
        }
        fn visit_i64<E>(self, _: i64) -> Result<LatestOut, E> {
            Ok(None)
        }
        fn visit_u64<E>(self, _: u64) -> Result<LatestOut, E> {
            Ok(None)
        }
        fn visit_f64<E>(self, _: f64) -> Result<LatestOut, E> {
            Ok(None)
        }
        fn visit_str<E>(self, _: &str) -> Result<LatestOut, E> {
            Ok(None)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<LatestOut, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }
    impl<'de> DeserializeSeed<'de> for Latest<'_> {
        type Value = LatestOut;
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<LatestOut, D::Error> {
            d.deserialize_any(LatestV(self.0))
        }
    }

    /// The top-level fields, last duplicate winning.
    #[derive(Default)]
    struct Top<'de> {
        v: Option<Kind<'de>>,
        size: Option<Kind<'de>>,
        mtime: Option<Kind<'de>>,
        offset: Option<Kind<'de>>,
        head: Option<Kind<'de>>,
        last: Option<LastOut<'de>>,
        latest: Option<LatestOut>,
    }
    struct TopV<'s>(&'s str);
    impl<'de> Visitor<'de> for TopV<'_> {
        type Value = Option<Top<'de>>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("any JSON value")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut t = Top::default();
            while let Some(k) = map.next_key_seed(Key)? {
                match &*k {
                    "v" => t.v = Some(map.next_value_seed(AnyKind)?),
                    "size" => t.size = Some(map.next_value_seed(AnyKind)?),
                    "mtimeMs" => t.mtime = Some(map.next_value_seed(AnyKind)?),
                    "offset" => t.offset = Some(map.next_value_seed(AnyKind)?),
                    "head" => t.head = Some(map.next_value_seed(AnyKind)?),
                    "last" => t.last = Some(map.next_value_seed(LastSeed)?),
                    "latest" => t.latest = Some(map.next_value_seed(Latest(self.0))?),
                    _ => {
                        map.next_value::<IgnoredAny>()?;
                    }
                }
            }
            Ok(Some(t))
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }

    enum LastOut<'de> {
        Null,
        Obj([Option<Kind<'de>>; 2]),
        Neither,
    }
    struct LastSeed;
    impl<'de> DeserializeSeed<'de> for LastSeed {
        type Value = LastOut<'de>;
        fn deserialize<D: Deserializer<'de>>(self, d: D) -> Result<LastOut<'de>, D::Error> {
            d.deserialize_any(NullOrFields)
        }
    }
    /// `null`, an object's fields, or neither.
    struct NullOrFields;
    impl<'de> Visitor<'de> for NullOrFields {
        type Value = LastOut<'de>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("any JSON value")
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(LastOut::Null)
        }
        fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
            Ok(FieldsV(LAST)
                .visit_map(map)?
                .map_or(LastOut::Neither, LastOut::Obj))
        }
        fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
            Ok(LastOut::Neither)
        }
        fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
            Ok(LastOut::Neither)
        }
        fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
            Ok(LastOut::Neither)
        }
        fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
            Ok(LastOut::Neither)
        }
        fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
            Ok(LastOut::Neither)
        }
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(LastOut::Neither)
        }
    }

    fn offset_of(k: Option<&Kind>) -> Option<u64> {
        let Some(Kind::Num(n)) = k else { return None };
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "checked a non-negative integer first"
        )]
        (n.is_finite() && *n >= 0.0 && n.fract() == 0.0).then_some(*n as u64)
    }

    /// What the quiet path needs from a valid file.
    pub(super) struct Quiet {
        pub size: u64,
        pub mtime_ms: f64,
        pub offset: u64,
        pub entry: Option<Registration>,
    }

    /// Err: serde rejected the bytes (the caller parses them the full way).
    /// Ok(None): parsed, and `parseRegFile` would refuse it.
    #[allow(clippy::float_cmp, reason = "the version is an exact integer")]
    pub(super) fn read(bytes: &[u8], session: &str) -> Result<Option<Quiet>, ()> {
        let mut de = serde_json::Deserializer::from_slice(bytes);
        let top = de.deserialize_any(TopV(session)).map_err(|_| ())?;
        de.end().map_err(|_| ())?;
        let Some(t) = top else { return Ok(None) };
        let check = || -> Option<Quiet> {
            let Some(Kind::Num(v)) = t.v else { return None };
            if v != REGISTRATIONS_VERSION {
                return None;
            }
            let size = offset_of(t.size.as_ref())?;
            let Some(Kind::Num(mtime_ms)) = t.mtime else {
                return None;
            };
            let offset = offset_of(t.offset.as_ref())?;
            if offset > size {
                return None;
            }
            match &t.last {
                Some(LastOut::Null) => {}
                Some(LastOut::Obj([start, sha])) => {
                    if offset_of(start.as_ref())? >= offset || !matches!(sha, Some(Kind::Str(_))) {
                        return None;
                    }
                }
                _ => return None,
            }
            if !matches!(t.head, Some(Kind::Str(_))) {
                return None;
            }
            let Some(Some((true, entry))) = t.latest else {
                return None;
            };
            Some(Quiet {
                size,
                mtime_ms,
                offset,
                entry,
            })
        };
        Ok(check())
    }
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
    let bytes = std::fs::read(&path).ok();
    // The quiet read (4b): a file whose key still matches the log answers
    // from a streamed lookup; anything else takes the full path below.
    if let Some(b) = &bytes
        && let Ok(Some(q)) = quiet::read(b, session_id)
        && q.size == stat.size
        && q.mtime_ms == stat.mtime_ms
    {
        let Some(rest) = read_range(log, q.offset, stat.size) else {
            return scan(log, session_id);
        };
        if let Some((_, r)) =
            registration_of(&String::from_utf8_lossy(&rest)).filter(|(s, _)| s == session_id)
        {
            return Some(r);
        }
        return q.entry;
    }
    let cached = bytes.as_deref().and_then(parse_reg_file);

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

    type Verdict = Option<(u64, u64, u64, Option<Registration>)>;

    /// The full parse's answer for one session — what the quiet read replaces.
    fn full(bytes: &[u8], session: &str) -> Verdict {
        let f = parse_reg_file(bytes)?;
        let entry = f.latest.get(session).and_then(Json::as_obj).map(|r| {
            (
                r.get("id").and_then(Json::as_str).unwrap().to_owned(),
                r.get("ts").and_then(Json::as_str).unwrap().to_owned(),
            )
        });
        Some((f.size, f.mtime_ms.to_bits(), f.offset, entry))
    }

    /// Agree wherever serde accepts the bytes; Err falls back to the full path.
    fn same(bytes: &[u8], session: &str) -> bool {
        match quiet::read(bytes, session) {
            Err(()) => false,
            Ok(q) => {
                let q = q.map(|q| (q.size, q.mtime_ms.to_bits(), q.offset, q.entry));
                assert_eq!(
                    q,
                    full(bytes, session),
                    "{session}: {}",
                    String::from_utf8_lossy(bytes)
                );
                true
            }
        }
    }

    /// A registration file built from every committed real log (the derived
    /// .sofar/.index is absent from a fresh checkout).
    fn real_registration_files() -> Vec<Vec<u8>> {
        let logs =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.sofar/initiatives");
        let (layout, _) = repo("quiet-real");
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&logs).unwrap() {
            let entry = entry.unwrap();
            let slug = entry.file_name().to_string_lossy().into_owned();
            let Ok(text) = std::fs::read(entry.path().join("events.jsonl")) else {
                continue;
            };
            let log = layout.events_path(&slug);
            std::fs::create_dir_all(log.parent().unwrap()).unwrap();
            std::fs::write(&log, text).unwrap();
            let _ = cached_registration_in(&layout, &slug, &log, "absent", registration_in);
            if let Ok(bytes) = std::fs::read(reg_path(&layout, &slug)) {
                out.push(bytes);
            }
        }
        out
    }

    #[test]
    fn the_quiet_read_equals_the_full_parse() {
        let base = |latest: &str| {
            format!(
                r#"{{"v":2,"size":900,"mtimeMs":1790177657980.5837,"offset":800,"last":{{"start":700,"sha256":"ab"}},"head":"cd","latest":{latest}}}"#
            )
        };
        let ok = r#"{"id":"I","ts":"T"}"#;
        let crafted: Vec<String> = vec![
            base(&format!(r#"{{"s":{ok},"o":{ok}}}"#)),
            base(r"{}"),
            base(&format!(r#"{{"s":{ok},"s":{{"id":"J","ts":"U"}}}}"#)),
            base(&format!(r#"{{"s":{{"id":1,"ts":"T"}},"s":{ok}}}"#)),
            base(&format!(r#"{{"s":{ok},"s":{{"id":1,"ts":"T"}}}}"#)),
            base(&format!(r#"{{"o":{{"ts":"T"}},"o":{ok},"s":{ok}}}"#)),
            base(&format!(r#"{{"o":{ok},"o":{{"ts":"T"}},"s":{ok}}}"#)),
            base(&format!(r#"{{"o":{{"id":"I"}},"s":{ok}}}"#)),
            base(r#"{"s":{"id":"I","ts":"T","x":[1,{"y":null}],"id":"K"}}"#),
            base(r#"{"s":{"id":"I","ts":"T","id":null}}"#),
            base(&format!(r#"{{"\u0073":{ok},"o\u00e9":{ok}}}"#)),
            base(r#"{"s":{"\u0069d":"I","ts":"T\n"}}"#),
            base(r"[]"),
            base(r#""s""#),
            base(r"null"),
            base(&format!(r#"{{"s":[{ok}]}}"#)),
            base(&format!(
                r#"{{"s":{ok}}},"latest":{{"s":{{"id":"Z","ts":"Z"}}}}"#
            )),
            base(&format!(r#"{{"s":{ok}}},"latest":7"#)),
            base(&format!(r#"{{"s":{ok}}},"v":3"#)),
            base(&format!(r#"{{"s":{ok}}},"v":"2""#)),
            base(&format!(r#"{{"s":{ok}}},"v":2.0,"offset":900"#)),
            base(&format!(r#"{{"s":{ok}}},"offset":901"#)),
            base(&format!(r#"{{"s":{ok}}},"offset":-0"#)),
            base(&format!(r#"{{"s":{ok}}},"size":1.5"#)),
            base(&format!(r#"{{"s":{ok}}},"mtimeMs":"1""#)),
            base(&format!(r#"{{"s":{ok}}},"head":1"#)),
            base(&format!(r#"{{"s":{ok}}},"last":null"#)),
            base(&format!(
                r#"{{"s":{ok}}},"last":null,"last":{{"start":1,"sha256":"x"}}"#
            )),
            base(&format!(
                r#"{{"s":{ok}}},"last":{{"start":800,"sha256":"x"}}"#
            )),
            base(&format!(r#"{{"s":{ok}}},"last":{{"start":1,"sha256":2}}"#)),
            base(&format!(r#"{{"s":{ok}}},"last":{{"start":1}}"#)),
            base(&format!(r#"{{"s":{ok}}},"last":[1]"#)),
            base(&format!(
                r#"{{"s":{ok}}},"last":{{"start":1,"sha256":"x","start":"y"}}"#
            )),
            base(&format!(
                r#"{{"s":{ok}}},"extra":{{"deep":[[[{{"a":"😀"}}]]]}}"#
            )),
            base(&format!(r#"{{"s":{ok}}},"extra":"\ud800""#)),
            base(&format!(r#"{{"\ud800":{ok}}}"#)),
            format!("  {}\n\n", base(&format!(r#"{{"s":{ok}}}"#))),
            format!("{}x", base(&format!(r#"{{"s":{ok}}}"#))),
            r#"{"v":2}"#.to_owned(),
            "7".to_owned(),
            String::new(),
        ];
        let sessions = ["s", "o", "oé", "absent", ""];
        let mut agreed = 0;
        let mut fell_back = 0;
        for text in &crafted {
            for s in sessions {
                if same(text.as_bytes(), s) {
                    agreed += 1;
                } else {
                    fell_back += 1;
                }
            }
        }
        assert!(fell_back > 0 && agreed > 150, "{agreed} / {fell_back}");
        let mut files = 0;
        for bytes in real_registration_files() {
            let Some(f) = parse_reg_file(&bytes) else {
                continue;
            };
            files += 1;
            let keys: Vec<String> = f.latest.iter().map(|(k, _)| k.to_owned()).collect();
            for k in keys.iter().map(String::as_str).chain(["absent", ""]) {
                assert!(same(&bytes, k), "a real file fell back");
            }
            for cut in (0..bytes.len()).step_by(bytes.len() / 40 + 1) {
                let _ = same(&bytes[..cut], keys.first().map_or("x", String::as_str));
            }
        }
        assert!(files > 20, "{files} real files");
    }

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
