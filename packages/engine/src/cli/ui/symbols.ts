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
  /** ○◔◕● — progress pie, empty→full; empty array = no pie (ASCII). */
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
  // ◑ (U+25D1) is deliberately absent — see pieFor (felt-cost D13).
  pie: ['○', '◔', '◕', '●'],
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
 * endpoints are honest — ● only at 100%, ○ only at 0 — and the interior
 * members split the middle evenly. Empty string when the symbol set has
 * no pie (ASCII: the numeric fraction already carries the value).
 *
 * The ramp is ○◔◕● — four members, NOT the five it started with. ◑
 * (U+25D1) was dropped in felt-cost D13: it is missing from common coding
 * fonts, so terminals fall back to a symbol font that draws it wider than
 * its neighbours, and a gauge that changes width as progress moves shifts
 * everything after it. ○◔◕● all sit in the same fonts and stay one cell.
 * The banding is derived from sym.pie.length rather than hardcoded, so a
 * ramp of any size still quantizes correctly.
 *
 * Ties round DOWN (exactly half → ◔, not ◕) — the same refusal to
 * overstate progress that keeps ● away from anything short of done.
 */
export function pieFor(done: number, total: number, sym: Symbols): string {
  if (sym.pie.length === 0 || total <= 0) return ''
  const r = Math.min(1, Math.max(0, done / total))
  if (r === 0) return sym.pie[0]!
  if (r === 1) return sym.pie[sym.pie.length - 1]!
  const steps = sym.pie.length - 2
  if (steps <= 0) return sym.pie[0]!
  return sym.pie[1 + Math.min(steps - 1, Math.max(0, Math.ceil(r * steps) - 1))]!
}
