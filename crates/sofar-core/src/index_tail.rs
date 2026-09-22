//! Read only what a log has grown by (`core/index-tail.ts`, record-index
//! 1.2): a cursor's offset is corroborated by the id at that line, never
//! trusted; anything else is a full read.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;

use crate::envelope::validate_envelope;
use crate::index_store::{Cursor, LogStat, cursor_usable, log_stat, log_untouched, mtime_ms_of};
use crate::json::{self, Json, Object};
use crate::payload::validate_payload;
use crate::text::js_trim;

/// A decoded envelope, only as far as the index needs it.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexedEvent {
    pub id: String,
    pub event_type: String,
    pub session: String,
    pub initiative: String,
    pub payload: Object,
    pub ts: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TailRead {
    pub events: Vec<IndexedEvent>,
    /// Cursor to persist, or None when the log held no usable event.
    pub cursor: Option<Cursor>,
    /// True when the whole log was read.
    pub full: bool,
}

/// `decode`: an envelope-valid line and whether the fold would replay it.
fn decode(line: &str) -> Option<(IndexedEvent, bool)> {
    let raw = json::parse(line).ok()?;
    let e = validate_envelope(raw).ok()?;
    let usable = validate_payload(&e.event_type, &Json::Obj(e.payload.clone())).is_ok();
    Some((
        IndexedEvent {
            id: e.id,
            event_type: e.event_type,
            session: e.session,
            initiative: e.initiative,
            payload: e.payload,
            ts: e.ts,
        },
        usable,
    ))
}

struct Chunk {
    text: String,
    stat: LogStat,
}

/// `readFrom`: bytes from `from` to the end, with the stat of the same open file.
fn read_from(path: &Path, from: u64) -> Option<Chunk> {
    let mut file = File::open(path).ok()?;
    let m = file.metadata().ok()?;
    let stat = LogStat {
        size: m.len(),
        mtime_ms: mtime_ms_of(&m),
    };
    if from >= stat.size {
        return Some(Chunk {
            text: String::new(),
            stat,
        });
    }
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity(usize::try_from(stat.size - from).ok()?);
    file.read_to_end(&mut buf).ok()?;
    Some(Chunk {
        text: String::from_utf8_lossy(&buf).into_owned(),
        stat,
    })
}

/// `linesWithOffsets`: non-blank lines with their absolute BYTE offsets.
fn lines_with_offsets(text: &str, base: u64) -> Vec<(&str, u64)> {
    let mut out = Vec::new();
    let mut cursor = base;
    for line in text.split('\n') {
        if !js_trim(line).is_empty() {
            out.push((line, cursor));
        }
        cursor += line.len() as u64 + 1;
    }
    out
}

/// `readSince`: events appended since the cursor, plus the cursor to store next.
#[must_use]
pub fn read_since(log_path: &Path, cursor: Option<&Cursor>) -> TailRead {
    let stat = cursor.and_then(|_| log_stat(log_path));
    if let (Some(cursor), Some(stat)) = (cursor, stat) {
        if log_untouched(stat, cursor) {
            return TailRead {
                events: Vec::new(),
                cursor: Some(cursor.clone()),
                full: false,
            };
        }
        if cursor_usable(stat, cursor)
            && let Some(chunk) = read_from(log_path, cursor.offset)
        {
            let lines = lines_with_offsets(&chunk.text, cursor.offset);
            let first = lines.first().and_then(|(line, _)| decode(line));
            if let Some((first, _)) = first
                && first.id == cursor.id
            {
                let mut events = Vec::new();
                let mut last = (cursor.id.clone(), cursor.offset);
                for (line, offset) in &lines[1..] {
                    let Some((event, usable)) = decode(line) else {
                        continue;
                    };
                    last = (event.id.clone(), *offset);
                    if usable {
                        events.push(event);
                    }
                }
                return TailRead {
                    events,
                    cursor: Some(Cursor {
                        id: last.0,
                        offset: last.1,
                        size: chunk.stat.size,
                        mtime_ms: chunk.stat.mtime_ms,
                        max_id: None,
                        voided: None,
                    }),
                    full: false,
                };
            }
        }
    }
    let Some(whole) = read_from(log_path, 0) else {
        return TailRead {
            events: Vec::new(),
            cursor: None,
            full: true,
        };
    };
    let mut events = Vec::new();
    let mut last: Option<(String, u64)> = None;
    for (line, offset) in lines_with_offsets(&whole.text, 0) {
        let Some((event, usable)) = decode(line) else {
            continue;
        };
        last = Some((event.id.clone(), offset));
        if usable {
            events.push(event);
        }
    }
    TailRead {
        events,
        cursor: last.map(|(id, offset)| Cursor {
            id,
            offset,
            size: whole.stat.size,
            mtime_ms: whole.stat.mtime_ms,
            max_id: None,
            voided: None,
        }),
        full: true,
    }
}
