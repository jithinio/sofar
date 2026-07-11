/**
 * Glyph vocabulary (1.3) — the cross-product convention every researched
 * CLI converged on (Claude Code, Codex, opencode, Kiro): check/cross state
 * marks, colored state bullets, tree rails for detail lines, checkbox
 * triplet for task status. ASCII fallbacks follow the figures/log-symbols
 * cp437-safe set for legacy Windows conhost / TERM=linux.
 */

export interface Symbols {
  /** ✓ — success/done. */
  ok: string
  /** ✗ — failure/error. */
  fail: string
  /** ⚠ — warning. */
  warn: string
  /** ℹ — informational. */
  info: string
  /** ● — filled state bullet (colored by caller). */
  bullet: string
  /** ○ — hollow bullet: pending/inactive. */
  circle: string
  /** [✓] / [•] / [ ] — task checkbox triplet (done/active/pending). */
  boxDone: string
  boxActive: string
  boxPending: string
  /** └ — detail/child line rail ("  └ hint"). */
  elbow: string
  /** │ — continuation rail for quoted/multiline blocks. */
  pipe: string
  /** ⋮ — vertical elision between omitted rows. */
  vellipsis: string
  /** … — inline truncation mark. */
  ellipsis: string
  /** ▸ — pointer/current-row marker. */
  pointer: string
}

const UNICODE: Symbols = {
  ok: '✓',
  fail: '✗',
  warn: '⚠',
  info: 'ℹ',
  bullet: '●',
  circle: '○',
  boxDone: '[✓]',
  boxActive: '[•]',
  boxPending: '[ ]',
  elbow: '└',
  pipe: '│',
  vellipsis: '⋮',
  ellipsis: '…',
  pointer: '▸',
}

const ASCII: Symbols = {
  ok: '√',
  fail: '×',
  warn: '!!',
  info: 'i',
  bullet: '*',
  circle: 'o',
  boxDone: '[x]',
  boxActive: '[*]',
  boxPending: '[ ]',
  elbow: '`-',
  pipe: '|',
  vellipsis: ':',
  ellipsis: '...',
  pointer: '>',
}

export function symbolsFor(unicode: boolean): Symbols {
  return unicode ? UNICODE : ASCII
}
