//! JavaScript text semantics the bytes depend on — `docs/HOTPATH.md`
//! §Text-semantics pins, P1 (UTF-16 units) and P2 (the `\s` / `trim()`
//! whitespace set). Every helper here is the JS behaviour, never the Rust
//! default (rust-core D2).

/// The ECMAScript `WhiteSpace` ∪ `LineTerminator` set (P2): what `\s` matches and
/// what `String.prototype.trim` strips. Includes U+FEFF and U+00A0, which
/// Rust's `char::is_whitespace` does not.
#[must_use]
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim` (P2).
#[must_use]
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimEnd` (P2).
#[must_use]
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// `string.length` — UTF-16 code units (P1), the unit of every budget.
#[must_use]
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_strips_the_js_set_only() {
        assert_eq!(js_trim("\u{FEFF}\u{00A0} a b \u{3000}\n"), "a b");
        // U+200B (zero width space) is NOT JS whitespace.
        assert_eq!(js_trim("\u{200B}a\u{200B}"), "\u{200B}a\u{200B}");
        // U+0085 (NEL) is Rust whitespace but not JS whitespace.
        assert_eq!(js_trim("\u{0085}a"), "\u{0085}a");
    }

    #[test]
    fn utf16_length_counts_units() {
        assert_eq!(utf16_len("a\u{1F600}"), 3);
        assert_eq!(utf16_len("\u{FFFD}"), 1);
        assert_eq!(utf16_len(""), 0);
    }
}

/// Plain JS `<`/`>` string comparison: UTF-16 code-unit order (rust-core D6),
/// which differs from `str::cmp` (code-point order) only when a supplementary
/// character meets a BMP character above U+D7FF.
#[must_use]
pub fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod utf16_order_tests {
    use super::cmp_utf16;
    use std::cmp::Ordering;

    #[test]
    fn code_units_not_code_points() {
        // U+FF01 (BMP) vs U+1F600 (surrogate D83D DE00): code point says
        // FF01 < 1F600, code units say D83D < FF01.
        assert_eq!(cmp_utf16("\u{1F600}", "\u{FF01}"), Ordering::Less);
        assert_eq!("\u{1F600}".cmp("\u{FF01}"), Ordering::Greater);
        assert_eq!(cmp_utf16("a", "b"), Ordering::Less);
        assert_eq!(cmp_utf16("B", "a"), Ordering::Less);
    }
}
