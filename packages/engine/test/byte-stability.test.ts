import { afterAll, describe, expect, it, vi } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { renderStatus } from '../src/projections/templates/status'

/**
 * felt-cost 1.2 — injection byte-stability (SPEC §Architectural invariants).
 *
 * For an unchanged record the SessionStart status block must render
 * byte-identically: every date in the block comes from event data, and no
 * render-time volatile bytes (wall clock, counters, randomness) may reach
 * the output. Cache-cost plays lean on this property, so it is pinned here
 * rather than assumed (felt-cost D2 records the informed-re-test citation
 * of token-optimization's "leading with prompt caching" rejection).
 *
 * Phase-2 note: the cold-resume advisory is resume-only content composed
 * AROUND the status block by handleSessionStart — it must never render
 * inside renderStatus, or this pin fails (correctly).
 */

function ev(type: string, payload: Record<string, unknown>, session = 'cli'): EventEnvelope {
  return makeEvent({ initiative: 'stability', session, source: 'cli', actor: 'agent', type, payload })
}

// Serialized ONCE at module load — both folds consume identical bytes, the
// same way two SessionStart re-fires consume the same events.jsonl.
const LINES: readonly string[] = [
  ev('initiative_created', { slug: 'stability', goal: 'exercise every status section' }),
  ev('plan_updated', {
    plan: {
      goal: 'exercise every status section',
      phases: [
        {
          name: 'Build',
          status: 'active',
          tasks: [
            { id: '1.1', title: 'done task', status: 'done' },
            { id: '1.2', title: 'active task', status: 'active' },
            { id: '1.3', title: 'pending task', status: 'pending' },
          ],
        },
        { name: 'Ship', status: 'pending', tasks: [{ id: '2.1', title: 'later task' }] },
      ],
    },
  }),
  ev('decision_logged', { chose: 'plain fold', over: 'incremental cache', because: 'simpler and fast enough' }),
  ev('note_added', { text: 'a free-form note that the digest may surface' }),
  ev('session_started', { tool: 'claude-code', model: 'claude-fable-5' }, 'sess-1'),
  ev('task_status_changed', { id: '1.1', status: 'done' }, 'sess-1'),
  ev('session_ended', { summary: 'finished 1.1', next_action: 'take 1.2 through review' }, 'sess-1'),
  // Post-write-back drift: triggers the "next action may be stale" line.
  ev('file_touched', { path: 'src/core/fold.ts', op: 'edit' }, 'sess-2'),
  ev('command_run', { cmd: 'npm test' }, 'sess-2'),
  // A second, still-open session (started, no write-back).
  ev('session_started', { tool: 'claude-code' }, 'sess-2'),
].map(serializeEvent)

function renderOnce(): string {
  const { state, warnings } = foldLines(LINES)
  expect(warnings).toEqual([])
  return renderStatus(state, {
    sessionId: 'sess-2',
    repoMemory: '## Repo memory\n- convention: byte-stability fixture',
  })
}

describe('injection byte-stability (felt-cost 1.2)', () => {
  afterAll(() => {
    vi.useRealTimers()
  })

  it('same events → byte-identical status block, even across a 90-day wall-clock jump', () => {
    const first = renderOnce()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'))
    const second = renderOnce()

    expect(second).toBe(first)
  })
})
