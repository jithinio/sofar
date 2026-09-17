//! When a log last GREW, from its content (`core/warmth.ts`): a bounded tail
//! read, the newest `ts` among the complete lines, never the mtime.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;

use crate::date::js_date_parse;
use crate::json::{self, Json};
use crate::text::js_trim;

/// Tail window (`TAIL_BYTES`).
pub const TAIL_BYTES: u64 = 16_384;

/// The newest event a log holds.
#[derive(Debug, Clone, PartialEq)]
pub struct NewestEvent {
    /// Epoch milliseconds.
    pub ts: f64,
    /// That event's `type`, or None when the line carried none.
    pub event_type: Option<String>,
}

/// `readTail`: at most `max` bytes from the END of a file.
pub(crate) fn read_tail(path: &Path, max: u64) -> Option<(String, bool)> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let length = size.min(max);
    let start = size - length;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity(usize::try_from(length).ok()?);
    file.take(length).read_to_end(&mut buf).ok()?;
    Some((String::from_utf8_lossy(&buf).into_owned(), start == 0))
}

/// `newestIn`: the max-`ts` complete line, corrupt lines skipped.
fn newest_in(text: &str, from_start: bool) -> Option<NewestEvent> {
    let mut parts = text.split('\n');
    if !from_start {
        parts.next();
    }
    let mut newest: Option<NewestEvent> = None;
    for line in parts {
        if js_trim(line).is_empty() {
            continue;
        }
        let Ok(Json::Obj(fields)) = json::parse(line) else {
            continue;
        };
        let Some(ts) = fields.get("ts").and_then(Json::as_str) else {
            continue;
        };
        let Some(ms) = js_date_parse(ts) else {
            continue;
        };
        if newest.as_ref().is_none_or(|n| ms > n.ts) {
            newest = Some(NewestEvent {
                ts: ms,
                event_type: fields.get("type").and_then(Json::as_str).map(str::to_owned),
            });
        }
    }
    newest
}

/// `newestEvent`: the newest event in the log, or None when none can be read.
#[must_use]
pub fn newest_event(log_path: &Path) -> Option<NewestEvent> {
    let (text, from_start) = read_tail(log_path, TAIL_BYTES)?;
    if let Some(found) = newest_in(&text, from_start) {
        return Some(found);
    }
    if from_start {
        return None;
    }
    let (whole, _) = read_tail(log_path, u64::MAX)?;
    newest_in(&whole, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;

    #[test]
    #[allow(clippy::float_cmp, reason = "exact epoch milliseconds")]
    fn newest_is_the_max_ts_among_complete_lines() {
        let dir = crate::testing::scratch_dir("warmth");
        let log = dir.join("events.jsonl");
        let mut text = String::new();
        for i in 0..400 {
            let _ = writeln!(
                text,
                "{{\"ts\":\"2026-01-01T00:00:{:02}.000Z\",\"type\":\"note_added\",\"pad\":\"{}\"}}",
                i % 60,
                "x".repeat(100)
            );
        }
        text.push_str(
            "{\"ts\":\"2026-01-02T00:00:00.000Z\",\"type\":\"initiative_status_changed\"}\n",
        );
        text.push_str("{\"ts\":\"2026-01-01T00:00:00.000Z\"}\n");
        std::fs::write(&log, &text).unwrap();
        let newest = newest_event(&log).unwrap();
        assert_eq!(
            newest.ts,
            js_date_parse("2026-01-02T00:00:00.000Z").unwrap()
        );
        assert_eq!(
            newest.event_type.as_deref(),
            Some("initiative_status_changed")
        );
        std::fs::write(&log, "").unwrap();
        assert_eq!(newest_event(&log), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
