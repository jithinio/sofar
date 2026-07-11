/**
 * Terminal capability detection (1.2). Pure function of env/argv/stream so
 * tests never fake a real TTY. Three independent capabilities:
 *
 * - color:   ladder NO_COLOR > --no-color > FORCE_COLOR > --color >
 *            (isTTY && TERM !== 'dumb') || CI. NO_COLOR presence wins over
 *            everything (no-color.org: "regardless of its value") — the
 *            spec-compliant precedence picocolors uses and ansis/styleText
 *            get backwards. FORCE_COLOR=0 disables (force-color.org).
 * - unicode: glyphs like ✓/└ vs ASCII fallbacks. Logic vendored from
 *            is-unicode-supported (MIT, Sindre Sorhus): non-Windows is
 *            unicode unless TERM=linux (kernel console); Windows only in
 *            modern hosts (Windows Terminal, VS Code, ConEmu, JetBrains…).
 * - animate: live redraw (spinners) — TTY-only, never in CI, never when
 *            TERM=dumb. Independent of color: an uncolored spinner is fine,
 *            a colored CI log full of frame spam is not.
 *
 * Color detection vendored from picocolors (MIT, Alexey Raspopov) per D2,
 * minus its win32-unconditional enable: piped output stays plain on every
 * platform here.
 */

export interface Caps {
  color: boolean
  unicode: boolean
  animate: boolean
}

export interface CapsInput {
  env?: Record<string, string | undefined>
  argv?: string[]
  /** Whether the target stream is a TTY (pass stream.isTTY). */
  isTTY?: boolean
  platform?: string
}

export function detectCaps(input: CapsInput = {}): Caps {
  const env = input.env ?? process.env
  const argv = input.argv ?? process.argv.slice(2)
  const isTTY = input.isTTY ?? false
  const platform = input.platform ?? process.platform

  const noColor =
    'NO_COLOR' in env || argv.includes('--no-color') || env.FORCE_COLOR === '0'
  const forceColor =
    ('FORCE_COLOR' in env && env.FORCE_COLOR !== '0') || argv.includes('--color')
  const term = env.TERM
  const color =
    !noColor && (forceColor || (isTTY && term !== 'dumb') || 'CI' in env)

  const unicode =
    platform !== 'win32'
      ? term !== 'linux'
      : Boolean(env.WT_SESSION) || // Windows Terminal
        Boolean(env.TERMINUS_SUBLIME) ||
        env.ConEmuTask === '{cmd::Cmder}' ||
        env.TERM_PROGRAM === 'Terminus-Sublime' ||
        env.TERM_PROGRAM === 'vscode' ||
        term === 'xterm-256color' ||
        term === 'alacritty' ||
        env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'

  const animate = isTTY && !('CI' in env) && term !== 'dumb'

  return { color, unicode, animate }
}

/** Caps for the human report stream (stdout). */
export function stdoutCaps(): Caps {
  return detectCaps({ isTTY: process.stdout.isTTY === true })
}

/** Caps for the progress stream (stderr) — spinners live here (clig.dev). */
export function stderrCaps(): Caps {
  return detectCaps({ isTTY: process.stderr.isTTY === true })
}
