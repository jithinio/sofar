import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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
  REPO_MEMORY_CHAR_BUDGET,
  REPO_MEMORY_TRUNCATION_MARKER,
  STATUS_CHAR_LIMIT,
  STATUS_TRUNCATION_MARKER,
} from '../src/projections/templates/status'
import { GENERATED_HEADER, clip } from '../src/projections/templates/shared'

const scratch = mkdtempSync(join(tmpdir(), 'sofar-projections-'))

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
    expect(plan).toContain('(no plan recorded yet — call sofar_update_plan)')
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

  it('atomic writes (6.3, BD38): repeated regeneration leaves no *.tmp behind, files stay complete', () => {
    const dir = join(scratch, 'initiatives', 'atomic')
    const state = populatedState()
    state.sessions = [
      { id: 'sess-atomic', tool: 'claude-code', started: '2026-07-07T00:00:00.000Z' },
    ]
    regenerateProjections(dir, state)
    regenerateProjections(dir, state) // second pass renames over existing targets

    const leftovers = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])

    // targets are the fully rendered documents — never a partial write
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toBe(renderPlan(state))
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe(renderDecisions(state))
    expect(readFileSync(join(dir, 'sessions', 'sess-atomic.md'), 'utf8')).toBe(
      renderSession(state, state.sessions[0]!),
    )
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

  it('renderSession derived resume block (7.2, BD44): activity + close reason for an unwritten session', () => {
    const md = renderSession(populatedState(), {
      id: 'sess-crash',
      tool: 'claude-code',
      started: '2026-07-07T01:00:00.000Z',
      ended: '2026-07-07T02:00:00.000Z',
      closed_reason: 'crash',
      activity: {
        files: ['src/a.ts', 'src/b.ts'],
        commands: 3,
        task_changes: ['1.2 → done'],
      },
    })
    expect(md).toContain('- Ended: 2026-07-07T02:00:00.000Z (closed: crash)')
    expect(md).toContain('(none recorded — ended without write-back; derived resume point below)')
    expect(md).toContain('## Activity (derived from mechanical events)')
    expect(md).toContain('- Derived: 2 files (src/a.ts, src/b.ts), 3 commands, task changes: 1.2 → done')
    expect(md).toContain('  - src/a.ts')
    expect(md).toContain('- Commands run: 3')
    expect(md).toContain('  - 1.2 → done')
  })

  it('renderSession with a summary still renders as a write-back; activity only enriches', () => {
    const md = renderSession(populatedState(), {
      id: 'sess-full',
      tool: 'claude-code',
      started: '2026-07-07T01:00:00.000Z',
      ended: '2026-07-07T02:00:00.000Z',
      summary: 'did the work',
      next_action: 'more work',
      activity: { files: ['src/a.ts'], commands: 1, task_changes: [] },
    })
    expect(md).toContain('did the work')
    expect(md).not.toContain('derived resume point')
    expect(md).toContain('## Activity (derived from mechanical events)')
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
    expect(status).toContain('# Sofar status: demo')
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

  it('surfaces a rejected-approaches ledger (over-only), excluding "(no alternative recorded)" (D-ledger)', () => {
    const state = populatedState()
    state.decisions = [
      { id: '01ARZ3NDEKTSV4RRFFQ69G5F01', ts: '2026-07-03T00:00:00.000Z', chose: 'sqlite', over: 'postgres', because: 'zero ops' },
      { id: '01ARZ3NDEKTSV4RRFFQ69G5F02', ts: '2026-07-03T00:00:00.000Z', chose: 'x', over: '(no alternative recorded)', because: 'y' },
    ]
    const status = renderStatus(state)
    // only the decision with a real alternative is counted + listed
    expect(status).toContain('Rejected approaches — do NOT re-propose (1):')
    expect(status).toContain('- postgres')
    // the placeholder over is not promoted into the ledger as its own line
    expect(status).not.toContain('- (no alternative recorded)')
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

  it('repo memory (6.5, BD40): section lands after the current block, before the phase tree, formatting kept', () => {
    const memory = 'Run npm test before committing.\nNever push to main directly.'
    const status = renderStatus(populatedState(), { repoMemory: memory })
    expect(status).toContain('Repo memory (.sofar/repo.md):')
    expect(status).toContain(memory) // multi-line content preserved verbatim
    expect(status.indexOf('Repo memory')).toBeGreaterThan(status.indexOf('Next action:'))
    expect(status.indexOf('Repo memory')).toBeLessThan(status.indexOf('Phases:'))
  })

  it('repo memory is clipped to its own budget with a marker; missing/blank omits the section', () => {
    const status = renderStatus(populatedState(), { repoMemory: 'M'.repeat(60_000) })
    const header = 'Repo memory (.sofar/repo.md):\n'
    const start = status.indexOf(header)
    expect(start).toBeGreaterThan(-1)
    const body = status.slice(start + header.length).split('\n\n', 1)[0]!
    expect(body.length).toBeLessThanOrEqual(REPO_MEMORY_CHAR_BUDGET)
    expect(body.endsWith(REPO_MEMORY_TRUNCATION_MARKER)).toBe(true)
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)

    expect(renderStatus(populatedState())).not.toContain('Repo memory')
    expect(renderStatus(populatedState(), { repoMemory: '  \n\t ' })).not.toContain('Repo memory')
  })

  it('repo memory on a large synthetic initiative: global ≤10k cap still holds', () => {
    const status = renderStatus(largeState(), { repoMemory: 'R'.repeat(50_000) })
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(status).toContain('Repo memory (.sofar/repo.md):')
    expect(status).toContain(REPO_MEMORY_TRUNCATION_MARKER)
    expect(status).toContain('Next action: do the thing') // essentials survive alongside it
  })

  it('derived resume fallback (7.2, BD44): an unwritten session with activity surfaces in status', () => {
    const state = populatedState()
    state.sessions = [
      {
        id: 'sess-crash',
        tool: 'claude-code',
        started: '2026-07-07T01:00:00.000Z',
        ended: '2026-07-07T02:00:00.000Z',
        closed_reason: 'crash',
        activity: { files: ['src/a.ts', 'src/b.ts'], commands: 2, task_changes: ['1.2 → done'] },
      },
    ]
    const status = renderStatus(state)
    expect(status).toContain(
      'Last session (claude-code, closed: crash) ended without write-back — derived: 2 files (src/a.ts, src/b.ts), 2 commands, task changes: 1.2 → done',
    )
    expect(status).toContain('(details in sessions/sess-crash.md)')
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('derived fallback stays summary-first: a NEWER written session suppresses it; an older one does not', () => {
    const crashed = {
      id: 'sess-crash',
      tool: 'claude-code',
      started: '2026-07-07T01:00:00.000Z',
      activity: { files: ['src/a.ts'], commands: 0, task_changes: [] },
    }
    const written = {
      id: 'sess-written',
      tool: 'claude-code',
      started: '2026-07-07T03:00:00.000Z',
      ended: '2026-07-07T04:00:00.000Z',
      summary: 'the real write-back',
      next_action: 'continue',
    }

    // crash BEFORE the written session → only the summary block renders
    const older = populatedState()
    older.sessions = [crashed, written]
    const olderStatus = renderStatus(older)
    expect(olderStatus).toContain('the real write-back')
    expect(olderStatus).not.toContain('derived:')

    // crash AFTER the written session → both render (summary first, derived after)
    const newer = populatedState()
    newer.sessions = [written, { ...crashed, started: '2026-07-07T05:00:00.000Z' }]
    const newerStatus = renderStatus(newer)
    expect(newerStatus).toContain('the real write-back')
    expect(newerStatus).toContain('open, no write-back yet — derived: 1 file (src/a.ts)')
    expect(newerStatus.indexOf('the real write-back')).toBeLessThan(newerStatus.indexOf('derived:'))

    // a just-started session with no activity is skipped, not a blocker
    const fresh = populatedState()
    fresh.sessions = [
      written,
      { ...crashed, started: '2026-07-07T05:00:00.000Z' },
      { id: 'sess-now', tool: 'claude-code', started: '2026-07-07T06:00:00.000Z' },
    ]
    expect(renderStatus(fresh)).toContain('derived: 1 file (src/a.ts)')
  })

  it('session id line (7.1, BD43): lands right under the title, clipped, cap intact', () => {
    const status = renderStatus(populatedState(), { sessionId: 'claude-sess-42' })
    expect(status).toContain(
      'Session: claude-sess-42 — when calling sofar_start_session, pass this as session_id.',
    )
    expect(status.indexOf('Session: claude-sess-42')).toBeLessThan(status.indexOf('Goal:'))

    // hostile external ids never blow the section, and the block omits the
    // line entirely when no id is known
    const hostile = renderStatus(largeState(), { sessionId: 'H'.repeat(5_000) })
    expect(hostile.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    expect(hostile).toContain('Session: HHH')
    expect(renderStatus(populatedState())).not.toContain('Session:')
    expect(renderStatus(populatedState(), { sessionId: '   ' })).not.toContain('Session:')
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
