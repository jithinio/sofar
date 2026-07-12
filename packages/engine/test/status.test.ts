import { appendFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { makeEvent } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { runStatus } from '../src/cli/status'
import type { Caps } from '../src/cli/ui'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Task 4.3 — `sofar status [slug]`: golden-ish assertions on a folded
 * fixture (progress %, per-task tree, blocked_on, last session), fold
 * warnings on stderr, and exit-1 resolution failures.
 *
 * cli-ui 2.2 — capability-gated rendering: all caps are passed explicitly
 * (no TTY faking); the plain path is locked byte-identical to the
 * pre-styling renderFullStatus output, the styled path gets the full-zoom
 * layout grammar.
 */

const STYLED: Caps = { color: true, unicode: true, animate: false }
const PLAIN: Caps = { color: false, unicode: true, animate: false }

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

function ev(
  fixture: Fixture,
  type: string,
  payload: Record<string, unknown>,
  session = 'cli',
): EventEnvelope {
  return makeEvent({
    initiative: fixture.slug,
    session,
    source: 'cli',
    actor: 'agent',
    type,
    payload,
  })
}

function seed(fixture: Fixture): void {
  appendEvents(fixture.eventsPath, [
    ev(fixture, 'initiative_created', { slug: fixture.slug, goal: 'ship the demo' }),
    ev(fixture, 'plan_updated', {
      plan: {
        phases: [
          {
            name: 'Build',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'scaffold', status: 'done' },
              { id: '1.2', title: 'wire events', status: 'active' },
              { id: '1.3', title: 'ship types', status: 'pending' },
            ],
          },
          {
            name: 'Polish',
            status: 'pending',
            tasks: [{ id: '2.1', title: 'docs', status: 'pending' }],
          },
        ],
      },
    }),
    ev(fixture, 'task_status_changed', { id: '1.3', status: 'blocked', note: 'waiting on schema review' }),
    ev(fixture, 'file_touched', { path: 'src/core/log.ts', op: 'edit' }),
    ev(fixture, 'session_started', { tool: 'claude-code' }, 'sess-1'),
    ev(
      fixture,
      'session_ended',
      { session_id: 'sess-1', summary: 'built the scaffold end to end', next_action: 'wire events next' },
      'sess-1',
    ),
  ])
}

describe('sofar status', () => {
  it('prints goal, progress %, per-task phase tree, blocked_on, next action, last session', () => {
    const fixture = fx()
    seed(fixture)

    const result = runStatus(fixture.root) // resolved via branch binding, like MCP
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')

    const out = result.stdout
    expect(out).toContain(`# ${fixture.slug}`)
    expect(out).toContain('Goal: ship the demo')
    expect(out).toContain('Progress: 1/4 tasks done (25%) across 2 phase(s)')
    // phase tree with per-task statuses
    expect(out).toContain('- Build [active] 1/3')
    expect(out).toContain('  - [x] 1.1 scaffold')
    expect(out).toContain('  - [~] 1.2 wire events')
    expect(out).toContain('  - [!] 1.3 ship types')
    expect(out).toContain('- Polish [pending] 0/1')
    expect(out).toContain('  - [ ] 2.1 docs')
    // derived current.*
    expect(out).toContain('Next action: wire events next')
    expect(out).toContain('Blocked on: task 1.3: waiting on schema review')
    // last session: tool + summary + ended
    expect(out).toMatch(/Last session \(claude-code, ended \d{4}-/)
    expect(out).toContain('built the scaffold end to end')
    // touched files
    expect(out).toContain('Files touched (1):')
    expect(out).toContain('- src/core/log.ts')
  })

  it('accepts an explicit slug and is NOT capped at 10k chars', () => {
    const fixture = fx({ bind: false }) // no binding — explicit slug must still work
    appendEvents(fixture.eventsPath, [
      ev(fixture, 'initiative_created', { slug: fixture.slug, goal: `big ${'goal '.repeat(3_000)}` }),
    ])
    const result = runStatus(fixture.root, fixture.slug)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBeGreaterThan(10_000) // BD3 cap is SessionStart-only
    expect(result.stdout).toContain('big goal')
  })

  it('prints fold warnings to stderr without failing', () => {
    const fixture = fx()
    seed(fixture)
    appendFileSync(fixture.eventsPath, '{ torn line', 'utf8')

    const result = runStatus(fixture.root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('warning:')
    expect(result.stderr).toContain('unparseable JSON')
    expect(result.stdout).toContain('Goal: ship the demo')
  })

  it('works on a created-but-empty initiative (no events.jsonl)', () => {
    const fixture = fx()
    const result = runStatus(fixture.root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`# ${fixture.slug}`)
    expect(result.stdout).toContain('Goal: (none recorded)')
    expect(result.stdout).toContain('Progress: 0/0 tasks done (0%)')
  })

  it('exits 1 with a helpful message when unresolvable', () => {
    const unbound = fx({ bind: false })
    const noBinding = runStatus(unbound.root)
    expect(noBinding.exitCode).toBe(1)
    expect(noBinding.stderr).toContain('no initiative bound to branch "main"')
    expect(noBinding.stderr).toContain('usage: sofar status [slug]')

    const unknown = runStatus(unbound.root, 'ghost')
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain('initiative "ghost" not found')

    const detached = fx({ branch: null, bind: false })
    const noBranch = runStatus(detached.root)
    expect(noBranch.exitCode).toBe(1)
    expect(noBranch.stderr).toContain('no current git branch')
  })
})

describe('sofar status: plain path stays byte-identical (cli-ui 2.2)', () => {
  it('explicit plain caps render the pre-styling bytes with no escapes', () => {
    const fixture = fx()
    seed(fixture)
    const r = runStatus(fixture.root, undefined, PLAIN)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`# ${fixture.slug}`)
    expect(r.stdout).toContain('Progress: 1/4 tasks done (25%) across 2 phase(s)')
    expect(r.stdout).toContain('  - [~] 1.2 wire events')
    expect(r.stdout).not.toContain('\x1b[')
  })

  it('default caps thread through detection and match explicit plain caps', () => {
    const fixture = fx()
    seed(fixture)
    // NO_COLOR beats every other signal (CI, FORCE_COLOR), so the default
    // stdoutCaps() path is deterministically plain here.
    vi.stubEnv('NO_COLOR', '1')
    try {
      const dflt = runStatus(fixture.root)
      const plain = runStatus(fixture.root, undefined, PLAIN)
      expect(dflt.stdout).toBe(plain.stdout)
      expect(dflt.exitCode).toBe(plain.exitCode)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('color gates the layout: a NO_COLOR TTY (animate on) still gets plain bytes', () => {
    const fixture = fx()
    seed(fixture)
    const noColorTty = runStatus(fixture.root, undefined, { color: false, unicode: true, animate: true })
    const plain = runStatus(fixture.root, undefined, PLAIN)
    expect(noColorTty.stdout).toBe(plain.stdout)
  })
})

describe('sofar status: styled path (cli-ui 2.2)', () => {
  it('renders the full-zoom grammar: bold header, dim goal, glyph phase tree', () => {
    const fixture = fx()
    seed(fixture)
    const r = runStatus(fixture.root, undefined, STYLED)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe('')

    const out = r.stdout
    // 4.2: warn-colored pie (1/4 = quarter) leads the bold header
  expect(out.startsWith(`\x1b[33m◔\x1b[39m \x1b[1m${fixture.slug}\x1b[22m  1/4 tasks (25%)`)).toBe(true)
    expect(out).toContain('\x1b[2mship the demo\x1b[22m')
    // phase line: yellow bullet + name + dim fraction
    expect(out).toContain('\x1b[33m●\x1b[39m Build \x1b[2m1/3\x1b[22m')
    // checkbox law: green done (dim text), yellow active, red blocked, dim pending
    expect(out).toContain('  \x1b[32m[✓]\x1b[39m \x1b[2m1.1 scaffold\x1b[22m')
    expect(out).toContain('  \x1b[33m[•]\x1b[39m 1.2 wire events')
    expect(out).toContain('  \x1b[31m[✗] 1.3 ship types\x1b[39m')
    expect(out).toContain('  \x1b[2m[ ]\x1b[22m 2.1 docs')
    // next-action callout + blocked severity
    expect(out).toContain('\x1b[1m▸ Next: wire events next\x1b[22m')
    expect(out).toContain('\x1b[31m✗ Blocked on: task 1.3: waiting on schema review\x1b[39m')
    // last session + files touched keep their slots
    expect(out).toMatch(/Last session \(claude-code, ended \d{4}-/)
    expect(out).toContain('  built the scaffold end to end')
    expect(out).toContain('\x1b[1mFiles touched\x1b[22m \x1b[2m(1)\x1b[22m')
    expect(out).toContain('  \x1b[2msrc/core/log.ts\x1b[22m')
    // legacy plain markers gone on the styled path
    expect(out).not.toContain(`# ${fixture.slug}`)
    expect(out).not.toContain('Progress:')
    expect(out).not.toContain('[~]')
    expect(out.endsWith('\n')).toBe(true)
  })

  it('ascii symbols when unicode is off', () => {
    const fixture = fx()
    seed(fixture)
    const r = runStatus(fixture.root, undefined, { color: true, unicode: false, animate: false })
    expect(r.stdout).toContain('\x1b[1m> Next: wire events next\x1b[22m')
    expect(r.stdout).toContain('\x1b[31m× Blocked on: task 1.3: waiting on schema review\x1b[39m')
    expect(r.stdout).toContain('  \x1b[31m[×] 1.3 ship types\x1b[39m')
  })

  it('works on a created-but-empty initiative (no events.jsonl)', () => {
    const fixture = fx()
    const r = runStatus(fixture.root, undefined, STYLED)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`\x1b[1m${fixture.slug}\x1b[22m  0/0 tasks (0%)`)
    expect(r.stdout).toContain('\x1b[2m(none recorded)\x1b[22m')
  })

  it('fold warnings stay plain on stderr; exit code unchanged', () => {
    const fixture = fx()
    seed(fixture)
    appendFileSync(fixture.eventsPath, '{ torn line', 'utf8')
    const r = runStatus(fixture.root, undefined, STYLED)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('warning:')
    expect(r.stderr).not.toContain('\x1b[')
  })

  it('resolution failures stay plain regardless of caps', () => {
    const unbound = fx({ bind: false })
    const r = runStatus(unbound.root, undefined, STYLED)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('no initiative bound to branch "main"')
    expect(r.stderr).not.toContain('\x1b[')
  })
})

describe('sofar status --watch (cli-ui 4.3)', () => {
  it('falls back to the one-shot result when animation is unavailable', async () => {
    const { runStatusWatch } = await import('../src/cli/status')
    const fixture = fx()
    seed(fixture)
    const piped = { color: false, unicode: true, animate: false }
    const watch = runStatusWatch(fixture.root, undefined, piped)
    expect(watch).toEqual(runStatus(fixture.root, undefined, piped))
  })

  it('fails like runStatus on an unresolvable initiative', async () => {
    const { runStatusWatch } = await import('../src/cli/status')
    const fixture = fx({ bind: false })
    const r = runStatusWatch(fixture.root, undefined, { color: false, unicode: true, animate: false })
    expect(r).toBeDefined()
    expect(r!.exitCode).toBe(1)
  })
})
