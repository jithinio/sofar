/**
 * Semantic style primitives (1.2). The color law (D1, from Codex CLI's
 * styles.md model): ANSI-16 semantic colors only — green=success,
 * red=error, yellow=warn, cyan=info/identifiers, magenta=accent/brand,
 * dim=secondary. Never hex/truecolor for text, never black/white
 * foregrounds — the user's terminal theme supplies the palette, so output
 * looks native everywhere without background detection.
 *
 * Formatter mechanics (the nested-close fix in `replaceClose`) vendored
 * from picocolors (MIT, Alexey Raspopov) per D2: re-opens an outer style
 * when an inner one closes, so success(bold('x') + 'y') keeps 'y' green.
 */

export type Format = (input: string) => string

export interface Style {
  /** Whether styling is active (false → every formatter is identity). */
  enabled: boolean
  bold: Format
  dim: Format
  /** Secondary/metadata text — alias of dim, named for call-site intent. */
  muted: Format
  success: Format
  error: Format
  warn: Format
  info: Format
  accent: Format
  /**
   * QUOTATION color, outside the semantic law (felt-cost D14). The law maps
   * color to meaning; this maps color to a source. Claude Code's default
   * status line paints the git branch blue, and `sofar statusline` restores
   * that line rather than replacing its look — so its identity segments
   * quote Claude's palette instead of assigning meaning. Do not reach for
   * this to express state: the semantic tones above cover that, and a
   * meaning wearing a non-semantic color is exactly what D1 forbids.
   */
  blue: Format
}

function replaceClose(
  s: string,
  close: string,
  replace: string,
  index: number,
): string {
  let result = ''
  let cursor = 0
  do {
    result += s.substring(cursor, index) + replace
    cursor = index + close.length
    index = s.indexOf(close, cursor)
  } while (index !== -1)
  return result + s.substring(cursor)
}

function formatter(open: string, close: string, replace = open): Format {
  return (input) => {
    const s = String(input)
    const index = s.indexOf(close, open.length)
    return index !== -1
      ? open + replaceClose(s, close, replace, index) + close
      : open + s + close
  }
}

const identity: Format = (input) => String(input)

const PLAIN: Style = {
  enabled: false,
  bold: identity,
  dim: identity,
  muted: identity,
  success: identity,
  error: identity,
  warn: identity,
  info: identity,
  accent: identity,
  blue: identity,
}

export function createStyle(enabled: boolean): Style {
  if (!enabled) return PLAIN
  const dim = formatter('\x1b[2m', '\x1b[22m')
  return {
    enabled: true,
    bold: formatter('\x1b[1m', '\x1b[22m', '\x1b[22m\x1b[1m'),
    dim,
    muted: dim,
    success: formatter('\x1b[32m', '\x1b[39m'),
    error: formatter('\x1b[31m', '\x1b[39m'),
    warn: formatter('\x1b[33m', '\x1b[39m'),
    info: formatter('\x1b[36m', '\x1b[39m'),
    accent: formatter('\x1b[35m', '\x1b[39m'),
    blue: formatter('\x1b[34m', '\x1b[39m'),
  }
}
