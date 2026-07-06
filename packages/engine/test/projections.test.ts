import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { emptyState, type InitiativeState, type PhaseState } from '../src/core/fold'
import { regenerateProjections } from '../src/projections/generator'
import { renderPlan } from '../src/projections/templates/plan'
import { renderDecisions } from '../src/projections/templates/decisions'
import { renderSession } from '../src/projections/templates/session'
import {
  enforceStatusLimit,
  renderStatus,
  STATUS_CHAR_LIMIT,
  STATUS_TRUNCATION_MARKER,
} from '../src/projections/templates/status'
import { GENERATED_HEADER, clip } from '../src/projections/templates/shared'

const scratch = mkdtempSync(join(tmpdir(), 'harness-projections-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function populatedState(): InitiativeState {
  const state = emptyState()
  state.slug = 'demo'
  state.goal = 'ship it'
  state.phases = [
    {
      name: 'Phase 1',
      status: 'active',
      tasks: [
        { id: '1.1', title: 'done task', status: 'done' },
        { id: '1.2', title: 'active task', status: 'active' },
        { id: '1.3', title: 'blocked task', status: 'blocked' },
      ],
    },
  ]
  state.decisions = [
    { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-07-03T00:00:00.000Z', chose: 'a', over: 'b', because: 'c' },
  ]
  state.current = { active_phase: 'Phase 1', next_action: 'finish 1.2', blocked_on: 'task 1.3' }
  return state
}

/** Large synthetic initiative (acceptance: status must stay ≤10k chars). */
function largeState(): InitiativeState {
  const state = emptyState()
  state.slug = 'huge-initiative'
  state.goal = 'G'.repeat(5_000) // absurdly long goal
  const phases: PhaseState[] = []
  for (let p = 0; p < 40; p++) {
    phases.push({
      name: `Phase ${p} — ${'n'.repeat(150)}`,
      status: p === 3 ? 'active' : p < 3 ? 'done' : 'pending',
      tasks: Array.from({ length: 8 }, (_, t) => ({
        id: `${p}.${t}`,
        title: `Task ${'t'.repeat(300)}`,
        status: p < 3 ? ('done' as const) : t === 0 && p === 3 ? ('active' as const) : ('pending' as const),
      })),
    })
  }
  state.phases = phases // 320 tasks
  state.decisions = Array.from({ length: 60 }, (_, i) => ({
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}`,
    ts: '2026-07-03T00:00:00.000Z',
    chose: `choice ${i} ${'c'.repeat(400)}`,
    over: `alternative ${'o'.repeat(400)}`,
    because: `reason ${'b'.repeat(400)}`,
  }))
  state.sessions = Array.from({ length: 30 }, (_, i) => ({
    id: `sess-${i}`,
    tool: 'claude-code',
    started: '2026-07-03T00:00:00.000Z',
    ended: '2026-07-03T01:00:00.000Z',
    summary: `summary ${i} ${'s'.repeat(4_000)}`,
    next_action: `next ${'x'.repeat(3_000)}`,
  }))
  state.current = {
    active_phase: phases[3]!.name,
    next_action: `do the thing ${'z'.repeat(3_000)}`,
    blocked_on: `waiting ${'w'.repeat(2_000)}`,
  }
  return state
}

describe('projection templates (v0 seam — BD14)', () => {
  it('renderPlan marks generated, checkboxes tasks, and surfaces current.*', () => {
    const md = renderPlan(populatedState())
    expect(md.startsWith(GENERATED_HEADER)).toBe(true)
    expect(md).toContain('# Plan: demo')
    expect(md).toContain('Goal: ship it')
    expect(md).toContain('## Phase 1 [active]')
    expect(md).toContain('- [x] 1.1 done task')
    expect(md).toContain('- [ ] 1.2 active task (active)')
    expect(md).toContain('- [ ] 1.3 blocked task (blocked)')
    expect(md).toContain('Active phase: Phase 1')
    expect(md).toContain('Next action: finish 1.2')
    expect(md).toContain('Blocked on: task 1.3')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('renderPlan and renderDecisions handle an empty state', () => {
    const plan = renderPlan(emptyState())
    expect(plan).toContain('(unnamed initiative)')
    expect(plan).toContain('(no plan recorded yet — call harness_update_plan)')
    const decisions = renderDecisions(emptyState())
    expect(decisions).toContain('(no decisions logged yet)')
  })

  it('regenerateProjections writes plan.md and decisions.md into the initiative dir', () => {
    const dir = join(scratch, 'initiatives', 'demo')
    regenerateProjections(dir, populatedState())
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe(renderPlan(populatedState()))
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe(renderDecisions(populatedState()))
  })

  it('regeneration overwrites: projections always reflect the latest state', () => {
    const dir = join(scratch, 'initiatives', 'overwrite')
    regenerateProjections(dir, populatedState())
    const updated = populatedState()
    updated.goal = 'ship it faster'
    regenerateProjections(dir, updated)
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('Goal: ship it faster')
  })
})

describe('full projections (3.6)', () => {
  it('renderPlan shows overall and per-phase progress', () => {
    const md = renderPlan(populatedState())
    expect(md).toContain('Progress: 1/3 tasks done (33%)')
    expect(md).toContain('## Phase 1 [active] — 1/3 done')
  })

  it('clip collapses whitespace and hard-caps length, ellipsis inside the budget', () => {
    expect(clip('a  b\n\nc', 100)).toBe('a b c')
    const clipped = clip('x'.repeat(500), 100)
    expect(clipped.length).toBe(100)
    expect(clipped.endsWith('…')).toBe(true)
    expect(clip('short', 100)).toBe('short')
  })

  it('renderSession carries tool, model, started/ended, summary, next_action', () => {
    const state = populatedState()
    const md = renderSession(state, {
      id: 'sess-9',
      tool: 'claude-code',
      model: 'claude-fable-5',
      started: '2026-07-06T01:00:00.000Z',
      ended: '2026-07-06T02:00:00.000Z',
      summary: 'built the hooks',
      next_action: 'projections next',
    })
    expect(md.startsWith(GENERATED_HEADER)).toBe(true)
    expect(md).toContain('# Session sess-9')
    expect(md).toContain('- Initiative: demo')
    expect(md).toContain('- Tool: claude-code')
    expect(md).toContain('- Model: claude-fable-5')
    expect(md).toContain('- Started: 2026-07-06T01:00:00.000Z')
    expect(md).toContain('- Ended: 2026-07-06T02:00:00.000Z')
    expect(md).toContain('built the hooks')
    expect(md).toContain('projections next')
  })

  it('renderSession marks in-progress sessions and missing write-backs honestly', () => {
    const md = renderSession(populatedState(), {
      id: 'sess-open',
      tool: 'claude-code',
      started: '2026-07-06T01:00:00.000Z',
    })
    expect(md).toContain('- Ended: (in progress)')
    expect(md).toContain('(none recorded — session did not write back)')
    expect(md).toContain('(none recorded)')
  })

  it('regenerateProjections writes sessions/<session-id>.md per session, ids sanitized', () => {
    const dir = join(scratch, 'initiatives', 'with-sessions')
    const state = populatedState()
    state.sessions = [
      { id: 'sess-ok', tool: 'claude-code', started: '2026-07-06T01:00:00.000Z' },
      { id: '../evil/name', tool: 'claude-code', started: '2026-07-06T01:00:00.000Z' },
    ]
    regenerateProjections(dir, state)
    expect(readFileSync(join(dir, 'sessions', 'sess-ok.md'), 'utf8')).toContain('# Session sess-ok')
    // hostile id stays inside sessions/
    expect(existsSync(join(dir, 'sessions', '.._evil_name.md'))).toBe(true)
    expect(existsSync(join(dir, '..', 'evil'))).toBe(false)
  })
})

describe('renderStatus — SessionStart context block (3.6, BD3)', () => {
  it('surfaces goal, progress, active phase, current/next task, next action, blocked, last session, recent decisions', () => {
    const state = populatedState()
    state.sessions = [
      {
        id: 'sess-1',
        tool: 'claude-code',
        started: '2026-07-05T00:00:00.000Z',
        ended: '2026-07-05T01:00:00.000Z',
        summary: 'wired the log core',
        next_action: 'finish 1.2',
      },
    ]
    const status = renderStatus(state)
    expect(status).toContain('# Harness status: demo')
    expect(status).toContain('Goal: ship it')
    expect(status).toContain('Progress: 1/3 tasks done (33%) across 1 phase(s)')
    expect(status).toContain('Active phase: Phase 1 — 1/3 tasks done')
    expect(status).toContain('Current task: 1.2 active task')
    expect(status).toContain('Next action: finish 1.2')
    expect(status).toContain('Blocked on: task 1.3')
    expect(status).toContain('- Phase 1 [active] 1/3')
    expect(status).toContain('Last session (claude-code')
    expect(status).toContain('wired the log core')
    expect(status).toContain('chose a over b — c')
  })

  it('handles an empty state without noise', () => {
    const status = renderStatus(emptyState())
    expect(status).toContain('(unnamed initiative)')
    expect(status).toContain('Progress: 0/0 tasks done (0%)')
    expect(status).toContain('Active phase: (none)')
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('acceptance: stays ≤10,000 chars on a large synthetic initiative, keeping goal + next_action', () => {
    const status = renderStatus(largeState())
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    // content sanity: the essentials survive the budgets
    expect(status).toContain(`Goal: ${'G'.repeat(100)}`)
    expect(status).toContain('Progress: 24/320 tasks done (7%) across 40 phase(s)')
    expect(status).toContain('Next action: do the thing')
    expect(status).toContain('Blocked on: waiting')
    expect(status).toContain('Current task: 3.0')
    expect(status).toContain('…and 28 more phases (see plan.md)')
    expect(status).toContain('Recent decisions (last 5 of 60):')
    expect(status).toContain('chose choice 59')
    expect(status).toContain('summary 29')
  })

  it('enforceStatusLimit is a hard guard: oversized text is cut and marked', () => {
    const oversized = 'x'.repeat(STATUS_CHAR_LIMIT + 5_000)
    const capped = enforceStatusLimit(oversized)
    expect(capped.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(capped).toContain(STATUS_TRUNCATION_MARKER)
    // under-limit text passes through untouched
    expect(enforceStatusLimit('fine')).toBe('fine')
  })
})
