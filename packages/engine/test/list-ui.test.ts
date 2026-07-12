import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runList } from '../src/cli/list'
import { stripAnsi, visibleWidth, type Caps } from '../src/cli/ui'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { listInitiatives } from '../src/core/listing'
import { serializeEvent } from '../src/core/log'
import { renderFullInitiativeList } from '../src/projections/templates/list'
import { makeRepoFixture } from './helpers/mcp'

/**
 * cli-ui 2.3 — styled `sofar list`. All caps and columns are passed
 * explicitly (no TTY faking): the styled path exercises the portfolio-zoom
 * layout plus the list decorations (current-branch pointer, right-aligned
 * branch tag), and the plain path is locked byte-identical to the
 * pre-styling render.
 */

const STYLED: Caps = { color: true, unicode: true, animate: false }
const PLAIN: Caps = { color: false, unicode: true, animate: false }

function ev(initiative: string, type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({
    initiative,
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
}

function writeInitiative(root: string, slug: string, events: EventEnvelope[]): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  if (events.length > 0) {
    writeFileSync(join(dir, 'events.jsonl'), events.map(serializeEvent).join('\n') + '\n')
  }
}

function planned(slug: string, extra: EventEnvelope[] = []): EventEnvelope[] {
  return [
    ev(slug, 'initiative_created', { slug, goal: `goal of ${slug}` }),
    ev(slug, 'plan_updated', {
      plan: {
        phases: [
          {
            name: 'Phase 1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'first', status: 'done' },
              { id: '1.2', title: 'second' },
            ],
          },
        ],
      },
    }),
    ...extra,
  ]
}

/** Bound demo (branch main) + a later unbound initiative, both planned. */
function twoInitiativeFixture(): { root: string } {
  const fixture = makeRepoFixture() // branch main, slug demo, bound
  writeInitiative(
    fixture.root,
    'demo',
    planned('demo', [
      ev('demo', 'session_started', { tool: 'claude-code' }),
      ev('demo', 'session_ended', { summary: 'did work', next_action: 'do next thing' }),
    ]),
  )
  writeInitiative(fixture.root, 'other', planned('other'))
  return fixture
}

describe('sofar list: plain path stays byte-identical', () => {
  it('renders exactly the pre-styling full listing when color is off', () => {
    const fixture = twoInitiativeFixture()
    const r = runList(fixture.root, PLAIN, 80)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe(renderFullInitiativeList(listInitiatives(fixture.root)))
    expect(r.stdout).toContain('- demo [main] — 1/2 tasks (50%)')
    expect(r.stdout).not.toContain('\x1b[')
  })

  it('default caps thread through detection and match explicit plain caps', () => {
    const fixture = twoInitiativeFixture()
    // NO_COLOR beats every other signal (CI, FORCE_COLOR), so the default
    // stdoutCaps() path is deterministically plain here.
    vi.stubEnv('NO_COLOR', '1')
    try {
      expect(runList(fixture.root)).toEqual(runList(fixture.root, PLAIN, 80))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('color gates the layout: a NO_COLOR TTY (animate on) still gets plain bytes', () => {
    const fixture = twoInitiativeFixture()
    const noColorTty = runList(fixture.root, { color: false, unicode: true, animate: true }, 80)
    expect(noColorTty.stdout).toBe(runList(fixture.root, PLAIN, 80).stdout)
  })

  it('narrow columns never touch the plain render (no truncation when piped)', () => {
    const fixture = twoInitiativeFixture()
    expect(runList(fixture.root, PLAIN, 24).stdout).toBe(runList(fixture.root, PLAIN, 80).stdout)
  })
})

describe('sofar list: styled path', () => {
  it('renders a bold header with a dim count over portfolio blocks', () => {
    const fixture = twoInitiativeFixture()
    const r = runList(fixture.root, STYLED, 80)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.startsWith('\x1b[1mSofar initiatives\x1b[22m \x1b[2m(2)\x1b[22m\n\n')).toBe(
      true,
    )
  })

  it('marks the current-branch initiative with an accent pointer; others get a plain gutter', () => {
    const fixture = twoInitiativeFixture()
    const lines = runList(fixture.root, STYLED, 80).stdout.split('\n')
    const demo = lines.find((l) => stripAnsi(l).includes('demo  1/2 tasks'))!
    const other = lines.find((l) => stripAnsi(l).includes('other  1/2 tasks'))!
    expect(demo.startsWith('\x1b[35m▸\x1b[39m ')).toBe(true)
    expect(stripAnsi(other).startsWith('  ◑ other')).toBe(true)
  })

  it('right-aligns dim branch tags to the column edge on visible width', () => {
    const fixture = twoInitiativeFixture()
    const lines = runList(fixture.root, STYLED, 80).stdout.split('\n')
    const demo = lines.find((l) => stripAnsi(l).includes('demo  1/2 tasks'))!
    const other = lines.find((l) => stripAnsi(l).includes('other  1/2 tasks'))!
    expect(stripAnsi(demo)).toMatch(/^▸ ◑ demo {2}1\/2 tasks \(50%\) {2}● Phase 1 +\[main\]$/)
    expect(demo.endsWith('\x1b[2m[main]\x1b[22m')).toBe(true)
    expect(visibleWidth(demo)).toBe(80)
    expect(stripAnsi(other)).toMatch(/\[unbound\]$/)
    expect(visibleWidth(other)).toBe(80)
  })

  it('portfolio detail lines ride the dim └ rail under a two-space gutter', () => {
    const fixture = twoInitiativeFixture()
    const text = runList(fixture.root, STYLED, 80).stdout
    expect(text).toContain('    \x1b[2m└ next: do next thing\x1b[22m')
    expect(text).toContain('    \x1b[2m└ goal: goal of other\x1b[22m') // no next action recorded yet
  })

  it('surfaces blocked and staleness lines from the folded state', () => {
    const fixture = makeRepoFixture()
    writeInitiative(fixture.root, 'demo', [
      ev('demo', 'initiative_created', { slug: 'demo', goal: 'goal of demo' }),
      ev('demo', 'plan_updated', {
        plan: {
          phases: [
            {
              name: 'Phase 1',
              status: 'active',
              tasks: [{ id: '1.1', title: 'first', status: 'blocked' }],
            },
          ],
        },
      }),
      ev('demo', 'session_started', { tool: 'claude-code' }),
      ev('demo', 'session_ended', { summary: 'did work', next_action: 'unblock 1.1' }),
      ev('demo', 'file_touched', { path: 'src/x.ts', op: 'edit' }),
    ])
    const text = runList(fixture.root, STYLED, 80).stdout
    expect(text).toContain('    \x1b[31m✗ blocked: task 1.1 (first)\x1b[39m')
    expect(text).toContain(
      '    \x1b[33m⚠ next action may be stale: 1 event since write-back\x1b[39m',
    )
  })

  it('survives SGR escapes recorded in prose fields — stripped, never a crash', () => {
    const fixture = makeRepoFixture()
    writeInitiative(
      fixture.root,
      'demo',
      planned('demo', [
        ev('demo', 'session_started', { tool: 'claude-code' }),
        ev('demo', 'session_ended', {
          summary: 'did work',
          next_action: 'paint it \x1b[31mred\x1b[39m next',
        }),
      ]),
    )
    const r = runList(fixture.root, STYLED, 80)
    expect(r.exitCode).toBe(0)
    expect(stripAnsi(r.stdout)).toContain('└ next: paint it red next')
    expect(r.stdout).not.toContain('\x1b[31mred')
  })

  it('keeps every line within the column budget and drops the tag when it cannot fit', () => {
    const fixture = twoInitiativeFixture()
    for (const columns of [40, 24]) {
      const text = runList(fixture.root, STYLED, columns).stdout
      for (const line of text.split('\n')) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
      }
      expect(text).not.toContain('[main]')
      expect(text).not.toContain('[unbound]')
    }
  })

  it('renders ascii glyphs throughout when unicode is off', () => {
    const fixture = twoInitiativeFixture()
    const ascii: Caps = { color: true, unicode: false, animate: false }
    const text = runList(fixture.root, ascii, 80).stdout
    const demo = text.split('\n').find((l) => stripAnsi(l).includes('demo  1/2 tasks'))!
    expect(stripAnsi(demo).startsWith('> demo')).toBe(true)
    expect(text).toContain('`- next: do next thing')
    expect(text).not.toContain('▸')
    expect(text).not.toContain('└')
  })

  it('renders the sofar-new hint dim on an empty listing', () => {
    const fixture = makeRepoFixture({ bind: false })
    rmSync(fixture.initiativeDir, { recursive: true, force: true })
    const r = runList(fixture.root, STYLED, 80)
    expect(r.stdout).toBe(
      '\x1b[1mSofar initiatives\x1b[22m \x1b[2m(0)\x1b[22m\n\n' +
        '\x1b[2m(no initiatives — create one with `sofar new <slug>`)\x1b[22m\n',
    )
  })

  it('keeps warnings on stderr and thins an unreadable initiative to its entry, exit 0', () => {
    const fixture = makeRepoFixture({ bind: false })
    writeInitiative(fixture.root, 'demo', planned('demo'))
    writeFileSync(join(fixture.root, '.sofar', 'bindings.json'), 'not json{')
    // A directory named events.jsonl makes foldLog throw (EISDIR) — the
    // styled block must survive without detail, like the plain line does.
    mkdirSync(join(fixture.root, '.sofar', 'initiatives', 'broken', 'events.jsonl'), {
      recursive: true,
    })
    const r = runList(fixture.root, STYLED, 80)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toContain('warning: bindings.json:')
    expect(r.stderr).toContain('warning: broken:')
    const plain = stripAnsi(r.stdout)
    expect(plain).toContain('  broken  0/0 tasks (0%)')
    expect(plain).toContain('  └ next: (none recorded)')
  })
})
