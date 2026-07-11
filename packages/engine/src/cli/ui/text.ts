/**
 * Visible-width text helpers (1.3). The single trap these exist for:
 * String.length counts ANSI escape bytes, so padding/truncating styled
 * text misaligns columns. Everything here measures the *visible* string
 * (escapes stripped). ASCII + BMP text only — sofar output has no
 * CJK/emoji surfaces, so no east-asian-width table is vendored (D2:
 * that's the line where a real dep would start to earn its keep).
 */

// Vendored from ansi-regex (MIT, Sindre Sorhus & contributors) per the
// cli-ui D2 vendoring rule. Matches the FULL ANSI grammar — SGR in any
// palette (256-color/truecolor included), other CSI finals (cursor moves,
// erase-line), and OSC/DCS-style strings terminated by BEL or ST — not
// just the `m`-final semantic-16 subset sofar's own styles emit. Record
// prose can carry arbitrary escapes; the styled layouts must degrade all
// of them (SPEC §CLI UI color law), so an SGR-only strip is not enough.
// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /[\x1b\x9b][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?(?:\x07|\x1b\x5c|\x9c))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

// C0 controls + DEL that can remain after sequence stripping (a bare ESC,
// a stray BEL from a truncated OSC) — everything except \t and \n.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/**
 * Record-prose sanitizer (SPEC §CLI UI color law): ANSI sequences
 * stripped, then leftover control bytes dropped, so a hostile or
 * accidental escape inside a log degrades to plain printable characters
 * before any styling wraps it. Newlines and tabs survive — one-line slots
 * collapse whitespace separately (layout.ts oneLine). Applied ONLY on the
 * styled layouts: the plain renderers are agent contract bytes and pass
 * record content through untouched.
 */
export function sanitizeProse(s: string): string {
  return stripAnsi(s).replace(CONTROL_RE, '')
}

/** Length of the string as the terminal shows it (escapes stripped). */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length
}

/** padEnd on visible width — styled strings align in columns. */
export function padEndVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

/** padStart on visible width — right-aligned numeric gutters. */
export function padStartVisible(s: string, width: number): string {
  const pad = width - visibleWidth(s)
  return pad > 0 ? ' '.repeat(pad) + s : s
}

/**
 * Truncate PLAIN text to `width`, appending `ellipsis` when cut. Refuses
 * styled input (would need escape-aware slicing — not worth owning; keep
 * truncation before styling in render pipelines).
 */
export function truncatePlain(s: string, width: number, ellipsis = '…'): string {
  if (s !== stripAnsi(s)) {
    throw new Error('truncatePlain: styled input — truncate before styling')
  }
  if (s.length <= width) return s
  if (width <= ellipsis.length) return ellipsis.slice(0, Math.max(0, width))
  return s.slice(0, width - ellipsis.length) + ellipsis
}

/** Terminal columns for a stream, defaulting to 80 when piped/unknown. */
export function columnsOf(stream: { columns?: number }): number {
  const c = stream.columns
  return typeof c === 'number' && c > 0 ? c : 80
}
