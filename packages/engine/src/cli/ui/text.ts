/**
 * Visible-width text helpers (1.3). The single trap these exist for:
 * String.length counts ANSI escape bytes, so padding/truncating styled
 * text misaligns columns. Everything here measures the *visible* string
 * (escapes stripped). ASCII + BMP text only — sofar output has no
 * CJK/emoji surfaces, so no east-asian-width table is vendored (D2:
 * that's the line where a real dep would start to earn its keep).
 */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

/** Length of the string as the terminal shows it (SGR escapes stripped). */
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
