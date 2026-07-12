import { describe, expect, it, vi } from 'vitest'
import { detectCaps, stderrCaps, stdoutCaps } from '../src/cli/ui/caps'
import { createStyle } from '../src/cli/ui/style'

/** UI kernel (Phase 1, cli-ui). Everything is pure — no TTY faking. */

const tty = { isTTY: true, env: {}, argv: [], platform: 'darwin' }

describe('detectCaps color ladder', () => {
  it('colors on a plain TTY', () => {
    expect(detectCaps(tty).color).toBe(true)
  })

  it('no color when piped (not a TTY, no CI)', () => {
    expect(detectCaps({ ...tty, isTTY: false }).color).toBe(false)
  })

  it('NO_COLOR wins over everything, regardless of value', () => {
    expect(detectCaps({ ...tty, env: { NO_COLOR: '' } }).color).toBe(false)
    expect(
      detectCaps({ ...tty, env: { NO_COLOR: '1', FORCE_COLOR: '3' } }).color,
    ).toBe(false)
  })

  it('--no-color beats FORCE_COLOR and TTY', () => {
    expect(
      detectCaps({ ...tty, env: { FORCE_COLOR: '1' }, argv: ['--no-color'] })
        .color,
    ).toBe(false)
  })

  it('FORCE_COLOR forces color without a TTY; FORCE_COLOR=0 disables', () => {
    expect(
      detectCaps({ ...tty, isTTY: false, env: { FORCE_COLOR: '1' } }).color,
    ).toBe(true)
    expect(detectCaps({ ...tty, env: { FORCE_COLOR: '0' } }).color).toBe(false)
  })

  it('--color forces color without a TTY', () => {
    expect(detectCaps({ ...tty, isTTY: false, argv: ['--color'] }).color).toBe(
      true,
    )
  })

  it('TERM=dumb disables color on a TTY', () => {
    expect(detectCaps({ ...tty, env: { TERM: 'dumb' } }).color).toBe(false)
  })

  it('CI enables color without a TTY (piped CI logs keep color)', () => {
    expect(detectCaps({ ...tty, isTTY: false, env: { CI: 'true' } }).color).toBe(
      true,
    )
  })

  it('CI ambient beats TERM=dumb (dumb only vetoes the TTY clause, not color itself)', () => {
    const caps = detectCaps({ ...tty, env: { TERM: 'dumb', CI: 'true' } })
    expect(caps.color).toBe(true)
    expect(caps.animate).toBe(false) // dumb still kills animation
  })
})

describe('stream caps (stdoutCaps / stderrCaps)', () => {
  /** Force a stream's TTY-ness for one call, restoring the original shape. */
  function withTTY<T>(stream: NodeJS.WriteStream, isTTY: boolean, fn: () => T): T {
    const desc = Object.getOwnPropertyDescriptor(stream, 'isTTY')
    Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true })
    try {
      return fn()
    } finally {
      if (desc !== undefined) Object.defineProperty(stream, 'isTTY', desc)
      else delete (stream as { isTTY?: boolean }).isTTY
    }
  }

  /** Pin the color-relevant env so the developer's shell can't leak in. */
  function stubColorEnv(overrides: Record<string, string>): void {
    for (const name of ['NO_COLOR', 'FORCE_COLOR', 'CI']) vi.stubEnv(name, undefined)
    vi.stubEnv('TERM', 'xterm-256color')
    for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value)
  }

  it('ambient CI never restyles a piped stream (byte-identity for agents/tests)', () => {
    stubColorEnv({ CI: 'true' })
    try {
      expect(withTTY(process.stdout, false, () => stdoutCaps().color)).toBe(false)
      expect(withTTY(process.stderr, false, () => stderrCaps().color)).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('explicit FORCE_COLOR still styles a piped stream, even in CI', () => {
    stubColorEnv({ CI: 'true', FORCE_COLOR: '1' })
    try {
      const caps = withTTY(process.stdout, false, () => stdoutCaps())
      expect(caps.color).toBe(true)
      expect(caps.animate).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a real TTY keeps color in CI but never animates there', () => {
    stubColorEnv({ CI: 'true' })
    try {
      const caps = withTTY(process.stdout, true, () => stdoutCaps())
      expect(caps.color).toBe(true)
      expect(caps.animate).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('detectCaps unicode gate', () => {
  it('unicode everywhere non-Windows except the kernel console', () => {
    expect(detectCaps(tty).unicode).toBe(true)
    expect(detectCaps({ ...tty, env: { TERM: 'linux' } }).unicode).toBe(false)
  })

  it('Windows: only modern hosts get unicode', () => {
    const win = { ...tty, platform: 'win32' }
    expect(detectCaps(win).unicode).toBe(false) // legacy conhost
    expect(detectCaps({ ...win, env: { WT_SESSION: '1' } }).unicode).toBe(true)
    expect(
      detectCaps({ ...win, env: { TERM_PROGRAM: 'vscode' } }).unicode,
    ).toBe(true)
  })
})

describe('detectCaps animate', () => {
  it('animates only on a TTY outside CI', () => {
    expect(detectCaps(tty).animate).toBe(true)
    expect(detectCaps({ ...tty, isTTY: false }).animate).toBe(false)
    expect(detectCaps({ ...tty, env: { CI: 'true' } }).animate).toBe(false)
    expect(detectCaps({ ...tty, env: { TERM: 'dumb' } }).animate).toBe(false)
  })

  it('animate is independent of color (NO_COLOR TTY still animates)', () => {
    expect(detectCaps({ ...tty, env: { NO_COLOR: '1' } }).animate).toBe(true)
  })
})

describe('createStyle', () => {
  it('disabled style is identity for every formatter', () => {
    const plain = createStyle(false)
    expect(plain.enabled).toBe(false)
    expect(plain.success('ok')).toBe('ok')
    expect(plain.bold(plain.error('x'))).toBe('x')
  })

  it('enabled style wraps with ANSI-16 SGR codes', () => {
    const s = createStyle(true)
    expect(s.success('ok')).toBe('\x1b[32mok\x1b[39m')
    expect(s.error('bad')).toBe('\x1b[31mbad\x1b[39m')
    expect(s.warn('careful')).toBe('\x1b[33mcareful\x1b[39m')
    expect(s.info('note')).toBe('\x1b[36mnote\x1b[39m')
    expect(s.accent('sofar')).toBe('\x1b[35msofar\x1b[39m')
    expect(s.dim('meta')).toBe('\x1b[2mmeta\x1b[22m')
    expect(s.bold('loud')).toBe('\x1b[1mloud\x1b[22m')
  })

  it('re-opens the outer style after a nested close (picocolors fix)', () => {
    const s = createStyle(true)
    // bold inside bold-class close: outer bold must resume after inner ends
    expect(s.bold(`a${s.dim('b')}c`)).toBe(
      '\x1b[1ma\x1b[2mb\x1b[22m\x1b[1mc\x1b[22m',
    )
  })

  it('muted aliases dim', () => {
    const s = createStyle(true)
    expect(s.muted('x')).toBe(s.dim('x'))
  })
})

describe('symbolsFor', () => {
  it('unicode set uses the shared CLI vocabulary', async () => {
    const { symbolsFor } = await import('../src/cli/ui/symbols')
    const u = symbolsFor(true)
    expect([u.ok, u.fail, u.warn, u.boxActive, u.elbow]).toEqual([
      '✓',
      '✗',
      '⚠',
      '[•]',
      '└',
    ])
  })

  it('ascii set is cp437-safe (no multibyte glyphs)', async () => {
    const { symbolsFor } = await import('../src/cli/ui/symbols')
    for (const v of Object.values(symbolsFor(false))) {
      for (const ch of v) expect(ch.charCodeAt(0)).toBeLessThan(0x2510)
    }
  })
})

describe('text helpers', () => {
  it('visibleWidth ignores SGR escapes', async () => {
    const { visibleWidth } = await import('../src/cli/ui/text')
    expect(visibleWidth('\x1b[32mok\x1b[39m')).toBe(2)
    expect(visibleWidth('plain')).toBe(5)
  })

  it('stripAnsi strips the full escape grammar, not just semantic SGR', async () => {
    const { stripAnsi } = await import('../src/cli/ui/text')
    expect(stripAnsi('a\x1b[38;5;196mb\x1b[0mc')).toBe('abc') // 256-color + reset-all
    expect(stripAnsi('a\x1b[38;2;1;2;3mb\x1b[0mc')).toBe('abc') // truecolor
    expect(stripAnsi('t\x1b]0;pwn\x07u')).toBe('tu') // OSC (BEL-terminated)
    expect(stripAnsi('t\x1b]0;pwn\x1b\\u')).toBe('tu') // OSC (ST-terminated)
    expect(stripAnsi('cur\x1b[2Ksor')).toBe('cursor') // erase-line CSI
  })

  it('sanitizeProse also drops leftover control bytes (lone ESC, stray BEL) but keeps \\n and \\t', async () => {
    const { sanitizeProse } = await import('../src/cli/ui/text')
    expect(sanitizeProse('a \x1b b\x07c\rd')).toBe('a  bcd')
    expect(sanitizeProse('line1\nline2\tend')).toBe('line1\nline2\tend')
  })

  it('padEndVisible aligns styled and plain to the same column', async () => {
    const { padEndVisible, visibleWidth } = await import('../src/cli/ui/text')
    const styled = padEndVisible('\x1b[31mbad\x1b[39m', 8)
    const plain = padEndVisible('bad', 8)
    expect(visibleWidth(styled)).toBe(8)
    expect(visibleWidth(plain)).toBe(8)
  })

  it('padStartVisible right-aligns and never truncates', async () => {
    const { padStartVisible } = await import('../src/cli/ui/text')
    expect(padStartVisible('42', 4)).toBe('  42')
    expect(padStartVisible('12345', 4)).toBe('12345')
  })

  it('truncatePlain cuts with ellipsis and rejects styled input', async () => {
    const { truncatePlain } = await import('../src/cli/ui/text')
    expect(truncatePlain('hello world', 8)).toBe('hello w…')
    expect(truncatePlain('short', 8)).toBe('short')
    expect(() => truncatePlain('\x1b[1mx\x1b[22m', 8)).toThrow(/styled/)
  })

  it('columnsOf defaults to 80 when piped', async () => {
    const { columnsOf } = await import('../src/cli/ui/text')
    expect(columnsOf({})).toBe(80)
    expect(columnsOf({ columns: 120 })).toBe(120)
  })
})

describe('spinner', () => {
  const capture = () => {
    const chunks: string[] = []
    return { chunks, write: (c: string) => chunks.push(c) }
  }
  const staticCaps = { color: false, unicode: true, animate: false }
  const liveCaps = { color: false, unicode: true, animate: true }

  it('static mode prints one line at start and one per text change', async () => {
    const { createSpinner } = await import('../src/cli/ui/spinner')
    const out = capture()
    const s = createSpinner({ caps: staticCaps, text: 'scanning', stream: out })
    s.start()
    s.update('still scanning')
    s.update('still scanning') // unchanged — no extra line
    s.succeed('done')
    expect(out.chunks).toEqual(['⋯ scanning\n', '⋯ still scanning\n', '✓ done\n'])
  })

  it('animated mode redraws frames in place and cleans up', async () => {
    const vi_ = (await import('vitest')).vi
    vi_.useFakeTimers()
    try {
      const { createSpinner } = await import('../src/cli/ui/spinner')
      const { DOTS } = await import('../src/cli/ui/frames')
      const out = capture()
      const before = process.listenerCount('SIGINT')
      const s = createSpinner({ caps: liveCaps, text: 'folding', stream: out, frames: DOTS })
      s.start()
      expect(process.listenerCount('SIGINT')).toBe(before + 1)
      vi_.advanceTimersByTime(DOTS.intervalMs * 2)
      s.succeed('folded')
      expect(process.listenerCount('SIGINT')).toBe(before)
      const joined = out.chunks.join('')
      expect(joined.startsWith('\x1b[?25l')).toBe(true) // cursor hidden first
      expect(joined).toContain('⠋ folding')
      expect(joined).toContain('⠹ folding') // advanced frames
      expect(joined).toContain('\x1b[?25h') // cursor restored
      expect(joined.endsWith('✓ folded\n')).toBe(true)
    } finally {
      vi_.useRealTimers()
    }
  })

  it('fail closes with the ✗ mark; stop can be silent', async () => {
    const { createSpinner } = await import('../src/cli/ui/spinner')
    const out = capture()
    createSpinner({ caps: staticCaps, text: 'x', stream: out }).start().fail()
    expect(out.chunks.at(-1)).toBe('✗ x\n')
    const out2 = capture()
    createSpinner({ caps: staticCaps, text: 'x', stream: out2 }).start().stop()
    expect(out2.chunks).toEqual(['⋯ x\n'])
  })

  it('SIGINT mid-animation restores the cursor, then re-raises so ^C still terminates', async () => {
    const { createSpinner } = await import('../src/cli/ui/spinner')
    // any SIGINT listener suppresses Node's default terminate-on-SIGINT;
    // the handler must restore-then-re-raise, never swallow the signal
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const out = capture()
    const spinner = createSpinner({ caps: liveCaps, text: 'interrupted', stream: out })
    const before = process.listeners('SIGINT')
    spinner.start()
    try {
      const added = process.listeners('SIGINT').filter((l) => !before.includes(l))
      expect(added).toHaveLength(1)
      ;(added[0] as () => void)() // deliver the signal to OUR handler only
      expect(out.chunks.join('')).toContain('\x1b[?25h') // cursor restored first
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGINT') // signal re-raised
    } finally {
      spinner.stop() // clears the interval + the once-wrapper still registered
      kill.mockRestore()
    }
    expect(process.listeners('SIGINT')).toEqual(before)
  })

  it('framesFor maps use cases and honors the unicode gate', async () => {
    const { framesFor, DOTS, GROW_VERTICAL, POINT, BRAND_PULSE, LINE, BOUNCING_BAR } =
      await import('../src/cli/ui/frames')
    expect(framesFor('scan', true)).toBe(DOTS)
    expect(framesFor('write', true)).toBe(GROW_VERTICAL)
    expect(framesFor('network', true)).toBe(POINT)
    expect(framesFor('brand', true)).toBe(BRAND_PULSE)
    expect(framesFor('scan', false)).toBe(LINE)
    expect(framesFor('write', false)).toBe(BOUNCING_BAR)
  })
})

describe('wrapPlain + terminalRows (4.1)', () => {
  it('greedy-wraps on word boundaries and never exceeds width', async () => {
    const { wrapPlain } = await import('../src/cli/ui/text')
    const lines = wrapPlain('Implement cli-ui task layout grammar then wire status renderer', 20)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20)
    expect(lines.join(' ')).toBe('Implement cli-ui task layout grammar then wire status renderer')
  })

  it('hard-cuts pathological long tokens; empty input yields one line', async () => {
    const { wrapPlain } = await import('../src/cli/ui/text')
    expect(wrapPlain('x'.repeat(25), 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
    expect(wrapPlain('', 10)).toEqual([''])
    expect(() => wrapPlain('\x1b[1mx\x1b[22m', 10)).toThrow(/styled/)
  })

  it('terminalRows counts soft-wrapped rows, not logical lines', async () => {
    const { terminalRows } = await import('../src/cli/ui/text')
    expect(terminalRows(['short', 'x'.repeat(85)], 80)).toBe(3) // 1 + 2
    expect(terminalRows([''], 80)).toBe(1)
  })
})

describe('pieFor (4.2)', () => {
  it('quantizes with honest endpoints', async () => {
    const { pieFor, symbolsFor } = await import('../src/cli/ui/symbols')
    const u = symbolsFor(true)
    expect(pieFor(0, 8, u)).toBe('○')
    expect(pieFor(1, 8, u)).toBe('◔')
    expect(pieFor(4, 8, u)).toBe('◑')
    expect(pieFor(6, 8, u)).toBe('◕')
    expect(pieFor(7, 8, u)).toBe('◕') // not ● until truly done
    expect(pieFor(8, 8, u)).toBe('●')
  })

  it('ASCII set and zero-total render no pie', async () => {
    const { pieFor, symbolsFor } = await import('../src/cli/ui/symbols')
    expect(pieFor(3, 8, symbolsFor(false))).toBe('')
    expect(pieFor(0, 0, symbolsFor(true))).toBe('')
  })
})
