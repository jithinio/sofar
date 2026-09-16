//! Clock and number helpers with JavaScript semantics (`docs/HOTPATH.md`
//! §Text-semantics pins P6, P8): `Date.parse` for the ISO-8601 shapes the
//! engine writes, `Date.now()`, and `Math.round`.

use std::time::{SystemTime, UNIX_EPOCH};

/// `Date.now()` — epoch milliseconds.
#[must_use]
pub fn now_ms() -> f64 {
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    #[allow(clippy::cast_precision_loss, reason = "milliseconds fit f64 exactly")]
    {
        u64::try_from(d.as_millis()).unwrap_or(u64::MAX) as f64
    }
}

/// `Math.round`: the closest integer, ties toward +∞ (P8).
#[must_use]
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

fn digits(s: &[u8], n: usize) -> Option<i64> {
    if s.len() < n || !s[..n].iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(&s[..n]).ok()?.parse().ok()
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Date.parse` for the ECMAScript date-time string format (P6): `YYYY-MM-DD`,
/// optionally `THH:mm[:ss[.sss]]` and `Z` / `±HH:mm`. A date-only form is
/// UTC; a date-time without an offset is LOCAL time in V8, which this treats
/// as UTC — every hot-path caller runs under `TZ=UTC` or writes `Z` itself.
/// Anything else (V8's legacy fallback grammar) is `None`, i.e. `NaN`.
#[must_use]
pub fn js_date_parse(text: &str) -> Option<f64> {
    let s = text.as_bytes();
    let (year, mut i) = if s.first() == Some(&b'+') || s.first() == Some(&b'-') {
        let sign = if s[0] == b'-' { -1 } else { 1 };
        (sign * digits(&s[1..], 6)?, 7)
    } else {
        (digits(s, 4)?, 4)
    };
    let mut month = 1;
    let mut day = 1;
    if s.get(i) == Some(&b'-') {
        month = digits(&s[i + 1..], 2)?;
        i += 3;
        if s.get(i) == Some(&b'-') {
            day = digits(&s[i + 1..], 2)?;
            i += 3;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut h, mut min, mut sec, mut ms) = (0, 0, 0, 0.0);
    let mut offset_ms: i64 = 0;
    if i < s.len() {
        if s[i] != b'T' {
            return None;
        }
        h = digits(&s[i + 1..], 2)?;
        i += 3;
        if s.get(i) != Some(&b':') {
            return None;
        }
        min = digits(&s[i + 1..], 2)?;
        i += 3;
        if s.get(i) == Some(&b':') {
            sec = digits(&s[i + 1..], 2)?;
            i += 3;
            if s.get(i) == Some(&b'.') {
                let start = i + 1;
                let mut end = start;
                while end < s.len() && s[end].is_ascii_digit() {
                    end += 1;
                }
                if end == start {
                    return None;
                }
                let frac = std::str::from_utf8(&s[start..end]).ok()?;
                ms = (format!("0.{frac}").parse::<f64>().ok()? * 1000.0).floor();
                i = end;
            }
        }
        if h > 24 || min > 59 || sec > 59 || (h == 24 && (min > 0 || sec > 0 || ms > 0.0)) {
            return None;
        }
        match s.get(i) {
            None => {}
            Some(b'Z') => i += 1,
            Some(b'+' | b'-') => {
                let sign = if s[i] == b'-' { -1 } else { 1 };
                let oh = digits(&s[i + 1..], 2)?;
                if s.get(i + 3) != Some(&b':') {
                    return None;
                }
                let om = digits(&s[i + 4..], 2)?;
                if oh > 23 || om > 59 {
                    return None;
                }
                offset_ms = sign * (oh * 60 + om) * 60_000;
                i += 6;
            }
            Some(_) => return None,
        }
    }
    if i != s.len() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    #[allow(clippy::cast_precision_loss, reason = "epoch milliseconds fit f64")]
    let base = (days * 86_400_000 + h * 3_600_000 + min * 60_000 + sec * 1000 - offset_ms) as f64;
    let total = base + ms;
    // V8 rejects dates outside ±8.64e15 ms.
    (total.abs() <= 8.64e15).then_some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::float_cmp, reason = "exact epoch milliseconds")]
    fn parses_the_engine_timestamp_shapes() {
        assert_eq!(js_date_parse("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(
            js_date_parse("2026-01-01T00:00:00Z"),
            Some(1_767_225_600_000.0)
        );
        assert_eq!(js_date_parse("2026-01-01"), Some(1_767_225_600_000.0));
        assert_eq!(
            js_date_parse("2026-01-01T01:00:00+01:00"),
            Some(1_767_225_600_000.0)
        );
        assert_eq!(
            js_date_parse("2026-01-01T00:00:00.5Z"),
            Some(1_767_225_600_500.0)
        );
        assert_eq!(js_date_parse("nope"), None);
        assert_eq!(js_date_parse("2026-13-01"), None);
        assert_eq!(js_date_parse(""), None);
    }

    #[test]
    #[allow(clippy::float_cmp, reason = "exact integers")]
    fn round_is_half_up() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49), 0.0);
        assert_eq!(js_round(-0.2), -0.0);
    }
}
