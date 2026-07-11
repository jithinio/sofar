import { describe, expect, it } from 'vitest'
import { detectCaps } from '../src/cli/ui/caps'
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
