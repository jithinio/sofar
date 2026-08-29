import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { foldLog, freshnessTotal, latestRun } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { renderFullStatus, renderStatus } from '../src/projections/templates/status'
import { renderSession } from '../src/projections/templates/session'
import { describeRun } from '../src/projections/templates/shared'

/**
 * Driver events (session-driver 1.2, D2): run_started / handoff / run_stopped.
 *
 * The record is the driver's ONLY state, so the fold must reconstruct a run
 * completely from its events, refuse to invent one it never saw start, and
 * never let driver bookkeeping read as drift against the next action.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Line {
  type: string
  payload: Record<string, unknown>
  /** Envelope session; driver events ride on "cli" — a run is not a session. */
  session?: string
}

function log(name: string, lines: Line[]): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-driver-${name}-`))
  roots.push(root)
  const path = join(root, 'events.jsonl')
  writeFileSync(path, '')
  const all: Line[] = [{ type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } }, ...lines]
  for (const l of all) {
    appendEvent(
      path,
      makeEvent({
        initiative: 'demo',
        session: l.session ?? 'cli',
        type: l.type,
        payload: l.payload,
        source: 'cli',
        actor: 'agent',
      }),
    )
  }
  return path
}

const RUN = '01JZ8B3V0N5B4W8XK2M9QF7TSE'
const started: Line = { type: 'run_started', payload: { run: RUN, adapter: 'claude-code', policy: 'task' } }
const s1: Line = { type: 'session_started', payload: { tool: 'claude-code' }, session: 's1' }
const s1end: Line = {
  type: 'session_ended',
  payload: { summary: 'did 1.1', next_action: 'do 1.2' },
  session: 's1',
}
const h1: Line = {
  type: 'handoff',
  payload: { run: RUN, session_id: 's1', reason: 'task_done', task: '1.1', tokens: 61_000 },
}
const stopped: Line = {
  type: 'run_stopped',
  payload: { run: RUN, reason: 'needs_user', note: 'next action names a release' },
}

describe('driver payload validation', () => {
  it('a threshold policy must carry its threshold — the next driver cannot guess it', () => {
    const res = validatePayload('run_started', { run: RUN, adapter: 'claude-code', policy: 'threshold' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toContain('threshold_pct: required')
    expect(
      validatePayload('run_started', { run: RUN, adapter: 'claude-code', policy: 'threshold', threshold_pct: 70 }),
    ).toEqual({ ok: true })
  })

  it('a run that died of an error must say what failed', () => {
    const res = validatePayload('run_stopped', { run: RUN, reason: 'error' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toContain('note: required')
    expect(validatePayload('run_stopped', { run: RUN, reason: 'interrupted' })).toEqual({ ok: true })
  })
})

describe('fold: a run is reconstructed from its events alone', () => {
  it('run_started → handoff → run_stopped folds to one complete RunState', () => {
    const { state, warnings } = foldLog(log('full', [started, s1, s1end, h1, stopped]))
    expect(warnings).toEqual([])
    expect(state.runs).toHaveLength(1)
    const run = latestRun(state)!
    expect(run.id).toBe(RUN)
    expect(run.adapter).toBe('claude-code')
    expect(run.policy).toBe('task')
    expect(run.threshold_pct).toBeUndefined()
    expect(run.handoffs).toEqual([
      { ts: expect.any(String), session_id: 's1', reason: 'task_done', task: '1.1', tokens: 61_000 },
    ])
    expect(run.stop_reason).toBe('needs_user')
    expect(run.stop_note).toBe('next action names a release')
    expect(run.stopped).toEqual(expect.any(String))
  })

  it('a running run has no stop — the same fact as a driver that died silently', () => {
    const { state } = foldLog(log('running', [started, s1, s1end, h1]))
    const run = latestRun(state)!
    expect(run.stopped).toBeUndefined()
    expect(run.stop_reason).toBeUndefined()
  })

  it('the handoff is attached to the REGISTERED session it names', () => {
    const { state } = foldLog(log('attach', [started, s1, s1end, h1]))
    const session = state.sessions.find((s) => s.id === 's1')!
    expect(session.handoff).toEqual({ run: RUN, reason: 'task_done', ts: expect.any(String) })
  })

  it('a handoff naming a session this log never registered stays on the run, never stubs a session', () => {
    const ghost: Line = { type: 'handoff', payload: { run: RUN, session_id: 'elsewhere', reason: 'stall' } }
    const { state, warnings } = foldLog(log('ghost', [started, ghost]))
    expect(warnings).toEqual([])
    expect(state.sessions).toEqual([])
    expect(latestRun(state)!.handoffs.map((h) => h.session_id)).toEqual(['elsewhere'])
  })

  it('a handoff for a run that never started is skipped with a warning — no stub run', () => {
    const { state, warnings } = foldLog(log('norun', [s1, h1]))
    expect(state.runs).toEqual([])
    expect(warnings.join('\n')).toContain(`handoff for run "${RUN}" that never started — skipped`)
  })

  it('a stop for a run that never started is skipped with a warning', () => {
    const { state, warnings } = foldLog(log('nostop', [stopped]))
    expect(state.runs).toEqual([])
    expect(warnings.join('\n')).toContain(`run "${RUN}" stopped without run_started — skipped`)
  })

  it('first stop wins; a second stop is a driver that lost track', () => {
    const again: Line = { type: 'run_stopped', payload: { run: RUN, reason: 'interrupted' } }
    const { state, warnings } = foldLog(log('twostops', [started, stopped, again]))
    expect(latestRun(state)!.stop_reason).toBe('needs_user')
    expect(warnings.join('\n')).toContain(`run "${RUN}" already stopped — skipped`)
  })

  it('a duplicate run_started is skipped, keeping the first', () => {
    const dup: Line = { type: 'run_started', payload: { run: RUN, adapter: 'codex', policy: 'task' } }
    const { state, warnings } = foldLog(log('dup', [started, dup]))
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]!.adapter).toBe('claude-code')
    expect(warnings.join('\n')).toContain(`run "${RUN}" already started — skipped`)
  })

  it('latestRun is the most recent run in log order', () => {
    const second: Line = {
      type: 'run_started',
      payload: { run: 'R2', adapter: 'opencode', policy: 'threshold', threshold_pct: 60, max_sessions: 4 },
    }
    const { state } = foldLog(log('two', [started, stopped, second]))
    expect(state.runs.map((r) => r.id)).toEqual([RUN, 'R2'])
    expect(latestRun(state)).toMatchObject({ id: 'R2', threshold_pct: 60, max_sessions: 4 })
  })
})

describe('drift: driver events are excluded, deliberately (commit-attribution D18)', () => {
  it('a handoff and a stop after the write-back do not stale the next action', () => {
    const { state } = foldLog(log('drift', [started, s1, s1end, h1, stopped]))
    expect(freshnessTotal(state.freshness)).toBe(0)
    expect(state.freshness.unattributed_mutations).toBe(0)
    expect(state.sessions.find((s) => s.id === 's1')!.unwritten).toBe(0)
  })
})

describe('render', () => {
  it('describeRun states adapter, policy, handoffs by reason in log order, and the fate', () => {
    const h2: Line = { type: 'handoff', payload: { run: RUN, session_id: 's2', reason: 'threshold' } }
    const h3: Line = { type: 'handoff', payload: { run: RUN, session_id: 's3', reason: 'task_done' } }
    const { state } = foldLog(log('describe', [started, h1, h2, h3, stopped]))
    expect(describeRun(latestRun(state)!)).toBe(
      `run ${RUN} via claude-code, task policy — 3 handoffs (2 task_done, 1 threshold); stopped: needs_user — next action names a release`,
    )
  })

  it('describeRun names the threshold for a threshold policy and says running while unstopped', () => {
    const t: Line = {
      type: 'run_started',
      payload: { run: RUN, adapter: 'claude-code', policy: 'threshold', threshold_pct: 70 },
    }
    const { state } = foldLog(log('threshold', [t]))
    expect(describeRun(latestRun(state)!)).toBe(`run ${RUN} via claude-code, threshold 70% — 0 handoffs; running`)
  })

  it('the digest carries one Driven line, and a hand-run record carries none', () => {
    const driven = foldLog(log('digest', [started, s1, s1end, h1, stopped])).state
    expect(renderStatus(driven)).toContain(`Driven: run ${RUN} via claude-code, task policy — 1 handoff (1 task_done); stopped: needs_user`)
    const manual = foldLog(log('manual', [s1, s1end])).state
    expect(renderStatus(manual)).not.toContain('Driven')
    expect(renderFullStatus(manual)).not.toContain('Driven')
  })

  it('the full status lists every run and every handoff with its task and tokens', () => {
    const { state } = foldLog(log('fullstatus', [started, s1, s1end, h1, stopped]))
    const text = renderFullStatus(state)
    expect(text).toContain('Driven (1 run):')
    expect(text).toContain(`- run ${RUN} via claude-code`)
    expect(text).toContain(`session s1 — task_done, task 1.1, 61000 tokens`)
  })

  it('sessions/<id>.md names the run that handed the session off', () => {
    const { state } = foldLog(log('session', [started, s1, s1end, h1]))
    const session = state.sessions.find((s) => s.id === 's1')!
    expect(renderSession(state, session)).toContain(`- Driven: run ${RUN} — handed off: task_done`)
    const manual = foldLog(log('session-manual', [s1, s1end])).state
    expect(renderSession(manual, manual.sessions[0]!)).not.toContain('Driven')
  })
})
