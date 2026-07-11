import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import { listInitiatives } from '../src/core/listing'
import { renderFullStatus, renderStatus } from '../src/projections/templates/status'
import { renderFullInitiativeList } from '../src/projections/templates/list'
import { runAppend } from '../src/cli/event'
import { runExport } from '../src/cli/transfer'
import { runStatus } from '../src/cli/status'
import { runList } from '../src/cli/list'
import { runDoctor } from '../src/cli/doctor'
import { runInit } from '../src/cli/init'
import { runUninit } from '../src/cli/uninit'
import { runNew, runSwitch } from '../src/cli/new'
import { runAdopt } from '../src/cli/adopt'
import { runUpgrade, type UpgradeDeps } from '../src/cli/upgrade'
import { renderServeBanner } from '../src/cli/serve'
import type { CmdResult } from '../src/cli/shared'
import { stripAnsi, type Caps } from '../src/cli/ui'
import { callToolText, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * CLI UI acceptance (cli-ui 3.3) — the SPEC §Acceptance "CLI UI" criteria,
 * exercised end-to-end over the pure handlers (caps injected — tests never
 * fake capability detection except where detection itself is under test):
 *
 *  1. Command × caps matrix (status, list, doctor, new, switch, init,
 *     uninit, adopt, upgrade, serve banner): plain default / styled /
 *     ASCII / NO_COLOR-disabled — zero ESC on plain paths, semantic
 *     ANSI-16 SGR ONLY on styled paths, exit codes styling-independent.
 *  2. Env-driven ladder through the REAL detection defaults (stubbed env +
 *     forced stream TTY-ness): piped+ambient-CI stays plain; FORCE_COLOR=1
 *     piped styles the styled-capable surfaces only; NO_COLOR (empty value
 *     included) beats FORCE_COLOR even on a TTY; FORCE_COLOR=0 and
 *     TERM=dumb veto ambient color.
 *  3. Guaranteed-plain surfaces byte-identical under every env/flag/TTY
 *     combination (get_state digest, export NDJSON, event-append JSON,
 *     on-disk projections).
 *  4. Spinner channel law: frames only on an animating stderr, zero bytes
 *     (not even the static line) on piped/CI stderr, stdout never.
 *  5. Static import lock: projections/**, mcp/**, cli/event.ts never reach
 *     cli/ui, directly or transitively.
 */

// ---------------------------------------------------------------------------
// Byte laws.
// ---------------------------------------------------------------------------

const ESC = /\x1b/
const SGR_RE = /\x1b\[([0-9;]*)m/g

/**
 * The color law (SPEC §CLI UI): semantic ANSI-16 only — bold(1), dim(2),
 * their close(22), red(31), green(32), yellow(33), magenta(35), cyan(36),
 * fg-close(39). No 256-color (38;5), no truecolor (38;2), no black/white
 * (30/37/90/97), no backgrounds (4x), no reset-all shortcut.
 */
const SEMANTIC_SGR = new Set(['1', '2', '22', '31', '32', '33', '35', '36', '39'])

/** Every ESC byte must open a semantic SGR sequence; returns violations. */
function nonSemanticEscapes(text: string): string[] {
  const bad: string[] = []
  const rest = text.replace(SGR_RE, (seq, codes: string) => {
    for (const code of codes.split(';')) {
      if (!SEMANTIC_SGR.has(code)) bad.push(JSON.stringify(seq))
    }
    return ''
  })
  if (ESC.test(rest)) bad.push('(escape byte outside any SGR sequence)')
  return bad
}

function expectPlainBytes(result: CmdResult): void {
  expect(result.stdout).not.toMatch(ESC)
  expect(result.stderr).not.toMatch(ESC)
}

function expectSemanticSgrOnly(result: CmdResult): void {
  expect(nonSemanticEscapes(result.stdout)).toEqual([])
  expect(nonSemanticEscapes(result.stderr)).toEqual([])
}

/** The unicode glyph vocabulary that must vanish under the ASCII gate. */
const UNICODE_GLYPHS = /[✓✗⚠ℹ●○└│⋮▸…⋯]/u

// ---------------------------------------------------------------------------
// Caps matrix (SPEC flag/env contract, resolved to stream caps).
// ---------------------------------------------------------------------------

/** Piped default on a modern posix host: no color, unicode fine, no frames. */
const PLAIN: Caps = { color: false, unicode: true, animate: false }
/** FORCE_COLOR pipe / color TTY (animate irrelevant to text rendering). */
const STYLED: Caps = { color: true, unicode: true, animate: false }
/** Colored legacy console (TERM=linux / old conhost): cp437-safe glyphs. */
const ASCII: Caps = { color: true, unicode: false, animate: false }
/** NO_COLOR floor — everything off. */
const DISABLED: Caps = { color: false, unicode: false, animate: false }

type Cell = (caps: Caps, errCaps: Caps) => CmdResult

interface Matrix {
  plain: CmdResult
  styled: CmdResult
  ascii: CmdResult
  disabled: CmdResult
}

/** `make` builds a fresh runner (own fixture) per cell — side effects never leak. */
function runMatrix(make: () => Cell): Matrix {
  return {
    plain: make()(PLAIN, PLAIN),
    styled: make()(STYLED, STYLED),
    ascii: make()(ASCII, ASCII),
    disabled: make()(DISABLED, DISABLED),
  }
}

/**
 * The cross-cutting laws every command obeys at every cell:
 *  - exit codes are styling-independent;
 *  - the plain and disabled cells carry zero ESC bytes;
 *  - color off makes the unicode flag irrelevant (disabled ≡ plain bytes,
 *    unless the command mints per-run content — adopt's fresh session id);
 *  - the styled and ascii cells carry semantic ANSI-16 SGR only;
 *  - the ascii cell never emits the unicode glyph vocabulary (skippable for
 *    commands whose stdout embeds verbatim agent content — adopt's brief —
 *    where '…'/'—' are prose, not UI chrome).
 */
function assertMatrixLaws(
  m: Matrix,
  opts: { stableBytes?: boolean; asciiGlyphFree?: boolean } = {},
): void {
  const exits = new Set([m.plain.exitCode, m.styled.exitCode, m.ascii.exitCode, m.disabled.exitCode])
  expect([...exits]).toHaveLength(1)

  expectPlainBytes(m.plain)
  expectPlainBytes(m.disabled)
  if (opts.stableBytes !== false) {
    expect(m.disabled.stdout).toBe(m.plain.stdout)
    expect(m.disabled.stderr).toBe(m.plain.stderr)
  }

  expectSemanticSgrOnly(m.styled)
  expectSemanticSgrOnly(m.ascii)
  if (opts.asciiGlyphFree !== false) {
    expect(m.ascii.stdout).not.toMatch(UNICODE_GLYPHS)
    expect(m.ascii.stderr).not.toMatch(UNICODE_GLYPHS)
  }
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

/** Fresh host repo: .git/HEAD on main — exactly what init receives. */
function freshRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-cliui-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

/** freshRepo + init (plain caps — setup must not depend on ambient env). */
function initializedRepo(): string {
  const root = freshRepo()
  expect(runInit(root, PLAIN, PLAIN).exitCode).toBe(0)
  return root
}

/**
 * Seed a log hitting every styling-tempting surface of the layout grammar:
 * done/active/blocked/pending tasks (blocked also derives blocked_on), a
 * write-back, a decision, and post-write-back drift (staleness + notes).
 * ASCII-safe prose so the ASCII-cell glyph assertion stays meaningful.
 */
function seedInitiative(fixture: Fixture): void {
  const mk = (
    type: string,
    payload: Record<string, unknown>,
    session = 'sess-a1',
    source: EventEnvelope['source'] = 'claude-code',
  ): EventEnvelope =>
    makeEvent({ initiative: fixture.slug, session, source, actor: 'agent', type, payload })

  appendEvents(fixture.eventsPath, [
    mk('initiative_created', { slug: fixture.slug, goal: 'lock the cli-ui contract' }, 'cli', 'cli'),
    mk('session_started', { tool: 'claude-code', model: 'fable-5' }),
    mk('plan_updated', {
      plan: {
        goal: 'lock the cli-ui contract',
        phases: [
          {
            name: 'Phase 1 - kernel',
            status: 'done',
            tasks: [{ id: '1.1', title: 'caps ladder', status: 'done' }],
          },
          {
            name: 'Phase 2 - surfaces',
            status: 'active',
            tasks: [
              { id: '2.1', title: 'styled status', status: 'done' },
              { id: '2.2', title: 'styled list', status: 'active' },
              { id: '2.3', title: 'spinner channel', status: 'blocked' },
              { id: '2.4', title: 'ascii fallback', status: 'pending' },
            ],
          },
        ],
      },
    }),
    mk('decision_logged', {
      chose: 'semantic ANSI-16 colors',
      over: 'truecolor themes',
      because: 'the terminal theme owns the palette',
    }),
    mk('session_ended', {
      session_id: 'sess-a1',
      summary: 'kernel and styled surfaces landed',
      next_action: 'run the acceptance matrix',
    }),
    // post-write-back drift → staleness warning + notes-since-write-back
    mk('file_touched', { path: 'src/cli/ui/style.ts', op: 'edit' }, 'sess-a2', 'hook'),
    mk('note_added', { text: 'ascii fallback needs the cp437 set' }, 'sess-a2', 'hook'),
  ])
}

function capture(): { chunks: string[]; write: (chunk: string) => void } {
  const chunks: string[] = []
  return { chunks, write: (chunk: string) => chunks.push(chunk) }
}

/** Inert progress channel for doctor cells — spinner bytes captured, never real. */
function inertProgress(): { caps: Caps; stream: { write: (chunk: string) => void } } {
  return { caps: DISABLED, stream: capture() }
}

// ---------------------------------------------------------------------------
// 1. Command × caps matrix.
// ---------------------------------------------------------------------------

describe('matrix: sofar status', () => {
  it('plain cells are byte-identical to the pre-cli-ui renderFullStatus; styled cells obey the color law', () => {
    const fixture = fx()
    seedInitiative(fixture)
    const m = runMatrix(() => (caps) => runStatus(fixture.root, undefined, caps, 100))
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    const { state } = foldLog(fixture.eventsPath)
    expect(m.plain.stdout).toBe(renderFullStatus(state))

    // styled full-zoom grammar: header, checkbox tree, next-action callout
    expect(m.styled.stdout).toContain('▸ Next: run the acceptance matrix')
    expect(m.styled.stdout).toContain('[✓]')
    expect(m.styled.stdout).toContain('\x1b[1m') // bold header
    expect(m.styled.stdout).toContain('\x1b[31m') // blocked task in red
    // ascii cell keeps the same grammar in cp437-safe glyphs
    expect(m.ascii.stdout).toContain('> Next: run the acceptance matrix')
    expect(m.ascii.stdout).toContain('[x]')
  })

  it('resolution failures render plain and exit 1 at every cell', () => {
    const fixture = fx()
    seedInitiative(fixture)
    const m = runMatrix(() => (caps) => runStatus(fixture.root, 'no-such-slug', caps, 100))
    assertMatrixLaws(m)
    expect(m.styled.exitCode).toBe(1)
    expect(m.styled.stderr).not.toMatch(ESC) // fail() text is never styled here
    expect(m.styled.stdout).toBe('')
  })
})

describe('matrix: sofar list', () => {
  it('plain cells are byte-identical to renderFullInitiativeList; styled cells obey the color law', () => {
    const fixture = fx()
    seedInitiative(fixture)
    mkdirSync(join(fixture.root, '.sofar', 'initiatives', 'zebra'), { recursive: true })
    const m = runMatrix(() => (caps) => runList(fixture.root, caps, 100))
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stdout).toBe(renderFullInitiativeList(listInitiatives(fixture.root)))

    expect(m.styled.stdout).toContain('Sofar initiatives')
    expect(m.styled.stdout).toContain('\x1b[1m') // bold header + slugs
    expect(m.styled.stdout).toContain('└') // portfolio detail rail
    expect(m.ascii.stdout).toContain('`-') // ascii rail
    // which initiatives render is the derivation's, not the style's
    for (const cell of [m.plain, m.styled, m.ascii]) {
      expect(cell.stdout).toContain(fixture.slug)
      expect(cell.stdout).toContain('zebra')
    }
  })
})

describe('matrix: sofar doctor', () => {
  it('clean repo: exit 0 at every cell; plain markers vs ✓ marks', () => {
    const root = initializedRepo()
    const m = runMatrix(() => (caps) => runDoctor(root, {}, caps, inertProgress()))
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stdout.startsWith(`sofar doctor — ${root}\n\nWiring integrity:\n  ok    `)).toBe(true)
    expect(m.plain.stdout).toContain('sofar doctor: no problems found')
    expect(m.styled.stdout).toContain('\x1b[32m✓\x1b[39m')
    expect(m.styled.stdout).not.toContain('  ok  ')
    expect(m.ascii.stdout).toContain('\x1b[32m√\x1b[39m')
  })

  it('broken wiring: fail→1 identically styled or plain (exit-code law)', () => {
    const root = initializedRepo()
    unlinkSync(join(root, '.claude', 'hooks', 'stop.sh'))
    const m = runMatrix(() => (caps) => runDoctor(root, {}, caps, inertProgress()))
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(1)
    expect(m.plain.stdout).toContain('  FAIL  hook shims missing: stop.sh')
    expect(m.styled.stdout).toContain('\x1b[31m✗\x1b[39m')
    expect(m.styled.stdout).toContain('\x1b[31m1 problem found\x1b[39m')
  })
})

describe('matrix: sofar new / switch', () => {
  it('new: styled ✓ confirmation with dim └ details; identical wording piped', () => {
    const m = runMatrix(() => {
      const root = freshRepo()
      return (caps, errCaps) => runNew(root, 'demo-x', { goal: 'matrix goal' }, caps, errCaps)
    })
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stdout).toBe(
      'created .sofar/initiatives/demo-x/ (goal: matrix goal)\nbound branch "main" → demo-x\n',
    )
    expect(m.styled.stdout).toContain('\x1b[32m✓\x1b[39m created .sofar/initiatives/demo-x/')
    expect(m.styled.stdout).toContain('└ bound branch "main" → demo-x')
    expect(m.ascii.stdout).toContain('\x1b[32m√\x1b[39m created')
  })

  it('new failure: exit 1 everywhere; stderr styles under errCaps only', () => {
    const m = runMatrix(() => {
      const root = freshRepo()
      return (caps, errCaps) => runNew(root, 'Bad_Slug', {}, caps, errCaps)
    })
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(1)
    expect(m.plain.stdout).toBe('')
    expect(m.plain.stderr).toContain('sofar new: invalid slug "Bad_Slug"')
    expect(m.styled.stderr.startsWith('\x1b[31m✗\x1b[39m sofar new: invalid slug')).toBe(true)
    expect(m.ascii.stderr.startsWith('\x1b[31m×\x1b[39m sofar new: invalid slug')).toBe(true)
  })

  it('switch: rebind confirmation styled per caps, same wording', () => {
    const m = runMatrix(() => {
      const fixture = fx() // binds main → demo
      mkdirSync(join(fixture.root, '.sofar', 'initiatives', 'other'), { recursive: true })
      return (caps, errCaps) => runSwitch(fixture.root, 'other', caps, errCaps)
    })
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stdout).toBe('bound branch "main" → other\n')
    expect(m.styled.stdout).toBe('\x1b[32m✓\x1b[39m bound branch "main" → other\n')
  })

  it('switch failure: unknown slug exits 1 everywhere; ✗ only under styled errCaps', () => {
    const m = runMatrix(() => {
      const fixture = fx()
      return (caps, errCaps) => runSwitch(fixture.root, 'ghost', caps, errCaps)
    })
    assertMatrixLaws(m)
    expect(m.plain.exitCode).toBe(1)
    expect(m.plain.stderr).toContain('sofar switch: initiative "ghost" not found')
    expect(m.styled.stderr).toContain('\x1b[31m✗\x1b[39m sofar switch:')
  })
})

describe('matrix: sofar init / uninit', () => {
  it('init: dim └ detail rails + ✓ result under styled caps; plain report piped', () => {
    const m = runMatrix(() => {
      const root = freshRepo()
      return (caps, errCaps) => runInit(root, caps, errCaps)
    })
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stdout).toContain('created .sofar/repo.md')
    expect(m.plain.stdout).toContain('sofar init: done')
    expect(m.styled.stdout).toContain('\x1b[2m  └ created .sofar/repo.md\x1b[22m')
    expect(m.styled.stdout).toContain('\x1b[32m✓\x1b[39m sofar init: done')
    expect(m.ascii.stdout).toContain('`- created .sofar/repo.md')
  })

  it('init scanner hint stays plain copy-paste material even under styled caps', () => {
    const m = runMatrix(() => {
      const root = freshRepo()
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { tailwindcss: '^4.1.0' } }, null, 2),
      )
      return (caps, errCaps) => runInit(root, caps, errCaps)
    })
    assertMatrixLaws(m)

    for (const cell of [m.plain, m.styled, m.ascii, m.disabled]) {
      const hintAt = cell.stdout.indexOf('note: Tailwind v4 detected')
      expect(hintAt).toBeGreaterThan(-1)
      expect(cell.stdout.slice(hintAt)).not.toMatch(ESC) // the hint block itself is never styled
      expect(cell.stdout.slice(hintAt)).toContain('@source not')
    }
  })

  it('uninit: styled rails + ✓ result; record-kept notice in every cell', () => {
    const m = runMatrix(() => {
      const root = initializedRepo()
      return (caps, errCaps) => runUninit(root, {}, caps, errCaps)
    })
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stdout).toContain('record kept at .sofar/ (use --purge to delete it)')
    expect(m.plain.stdout).toContain('sofar uninit: done')
    expect(m.styled.stdout).toContain('\x1b[32m✓\x1b[39m sofar uninit: done')
    expect(m.styled.stdout).toContain('└ record kept at .sofar/')
  })

  it('uninit --purge: irreversibility warning styles yellow under stderr caps only', () => {
    const m = runMatrix(() => {
      const root = initializedRepo()
      return (caps, errCaps) => runUninit(root, { purge: true }, caps, errCaps)
    })
    assertMatrixLaws(m)

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stderr).toContain('warning: --purge deleted the sofar record')
    expect(m.styled.stderr).toContain('\x1b[33mwarning: --purge deleted the sofar record')
  })
})

describe('matrix: sofar adopt', () => {
  function adoptFixture(): Fixture {
    const fixture = fx()
    writeFileSync(join(fixture.root, 'LEGACY.md'), '# Legacy record\n\nGoal: old goal\n')
    return fixture
  }

  it('the migration brief is agent-executed copy-paste material — plain in every cell; only the --mark line styles', () => {
    // The brief embeds a fresh session id per run, so cross-cell bytes differ
    // legitimately (stableBytes: false) — plainness is asserted per cell.
    const m = runMatrix(() => {
      const fixture = adoptFixture()
      return (caps) => runAdopt(fixture.root, 'LEGACY.md', undefined, { mark: true }, caps)
    })
    assertMatrixLaws(m, { stableBytes: false, asciiGlyphFree: false })

    expect(m.plain.exitCode).toBe(0)
    expect(m.plain.stdout).toContain('# Sofar migration brief — replay LEGACY.md into initiative "demo"')
    expect(m.plain.stdout).toContain('marked LEGACY.md superseded (banner prepended)')

    // styled: every line except the final --mark confirmation stays plain
    const styledLines = m.styled.stdout.trimEnd().split('\n')
    const markLine = styledLines[styledLines.length - 1]!
    expect(markLine).toBe('\x1b[32m✓\x1b[39m marked LEGACY.md superseded (banner prepended)')
    expect(styledLines.slice(0, -1).join('\n')).not.toMatch(ESC)

    const asciiLines = m.ascii.stdout.trimEnd().split('\n')
    expect(asciiLines[asciiLines.length - 1]).toBe(
      '\x1b[32m√\x1b[39m marked LEGACY.md superseded (banner prepended)',
    )
  })

  it('typed-error JSON on stderr (BD17) is an agent contract — never styled, exit 1 everywhere', () => {
    const m = runMatrix(() => {
      const fixture = fx()
      return (caps) => runAdopt(fixture.root, 'missing.md', undefined, {}, caps)
    })
    assertMatrixLaws(m, { stableBytes: false })

    for (const cell of [m.plain, m.styled, m.ascii, m.disabled]) {
      expect(cell.exitCode).toBe(1)
      expect(cell.stdout).toBe('')
      expect(cell.stderr).not.toMatch(ESC)
      const shape = JSON.parse(cell.stderr) as { code: string; message: string }
      expect(shape.code).toBe('io_error')
      expect(shape.message).toContain('legacy file not found')
    }
  })
})

describe('matrix: sofar upgrade (pure handler, injected deps)', () => {
  const GLOBAL_SELF = join(sep, 'usr', 'local', 'lib', 'node_modules', '@alignlabs', 'sofar', 'dist', 'cli.js')

  function deps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
    return {
      selfPath: GLOBAL_SELF,
      fetchLatest: () => '99.0.0',
      spawnInstall: async () => 0,
      ...overrides,
    }
  }

  it('--check report is plain text under every caps cell', async () => {
    const outputs: CmdResult[] = []
    for (const caps of [PLAIN, STYLED, ASCII, DISABLED]) {
      outputs.push(await runUpgrade({ check: true }, deps(), caps))
    }
    for (const result of outputs) {
      expect(result.exitCode).toBe(0)
      expectPlainBytes(result)
      expect(result.stdout).toContain('latest:    99.0.0 (update available)')
    }
    // upgrade's stdout report never styles: all four cells byte-identical
    expect(new Set(outputs.map((r) => r.stdout)).size).toBe(1)
  })

  it('npm failure exit codes pass through unchanged, styled or plain', async () => {
    const failing = deps({ spawnInstall: async () => 3, spinnerStream: capture() })
    const plain = await runUpgrade({}, failing, PLAIN)
    const styled = await runUpgrade({}, failing, { ...STYLED, animate: true })
    expect(plain.exitCode).toBe(3)
    expect(styled.exitCode).toBe(3)
    expectPlainBytes(plain)
  })
})

describe('matrix: sofar serve banner (pure renderer — no ports)', () => {
  const URL_ = 'http://127.0.0.1:4173'
  const WORDING = 'sofar serve: http://127.0.0.1:4173 (GET /state, /state/<slug>, /events SSE)\n'

  it('plain and disabled cells carry the exact plain wording; styled adds accent+dim only', () => {
    expect(renderServeBanner(URL_, PLAIN)).toBe(WORDING)
    expect(renderServeBanner(URL_, DISABLED)).toBe(WORDING)

    const styled = renderServeBanner(URL_, STYLED)
    expect(nonSemanticEscapes(styled)).toEqual([])
    expect(styled).toContain('\x1b[35msofar serve\x1b[39m') // brand accent
    expect(styled).toContain('\x1b[2m') // dim endpoints
    expect(stripAnsi(styled)).toBe(WORDING) // identical wording, styled or not

    expect(stripAnsi(renderServeBanner(URL_, ASCII))).toBe(WORDING)
  })
})

// ---------------------------------------------------------------------------
// 1b. Hostile record content — the color law holds for arbitrary record
//     bytes (SPEC §CLI UI: record prose is sanitized before styled
//     rendering; the plain renderers pass record bytes through untouched).
// ---------------------------------------------------------------------------

describe('hostile record content: escapes in record prose degrade to plain characters on the styled layouts', () => {
  const OSC = '\x1b]0;pwn\x07' // window-title escape — the classic terminal-injection probe

  /**
   * Every record-prose slot of the layout grammar booby-trapped with the
   * escapes the SGR-only strip used to leak: 256-color and truecolor SGR,
   * reset-all, background + reverse-video codes, an OSC sequence, and a
   * lone ESC byte that is not part of any sequence.
   */
  function seedHostile(fixture: Fixture): void {
    const mk = (
      type: string,
      payload: Record<string, unknown>,
      session = 'sess-h1',
      source: EventEnvelope['source'] = 'claude-code',
    ): EventEnvelope =>
      makeEvent({ initiative: fixture.slug, session, source, actor: 'agent', type, payload })

    appendEvents(fixture.eventsPath, [
      mk(
        'initiative_created',
        { slug: fixture.slug, goal: 'ship \x1b[38;2;9;9;9mtruecolor\x1b[0m goal' },
        'cli',
        'cli',
      ),
      mk('session_started', { tool: 'claude-code', model: 'fable-5' }),
      mk('plan_updated', {
        plan: {
          goal: 'ship \x1b[38;2;9;9;9mtruecolor\x1b[0m goal',
          phases: [
            {
              name: 'Phase \x1b[41mred-bg\x1b[0m 1',
              status: 'active',
              tasks: [
                { id: '1.1', title: 'title \x1b[38;5;196mred256\x1b[0m end', status: 'active' },
                { id: '1.2', title: 'task \x1b[7mreverse\x1b[0m video', status: 'blocked' },
              ],
            },
          ],
        },
      }),
      mk('session_ended', {
        session_id: 'sess-h1',
        summary: 'wrote \x1b[35;45mmagenta\x1b[0m bytes',
        next_action: `deploy \x1b[38;5;196mRED\x1b[0m now ${OSC}quietly`,
      }),
      // post-write-back → notes + staleness sections render the hostile note
      mk('note_added', { text: `note ${OSC} osc and a lone \x1b byte` }, 'sess-h2', 'hook'),
      mk('file_touched', { path: 'src/\x1b[31mred\x1b[0m.ts', op: 'edit' }, 'sess-h2', 'hook'),
    ])
  }

  it('styled status: 256-color/truecolor/OSC/lone-ESC bytes never reach stdout — the prose degrades to plain', () => {
    const fixture = fx()
    seedHostile(fixture)
    const styled = runStatus(fixture.root, undefined, STYLED, 200)
    expect(styled.exitCode).toBe(0)
    // the color law holds for arbitrary record bytes — nonSemanticEscapes
    // would flag 38;5 / 38;2 / 0 / 41 / 45 / 7 and the OSC sequence
    expect(nonSemanticEscapes(styled.stdout)).toEqual([])
    expect(styled.stdout).not.toContain('\x07') // OSC terminator gone too
    // every booby-trapped slot renders its plain characters
    expect(styled.stdout).toContain('ship truecolor goal')
    expect(styled.stdout).toContain('Phase red-bg 1')
    expect(styled.stdout).toContain('1.1 title red256 end')
    expect(styled.stdout).toContain('1.2 task reverse video')
    expect(styled.stdout).toContain('Next: deploy RED now quietly')
    expect(styled.stdout).toContain('note osc and a lone byte')
    expect(styled.stdout).toContain('wrote magenta bytes')
    expect(styled.stdout).toContain('src/red.ts')
  })

  it('styled list (portfolio zoom) degrades the same bytes', () => {
    const fixture = fx()
    seedHostile(fixture)
    const styled = runList(fixture.root, STYLED, 200)
    expect(styled.exitCode).toBe(0)
    expect(nonSemanticEscapes(styled.stdout)).toEqual([])
    expect(styled.stdout).not.toContain('\x07')
    expect(styled.stdout).toContain('next: deploy RED now quietly')
  })

  it('the plain path stays the agent-contract passthrough — byte-identical to renderFullStatus, hostile bytes included', () => {
    const fixture = fx()
    seedHostile(fixture)
    const plain = runStatus(fixture.root, undefined, PLAIN, 200)
    expect(plain.exitCode).toBe(0)
    // proves the seed is live AND that sanitization is scoped to the
    // styled layouts: plain bytes are the record's bytes, escapes and all
    expect(plain.stdout).toMatch(ESC)
    expect(plain.stdout).toBe(renderFullStatus(foldLog(fixture.eventsPath).state))
  })
})

// ---------------------------------------------------------------------------
// 2. Env-driven ladder — REAL detection through the default caps params.
// ---------------------------------------------------------------------------

/**
 * Force a stream's TTY-ness for one call, restoring the original shape.
 * An async callback holds the forced shape until its promise settles — a
 * plain try/finally would restore synchronously on the PENDING promise,
 * so the awaited work under test would run with the real TTY-ness.
 */
function withTTY<T>(stream: NodeJS.WriteStream, isTTY: boolean, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(stream, 'isTTY')
  Object.defineProperty(stream, 'isTTY', { value: isTTY, configurable: true })
  const restore = (): void => {
    if (desc !== undefined) Object.defineProperty(stream, 'isTTY', desc)
    else delete (stream as { isTTY?: boolean }).isTTY
  }
  let result: T
  try {
    result = fn()
  } catch (err) {
    restore()
    throw err
  }
  if (result instanceof Promise) {
    return result.finally(restore) as unknown as T
  }
  restore()
  return result
}

function withTTYs<T>(stdoutTTY: boolean, stderrTTY: boolean, fn: () => T): T {
  return withTTY(process.stdout, stdoutTTY, () => withTTY(process.stderr, stderrTTY, fn))
}

/** Pin the entire color ladder's env inputs (undefined = variable absent). */
function ladderEnv(vars: {
  NO_COLOR?: string
  FORCE_COLOR?: string
  CI?: string
  TERM?: string
}): void {
  vi.stubEnv('NO_COLOR', vars.NO_COLOR)
  vi.stubEnv('FORCE_COLOR', vars.FORCE_COLOR)
  vi.stubEnv('CI', vars.CI)
  vi.stubEnv('TERM', vars.TERM ?? 'xterm-256color')
}

describe('env ladder: piped default — ambient CI included — is byte-plain everywhere', () => {
  it('every human command emits zero ESC on stdout AND stderr with both streams piped under CI', () => {
    const statusFixture = fx()
    seedInitiative(statusFixture)
    const doctorRoot = initializedRepo()
    const initRoot = freshRepo()
    const newRoot = freshRepo()
    const uninitRoot = initializedRepo()
    const adoptFixture = fx()
    writeFileSync(join(adoptFixture.root, 'LEGACY.md'), '# Legacy\n')

    ladderEnv({ CI: 'true' })
    withTTYs(false, false, () => {
      const results: Array<[string, CmdResult, number]> = [
        ['status', runStatus(statusFixture.root), 0],
        ['list', runList(statusFixture.root), 0],
        ['doctor', runDoctor(doctorRoot), 0],
        ['init', runInit(initRoot), 0],
        ['new', runNew(newRoot, 'piped-demo', { goal: 'piped' }), 0],
        ['uninit', runUninit(uninitRoot), 0],
        ['adopt', runAdopt(adoptFixture.root, 'LEGACY.md'), 0],
        ['export', runExport(statusFixture.root), 0],
      ]
      for (const [name, result, exitCode] of results) {
        expect(result.exitCode, `${name} exit code`).toBe(exitCode)
        expect(result.stdout, `${name} stdout`).not.toMatch(ESC)
        expect(result.stderr, `${name} stderr`).not.toMatch(ESC)
      }
      // the report surfaces fall back to the pre-cli-ui plain renderers
      const { state } = foldLog(statusFixture.eventsPath)
      expect(results[0]![1].stdout).toBe(renderFullStatus(state))
      expect(results[1]![1].stdout).toBe(renderFullInitiativeList(listInitiatives(statusFixture.root)))
      // serve banner (stderr channel) via its stderrCaps default
      expect(renderServeBanner('http://127.0.0.1:0')).not.toMatch(ESC)
    })
  })
})

describe('env ladder: FORCE_COLOR=1 piped styles the styled-capable surfaces only', () => {
  it('status/list/doctor stdout carries semantic SGR; nothing is written to the real streams', () => {
    const fixture = fx()
    seedInitiative(fixture)
    const doctorRoot = initializedRepo()
    // tempt the scan spinner: Tailwind v4 with the exclusion already in place
    writeFileSync(
      join(doctorRoot, 'package.json'),
      JSON.stringify({ dependencies: { tailwindcss: '^4.1.0' } }, null, 2),
    )
    mkdirSync(join(doctorRoot, 'src'), { recursive: true })
    writeFileSync(join(doctorRoot, 'src', 'app.css'), '@import "tailwindcss";\n@source not "../.sofar";\n')

    ladderEnv({ FORCE_COLOR: '1', CI: 'true' })
    withTTYs(false, false, () => {
      const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

      const status = runStatus(fixture.root)
      const list = runList(fixture.root)
      const doctor = runDoctor(doctorRoot)
      for (const result of [status, list, doctor]) {
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toMatch(SGR_RE)
        expect(nonSemanticEscapes(result.stdout)).toEqual([])
        expect(result.stderr).not.toMatch(ESC) // warnings channel stays quiet/plain
      }
      // handlers are pure and the spinner is animate-gated: a FORCE_COLOR
      // pipe carries no spinner bytes at all — not even the static line
      expect(outSpy).not.toHaveBeenCalled()
      expect(errSpy).not.toHaveBeenCalled()

      // one-shot confirmations style too (styled-capable surfaces)
      const initRoot = freshRepo()
      expect(runInit(initRoot).stdout).toContain('\x1b[32m✓\x1b[39m sofar init: done')
    })
  })

  it('guaranteed-plain surfaces ignore FORCE_COLOR entirely', () => {
    const fixture = fx()
    seedInitiative(fixture)

    ladderEnv({ FORCE_COLOR: '1', CI: 'true' })
    withTTYs(false, false, () => {
      const { state } = foldLog(fixture.eventsPath)
      const digest = renderStatus(state, { sessionId: 'sess-env-1' })
      expect(digest).not.toMatch(ESC)
      expect(digest.startsWith(`# Sofar status: ${fixture.slug}`)).toBe(true)

      const exported = runExport(fixture.root)
      expect(exported.exitCode).toBe(0)
      expect(exported.stdout).not.toMatch(ESC)
      for (const line of exported.stdout.trimEnd().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow()
      }

      const appended = runAppend(fixture.root, {
        type: 'note_added',
        payload: JSON.stringify({ text: 'plain-surface probe' }),
        session: 'sess-env-1',
        source: 'cli',
        actor: 'human',
      })
      expect(appended.exitCode).toBe(0)
      expect(appended.stdout).not.toMatch(ESC)
      expect(JSON.parse(appended.stdout)).toMatchObject({ ok: true })

      // on-disk projections regenerated under the hostile env stay plain
      const plan = readFileSync(join(fixture.initiativeDir, 'plan.md'), 'utf8')
      expect(plan).not.toMatch(ESC)
    })
  })
})

describe('env ladder: vetoes', () => {
  it('NO_COLOR with an EMPTY value beats FORCE_COLOR on a TTY — plain renderer bytes', () => {
    const fixture = fx()
    seedInitiative(fixture)
    const doctorRoot = initializedRepo()

    ladderEnv({ NO_COLOR: '', FORCE_COLOR: '1' })
    withTTYs(true, true, () => {
      const status = runStatus(fixture.root)
      expect(status.stdout).toBe(renderFullStatus(foldLog(fixture.eventsPath).state))
      const list = runList(fixture.root)
      expect(list.stdout).toBe(renderFullInitiativeList(listInitiatives(fixture.root)))
      const doctor = runDoctor(doctorRoot)
      expect(doctor.exitCode).toBe(0)
      expect(doctor.stdout).toContain('  ok  ')
      for (const result of [status, list, doctor]) expectPlainBytes(result)
    })
  })

  it('FORCE_COLOR=0 vetoes ambient TTY color', () => {
    const fixture = fx()
    seedInitiative(fixture)
    ladderEnv({ FORCE_COLOR: '0' })
    withTTYs(true, true, () => {
      expect(runStatus(fixture.root).stdout).toBe(renderFullStatus(foldLog(fixture.eventsPath).state))
    })
  })

  it('TERM=dumb never gets ambient color, even on a TTY', () => {
    const fixture = fx()
    seedInitiative(fixture)
    ladderEnv({ TERM: 'dumb' })
    withTTYs(true, true, () => {
      expect(runStatus(fixture.root).stdout).toBe(renderFullStatus(foldLog(fixture.eventsPath).state))
    })
  })
})

describe('guaranteed-plain byte-identity across EVERY env/flag/TTY combination', () => {
  interface Scenario {
    name: string
    env: { NO_COLOR?: string; FORCE_COLOR?: string; CI?: string; TERM?: string }
    tty: boolean
  }

  const SCENARIOS: Scenario[] = [
    { name: 'piped default', env: {}, tty: false },
    { name: 'piped ambient CI', env: { CI: 'true' }, tty: false },
    { name: 'piped FORCE_COLOR+CI', env: { FORCE_COLOR: '1', CI: 'true' }, tty: false },
    { name: 'TTY FORCE_COLOR', env: { FORCE_COLOR: '1' }, tty: true },
    { name: 'TTY NO_COLOR empty', env: { NO_COLOR: '' }, tty: true },
    { name: 'TTY TERM=dumb', env: { TERM: 'dumb' }, tty: true },
  ]

  it('renderStatus digest and export NDJSON produce identical bytes in all six scenarios', () => {
    const fixture = fx()
    seedInitiative(fixture)
    const { state } = foldLog(fixture.eventsPath)

    const digests = new Set<string>()
    const exports = new Set<string>()
    for (const scenario of SCENARIOS) {
      ladderEnv(scenario.env)
      withTTYs(scenario.tty, scenario.tty, () => {
        digests.add(renderStatus(state, { sessionId: 'sess-fixed' }))
        exports.add(runExport(fixture.root).stdout)
      })
      vi.unstubAllEnvs()
    }
    expect(digests.size).toBe(1)
    expect(exports.size).toBe(1)
    expect([...digests][0]).not.toMatch(ESC)
    expect([...exports][0]).not.toMatch(ESC)
  })

  it('sofar_get_state over MCP stdio is byte-identical hostile vs plain env', async () => {
    const fixture = fx()
    seedInitiative(fixture)

    async function digestUnder(env: Scenario['env'], tty: boolean): Promise<string> {
      ladderEnv(env)
      return withTTYs(tty, tty, async () => {
        const { client } = await connectServer(fixture.root)
        try {
          const { isError, text } = await callToolText(client, 'sofar_get_state', {})
          expect(isError).toBe(false)
          return text
        } finally {
          await client.close()
        }
      }).finally(() => vi.unstubAllEnvs())
    }

    const hostile = await digestUnder({ FORCE_COLOR: '1', CI: 'true' }, true)
    const plain = await digestUnder({ NO_COLOR: '' }, false)
    expect(hostile).toBe(plain)
    expect(hostile).not.toMatch(ESC)
    expect(hostile.startsWith(`# Sofar status: ${fixture.slug}`)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Spinner channel law.
// ---------------------------------------------------------------------------

describe('spinner law: frames only on an animating stderr, never stdout, nothing when piped', () => {
  function tailwindRepo(): string {
    const root = initializedRepo()
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { tailwindcss: '^4.1.0' } }, null, 2),
    )
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'app.css'), '@import "tailwindcss";\n@source not "../.sofar";\n')
    return root
  }

  it('doctor: animating stderr gets frames + cursor control; stdout write never fires', () => {
    const root = tailwindRepo()
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const progress = capture()
    const result = runDoctor(root, {}, PLAIN, {
      caps: { color: true, unicode: true, animate: true },
      stream: progress,
    })
    const frames = progress.chunks.join('')
    expect(frames).toContain('\x1b[?25l') // cursor hidden
    expect(frames).toContain('scanning tree for Tailwind entry stylesheets')
    expect(frames).toContain('\x1b[?25h') // cursor restored
    expect(frames).toContain('tree scan: 1 Tailwind entry stylesheet')
    expect(outSpy).not.toHaveBeenCalled()
    // the report itself carries no cursor tricks — spinner bytes never leak in
    expect(result.stdout).not.toContain('\x1b[?25l')
    expect(result.stdout).not.toContain('\r')
  })

  it('doctor: a piped stderr carries ZERO spinner bytes — color-without-animate (FORCE_COLOR pipe) included', () => {
    const root = tailwindRepo()
    for (const caps of [
      { color: true, unicode: true, animate: false }, // FORCE_COLOR=1 pipe
      { color: false, unicode: true, animate: false }, // plain pipe / CI
      DISABLED,
    ]) {
      const progress = capture()
      const result = runDoctor(root, {}, PLAIN, { caps, stream: progress })
      expect(result.exitCode).toBe(0)
      expect(progress.chunks).toEqual([]) // not even the static ⋯ line
    }
  })

  it('upgrade: network spinner obeys the same gate', async () => {
    const deps: UpgradeDeps = {
      selfPath: join(sep, 'usr', 'local', 'lib', 'node_modules', '@alignlabs', 'sofar', 'dist', 'cli.js'),
      fetchLatest: () => '99.0.0',
      spawnInstall: async () => 0,
    }

    const animated = capture()
    const spun = await runUpgrade({}, { ...deps, spinnerStream: animated }, { color: true, unicode: true, animate: true })
    expect(spun.exitCode).toBe(0)
    const frames = animated.chunks.join('')
    expect(frames).toContain('installing @alignlabs/sofar@99.0.0')
    expect(frames).toContain('\x1b[?25l')
    expect(frames).toContain('\x1b[?25h')

    const piped = capture()
    const still = await runUpgrade({}, { ...deps, spinnerStream: piped }, { color: true, unicode: true, animate: false })
    expect(still.exitCode).toBe(0)
    expect(piped.chunks).toEqual([]) // FORCE_COLOR pipe: silent, no static line
  })
})

// ---------------------------------------------------------------------------
// 4. Static import lock — protected surfaces never reach cli/ui.
// ---------------------------------------------------------------------------

const SRC_DIR = resolve(fileURLToPath(new URL('../src', import.meta.url)))

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walkTs(path, out)
    else if (path.endsWith('.ts')) out.push(path)
  }
  return out
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

// A `.js`/`.mjs`/`.cjs` suffix maps back to the TS source (bundler
// resolution) — a '../cli/ui/index.js' import typechecks and bundles into
// cli/ui, so the lock must resolve it rather than drop the edge.
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec.replace(/\.[cm]?js$/, ''))
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (candidate.endsWith('.ts') && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate
    }
  }
  return null
}

describe('static lock: projections/**, mcp/**, cli/event.ts import nothing from cli/ui', () => {
  it('BFS over relative imports finds no chain into src/cli/ui', () => {
    const files = walkTs(SRC_DIR)
    const graph = new Map<string, string[]>()
    for (const file of files) {
      const deps: string[] = []
      for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3]
        if (spec === undefined || !spec.startsWith('.')) continue
        const dep = resolveRelative(file, spec)
        if (dep !== null) deps.push(dep)
      }
      graph.set(file, deps)
    }

    const uiDir = join(SRC_DIR, 'cli', 'ui') + sep
    const protectedRoots = files.filter(
      (file) =>
        file.startsWith(join(SRC_DIR, 'projections') + sep) ||
        file.startsWith(join(SRC_DIR, 'mcp') + sep) ||
        file === join(SRC_DIR, 'cli', 'event.ts'),
    )
    expect(protectedRoots.length).toBeGreaterThan(5) // the walk is real

    // positive controls: the styled surfaces DO reach cli/ui, and the
    // resolver sees bundler-style `.js` specifiers — if either fails, the
    // resolver has gone blind, not the codebase clean
    expect(resolveRelative(join(SRC_DIR, 'cli', 'status.ts'), './ui/index.js')).toBe(
      join(SRC_DIR, 'cli', 'ui', 'index.ts'),
    )
    const reaches = (root: string): boolean => {
      const seen = new Set([root])
      const queue = [root]
      while (queue.length > 0) {
        for (const dep of graph.get(queue.shift()!) ?? []) {
          if (seen.has(dep)) continue
          if (dep.startsWith(uiDir)) return true
          seen.add(dep)
          queue.push(dep)
        }
      }
      return false
    }
    expect(reaches(join(SRC_DIR, 'cli', 'status.ts'))).toBe(true)

    const violations = protectedRoots.filter(reaches).map((f) => f.slice(SRC_DIR.length + 1))
    expect(violations).toEqual([])
  })
})
