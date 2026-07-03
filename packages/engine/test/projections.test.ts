import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { emptyState, type InitiativeState } from '../src/core/fold'
import { regenerateProjections } from '../src/projections/generator'
import { renderPlan } from '../src/projections/templates/plan'
import { renderDecisions } from '../src/projections/templates/decisions'
import { GENERATED_HEADER } from '../src/projections/templates/shared'

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
