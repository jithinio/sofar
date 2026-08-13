import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { runClose } from '../src/cli/close'
import { closedBanner } from '../src/cli/event'
import { closeoutFindings, type CloseFindingKind } from '../src/core/closeout'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { renderFullStatus } from '../src/projections/templates/status'
import type { Caps } from '../src/cli/ui'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

const PLAIN: Caps = { color: false, unicode: true, animate: false }

/**
 * The close gate (commit-attribution 5.1/5.2/5.3).
 *
 * Two properties are being pinned, and the second is the load-bearing one:
 * the audit sees what is actually outstanding, and it REFUSES NOTHING. A gate
 * that blocks grows a `--force`; this one records the override instead.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({
    initiative: 'demo',
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
    ...overrides,
  })
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

interface PlanTask {
  id: string
  title: string
  status?: string
}

function plan(phases: { name: string; status?: string; tasks: PlanTask[] }[]): EventEnvelope {
  return ev('plan_updated', { plan: { phases } })
}

/** A three-phase record with everything resolved — the clean baseline. */
function cleanRecord(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    plan([
      { name: 'P1', status: 'done', tasks: [{ id: '1.1', title: 't', status: 'done' }] },
      { name: 'P2', status: 'done', tasks: [{ id: '2.1', title: 't', status: 'done' }] },
      { name: 'P3', status: 'done', tasks: [{ id: '3.1', title: 't', status: 'done' }] },
    ]),
    ev('review_recorded', { scope: 'phase', verdict: 'pass', phase: 'P1' }),
    ev('review_recorded', { scope: 'phase', verdict: 'pass', phase: 'P2' }),
    ev('review_recorded', { scope: 'phase', verdict: 'pass', phase: 'P3' }),
    ev('review_recorded', { scope: 'final', verdict: 'pass' }),
    ev('session_ended', { summary: 's', next_action: 'close it' }),
  ]
}

const kinds = (state: InitiativeState, status: 'done' | 'dropped'): CloseFindingKind[] =>
  closeoutFindings(state, status).map((finding) => finding.kind)

describe('the close-time audit (5.1)', () => {
  it('finds nothing on a record that actually finished', () => {
    expect(closeoutFindings(foldOf(cleanRecord()), 'done')).toEqual([])
  })

  it('names the tasks a `done` close is walking past', () => {
    const state = foldOf([
      ...cleanRecord().slice(0, 2),
      ev('task_status_changed', { id: '2.1', status: 'pending' }),
      ev('task_status_changed', { id: '3.1', status: 'active' }),
    ])
    const finding = closeoutFindings(state, 'done').find((f) => f.kind === 'tasks_outstanding')
    expect(finding?.text).toContain('2.1 (pending)')
    expect(finding?.text).toContain('3.1 (active)')
  })

  it('counts a DROPPED task as resolved — it was decided, not forgotten', () => {
    const state = foldOf([
      ...cleanRecord().slice(0, 2),
      ev('task_status_changed', { id: '2.1', status: 'dropped', note: 'superseded' }),
    ])
    expect(kinds(state, 'done')).not.toContain('tasks_outstanding')
  })

  it('caps the ids it names rather than rendering a wall', () => {
    const tasks = Array.from({ length: 9 }, (_, i) => ({ id: `1.${i + 1}`, title: 't' }))
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', tasks }]),
    ])
    const finding = closeoutFindings(state, 'done').find((f) => f.kind === 'tasks_outstanding')
    expect(finding?.text).toContain('(+4 more)')
  })

  it('reports phases nobody ever resolved', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([
        { name: 'P1', status: 'done', tasks: [{ id: '1.1', title: 't', status: 'done' }] },
        { name: 'P2', status: 'active', tasks: [{ id: '2.1', title: 't', status: 'done' }] },
      ]),
    ])
    const finding = closeoutFindings(state, 'done').find((f) => f.kind === 'phases_unresolved')
    expect(finding?.text).toContain('P2 (active)')
    expect(finding?.text).not.toContain('P1')
  })

  it('flags a task claimed done that no file_touched event ever saw', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([
        {
          name: 'P1',
          status: 'done',
          tasks: [
            { id: '1.1', title: 'built something', status: 'done' },
            { id: '1.2', title: 'built something else', status: 'done' },
          ],
        },
      ]),
      ev('task_status_changed', { id: '1.1', status: 'active' }),
      ev('file_touched', { path: 'src/a.ts', op: 'edit' }),
      ev('task_status_changed', { id: '1.1', status: 'done' }),
    ])
    const finding = closeoutFindings(state, 'done').find(
      (f) => f.kind === 'tasks_without_evidence',
    )
    expect(finding?.text).toContain('1.2')
    expect(finding?.text).not.toContain('1.1')
  })

  it('stays silent about evidence on a record that never touched a file at all', () => {
    // A pure decision record: every task would flag, and a finding that fires
    // on every member of a class says nothing about any of them.
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', status: 'done', tasks: [{ id: '1.1', title: 't', status: 'done' }] }]),
    ])
    expect(kinds(state, 'done')).not.toContain('tasks_without_evidence')
  })

  it('reports guard crossings nobody answered', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', status: 'done', tasks: [{ id: '1.1', title: 't', status: 'done' }] }]),
      ev('decision_logged', {
        chose: 'c',
        over: 'o',
        because: 'b',
        rule: 'never touch the schema from outside packages/schema',
        guard: 'path:packages/schema/**',
      }),
      ev('file_touched', { path: 'packages/schema/src/events.ts', op: 'edit' }),
    ])
    const finding = closeoutFindings(state, 'done').find((f) => f.kind === 'guards_crossed')
    expect(finding?.text).toContain('D1')
  })

  it('reports drift since the write-back rather than reading the next action', () => {
    // Mechanical by construction: content-semantic staleness inference is
    // banned (staleness-detection D3/D12), so "dangling" is answered as drift.
    const state = foldOf([...cleanRecord(), ev('file_touched', { path: 'src/a.ts', op: 'edit' })])
    const finding = closeoutFindings(state, 'done').find((f) => f.kind === 'writeback_stale')
    expect(finding?.text).toContain('1 event')
  })

  it('asks for phase reviews only above D9\'s three-phase floor', () => {
    const twoPhases = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([
        { name: 'P1', status: 'done', tasks: [{ id: '1.1', title: 't', status: 'done' }] },
        { name: 'P2', status: 'done', tasks: [{ id: '2.1', title: 't', status: 'done' }] },
      ]),
      ev('review_recorded', { scope: 'final', verdict: 'pass' }),
    ])
    expect(kinds(twoPhases, 'done')).not.toContain('phases_unreviewed')

    const threePhases = foldOf([
      ...cleanRecord().slice(0, 2),
      ev('review_recorded', { scope: 'phase', verdict: 'pass', phase: 'P1' }),
      ev('review_recorded', { scope: 'final', verdict: 'pass' }),
    ])
    const finding = closeoutFindings(threePhases, 'done').find(
      (f) => f.kind === 'phases_unreviewed',
    )
    expect(finding?.text).toContain('P2')
    expect(finding?.text).toContain('P3')
    expect(finding?.text).not.toContain('P1,')
  })

  it('asks for the final review at EVERY size — it is the one no phase pass can do', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', status: 'done', tasks: [{ id: '1.1', title: 't', status: 'done' }] }]),
    ])
    expect(kinds(state, 'done')).toContain('final_review_missing')
  })
})

describe('a drop is audited too, and asks a different question (5.3)', () => {
  const halfBuilt = (): InitiativeState =>
    foldOf([
      ...cleanRecord().slice(0, 2),
      ev('task_status_changed', { id: '2.1', status: 'pending' }),
      ev('task_status_changed', { id: '3.1', status: 'active' }),
    ])

  it('ignores PENDING tasks — never starting them is what dropping means', () => {
    const finding = closeoutFindings(halfBuilt(), 'dropped').find(
      (f) => f.kind === 'tasks_outstanding',
    )
    expect(finding?.text).toContain('3.1')
    expect(finding?.text).not.toContain('2.1')
  })

  it('names ACTIVE tasks, which are the landmine a drop leaves behind', () => {
    const finding = closeoutFindings(halfBuilt(), 'dropped').find(
      (f) => f.kind === 'tasks_outstanding',
    )
    expect(finding?.text).toContain('half-built')
  })

  it('still asks every other question a `done` close asks', () => {
    expect(kinds(halfBuilt(), 'dropped')).toEqual(
      expect.arrayContaining(['phases_unreviewed', 'final_review_missing', 'writeback_stale']),
    )
  })
})

describe('the override is an EVENT, never a refusal (5.2)', () => {
  it('records what it closed over, and the fold carries it', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', tasks: [{ id: '1.1', title: 't' }] }]),
      ev('initiative_status_changed', {
        status: 'done',
        overrides: ['1 task never resolved: 1.1 (pending)'],
      }),
    ])
    expect(state.status).toBe('done')
    expect(state.status_overrides).toEqual(['1 task never resolved: 1.1 (pending)'])
  })

  it('renders forever on the closed record, under its status', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', tasks: [{ id: '1.1', title: 't' }] }]),
      ev('initiative_status_changed', {
        status: 'done',
        overrides: ['1 task never resolved: 1.1 (pending)'],
      }),
    ])
    const out = renderFullStatus(state)
    expect(out).toContain('Closed over 1 finding(s):')
    expect(out).toContain('1 task never resolved: 1.1 (pending)')
  })

  it('is cleared by reopening — it describes the status in force, like the note', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', tasks: [{ id: '1.1', title: 't' }] }]),
      ev('initiative_status_changed', { status: 'done', overrides: ['1 task never resolved'] }),
      ev('initiative_status_changed', { status: 'active' }),
    ])
    expect(state.status).toBe('active')
    expect(state.status_overrides).toEqual([])
  })

  it('validates as an optional string list, and rejects anything else', () => {
    expect(validatePayload('initiative_status_changed', { status: 'done' }).ok).toBe(true)
    expect(
      validatePayload('initiative_status_changed', { status: 'done', overrides: ['a'] }).ok,
    ).toBe(true)
    expect(
      validatePayload('initiative_status_changed', { status: 'done', overrides: 'a' }).ok,
    ).toBe(false)
    expect(
      validatePayload('initiative_status_changed', { status: 'done', overrides: [''] }).ok,
    ).toBe(false)
  })

  it('an older engine folds a close carrying overrides without failing', () => {
    // The additive contract every payload here has had: an unknown field is
    // ignored, never fatal, so a record closed by a newer engine stays
    // readable by an older one.
    const { state, warnings } = foldLines(
      [
        ev('initiative_created', { slug: 'demo', goal: 'g' }),
        ev('initiative_status_changed', { status: 'done', overrides: ['x'] }),
      ].map(serializeEvent),
    )
    expect(warnings).toEqual([])
    expect(state.status).toBe('done')
  })
})

describe('both close surfaces record the same override (5.2)', () => {
  const fx = (): Fixture => {
    const fixture = makeRepoFixture()
    roots.push(fixture.root)
    return fixture
  }

  /** A record with one task left pending — one guaranteed finding, plus the review ones. */
  function seed(fixture: Fixture): void {
    writeFileSync(
      fixture.eventsPath,
      [
        ev('initiative_created', { slug: fixture.slug, goal: 'g' }, { initiative: fixture.slug }),
        plan([{ name: 'P1', tasks: [{ id: '1.1', title: 'unfinished' }] }]),
      ]
        .map(serializeEvent)
        .join('\n') + '\n',
    )
  }

  it('sofar_close_initiative returns the findings AND still closes', async () => {
    const fixture = fx()
    seed(fixture)
    const { client } = await connectServer(fixture.root)
    const { body } = await callTool<{ event_id: string; overrides: string[] }>(
      client,
      'sofar_close_initiative',
      { status: 'done' },
    )
    expect(body.event_id).not.toBeNull()
    expect(body.overrides.some((f) => f.includes('1.1'))).toBe(true)
    const events = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')
    const closed = JSON.parse(events[events.length - 1]!) as {
      type: string
      payload: { overrides?: string[] }
    }
    expect(closed.type).toBe('initiative_status_changed')
    expect(closed.payload.overrides).toEqual(body.overrides)
  })

  it('`sofar close` prints them, and calls them OVERRIDDEN rather than blocking', () => {
    const fixture = fx()
    seed(fixture)
    const result = runClose(fixture.root, fixture.slug, {}, PLAIN, PLAIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('OVERRIDDEN')
    expect(result.stdout).toContain('1.1')
  })

  it('a clean record closes with no override section at all', () => {
    const fixture = fx()
    writeFileSync(
      fixture.eventsPath,
      cleanRecord()
        .map((event) => serializeEvent({ ...event, initiative: fixture.slug }))
        .join('\n') + '\n',
    )
    const result = runClose(fixture.root, fixture.slug, {}, PLAIN, PLAIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain('OVERRIDDEN')
  })
})

describe('the closed banner carries the override too (5.2)', () => {
  const closedOver = (findings: string[]): InitiativeState =>
    foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan([{ name: 'P1', tasks: [{ id: '1.1', title: 't' }] }]),
      ev('initiative_status_changed', { status: 'done', overrides: findings }),
    ])

  it('names what the close was taken over, on the surface an agent reads', () => {
    const banner = closedBanner(closedOver(['1 task never resolved: 1.1 (pending)']))
    expect(banner).toContain('Closed over 1 finding(s)')
    expect(banner).toContain('1.1 (pending)')
  })

  it('points at `sofar status` rather than rendering a wall into a budgeted block', () => {
    const banner = closedBanner(closedOver(['a', 'b', 'c', 'd', 'e']))
    expect(banner).toContain('(+2 more — `sofar status demo`)')
  })

  it('is byte-identical to before on a close that had nothing outstanding', () => {
    const clean = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('initiative_status_changed', { status: 'done' }),
    ])
    expect(closedBanner(clean)).not.toContain('Closed over')
  })
})
