//! The public incremental fold — the port of `core/snapshot.ts` (r1-fixes
//! 5.1, D20–D22; SPEC §Incremental fold; rust-core D14/D22): the fold,
//! retained between calls as a VERSIONED snapshot, so a consumer applies the
//! tail instead of replaying the stream.
//!
//! Laws (D20's rule): a snapshot is DERIVED state — not an event, never
//! written under `.sofar/` by the engine, never exported, imported or
//! synced. Its version is a readable field (D21) and a mismatch is a refusal
//! carrying both versions. Nothing here reads the clock or the environment.
//!
//! Refusals are a CLOSED set (D22) — exact strings the TypeScript engine
//! emits: `version`, `out_of_order_id`, `correction`, `invalid_line`,
//! `cursor_mismatch`. Every refusal is decided before anything is applied,
//! and means "refold from all events", never "close enough".

use std::fs;
use std::io;
use std::path::Path;
use std::sync::OnceLock;

use crate::envelope::{Envelope, error_detail, serialize_event, validate_envelope};
use crate::fold::{
    FoldCheckpoint, FoldResult, GraphEdge, InitiativeState, OrphanTaskEvent, append_to_checkpoint,
    finalize_fold, replay_decoded,
};
use crate::json::{self, Json, Object};
use crate::log::{count_lines, decode_lines};
use crate::sha256;
use crate::text::{cmp_utf16, js_trim};

/// The sofar.sh package version (`packages/engine/package.json`), read at
/// build time by `build.rs` — the `engine` half of a snapshot's version.
pub const ENGINE_VERSION: &str = env!("SOFAR_ENGINE_VERSION");

/// The committed fingerprint `npm run schema:emit` writes from
/// `schemaFingerprint()`; a snapshot's `schema` version is its sha256, byte
/// for byte (D22).
const SCHEMA_FINGERPRINT: &str = include_str!("../../../packages/schema/schema-fingerprint.txt");

/// Both halves readable, both compared on parse (D21).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotVersion {
    pub engine: String,
    pub schema: String,
}

impl SnapshotVersion {
    #[must_use]
    pub fn to_json(&self) -> Json {
        let mut o = Object::with_capacity(2);
        o.insert("engine", Json::Str(self.engine.clone()));
        o.insert("schema", Json::Str(self.schema.clone()));
        Json::Obj(o)
    }
}

/// Computed once per process (`currentSchemaHash`).
#[must_use]
pub fn current_schema_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| sha256::hex_digest(SCHEMA_FINGERPRINT.as_bytes()))
}

#[must_use]
pub fn current_version() -> SnapshotVersion {
    SnapshotVersion {
        engine: ENGINE_VERSION.to_owned(),
        schema: current_schema_hash().to_owned(),
    }
}

/// The bytes a snapshot folded (D22): what a file tail is checked against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotPrefix {
    /// UTF-8 bytes consumed, through the last consumed line's newline.
    pub bytes: usize,
    /// sha256 of those bytes, or `chain:<sha256 of "<previous>\n<tail>">`
    /// after a value tail whose earlier bytes the fold no longer holds.
    pub sha256: String,
    /// Lines consumed.
    pub lines: usize,
    /// sha256 of the last consumed line, without its newline; `""` when no line.
    pub last_line_sha256: String,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub version: SnapshotVersion,
    /// Greatest event id folded — the cursor a since-read continues from; `""` on an empty fold.
    pub cursor: String,
    pub prefix: SnapshotPrefix,
    pub slug: String,
    /// The retained replay. Opaque to consumers; [`state_of`] reads it.
    pub checkpoint: FoldCheckpoint,
}

/// Closed (D22): a second implementation must emit exactly these.
pub const FOLD_REFUSALS: [&str; 5] = [
    "version",
    "out_of_order_id",
    "correction",
    "invalid_line",
    "cursor_mismatch",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FoldRefusal {
    Version,
    OutOfOrderId,
    Correction,
    InvalidLine,
    CursorMismatch,
}

impl FoldRefusal {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            FoldRefusal::Version => "version",
            FoldRefusal::OutOfOrderId => "out_of_order_id",
            FoldRefusal::Correction => "correction",
            FoldRefusal::InvalidLine => "invalid_line",
            FoldRefusal::CursorMismatch => "cursor_mismatch",
        }
    }
}

/// `FoldStep`: the snapshot after a tail, or why it could not be applied.
#[derive(Debug, Clone)]
#[allow(
    clippy::large_enum_variant,
    reason = "the snapshot IS the result; a refusal is the rare arm"
)]
pub enum FoldStep {
    Ok(Snapshot),
    Refused { reason: FoldRefusal, detail: String },
}

impl FoldStep {
    /// `{ok: false, reason, detail}` for a refusal; `None` when the step applied.
    #[must_use]
    pub fn refusal_json(&self) -> Option<Json> {
        match self {
            FoldStep::Ok(_) => None,
            FoldStep::Refused { reason, detail } => {
                let mut o = Object::with_capacity(3);
                o.insert("ok", Json::Bool(false));
                o.insert("reason", Json::Str(reason.as_str().to_owned()));
                o.insert("detail", Json::Str(detail.clone()));
                Some(Json::Obj(o))
            }
        }
    }
}

/// `ParsedSnapshot`: a version mismatch carries both versions (D21).
#[derive(Debug, Clone)]
#[allow(
    clippy::large_enum_variant,
    reason = "the snapshot IS the result; a refusal is the rare arm"
)]
pub enum ParsedSnapshot {
    Ok(Snapshot),
    Version {
        found: SnapshotVersion,
        expected: SnapshotVersion,
    },
    Corrupt {
        detail: String,
    },
}

impl ParsedSnapshot {
    /// The refusal object the `fold` command prints; `None` when parsed.
    #[must_use]
    pub fn refusal_json(&self) -> Option<Json> {
        let mut o = Object::with_capacity(4);
        o.insert("ok", Json::Bool(false));
        match self {
            ParsedSnapshot::Ok(_) => return None,
            ParsedSnapshot::Version { found, expected } => {
                o.insert("reason", Json::Str("version".to_owned()));
                o.insert("found", found.to_json());
                o.insert("expected", expected.to_json());
            }
            ParsedSnapshot::Corrupt { detail } => {
                o.insert("reason", Json::Str("corrupt".to_owned()));
                o.insert("detail", Json::Str(detail.clone()));
            }
        }
        Some(Json::Obj(o))
    }
}

fn sha_hex(data: &[u8]) -> String {
    sha256::hex_digest(data)
}

/// A text's lines as a file read splits them, and the prefix they occupy (`splitText`).
fn split_text(text: &str) -> (Vec<&str>, SnapshotPrefix) {
    let lines: Vec<&str> = text.split('\n').collect();
    let count = count_lines(text);
    let consumed = if count == 0 {
        String::new()
    } else {
        format!("{}\n", lines[..count].join("\n"))
    };
    let prefix = SnapshotPrefix {
        bytes: consumed.len(),
        sha256: sha_hex(consumed.as_bytes()),
        lines: count,
        last_line_sha256: if count == 0 {
            String::new()
        } else {
            sha_hex(lines[count - 1].as_bytes())
        },
    };
    (lines, prefix)
}

fn lines_to_text<'a>(lines: impl IntoIterator<Item = &'a str>) -> String {
    let mut text = String::new();
    for line in lines {
        text.push_str(line);
        text.push('\n');
    }
    text
}

fn events_to_text(events: &[Envelope]) -> String {
    lines_to_text(
        events
            .iter()
            .map(serialize_event)
            .collect::<Vec<_>>()
            .iter()
            .map(String::as_str),
    )
}

fn from_text(text: &str, slug: &str) -> Snapshot {
    let (lines, prefix) = split_text(text);
    let checkpoint = replay_decoded(decode_lines(lines.iter().copied()), slug, prefix.lines);
    Snapshot {
        version: current_version(),
        cursor: checkpoint.last_id.clone(),
        prefix,
        slug: slug.to_owned(),
        checkpoint,
    }
}

/// The full fold of raw lines, retained (`foldAll`): what every incremental step starts from.
#[must_use]
pub fn fold_all<'a>(lines: impl IntoIterator<Item = &'a str>, slug: &str) -> Snapshot {
    from_text(&lines_to_text(lines), slug)
}

/// `foldAll` over events.
#[must_use]
pub fn fold_all_events(events: &[Envelope], slug: &str) -> Snapshot {
    from_text(&events_to_text(events), slug)
}

/// The full fold of a log file's bytes (`foldFile`); a missing file is an empty log.
pub fn fold_file(log_path: &Path, slug: &str) -> io::Result<Snapshot> {
    let text = match fs::read(log_path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    Ok(from_text(&text, slug))
}

fn version_refusal(snapshot: &Snapshot) -> Option<FoldStep> {
    let expected = current_version();
    if snapshot.version == expected {
        return None;
    }
    Some(FoldStep::Refused {
        reason: FoldRefusal::Version,
        detail: format!(
            "snapshot is engine {} schema {}; this is engine {} schema {}",
            snapshot.version.engine,
            head12(&snapshot.version.schema),
            expected.engine,
            head12(&expected.schema)
        ),
    })
}

/// `s.slice(0, 12)` — UTF-16 units, which for a hex digest are bytes.
fn head12(s: &str) -> String {
    s.encode_utf16().take(12).collect::<Vec<_>>().pipe_utf16()
}

trait PipeUtf16 {
    fn pipe_utf16(self) -> String;
}
impl PipeUtf16 for Vec<u16> {
    fn pipe_utf16(self) -> String {
        String::from_utf16_lossy(&self)
    }
}

/// Apply a tail (as text) — `applyText`. Every refusal is decided BEFORE
/// anything is applied, and the input snapshot is never mutated.
fn apply_text(snapshot: &Snapshot, tail: &str) -> FoldStep {
    if let Some(refused) = version_refusal(snapshot) {
        return refused;
    }
    let consumed: String = if tail.is_empty() || tail.ends_with('\n') {
        tail.to_owned()
    } else {
        format!("{tail}\n")
    };
    let lines: Vec<&str> = if consumed.is_empty() {
        Vec::new()
    } else {
        consumed[..consumed.len() - 1].split('\n').collect()
    };
    let mut last = snapshot.cursor.clone();
    for raw in &lines {
        let line = js_trim(raw);
        if line.is_empty() {
            continue;
        }
        let Ok(decoded) = json::parse(line) else {
            return FoldStep::Refused {
                reason: FoldRefusal::InvalidLine,
                detail: "a tail line is not JSON".to_owned(),
            };
        };
        let event = match validate_envelope(decoded) {
            Ok(event) => event,
            Err(errors) => {
                return FoldStep::Refused {
                    reason: FoldRefusal::InvalidLine,
                    detail: format!("a tail line is not an envelope: {}", error_detail(&errors)),
                };
            }
        };
        if event.event_type == "correction" {
            return FoldStep::Refused {
                reason: FoldRefusal::Correction,
                detail: format!(
                    "event {} is a correction, which voids an event already folded",
                    event.id
                ),
            };
        }
        if cmp_utf16(&event.id, &last).is_lt() {
            return FoldStep::Refused {
                reason: FoldRefusal::OutOfOrderId,
                detail: format!("event {} precedes the cursor {last}", event.id),
            };
        }
        last = event.id;
    }
    let mut cp = snapshot.checkpoint.clone();
    // Line numbers advance over every tail line, blank ones included, exactly
    // as a file read numbers them; only non-blank lines are applied.
    let mut line_no = cp.line_count;
    for raw in &lines {
        line_no += 1;
        let line = js_trim(raw);
        if line.is_empty() {
            continue;
        }
        cp.line_count = line_no - 1;
        if !append_to_checkpoint(&mut cp, line) {
            return FoldStep::Refused {
                reason: FoldRefusal::InvalidLine,
                detail: "the decoder rejected a tail line the pre-check accepted".to_owned(),
            };
        }
    }
    cp.line_count = line_no;
    let prefix = SnapshotPrefix {
        bytes: snapshot.prefix.bytes + consumed.len(),
        sha256: if consumed.is_empty() {
            snapshot.prefix.sha256.clone()
        } else {
            format!(
                "chain:{}",
                sha_hex(format!("{}\n{consumed}", snapshot.prefix.sha256).as_bytes())
            )
        },
        lines: cp.line_count,
        last_line_sha256: match lines.last() {
            Some(last_line) => sha_hex(last_line.as_bytes()),
            None => snapshot.prefix.last_line_sha256.clone(),
        },
    };
    FoldStep::Ok(Snapshot {
        version: snapshot.version.clone(),
        cursor: cp.last_id.clone(),
        prefix,
        slug: snapshot.slug.clone(),
        checkpoint: cp,
    })
}

/// Apply a tail of raw lines (`fold`). See [`apply_text`] for the refusal rules.
#[must_use]
pub fn fold_lines<'a>(snapshot: &Snapshot, lines: impl IntoIterator<Item = &'a str>) -> FoldStep {
    apply_text(snapshot, &lines_to_text(lines))
}

/// Apply a tail of events (`fold`).
#[must_use]
pub fn fold_events(snapshot: &Snapshot, events: &[Envelope]) -> FoldStep {
    apply_text(snapshot, &events_to_text(events))
}

/// Apply what a log FILE has gained since the snapshot (`foldFileSince`,
/// D22): the file's first `prefix.bytes` bytes must still hash to
/// `prefix.sha256` — else `cursor_mismatch`; `since`, when given, must equal
/// the snapshot's line count. The result carries the plain hash of the
/// file's consumed bytes. A missing file is empty; another read error is the caller's.
pub fn fold_file_since(
    snapshot: &Snapshot,
    log_path: &Path,
    since: Option<usize>,
) -> io::Result<FoldStep> {
    if let Some(refused) = version_refusal(snapshot) {
        return Ok(refused);
    }
    if let Some(since) = since
        && since != snapshot.prefix.lines
    {
        return Ok(FoldStep::Refused {
            reason: FoldRefusal::CursorMismatch,
            detail: format!(
                "since {since}, but the snapshot consumed {} line(s)",
                snapshot.prefix.lines
            ),
        });
    }
    let buffer = match fs::read(log_path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    if buffer.len() < snapshot.prefix.bytes {
        return Ok(FoldStep::Refused {
            reason: FoldRefusal::CursorMismatch,
            detail: format!(
                "the file holds {} byte(s), fewer than the {} the snapshot folded",
                buffer.len(),
                snapshot.prefix.bytes
            ),
        });
    }
    let head = &buffer[..snapshot.prefix.bytes];
    if snapshot.prefix.sha256.starts_with("chain:") {
        let last_line_hash = last_line_of(head).map_or_else(String::new, |l| sha_hex(l.as_bytes()));
        if last_line_hash != snapshot.prefix.last_line_sha256 {
            return Ok(FoldStep::Refused {
                reason: FoldRefusal::CursorMismatch,
                detail: "the last folded line is not where the snapshot left it".to_owned(),
            });
        }
    } else if sha_hex(head) != snapshot.prefix.sha256 {
        return Ok(FoldStep::Refused {
            reason: FoldRefusal::CursorMismatch,
            detail: format!(
                "the first {} byte(s) no longer hash to what the snapshot folded",
                snapshot.prefix.bytes
            ),
        });
    }
    let tail = String::from_utf8_lossy(&buffer[snapshot.prefix.bytes..]);
    let step = apply_text(snapshot, &tail);
    let FoldStep::Ok(mut next) = step else {
        return Ok(step);
    };
    let consumed_bytes = next.prefix.bytes;
    next.prefix.sha256 = if buffer.len() >= consumed_bytes {
        sha_hex(&buffer[..consumed_bytes])
    } else {
        let mut with_newline = buffer.clone();
        with_newline.push(b'\n');
        sha_hex(&with_newline)
    };
    Ok(FoldStep::Ok(next))
}

/// `lastLineOf`: the last line of the consumed bytes, as text.
fn last_line_of(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.strip_suffix('\n').unwrap_or(&text);
    if trimmed.is_empty() {
        return None;
    }
    Some(match trimmed.rfind('\n') {
        Some(at) => trimmed[at + 1..].to_owned(),
        None => trimmed.to_owned(),
    })
}

/// The folded state (`stateOf`) — finalized on a clone, so the snapshot stays reusable.
#[must_use]
pub fn state_of(snapshot: &Snapshot) -> FoldResult {
    let mut result = finalize_fold(&snapshot.checkpoint);
    if result.state.slug.is_empty() {
        result.state.slug.clone_from(&snapshot.slug);
    }
    result
}

/// `canonicalJSON`: keys sorted by code point recursively, arrays in order,
/// `JSON.stringify(v, null, 2)` verbatim (D22 (6)).
#[must_use]
pub fn canonical_json(value: &Json) -> String {
    json::stringify_pretty_canonical(value)
}

// --- the wire ---------------------------------------------------------------
// The serialized layout (`SnapshotWire`). Not a record format: bump the
// engine version to change it. Key order follows the TypeScript wire; the
// guard cache is a compile cache, rebuilt on demand, never carried.

fn str_arr<'a>(items: impl IntoIterator<Item = &'a str>) -> Json {
    Json::Arr(items.into_iter().map(|s| Json::Str(s.to_owned())).collect())
}

#[must_use]
pub fn serialize_snapshot(snapshot: &Snapshot) -> String {
    let cp = &snapshot.checkpoint;
    let mut prefix = Object::with_capacity(4);
    #[allow(
        clippy::cast_precision_loss,
        reason = "byte and line counts below 2^53"
    )]
    {
        prefix.insert("bytes", Json::Num(snapshot.prefix.bytes as f64));
        prefix.insert("sha256", Json::Str(snapshot.prefix.sha256.clone()));
        prefix.insert("lines", Json::Num(snapshot.prefix.lines as f64));
        prefix.insert(
            "last_line_sha256",
            Json::Str(snapshot.prefix.last_line_sha256.clone()),
        );
    }
    let mut checkpoint = Object::with_capacity(11);
    checkpoint.insert("slug", Json::Str(cp.slug.clone()));
    checkpoint.insert("state", cp.state.to_json());
    checkpoint.insert("warnings", str_arr(cp.warnings.iter().map(String::as_str)));
    checkpoint.insert("voided", str_arr(cp.voided.iter()));
    checkpoint.insert(
        "blockNotes",
        Json::Arr(
            cp.block_notes
                .iter()
                .map(|(k, v)| Json::Arr(vec![Json::Str(k.to_owned()), Json::Str(v.to_owned())]))
                .collect(),
        ),
    );
    checkpoint.insert(
        "edges",
        Json::Arr(cp.edges.iter().map(GraphEdge::to_json).collect()),
    );
    checkpoint.insert("seenSessions", str_arr(cp.seen_sessions.iter()));
    checkpoint.insert(
        "orphanCandidates",
        Json::Arr(
            cp.orphan_candidates
                .iter()
                .map(OrphanTaskEvent::to_json)
                .collect(),
        ),
    );
    checkpoint.insert("guardSeen", str_arr(cp.guard_seen.iter()));
    checkpoint.insert("lastId", Json::Str(cp.last_id.clone()));
    #[allow(clippy::cast_precision_loss, reason = "a line count below 2^53")]
    checkpoint.insert("lineCount", Json::Num(cp.line_count as f64));

    let mut wire = Object::with_capacity(5);
    wire.insert("version", snapshot.version.to_json());
    wire.insert("cursor", Json::Str(snapshot.cursor.clone()));
    wire.insert("prefix", Json::Obj(prefix));
    wire.insert("slug", Json::Str(snapshot.slug.clone()));
    wire.insert("checkpoint", Json::Obj(checkpoint));
    json::stringify(&Json::Obj(wire))
}

/// Parse a serialized snapshot (`parseSnapshot`). A version mismatch is a
/// REFUSAL carrying both versions (D21); corrupt text is a refusal too.
#[must_use]
pub fn parse_snapshot(text: &str) -> ParsedSnapshot {
    let corrupt = |detail: &str| ParsedSnapshot::Corrupt {
        detail: detail.to_owned(),
    };
    let Ok(raw) = json::parse(text) else {
        return corrupt("not JSON");
    };
    let Some(raw) = raw.as_obj() else {
        return corrupt("no readable version");
    };
    let version = raw.get("version").and_then(Json::as_obj);
    let (Some(engine), Some(schema)) = (
        version.and_then(|v| v.get("engine")).and_then(Json::as_str),
        version.and_then(|v| v.get("schema")).and_then(Json::as_str),
    ) else {
        return corrupt("no readable version");
    };
    let found = SnapshotVersion {
        engine: engine.to_owned(),
        schema: schema.to_owned(),
    };
    let expected = current_version();
    if found != expected {
        return ParsedSnapshot::Version { found, expected };
    }
    match parse_body(raw) {
        Some((cursor, prefix, slug, checkpoint)) => ParsedSnapshot::Ok(Snapshot {
            version: found,
            cursor,
            prefix,
            slug,
            checkpoint,
        }),
        None => corrupt("checkpoint shape is not this engine's"),
    }
}

fn usize_of(v: Option<&Json>) -> Option<usize> {
    let n = v?.as_f64()?;
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "a count the same engine wrote"
    )]
    (n >= 0.0 && n.fract() == 0.0).then_some(n as usize)
}

fn string_list(v: Option<&Json>) -> Option<Vec<String>> {
    v?.as_arr()?
        .iter()
        .map(|s| s.as_str().map(str::to_owned))
        .collect()
}

fn parse_body(raw: &Object) -> Option<(String, SnapshotPrefix, String, FoldCheckpoint)> {
    let cp = raw.get("checkpoint")?.as_obj()?;
    let prefix = raw.get("prefix")?.as_obj()?;
    let prefix = SnapshotPrefix {
        bytes: usize_of(prefix.get("bytes"))?,
        sha256: prefix.get("sha256")?.as_str()?.to_owned(),
        lines: usize_of(prefix.get("lines"))?,
        last_line_sha256: prefix.get("last_line_sha256")?.as_str()?.to_owned(),
    };
    let cursor = raw.get("cursor")?.as_str()?.to_owned();
    let slug = raw.get("slug")?.as_str()?.to_owned();
    let mut block_notes = crate::collections::StringMap::new();
    for entry in cp.get("blockNotes")?.as_arr()? {
        let pair = entry.as_arr()?;
        if pair.len() != 2 {
            return None;
        }
        block_notes.set(pair[0].as_str()?, pair[1].as_str()?.to_owned());
    }
    let checkpoint = FoldCheckpoint {
        slug: cp.get("slug")?.as_str()?.to_owned(),
        state: InitiativeState::from_json(cp.get("state")?.as_obj()?)?,
        warnings: string_list(cp.get("warnings"))?,
        voided: string_list(cp.get("voided"))?.into_iter().collect(),
        block_notes,
        edges: cp
            .get("edges")?
            .as_arr()?
            .iter()
            .map(|e| GraphEdge::from_json(e.as_obj()?))
            .collect::<Option<_>>()?,
        seen_sessions: string_list(cp.get("seenSessions"))?.into_iter().collect(),
        orphan_candidates: cp
            .get("orphanCandidates")?
            .as_arr()?
            .iter()
            .map(|o| OrphanTaskEvent::from_json(o.as_obj()?))
            .collect::<Option<_>>()?,
        guard_cache: std::collections::HashMap::new(),
        guard_seen: string_list(cp.get("guardSeen"))?.into_iter().collect(),
        last_id: cp.get("lastId")?.as_str()?.to_owned(),
        line_count: usize_of(cp.get("lineCount"))?,
    };
    Some((cursor, prefix, slug, checkpoint))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fold::fold_text;

    fn line(id: &str, ts: &str, session: &str, event_type: &str, payload: &str) -> String {
        format!(
            "{{\"v\":1,\"id\":\"{id}\",\"ts\":\"{ts}\",\"initiative\":\"demo\",\"session\":\"{session}\",\"source\":\"hook\",\"actor\":\"agent\",\"type\":\"{event_type}\",\"payload\":{payload}}}"
        )
    }

    fn story() -> Vec<String> {
        vec![
            line(
                "01K4C0000000000000000000A1",
                "2026-09-16T00:00:01.000Z",
                "cli",
                "initiative_created",
                "{\"slug\":\"demo\",\"goal\":\"g\"}",
            ),
            line(
                "01K4C0000000000000000000A2",
                "2026-09-16T00:00:02.000Z",
                "s1",
                "session_started",
                "{\"tool\":\"claude-code\"}",
            ),
            line(
                "01K4C0000000000000000000A3",
                "2026-09-16T00:00:03.000Z",
                "s1",
                "plan_updated",
                "{\"plan\":{\"goal\":\"g\",\"phases\":[{\"name\":\"Phase 1\",\"status\":\"active\",\"tasks\":[{\"id\":\"1.1\",\"title\":\"a\"},{\"id\":\"1.2\",\"title\":\"b\"}]}]}}",
            ),
            line(
                "01K4C0000000000000000000A4",
                "2026-09-16T00:00:04.000Z",
                "s1",
                "task_status_changed",
                "{\"id\":\"1.1\",\"status\":\"active\"}",
            ),
            line(
                "01K4C0000000000000000000A5",
                "2026-09-16T00:00:05.000Z",
                "s1",
                "file_touched",
                "{\"path\":\"src/a.ts\",\"op\":\"edit\"}",
            ),
            line(
                "01K4C0000000000000000000A6",
                "2026-09-16T00:00:06.000Z",
                "s1",
                "decision_logged",
                "{\"chose\":\"x\",\"over\":\"y\",\"because\":\"z\",\"rule\":\"Never do y.\",\"guard\":\"path:src/y/**\"}",
            ),
            line(
                "01K4C0000000000000000000A7",
                "2026-09-16T00:00:07.000Z",
                "s1",
                "file_touched",
                "{\"path\":\"src/y/b.ts\",\"op\":\"write\"}",
            ),
            line(
                "01K4C0000000000000000000A8",
                "2026-09-16T00:00:08.000Z",
                "s1",
                "command_run",
                "{\"cmd\":\"npm test\"}",
            ),
            line(
                "01K4C0000000000000000000A9",
                "2026-09-16T00:00:09.000Z",
                "s1",
                "task_status_changed",
                "{\"id\":\"9.9\",\"status\":\"done\"}",
            ),
            line(
                "01K4C0000000000000000000AA",
                "2026-09-16T00:00:10.000Z",
                "s1",
                "session_ended",
                "{\"summary\":\"s\",\"next_action\":\"n\"}",
            ),
        ]
    }

    #[test]
    fn fold_all_then_fold_tail_equals_the_full_fold_prefix_by_prefix() {
        let all = story();
        let text = format!("{}\n", all.join("\n"));
        let fresh = fold_text(&text, "demo");
        for n in 0..=all.len() {
            let base = fold_all(all[..n].iter().map(String::as_str), "demo");
            let before = serialize_snapshot(&base);
            let FoldStep::Ok(next) = fold_lines(&base, all[n..].iter().map(String::as_str)) else {
                panic!("prefix {n} refused");
            };
            assert_eq!(state_of(&next), fresh, "prefix {n}");
            assert_eq!(serialize_snapshot(&base), before, "input mutated at {n}");
            assert_eq!(next.cursor, "01K4C0000000000000000000AA");
            assert_eq!(next.prefix.lines, all.len());
        }
        assert_eq!(fresh.state.guard_violations.len(), 1);
    }

    #[test]
    fn version_is_readable_and_a_mismatch_carries_both() {
        let all = story();
        let snap = fold_all(all.iter().map(String::as_str), "demo");
        assert_eq!(snap.version, current_version());
        assert_eq!(snap.version.schema.len(), 64);
        let text = serialize_snapshot(&snap);
        let ParsedSnapshot::Ok(round) = parse_snapshot(&text) else {
            panic!("round trip");
        };
        assert_eq!(state_of(&round), state_of(&snap));
        assert_eq!(serialize_snapshot(&round), text);
        let bumped = text.replacen(
            &format!("\"engine\":\"{}\"", snap.version.engine),
            "\"engine\":\"99.0.0\"",
            1,
        );
        match parse_snapshot(&bumped) {
            ParsedSnapshot::Version { found, expected } => {
                assert_eq!(found.engine, "99.0.0");
                assert_eq!(found.schema, snap.version.schema);
                assert_eq!(expected, current_version());
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse_snapshot("not json"),
            ParsedSnapshot::Corrupt { .. }
        ));
        assert!(matches!(
            parse_snapshot("{\"version\":{\"engine\":\"x\",\"schema\":\"y\"}}"),
            ParsedSnapshot::Version { .. }
        ));
        let mut stale = snap.clone();
        stale.version.engine = "0.0.1".to_owned();
        assert!(matches!(
            fold_lines(&stale, std::iter::empty()),
            FoldStep::Refused {
                reason: FoldRefusal::Version,
                ..
            }
        ));
    }

    #[test]
    fn refusals_are_the_closed_set_and_apply_nothing() {
        let all = story();
        let snap = fold_all(all[..6].iter().map(String::as_str), "demo");
        let before = serialize_snapshot(&snap);
        let early = line(
            "00000000000000000000000000",
            "2026-09-16T00:00:10.000Z",
            "s1",
            "note_added",
            "{\"text\":\"late\"}",
        );
        let corr = line(
            "01K4C0000000000000000000AB",
            "2026-09-16T00:00:11.000Z",
            "s1",
            "correction",
            "{\"ref\":\"01K4C0000000000000000000A5\"}",
        );
        let reason = |step: FoldStep| match step {
            FoldStep::Refused { reason, .. } => reason,
            FoldStep::Ok(_) => panic!("applied"),
        };
        assert_eq!(
            reason(fold_lines(&snap, [all[6].as_str(), early.as_str()])),
            FoldRefusal::OutOfOrderId
        );
        assert_eq!(
            reason(fold_lines(&snap, [corr.as_str()])),
            FoldRefusal::Correction
        );
        assert_eq!(
            reason(fold_lines(&snap, ["not json{{{"])),
            FoldRefusal::InvalidLine
        );
        assert_eq!(
            reason(fold_lines(&snap, ["{\"v\":1,\"id\":\"x\"}"])),
            FoldRefusal::InvalidLine
        );
        assert_eq!(serialize_snapshot(&snap), before);
        assert_eq!(
            FOLD_REFUSALS,
            [
                "version",
                "out_of_order_id",
                "correction",
                "invalid_line",
                "cursor_mismatch"
            ]
        );
    }

    #[test]
    fn file_tail_applies_with_a_prefix_check() {
        let dir = crate::testing::scratch_dir("snapshot");
        let path = dir.join("events.jsonl");
        let all = story();
        fs::write(&path, format!("{}\n", all[..4].join("\n"))).unwrap();
        let base = fold_file(&path, "demo").unwrap();
        assert_eq!(base.prefix.lines, 4);
        fs::write(&path, format!("{}\n", all.join("\n"))).unwrap();
        let FoldStep::Ok(next) = fold_file_since(&base, &path, Some(4)).unwrap() else {
            panic!("tail refused");
        };
        assert_eq!(
            state_of(&next),
            fold_text(&format!("{}\n", all.join("\n")), "demo")
        );
        assert_eq!(
            next.prefix.sha256,
            sha256::hex_digest(fs::read(&path).unwrap().as_slice())
        );
        assert!(matches!(
            fold_file_since(&base, &path, Some(3)).unwrap(),
            FoldStep::Refused {
                reason: FoldRefusal::CursorMismatch,
                ..
            }
        ));
        // A rewritten prefix is a cursor mismatch, as is a shorter file.
        fs::write(&path, format!("{}\n", all[1..].join("\n"))).unwrap();
        assert!(matches!(
            fold_file_since(&base, &path, None).unwrap(),
            FoldStep::Refused {
                reason: FoldRefusal::CursorMismatch,
                ..
            }
        ));
        fs::write(&path, format!("{}\n", all[..2].join("\n"))).unwrap();
        assert!(matches!(
            fold_file_since(&base, &path, None).unwrap(),
            FoldStep::Refused {
                reason: FoldRefusal::CursorMismatch,
                ..
            }
        ));
        // A chained prefix (after a value tail) checks the last line only.
        fs::write(&path, format!("{}\n", all.join("\n"))).unwrap();
        let FoldStep::Ok(chained) = fold_lines(&base, all[4..7].iter().map(String::as_str)) else {
            panic!()
        };
        assert!(chained.prefix.sha256.starts_with("chain:"));
        let FoldStep::Ok(rest) = fold_file_since(&chained, &path, Some(7)).unwrap() else {
            panic!("chained tail refused");
        };
        assert_eq!(state_of(&rest), state_of(&next));
        // A file without a trailing newline hashes as if it had one.
        fs::write(&path, all.join("\n")).unwrap();
        let FoldStep::Ok(unterminated) = fold_file_since(&base, &path, None).unwrap() else {
            panic!()
        };
        assert_eq!(unterminated.prefix.sha256, next.prefix.sha256);
        fs::remove_dir_all(&dir).unwrap();
    }
}
