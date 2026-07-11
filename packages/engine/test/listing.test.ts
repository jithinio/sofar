import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runList } from '../src/cli/list'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import { listInitiatives } from '../src/core/listing'
import {
  MAX_LIST_ENTRIES,
  renderFullInitiativeList,
  renderInitiativeList,
} from '../src/projections/templates/list'
import { callToolExpectError, callToolText, connectServer, makeRepoFixture } from './helpers/mcp'

/**
 * Listing acceptance (initiative-list 4.2, SPEC §Acceptance "Listing"):
 * derivation over several initiatives incl. empty logs and corrupt
 * bindings, recency ordering, determinism, and both renders' budgets.
 */

function ev(
  initiative: string,
  type: string,
  payload: Record<string, unknown>,
): EventEnvelope {
  return makeEvent({
    initiative,
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
}

/** Write a synthetic initiative log under the fixture root. */
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

describe('listInitiatives', () => {
  it('summarizes every initiative dir, most recently active first, never-logged last', () => {
    const fixture = makeRepoFixture({ slug: 'older' })
    // Creation order: older first, then newer — ulids are monotonic, so
    // "newer" holds the larger cursor and must list first.
    writeInitiative(fixture.root, 'older', planned('older'))
    writeInitiative(
      fixture.root,
      'newer',
      planned('newer', [
        ev('newer', 'session_started', { tool: 'claude-code' }),
        ev('newer', 'session_ended', { summary: 'did work', next_action: 'do next thing' }),
      ]),
    )
    writeInitiative(fixture.root, 'unlogged', []) // dir exists, no events.jsonl

    const { entries, warnings } = listInitiatives(fixture.root)
    expect(warnings).toEqual([])
    expect(entries.map((e) => e.slug)).toEqual(['newer', 'older', 'unlogged'])

    const newer = entries[0]!
    expect(newer.goal).toBe('goal of newer')
    expect(newer.tasks_done).toBe(1)
    expect(newer.tasks_total).toBe(2)
    expect(newer.active_phase).toBe('Phase 1')
    expect(newer.next_action).toBe('do next thing')
    expect(newer.last_event_id).not.toBeNull()

    const unlogged = entries[2]!
    expect(unlogged.last_event_id).toBeNull()
    expect(unlogged.goal).toBe('')
    expect(unlogged.tasks_total).toBe(0)
  })

  it('inverts bindings.json into sorted branch lists and leaves unbound slugs empty', () => {
    const fixture = makeRepoFixture({ slug: 'demo', bind: false })
    writeInitiative(fixture.root, 'demo', planned('demo'))
    writeFileSync(
      join(fixture.root, '.sofar', 'bindings.json'),
      JSON.stringify({ main: 'demo', 'feature/x': 'demo', stray: 42 }) + '\n',
    )

    const { entries } = listInitiatives(fixture.root)
    expect(entries[0]!.branches).toEqual(['feature/x', 'main'])
  })

  it('degrades corrupt bindings.json and an unreadable log to warnings, never a failure', () => {
    const fixture = makeRepoFixture({ slug: 'demo', bind: false })
    writeInitiative(fixture.root, 'demo', planned('demo'))
    writeFileSync(join(fixture.root, '.sofar', 'bindings.json'), 'not json{')
    // A directory named events.jsonl makes foldLog throw (EISDIR) — the
    // entry must survive without detail.
    mkdirSync(join(fixture.root, '.sofar', 'initiatives', 'broken', 'events.jsonl'), {
      recursive: true,
    })

    const { entries, warnings } = listInitiatives(fixture.root)
    expect(entries.map((e) => e.slug)).toEqual(['demo', 'broken'])
    expect(entries[1]!.last_event_id).toBeNull()
    expect(warnings.some((w) => w.startsWith('bindings.json:'))).toBe(true)
    expect(warnings.some((w) => w.startsWith('broken:'))).toBe(true)
  })

  it('prefixes per-initiative fold warnings with the slug', () => {
    const fixture = makeRepoFixture({ slug: 'demo' })
    const dir = join(fixture.root, '.sofar', 'initiatives', 'demo')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.jsonl'),
      planned('demo').map(serializeEvent).join('\n') + '\n{"torn":',
    )
    const { warnings } = listInitiatives(fixture.root)
    expect(warnings.some((w) => /^demo: line \d+: unparseable JSON/.test(w))).toBe(true)
  })

  it('is deterministic — same records → deep-equal listing, same warnings', () => {
    const fixture = makeRepoFixture({ slug: 'a' })
    writeInitiative(fixture.root, 'a', planned('a'))
    writeInitiative(fixture.root, 'b', planned('b'))
    expect(listInitiatives(fixture.root)).toEqual(listInitiatives(fixture.root))
  })

  it('returns an empty listing for a repo with no .sofar/initiatives', () => {
    const fixture = makeRepoFixture({ slug: 'demo', bind: false })
    // makeRepoFixture creates the slug dir; point at a root without one.
    const bare = join(fixture.root, 'elsewhere')
    mkdirSync(bare, { recursive: true })
    expect(listInitiatives(bare)).toEqual({ entries: [], warnings: [] })
  })
})

describe('listing renders', () => {
  function entry(slug: string, overrides: Record<string, unknown> = {}) {
    return {
      slug,
      branches: [],
      goal: '',
      tasks_done: 0,
      tasks_total: 0,
      active_phase: null,
      next_action: null,
      last_event_id: null,
      ...overrides,
    }
  }

  it('renders one line per initiative with branch, progress, phase, next action', () => {
    const text = renderFullInitiativeList({
      entries: [
        entry('alpha', {
          branches: ['main'],
          tasks_done: 2,
          tasks_total: 4,
          active_phase: 'Phase 2',
          next_action: 'ship it',
        }),
        entry('beta'),
      ],
      warnings: [],
    })
    expect(text).toContain('# Sofar initiatives (2)')
    expect(text).toContain('- alpha [main] — 2/4 tasks (50%) — active: Phase 2 — next: ship it')
    expect(text).toContain('- beta [unbound] — 0/0 tasks (0%)')
  })

  it('collapses whitespace so a multi-line next action stays one list line', () => {
    const text = renderFullInitiativeList({
      entries: [entry('alpha', { next_action: 'line one\nline two' })],
      warnings: [],
    })
    expect(text).toContain('next: line one line two')
  })

  it('budgeted render count-caps with the overflow pointer; full render does not', () => {
    const entries = Array.from({ length: MAX_LIST_ENTRIES + 3 }, (_, i) =>
      entry(`init-${String(i).padStart(2, '0')}`),
    )
    const budgeted = renderInitiativeList({ entries, warnings: [] })
    const budgetedLines = budgeted.split('\n').filter((l) => l.startsWith('- '))
    expect(budgetedLines).toHaveLength(MAX_LIST_ENTRIES + 1)
    expect(budgeted).toContain(`- …and 3 more (run sofar list)`)

    const full = renderFullInitiativeList({ entries, warnings: [] })
    expect(full.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(
      MAX_LIST_ENTRIES + 3,
    )
  })

  it('budgeted lines hold their clip budget even with a huge next action', () => {
    const text = renderInitiativeList({
      entries: [entry('alpha', { next_action: 'x'.repeat(1000) })],
      warnings: [],
    })
    const line = text.split('\n').find((l) => l.startsWith('- alpha'))!
    expect(line.length).toBeLessThanOrEqual(220)
    expect(line.endsWith('…')).toBe(true)
  })

  it('renders the sofar-new hint on an empty listing', () => {
    for (const render of [renderInitiativeList, renderFullInitiativeList]) {
      expect(render({ entries: [], warnings: [] })).toContain(
        '(no initiatives — create one with `sofar new <slug>`)',
      )
    }
  })
})

describe('listing surfaces', () => {
  it('get_state view:"initiatives" succeeds from an UNBOUND branch', async () => {
    const fixture = makeRepoFixture({ branch: 'unbound-branch', bind: false })
    writeInitiative(fixture.root, 'demo', planned('demo'))
    const { client } = await connectServer(fixture.root)
    const { isError, text } = await callToolText(client, 'sofar_get_state', {
      view: 'initiatives',
    })
    expect(isError).toBe(false)
    expect(text).toContain('# Sofar initiatives (1)')
    expect(text).toContain('- demo [unbound] — 1/2 tasks (50%)')
  })

  it('unknown_initiative from branch resolution carries the available-initiatives suffix', async () => {
    const fixture = makeRepoFixture({ branch: 'unbound-branch', bind: false })
    writeInitiative(fixture.root, 'demo', planned('demo'))
    const { client } = await connectServer(fixture.root)
    const err = await callToolExpectError(client, 'sofar_get_state', {})
    expect(err.code).toBe('unknown_initiative')
    expect(err.message).toContain('available initiatives: demo (details: sofar list)')
  })

  it('unknown_initiative from an explicit bad slug carries the suffix too', async () => {
    const fixture = makeRepoFixture()
    writeInitiative(fixture.root, 'demo', planned('demo'))
    const { client } = await connectServer(fixture.root)
    const err = await callToolExpectError(client, 'sofar_get_state', { initiative: 'nope' })
    expect(err.code).toBe('unknown_initiative')
    expect(err.message).toContain('available initiatives: demo')
  })

  it('unknown_initiative on an initiative-less repo hints sofar new instead', async () => {
    const fixture = makeRepoFixture({ branch: 'unbound-branch', bind: false })
    rmSync(fixture.initiativeDir, { recursive: true, force: true })
    const { client } = await connectServer(fixture.root)
    const err = await callToolExpectError(client, 'sofar_get_state', {})
    expect(err.code).toBe('unknown_initiative')
    expect(err.message).toContain('no initiatives exist yet — create one with `sofar new <slug>`')
  })

  it('sofar list renders the full listing with warnings on stderr, exit 0', () => {
    const fixture = makeRepoFixture({ bind: false })
    writeInitiative(fixture.root, 'demo', planned('demo'))
    writeFileSync(join(fixture.root, '.sofar', 'bindings.json'), 'not json{')
    const result = runList(fixture.root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('- demo [unbound] — 1/2 tasks (50%)')
    expect(result.stderr).toContain('warning: bindings.json:')
  })
})
