//! The v1 event envelope — the port of `core/envelope.ts` and the canonical
//! serializer of `core/log.ts` (SPEC §Event envelope, FORMAT.md §3). The
//! envelope lives outside the schema package, so this file is hand-written
//! (rust-core 2.2); payload types stay generated.
//!
//! Every error string is the TypeScript one verbatim: the fold prints them
//! (`syn.corrupt` golden) and D2 forbids a looser suite.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::json::{self, Json, Object};

pub const ENVELOPE_VERSION: u8 = 1;
pub const SOURCES: [&str; 5] = ["claude-code", "opencode", "codex", "cli", "hook"];
pub const ACTORS: [&str; 2] = ["agent", "human"];

/// Envelope fields in the fixed schema order the append path writes.
const KEY_ORDER: [&str; 10] = [
    "v",
    "id",
    "ts",
    "initiative",
    "session",
    "source",
    "actor",
    "user",
    "type",
    "payload",
];

/// A validated v1 envelope. `extras` holds unknown additive fields (a future
/// field, as `user` once was), preserved after the known ones on
/// serialization so an older client never strips what a newer one minted.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    pub id: String,
    pub ts: String,
    pub initiative: String,
    pub session: String,
    pub source: String,
    pub actor: String,
    pub user: Option<String>,
    pub event_type: String,
    pub payload: Object,
    pub extras: Vec<(String, Json)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeError {
    pub field: &'static str,
    pub message: String,
}

/// `errors.map((e) => `${e.field}: ${e.message}`).join('; ')`.
#[must_use]
pub fn error_detail(errors: &[EnvelopeError]) -> String {
    errors
        .iter()
        .map(|e| format!("{}: {}", e.field, e.message))
        .collect::<Vec<_>>()
        .join("; ")
}

/// `^[0-9A-HJKMNP-TV-Z]{26}$`.
#[must_use]
pub fn is_ulid(s: &str) -> bool {
    s.len() == 26 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J' | b'K' | b'M' | b'N' | b'P'..=b'T' | b'V'..=b'Z'))
}

/// The envelope's timestamp rule: the shape regex
/// `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$` AND
/// `Date.parse` not NaN. V8's ISO parser range-checks fields but not the
/// day against its month (`2026-02-30` parses), allows hour 24 only at
/// exactly `24:00:00[.0…]`, and caps the zone at `23:59`.
#[must_use]
pub fn is_iso8601_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        b.get(range)
            .is_some_and(|d| d.iter().all(u8::is_ascii_digit))
    };
    let num = |range: std::ops::Range<usize>| -> u32 { s[range].parse().unwrap_or(u32::MAX) };
    if b.len() < 20
        || !digits(0..4)
        || b[4] != b'-'
        || !digits(5..7)
        || b[7] != b'-'
        || !digits(8..10)
        || b[10] != b'T'
    {
        return false;
    }
    if !digits(11..13) || b[13] != b':' || !digits(14..16) || b[16] != b':' || !digits(17..19) {
        return false;
    }
    let mut pos = 19;
    let mut fraction_zero = true;
    if b.get(pos) == Some(&b'.') {
        let start = pos + 1;
        let mut end = start;
        while b.get(end).is_some_and(u8::is_ascii_digit) {
            end += 1;
        }
        if end == start {
            return false;
        }
        fraction_zero = b[start..end].iter().all(|d| *d == b'0');
        pos = end;
    }
    match b.get(pos) {
        Some(b'Z') => {
            if pos + 1 != b.len() {
                return false;
            }
        }
        Some(b'+' | b'-') => {
            if pos + 6 != b.len()
                || !digits(pos + 1..pos + 3)
                || b[pos + 3] != b':'
                || !digits(pos + 4..pos + 6)
            {
                return false;
            }
            if num(pos + 1..pos + 3) > 23 || num(pos + 4..pos + 6) > 59 {
                return false;
            }
        }
        _ => return false,
    }
    let month = num(5..7);
    let day = num(8..10);
    let hour = num(11..13);
    let minute = num(14..16);
    let second = num(17..19);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || minute > 59 || second > 59 {
        return false;
    }
    match hour {
        0..=23 => true,
        24 => minute == 0 && second == 0 && fraction_zero,
        _ => false,
    }
}

/// Structural validation of a decoded log line against the v1 envelope
/// (`validateEnvelope`). Payload CONTENTS are not validated here; unknown
/// event types pass. Consumes the value so a valid line moves, not copies.
pub fn validate_envelope(value: Json) -> Result<Envelope, Vec<EnvelopeError>> {
    let Json::Obj(mut obj) = value else {
        return Err(vec![EnvelopeError {
            field: "(root)",
            message: "event must be a JSON object".into(),
        }]);
    };
    let mut errors = Vec::new();
    let mut push =
        |field: &'static str, message: String| errors.push(EnvelopeError { field, message });

    if obj.get("v") != Some(&Json::Num(f64::from(ENVELOPE_VERSION))) {
        push("v", format!("must be {ENVELOPE_VERSION}"));
    }
    if !obj.get("id").and_then(Json::as_str).is_some_and(is_ulid) {
        push("id", "must be a 26-char ulid".into());
    }
    if !obj
        .get("ts")
        .and_then(Json::as_str)
        .is_some_and(is_iso8601_timestamp)
    {
        push("ts", "must be an ISO8601 timestamp".into());
    }
    if obj
        .get("initiative")
        .and_then(Json::as_nonempty_str)
        .is_none()
    {
        push("initiative", "must be a non-empty slug".into());
    }
    if obj.get("session").and_then(Json::as_nonempty_str).is_none() {
        push(
            "session",
            "must be a non-empty session id (or \"cli\")".into(),
        );
    }
    if !obj
        .get("source")
        .and_then(Json::as_str)
        .is_some_and(|s| SOURCES.contains(&s))
    {
        push("source", format!("must be one of: {}", SOURCES.join(", ")));
    }
    if !obj
        .get("actor")
        .and_then(Json::as_str)
        .is_some_and(|s| ACTORS.contains(&s))
    {
        push("actor", format!("must be one of: {}", ACTORS.join(", ")));
    }
    if obj.contains_key("user") && obj.get("user").and_then(Json::as_nonempty_str).is_none() {
        push("user", "when present, must be a non-empty string".into());
    }
    if obj.get("type").and_then(Json::as_nonempty_str).is_none() {
        push("type", "must be a non-empty event type".into());
    }
    if obj.get("payload").and_then(Json::as_obj).is_none() {
        push("payload", "must be a JSON object".into());
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    let take_str = |obj: &mut Object, key: &str| match obj.remove(key) {
        Some(Json::Str(s)) => s,
        _ => unreachable!("validated above"),
    };
    let id = take_str(&mut obj, "id");
    let ts = take_str(&mut obj, "ts");
    let initiative = take_str(&mut obj, "initiative");
    let session = take_str(&mut obj, "session");
    let source = take_str(&mut obj, "source");
    let actor = take_str(&mut obj, "actor");
    let user = obj.remove("user").map(|u| match u {
        Json::Str(s) => s,
        _ => unreachable!("validated above"),
    });
    let event_type = take_str(&mut obj, "type");
    let Some(Json::Obj(payload)) = obj.remove("payload") else {
        unreachable!("validated above")
    };
    obj.remove("v");
    let extras: Vec<(String, Json)> = obj.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect();
    Ok(Envelope {
        id,
        ts,
        initiative,
        session,
        source,
        actor,
        user,
        event_type,
        payload,
        extras,
    })
}

/// Canonical serialization (`serializeEvent`): the byte form is a pure
/// function of the envelope VALUE — fixed field order, `user` omitted when
/// absent, extras after `payload` sorted by code point, payload keys sorted
/// recursively, no whitespace, `ts` verbatim.
#[must_use]
pub fn serialize_event(event: &Envelope) -> String {
    let mut out = String::with_capacity(256);
    out.push_str("{\"v\":1,\"id\":");
    json::write_string(&mut out, &event.id);
    out.push_str(",\"ts\":");
    json::write_string(&mut out, &event.ts);
    out.push_str(",\"initiative\":");
    json::write_string(&mut out, &event.initiative);
    out.push_str(",\"session\":");
    json::write_string(&mut out, &event.session);
    out.push_str(",\"source\":");
    json::write_string(&mut out, &event.source);
    out.push_str(",\"actor\":");
    json::write_string(&mut out, &event.actor);
    if let Some(user) = &event.user {
        out.push_str(",\"user\":");
        json::write_string(&mut out, user);
    }
    out.push_str(",\"type\":");
    json::write_string(&mut out, &event.event_type);
    out.push_str(",\"payload\":");
    let mut extras: Vec<&(String, Json)> = event
        .extras
        .iter()
        .filter(|(k, _)| !KEY_ORDER.contains(&k.as_str()))
        .collect();
    extras.sort_by(|a, b| a.0.cmp(&b.0));
    out.push('{');
    for (i, (k, v)) in event.payload.sorted().into_iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json::write_string(&mut out, k);
        out.push(':');
        json::write_value(&mut out, v, true);
    }
    out.push('}');
    for (k, v) in extras {
        out.push(',');
        json::write_string(&mut out, k);
        out.push(':');
        json::write_value(&mut out, v, true);
    }
    out.push('}');
    out
}

/// What a caller supplies to mint an event (`MakeEventInput`).
#[derive(Debug, Clone)]
pub struct MakeEventInput {
    pub initiative: String,
    pub session: String,
    pub source: &'static str,
    pub actor: &'static str,
    pub event_type: String,
    pub payload: Object,
}

/// Build a valid envelope with a fresh monotonic ulid, the current time and
/// the author identity (`makeEvent`). Identity is looked up once per
/// process and omitted when unavailable — an append never fails for it.
pub fn make_event(input: MakeEventInput) -> Result<Envelope, String> {
    make_event_at(
        input,
        SystemTime::now(),
        crate::identity::git_user_email().map(str::to_owned),
    )
}

/// `make_event` with the clock and identity supplied — the seam tests use.
pub fn make_event_at(
    input: MakeEventInput,
    now: SystemTime,
    user: Option<String>,
) -> Result<Envelope, String> {
    let event = Envelope {
        id: mint_ulid(now),
        ts: to_iso_string(now),
        initiative: input.initiative,
        session: input.session,
        source: input.source.to_owned(),
        actor: input.actor.to_owned(),
        user,
        event_type: input.event_type,
        payload: input.payload,
        extras: Vec::new(),
    };
    check_minted(&event)?;
    Ok(event)
}

/// The re-validation `makeEvent` performs on its own output.
fn check_minted(event: &Envelope) -> Result<(), String> {
    let mut errors = Vec::new();
    if event.initiative.is_empty() {
        errors.push(EnvelopeError {
            field: "initiative",
            message: "must be a non-empty slug".into(),
        });
    }
    if event.session.is_empty() {
        errors.push(EnvelopeError {
            field: "session",
            message: "must be a non-empty session id (or \"cli\")".into(),
        });
    }
    if let Some(user) = &event.user
        && user.is_empty()
    {
        errors.push(EnvelopeError {
            field: "user",
            message: "when present, must be a non-empty string".into(),
        });
    }
    if event.event_type.is_empty() {
        errors.push(EnvelopeError {
            field: "type",
            message: "must be a non-empty event type".into(),
        });
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "makeEvent produced an invalid envelope — {}",
            error_detail(&errors)
        ))
    }
}

/// Same-millisecond ulids from a plain generator are randomly ordered; the
/// cursor contract needs creation order to match sort order, so ids are
/// monotonic within the process (`monotonicFactory`). On the vanishingly
/// rare random-part overflow a fresh random ulid is taken.
static GENERATOR: Mutex<ulid::Generator> = Mutex::new(ulid::Generator::new());

#[must_use]
pub fn mint_ulid(now: SystemTime) -> String {
    let mut generator = GENERATOR
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match generator.generate_from_datetime(now) {
        Ok(id) => id.to_string(),
        Err(overflow) => overflow.commit_overflow_random().to_string(),
    }
}

/// `new Date(t).toISOString()` — millisecond precision, `Z` suffix (P9).
#[must_use]
pub fn to_iso_string(t: SystemTime) -> String {
    let ms: i64 = match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    };
    iso_from_epoch_ms(ms)
}

/// `new Date(ms).toISOString()` for years 0000–9999 (the six-digit
/// `±YYYYYY` form outside that range is not a form the log ever carries).
#[must_use]
pub fn iso_from_epoch_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let hh = rem / 3_600_000;
    let mm = (rem / 60_000) % 60;
    let ss = (rem / 1000) % 60;
    let mss = rem % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{mss:03}Z")
}

/// Days since 1970-01-01 → proleptic Gregorian (y, m, d); Howard Hinnant's
/// `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (
        y,
        u32::try_from(m).expect("1..=12"),
        u32::try_from(d).expect("1..=31"),
    )
}

impl Envelope {
    /// The envelope as a JSON value again, for callers that hand it on.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut obj = Object::with_capacity(10 + self.extras.len());
        obj.insert("v", Json::Num(f64::from(ENVELOPE_VERSION)));
        obj.insert("id", Json::Str(self.id.clone()));
        obj.insert("ts", Json::Str(self.ts.clone()));
        obj.insert("initiative", Json::Str(self.initiative.clone()));
        obj.insert("session", Json::Str(self.session.clone()));
        obj.insert("source", Json::Str(self.source.clone()));
        obj.insert("actor", Json::Str(self.actor.clone()));
        if let Some(u) = &self.user {
            obj.insert("user", Json::Str(u.clone()));
        }
        obj.insert("type", Json::Str(self.event_type.clone()));
        obj.insert("payload", Json::Obj(self.payload.clone()));
        for (k, v) in &self.extras {
            obj.insert(k.clone(), v.clone());
        }
        Json::Obj(obj)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    const LINE: &str = "{\"v\":1,\"id\":\"01K4C0000000000000000000AA\",\"ts\":\"2026-09-01T10:00:00.000Z\",\"initiative\":\"x\",\"session\":\"cli\",\"source\":\"cli\",\"actor\":\"agent\",\"type\":\"note_added\",\"payload\":{\"text\":\"hi\"}}";

    fn errors_of(text: &str) -> String {
        match validate_envelope(parse(text).unwrap()) {
            Ok(_) => String::new(),
            Err(errors) => error_detail(&errors),
        }
    }

    #[test]
    fn valid_line_round_trips_byte_for_byte() {
        let event = validate_envelope(parse(LINE).unwrap()).unwrap();
        assert_eq!(serialize_event(&event), LINE);
        assert_eq!(event.user, None);
        assert!(event.extras.is_empty());
    }

    #[test]
    fn error_strings_and_order_match_typescript() {
        assert_eq!(errors_of("[1,2,3]"), "(root): event must be a JSON object");
        assert_eq!(
            errors_of("\"just a string\""),
            "(root): event must be a JSON object"
        );
        let bad_ts = LINE
            .replace("2026-09-01T10:00:00.000Z", "2026-13-45T99:00:00Z")
            .replace("01K4C0000000000000000000AA", "01K4C00000000000000000BAD");
        assert_eq!(
            errors_of(&bad_ts),
            "id: must be a 26-char ulid; ts: must be an ISO8601 timestamp"
        );
        let no_payload = LINE
            .replace("{\"text\":\"hi\"}", "\"not an object\"")
            .replace("01K4C0000000000000000000AA", "01K4C0000000000000000NOPL");
        assert_eq!(
            errors_of(&no_payload),
            "id: must be a 26-char ulid; payload: must be a JSON object"
        );
        assert_eq!(
            errors_of("{}"),
            "v: must be 1; id: must be a 26-char ulid; ts: must be an ISO8601 timestamp; initiative: must be a non-empty slug; session: must be a non-empty session id (or \"cli\"); source: must be one of: claude-code, opencode, codex, cli, hook; actor: must be one of: agent, human; type: must be a non-empty event type; payload: must be a JSON object"
        );
        assert_eq!(
            errors_of(&LINE.replace("\"type\":", "\"user\":null,\"type\":")),
            "user: when present, must be a non-empty string"
        );
        assert_eq!(
            errors_of(&LINE.replace("\"type\":", "\"user\":\"\",\"type\":")),
            "user: when present, must be a non-empty string"
        );
        assert_eq!(
            errors_of(&LINE.replace("\"v\":1", "\"v\":\"1\"")),
            "v: must be 1"
        );
        assert_eq!(errors_of(&LINE.replace("\"v\":1", "\"v\":1.0")), "");
    }

    #[test]
    fn extras_survive_after_payload_sorted_and_user_in_place() {
        let text = LINE.replace(
            "\"type\":",
            "\"zeta\":1,\"alpha\":{\"b\":1,\"a\":2},\"user\":\"me@x\",\"type\":",
        );
        let event = validate_envelope(parse(&text).unwrap()).unwrap();
        assert_eq!(event.user.as_deref(), Some("me@x"));
        assert_eq!(
            serialize_event(&event),
            "{\"v\":1,\"id\":\"01K4C0000000000000000000AA\",\"ts\":\"2026-09-01T10:00:00.000Z\",\"initiative\":\"x\",\"session\":\"cli\",\"source\":\"cli\",\"actor\":\"agent\",\"user\":\"me@x\",\"type\":\"note_added\",\"payload\":{\"text\":\"hi\"},\"alpha\":{\"a\":2,\"b\":1},\"zeta\":1}"
        );
        // And the JSON view carries everything back.
        let again = validate_envelope(event.to_json()).unwrap();
        assert_eq!(again, event);
    }

    #[test]
    fn payload_is_canonical_with_js_numbers() {
        let text = LINE.replace(
            "{\"text\":\"hi\"}",
            "{\"z\":1e21,\"a\":1e-7,\"m\":-0,\"f\":1.0,\"big\":12345678901234567890,\"s\":0.30000000000000004,\"tiny\":5e-324,\"nest\":{\"b\":[null,1,{\"y\":2,\"x\":1}],\"a\":true},\"dup\":1,\"dup\":2}",
        );
        let event = validate_envelope(parse(&text).unwrap()).unwrap();
        assert!(serialize_event(&event).ends_with(
            "\"payload\":{\"a\":1e-7,\"big\":12345678901234567000,\"dup\":2,\"f\":1,\"m\":0,\"nest\":{\"a\":true,\"b\":[null,1,{\"x\":1,\"y\":2}]},\"s\":0.30000000000000004,\"tiny\":5e-324,\"z\":1e+21}}"
        ));
    }

    #[test]
    fn timestamp_rule_follows_v8_ranges() {
        for ok in [
            "2026-09-01T10:00:00.000Z",
            "2026-02-30T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T24:00:00.000Z",
            "2026-01-01T23:59:59.9999999Z",
            "2026-01-01T23:59:59+23:59",
            "0000-01-01T00:00:00Z",
            "9999-12-31T23:59:59-00:00",
            "2026-01-01T00:00:00.1Z",
        ] {
            assert!(is_iso8601_timestamp(ok), "{ok}");
        }
        for bad in [
            "2026-13-45T99:00:00Z",
            "2026-01-00T00:00:00Z",
            "2026-00-10T00:00:00Z",
            "2026-01-32T00:00:00Z",
            "2026-01-01T24:00:01Z",
            "2026-01-01T24:00:00.5Z",
            "2026-01-01T23:60:00Z",
            "2026-01-01T23:59:60Z",
            "2026-01-01T23:59:59+24:00",
            "2026-01-01T23:59:59+23:60",
            "2026-01-01T00:00:00.Z",
            "2026-01-01T00:00:00",
            "2026-01-01",
            "2026-01-01T00:00:00z",
            "2026-01-01T00:00:00Z ",
            "\u{661}026-01-01T00:00:00Z",
            "",
        ] {
            assert!(!is_iso8601_timestamp(bad), "{bad}");
        }
    }

    #[test]
    fn iso_string_matches_date_to_iso_string() {
        assert_eq!(iso_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_epoch_ms(1_767_225_600_100),
            "2026-01-01T00:00:00.100Z"
        );
        assert_eq!(
            iso_from_epoch_ms(1_772_409_600_000),
            "2026-03-02T00:00:00.000Z"
        );
        assert_eq!(
            iso_from_epoch_ms(253_402_300_799_000),
            "9999-12-31T23:59:59.000Z"
        );
        assert_eq!(
            iso_from_epoch_ms(-62_167_219_200_000),
            "0000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            iso_from_epoch_ms(951_782_400_000),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(iso_from_epoch_ms(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn minted_events_are_valid_monotonic_and_stamp_identity() {
        let now = SystemTime::now();
        let input = || MakeEventInput {
            initiative: "x".into(),
            session: "s".into(),
            source: "hook",
            actor: "agent",
            event_type: "note_added".into(),
            payload: [("text".to_owned(), Json::Str("hi".into()))]
                .into_iter()
                .collect(),
        };
        let a = make_event_at(input(), now, Some("me@example.invalid".into())).unwrap();
        let b = make_event_at(input(), now, None).unwrap();
        assert!(is_ulid(&a.id) && is_ulid(&b.id));
        assert!(
            a.id < b.id,
            "same-millisecond ids must stay ordered: {} {}",
            a.id,
            b.id
        );
        assert!(serialize_event(&a).contains(",\"user\":\"me@example.invalid\",\"type\":"));
        assert!(!serialize_event(&b).contains("\"user\""));
        assert!(validate_envelope(a.to_json()).is_ok());
        let bad = make_event_at(
            MakeEventInput {
                session: String::new(),
                ..input()
            },
            now,
            None,
        )
        .unwrap_err();
        assert_eq!(
            bad,
            "makeEvent produced an invalid envelope — session: must be a non-empty session id (or \"cli\")"
        );
    }
}
