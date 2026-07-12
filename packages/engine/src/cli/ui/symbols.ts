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
  /** ○◔◑◕● — progress pie, empty→full; empty array = no pie (ASCII). */
  pie: readonly string[]
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
  pie: ['○', '◔', '◑', '◕', '●'],
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
  pie: [],
}

export function symbolsFor(unicode: boolean): Symbols {
  return unicode ? UNICODE : ASCII
}

/**
 * Progress pie (4.2): quantize done/total onto the pie glyph ramp. The
 * endpoints are honest — ● only at 100%, ○ only at 0 — and everything
 * in between rounds to a quarter. Empty string when the symbol set has
 * no pie (ASCII: the numeric fraction already carries the value).
 */
export function pieFor(done: number, total: number, sym: Symbols): string {
  if (sym.pie.length === 0 || total <= 0) return ''
  const r = Math.min(1, Math.max(0, done / total))
  if (r === 0) return sym.pie[0]!
  if (r === 1) return sym.pie[sym.pie.length - 1]!
  if (r < 0.375) return sym.pie[1]!
  if (r < 0.625) return sym.pie[2]!
  return sym.pie[3]!
}
