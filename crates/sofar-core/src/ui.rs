//! The ANSI style kernel and the progress pie the statusline uses
//! (`cli/ui/style.ts`, `cli/ui/symbols.ts`): picocolors' formatter, including
//! its nested-close re-opening, and `pieFor`.

/// One ANSI formatter: `open + s + close`, re-opening after any `close` the
/// input already carries (searched from `open.length` INTO the input, as
/// picocolors does).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    open: &'static str,
    close: &'static str,
    replace: &'static str,
}

impl Format {
    fn apply(self, input: &str) -> String {
        let from = self.open.len().min(input.len());
        let from = (from..=input.len())
            .find(|i| input.is_char_boundary(*i))
            .unwrap_or(input.len());
        match input[from..].find(self.close) {
            None => format!("{}{input}{}", self.open, self.close),
            Some(rel) => {
                let mut index = from + rel;
                let mut result = String::new();
                let mut cursor = 0;
                loop {
                    result.push_str(&input[cursor..index]);
                    result.push_str(self.replace);
                    cursor = index + self.close.len();
                    match input[cursor..].find(self.close) {
                        Some(r) => index = cursor + r,
                        None => break,
                    }
                }
                result.push_str(&input[cursor..]);
                format!("{}{result}{}", self.open, self.close)
            }
        }
    }
}

/// `Style`: every formatter is identity when styling is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Style {
    pub enabled: bool,
}

const fn fmt(open: &'static str, close: &'static str, replace: &'static str) -> Format {
    Format {
        open,
        close,
        replace,
    }
}

const BOLD: Format = fmt("\x1b[1m", "\x1b[22m", "\x1b[22m\x1b[1m");
const DIM: Format = fmt("\x1b[2m", "\x1b[22m", "\x1b[2m");
const SUCCESS: Format = fmt("\x1b[32m", "\x1b[39m", "\x1b[32m");
const ERROR: Format = fmt("\x1b[31m", "\x1b[39m", "\x1b[31m");
const WARN: Format = fmt("\x1b[33m", "\x1b[39m", "\x1b[33m");
const INFO: Format = fmt("\x1b[36m", "\x1b[39m", "\x1b[36m");
const ACCENT: Format = fmt("\x1b[35m", "\x1b[39m", "\x1b[35m");
const BLUE: Format = fmt("\x1b[34m", "\x1b[39m", "\x1b[34m");

impl Style {
    #[must_use]
    pub const fn new(enabled: bool) -> Self {
        Self { enabled }
    }
    fn with(self, f: Format, s: &str) -> String {
        if self.enabled {
            f.apply(s)
        } else {
            s.to_owned()
        }
    }
    #[must_use]
    pub fn bold(self, s: &str) -> String {
        self.with(BOLD, s)
    }
    #[must_use]
    pub fn dim(self, s: &str) -> String {
        self.with(DIM, s)
    }
    #[must_use]
    pub fn success(self, s: &str) -> String {
        self.with(SUCCESS, s)
    }
    #[must_use]
    pub fn error(self, s: &str) -> String {
        self.with(ERROR, s)
    }
    #[must_use]
    pub fn warn(self, s: &str) -> String {
        self.with(WARN, s)
    }
    #[must_use]
    pub fn info(self, s: &str) -> String {
        self.with(INFO, s)
    }
    #[must_use]
    pub fn accent(self, s: &str) -> String {
        self.with(ACCENT, s)
    }
    #[must_use]
    pub fn blue(self, s: &str) -> String {
        self.with(BLUE, s)
    }
}

/// ○◔◕● — the Unicode pie; ASCII mode has none.
const PIE: [&str; 4] = ["○", "◔", "◕", "●"];

/// `pieFor(done, total, sym)`: empty in ASCII mode or with no total.
#[must_use]
#[allow(
    clippy::float_cmp,
    reason = "the exact endpoints, as the TypeScript compares them"
)]
pub fn pie_for(done: f64, total: f64, unicode: bool) -> &'static str {
    if !unicode || total <= 0.0 {
        return "";
    }
    let r = (done / total).clamp(0.0, 1.0);
    if r == 0.0 {
        return PIE[0];
    }
    if r == 1.0 {
        return PIE[3];
    }
    let steps = PIE.len() - 2;
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "tiny"
    )]
    let idx = 1 + (steps - 1).min(((r * steps as f64).ceil() as usize).saturating_sub(1));
    PIE[idx]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatter_reopens_nested_closes_like_picocolors() {
        let s = Style::new(true);
        assert_eq!(s.bold("x"), "\x1b[1mx\x1b[22m");
        assert_eq!(s.bold(&s.accent("x")), "\x1b[1m\x1b[35mx\x1b[39m\x1b[22m");
        assert_eq!(s.dim(&s.bold("x")), "\x1b[2m\x1b[1mx\x1b[2m\x1b[22m");
        assert_eq!(Style::new(false).warn("x"), "x");
    }

    #[test]
    #[allow(clippy::float_cmp, reason = "pie steps")]
    fn pie_steps() {
        assert_eq!(pie_for(0.0, 4.0, true), "○");
        assert_eq!(pie_for(1.0, 4.0, true), "◔");
        assert_eq!(pie_for(2.0, 4.0, true), "◔");
        assert_eq!(pie_for(3.0, 4.0, true), "◕");
        assert_eq!(pie_for(4.0, 4.0, true), "●");
        assert_eq!(pie_for(1.0, 4.0, false), "");
    }
}
