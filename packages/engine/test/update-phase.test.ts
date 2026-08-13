import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateToolInput } from '@sofar/schema/tool-inputs'
import { closeoutFindings } from '../src/core/closeout'
import { foldLog, freshnessTotal, staleActivePhases } from '../src/core/fold'
import { ToolError, createToolContext, type ToolContext } from '../src/mcp/context'
import { updatePhase } from '../src/mcp/update-phase'
import { updatePlan } from '../src/mcp/update-plan'
import { updateTask } from '../src/mcp/update-task'

/**
 * phase-lifecycle 5.2 — sofar_update_phase.
 *
 * The initiative exists because 35 finished phases across 16 records still
 * rendered active or pending, with no first-class way to say otherwise. So the
 * tests that matter are not "does it append": they are the three places phase
 * status is READ (the digest's active phase, doctor's stale axis, the close
 * audit's phases_unresolved), and the two ways a name-addressed write can go
 * wrong — a typo minting a phantom phase, and a re-issue littering the log.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const PLAN = {
  goal: 'ship the thing',
  phases: [
    {
      name: 'Phase 1 — Settle',
      tasks: [
        { id: '1.1', title: 'decide' },
        { id: '1.2', title: 'write it down' },
      ],
    },
    { name: 'Phase 2 — Build', tasks: [{ id: '2.1', title: 'build' }] },
    { name: 'Phase 3 — Prove', tasks: [{ id: '3.1', title: 'prove' }] },
  ],
}

interface Fixture {
  ctx: ToolContext
  root: string
  eventsPath: string
  planPath: string
  events(): Array<{ type: string; payload: Record<string, unknown> }>
}

function fx(slug = 'demo'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'sofar-update-phase-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const sofar = join(root, '.sofar')
  mkdirSync(join(sofar, 'initiatives', slug), { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ main: slug })}\n`)

  const ctx = createToolContext(root)
  updatePlan(ctx, { plan: PLAN })
  const eventsPath = join(sofar, 'initiatives', slug, 'events.jsonl')
  return {
    ctx,
    root,
    eventsPath,
    planPath: join(sofar, 'initiatives', slug, 'plan.md'),
    events: () =>
      readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> }),
  }
}

const phaseOf = (f: Fixture, name: string) =>
  foldLog(f.eventsPath).state.phases.find((p) => p.name === name)

describe('sofar_update_phase — the write', () => {
  it('appends exactly one phase_status_changed and the fold reflects it', () => {
    const f = fx()
    const before = f.events().length

    const result = updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done' })

    expect(result).toEqual({
      ok: true,
      event_id: expect.any(String),
      tasks_done: 0,
      tasks_total: 2,
    })
    const events = f.events()
    expect(events).toHaveLength(before + 1)
    expect(events[before]).toMatchObject({
      type: 'phase_status_changed',
      payload: { phase: 'Phase 1 — Settle', status: 'done' },
    })
    expect(phaseOf(f, 'Phase 1 — Settle')?.status).toBe('done')
    // Sibling phases are untouched — the write is addressed, not broadcast.
    expect(phaseOf(f, 'Phase 2 — Build')?.status).toBe('pending')
  })

  it('reports the phase task counts it just resolved', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '1.1', status: 'done' })
    const result = updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'active' })
    expect(result.tasks_done).toBe(1)
    expect(result.tasks_total).toBe(2)
  })

  it('carries a note onto the payload and renders it under the phase in plan.md', () => {
    const f = fx()
    updatePhase(f.ctx, {
      phase: 'Phase 3 — Prove',
      status: 'dropped',
      note: 'folded into Phase 2 (D4)',
    })
    expect(f.events().at(-1)).toMatchObject({
      payload: { status: 'dropped', note: 'folded into Phase 2 (D4)' },
    })
    expect(phaseOf(f, 'Phase 3 — Prove')?.note).toBe('folded into Phase 2 (D4)')
    expect(readFileSync(f.planPath, 'utf8')).toContain('> folded into Phase 2 (D4)')
  })

  it('CLEARS the note when a later event omits it — a reason never outlives its status', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 3 — Prove', status: 'blocked', note: 'waiting on 2.1' })
    expect(phaseOf(f, 'Phase 3 — Prove')?.note).toBe('waiting on 2.1')

    updatePhase(f.ctx, { phase: 'Phase 3 — Prove', status: 'active' })
    expect(phaseOf(f, 'Phase 3 — Prove')?.note).toBeUndefined()
    expect(readFileSync(f.planPath, 'utf8')).not.toContain('waiting on 2.1')
  })
})

describe('sofar_update_phase — idempotence', () => {
  it('appends nothing and returns a null event_id when already at this status', () => {
    const f = fx()
    const first = updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })
    expect(first.event_id).toEqual(expect.any(String))
    const after = f.events().length

    const second = updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })
    expect(second.event_id).toBeNull()
    expect(second.ok).toBe(true)
    expect(f.events()).toHaveLength(after)
  })

  it('still appends when only the note changes — a new reason is a real transition', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'blocked', note: 'waiting on review' })
    const after = f.events().length

    const result = updatePhase(f.ctx, {
      phase: 'Phase 2 — Build',
      status: 'blocked',
      note: 'waiting on the 0.27 release instead',
    })
    expect(result.event_id).toEqual(expect.any(String))
    expect(f.events()).toHaveLength(after + 1)
    expect(phaseOf(f, 'Phase 2 — Build')?.note).toBe('waiting on the 0.27 release instead')
  })
})

describe('sofar_update_phase — an unknown phase is an error, never a phantom', () => {
  it('rejects a name the plan does not carry and appends nothing', () => {
    const f = fx()
    const before = f.events().length

    // The fold's findOrCreatePhase would CREATE this one; the tool must not.
    expect(() => updatePhase(f.ctx, { phase: 'Phase 1 - Settle', status: 'done' })).toThrow(
      ToolError,
    )
    expect(f.events()).toHaveLength(before)
    expect(foldLog(f.eventsPath).state.phases).toHaveLength(3)
  })

  it('names the phases that DO exist, so the dead end orients', () => {
    const f = fx()
    let thrown: ToolError | undefined
    try {
      updatePhase(f.ctx, { phase: 'Phase 9', status: 'done' })
    } catch (err) {
      thrown = err as ToolError
    }
    expect(thrown?.code).toBe('invalid_input')
    expect(thrown?.message).toContain('"Phase 1 — Settle"')
    expect(thrown?.message).toContain('"Phase 3 — Prove"')
  })

  it('says so plainly when the initiative has no plan at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-update-phase-bare-'))
    roots.push(root)
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(root, '.sofar', 'initiatives', 'bare'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), `${JSON.stringify({ main: 'bare' })}\n`)

    const ctx = createToolContext(root)
    expect(() => updatePhase(ctx, { phase: 'Phase 1', status: 'done' })).toThrow(/no phases yet/)
  })

  it('refuses a drop with no reason, at the same tier a dropped task is refused', () => {
    const bad = validateToolInput('sofar_update_phase', { phase: 'Phase 1', status: 'dropped' })
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.errors.join(' ')).toContain('note: required')

    const good = validateToolInput('sofar_update_phase', {
      phase: 'Phase 1',
      status: 'dropped',
      note: 'superseded by Phase 2',
    })
    expect(good).toEqual({ ok: true })
  })
})

describe('sofar_update_phase — routing and drift', () => {
  it('follows the session pin, not the branch, when a peer rebinds mid-session', () => {
    const f = fx('alpha')
    mkdirSync(join(f.root, '.sofar', 'initiatives', 'beta'), { recursive: true })
    f.ctx.session.set({ id: 'S1', tool: 'claude-code', initiative: 'alpha' })

    // A peer moves the branch onto another record between our calls.
    writeFileSync(
      join(f.root, '.sofar', 'bindings.json'),
      `${JSON.stringify({ main: 'beta' })}\n`,
    )

    updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done' })

    expect(f.events().at(-1)).toMatchObject({ type: 'phase_status_changed' })
    expect(phaseOf(f, 'Phase 1 — Settle')?.status).toBe('done')
  })

  it('counts as drift, so a session that ONLY closes phases still owes a write-back', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done' })
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })

    const { freshness } = foldLog(f.eventsPath).state
    expect(freshness.events_since_writeback.phases).toBe(2)
    expect(freshness.events_since_writeback.tasks).toBe(0)
    expect(freshnessTotal(freshness)).toBe(2)
  })

  it('replays deterministically — same log, deep-equal state', () => {
    const f = fx()
    updatePhase(f.ctx, { phase: 'Phase 1 — Settle', status: 'done', note: 'settled' })
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })
    expect(foldLog(f.eventsPath).state).toEqual(foldLog(f.eventsPath).state)
  })
})

describe('sofar_update_phase — what closing a phase actually clears', () => {
  it('clears the stale-phase axis doctor reports', () => {
    const f = fx()
    updateTask(f.ctx, { task_id: '2.1', status: 'done' })
    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'active' })

    const before = staleActivePhases(foldLog(f.eventsPath).state)
    expect(before.map((p) => p.name)).toContain('Phase 2 — Build')

    updatePhase(f.ctx, { phase: 'Phase 2 — Build', status: 'done' })
    expect(staleActivePhases(foldLog(f.eventsPath).state).map((p) => p.name)).not.toContain(
      'Phase 2 — Build',
    )
  })

  it("clears the close audit's phases_unresolved finding — the same fact, read twice", () => {
    const f = fx()
    const findingKinds = () =>
      closeoutFindings(foldLog(f.eventsPath).state, 'done').map((finding) => finding.kind)

    expect(findingKinds()).toContain('phases_unresolved')

    for (const phase of PLAN.phases) {
      updatePhase(f.ctx, { phase: phase.name, status: 'done' })
    }
    expect(findingKinds()).not.toContain('phases_unresolved')
  })
})
