import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import type { JudgeProvider, WireAnswer, WireRequest } from '../src/core/judge'
import { serializeEvent } from '../src/core/log'
import { buildRequests, choiceSentence, lexicallyVague, writebackJudgeWarnings, type WritebackDraft } from '../src/core/writeback-judge'
import { callTool, connectServer, makeRepoFixture } from './helpers/mcp'

/**
 * typed-judge 3.2 — the write-back judge (catalogue A1, SPEC §Judge).
 *
 * One describe per property: the free-path rules claim only the certain cases;
 * code selects what the summary is judged against; the provider sees only what
 * the rules left open and warns at the provisional threshold; the tool ends
 * the session first and only adds lines.
 */

function ev(type: string, payload: Record<string, unknown>, session = 'sess-1'): EventEnvelope {
  return makeEvent({ initiative: 'demo', session, source: 'claude-code', actor: 'agent', type, payload })
}

/** Ids and timestamps stamped in array order, one second apart. */
function foldOf(events: EventEnvelope[]): InitiativeState {
  const stamped = events.map((e, i) => ({
    ...e,
    id: `0000000000${String(i + 1).padStart(16, '0')}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString(),
  }))
  return foldLines(stamped.map(serializeEvent), 'demo').state
}

const created = ev('initiative_created', { slug: 'demo', goal: 'g' })
const plan = ev('plan_updated', {
  plan: {
    phases: [
      { name: 'P1', status: 'done', tasks: [{ id: '1.1', title: 'Lock file', status: 'done' }] },
      { name: 'P2', status: 'active', tasks: [{ id: '2.1', title: 'Run lock with tests', status: 'pending' }] },
    ],
  },
})
const earlier = ev('decision_logged', { chose: 'an empty lock file', over: 'a pid file', because: 'the OS releases it' }, 'sess-0')
const started = ev('session_started', { tool: 'claude-code' })

/** 1.1 done, 2.1 next; D1 logged by an earlier session; sess-1 started after it. */
const base = (...more: EventEnvelope[]): InitiativeState => foldOf([created, plan, earlier, started, ...more])

const draft = (summary: string, next_action: string): WritebackDraft => ({ session_id: 'sess-1', summary, next_action })

describe('the free-path rules claim only the certain cases', () => {
  it('a next action made only of continuation words is vague', () => {
    for (const text of ['continue', 'Keep going on the remaining tasks.', 'Continue with the next task', 'n', 'Pick up where we left off']) {
      expect(lexicallyVague(text), text).toBe(true)
    }
  })

  it('one that names anything is left to the judge', () => {
    for (const text of ['Start 2.1', 'Run `npm test`', 'Merge agents-parity into main', 'Write tests for the lock', 'Wait for the operator ruling', 'Edit src/core/lock.ts']) {
      expect(lexicallyVague(text), text).toBe(false)
    }
  })

  it('a summary sentence choosing one thing over another, citing no decision, is found', () => {
    expect(choiceSentence('Built the lock. The user ruled usesofar over sofarhq. Tests pass.')).toBe('The user ruled usesofar over sofarhq.')
    expect(choiceSentence('Decided to keep the 10s timeout rather than 30s')).toBe('Decided to keep the 10s timeout rather than 30s')
  })

  it('a cited decision, a code span, or "over" without a choice verb is not', () => {
    expect(choiceSentence('Implemented the endpoint; chose the path form over the body form per D3.')).toBeNull()
    expect(choiceSentence('The judge reads `decision.chose` over the rejected text.')).toBeNull()
    expect(choiceSentence('Went over the failing tests and fixed two.')).toBeNull()
    expect(choiceSentence('Decided to stop here.')).toBeNull()
  })
})

describe('code selects the state', () => {
  it('the next action is judged against the plan’s next task only; no open task asks nothing', () => {
    const { next } = buildRequests(base(), draft('s', 'continue'))
    expect(next!.state).toEqual({ next_action: 'continue', plan_next_task: '2.1 Run lock with tests' })
    const allDone = ev('task_status_changed', { id: '2.1', status: 'done' })
    expect(buildRequests(base(allDone), draft('s', 'Nothing left')).next).toBeNull()
  })

  it('the summary is judged against recent and related decisions and live memories', () => {
    const filler = Array.from({ length: 12 }, (_, i) => ev('decision_logged', { chose: `option ${i}`, over: `alt ${i}`, because: 'b' }, 'sess-0'))
    const state = foldOf([
      created,
      plan,
      earlier,
      ...filler,
      ev('memory_promoted', { text: 'the test command is npm test' }, 'sess-0'),
      ev('memory_promoted', { text: 'tests run with vitest', supersedes: 'demo M1' }, 'sess-0'),
      started,
      ev('decision_logged', { chose: 'flock on the lock file', over: 'fcntl', because: 'b' }),
    ])
    const summary = buildRequests(state, draft('Took the lock with flock; the empty lock file stays.', 'Start 2.1')).summary
    const s = summary.state as { decisions: Record<string, string>; memories: Record<string, string> }
    expect(Object.keys(s.decisions)).toHaveLength(8)
    expect(s.decisions.D1).toBe('an empty lock file — over: a pid file') // the BM25 hit, though oldest
    expect(s.decisions.D14).toBe('flock on the lock file — over: fcntl') // this session's own
    expect(s.memories).toEqual({ M2: 'tests run with vitest' }) // M1 was superseded
  })
})

/** Records what it was sent; answers nouls with `p[id]` (default 0.1) and the score with `vague` on level 0. */
function fake(p: Record<string, number>, vague = 0.1, seen: WireRequest[] = []): JudgeProvider {
  return {
    name: 'cloud',
    async judge(request) {
      seen.push(request)
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, q]): [string, WireAnswer] => [
          id,
          q.type === 'score'
            ? { type: 'score' as const, score: 1 - vague, probabilities: { '0': vague, '1': 1 - vague, '2': 0, '3': 0 }, legend: {}, confidence: 0 }
            : { type: 'noul' as const, noul: p[id] ?? 0.1 },
        ]),
      )
      return { model: 'jev-1.13.0', answers }
    },
  }
}

describe('answers become warnings', () => {
  it('free path: a vague next action warns, naming the next task; a concrete one is silent', async () => {
    const out = await writebackJudgeWarnings(base(), draft('Built the lock.', 'keep going'))
    expect(out).toEqual([
      'next_action may be too vague to resume from (names no task, file or command): "keep going". Write back again with one that names the task (next in the plan: 2.1) and its first concrete step.',
    ])
    expect(await writebackJudgeWarnings(base(), draft('Built the lock.', 'Start 2.1: flock in core/lock.ts'))).toEqual([])
  })

  it('free path: an unlogged choice warns with its sentence, unless the session logged a decision', async () => {
    const summary = 'Built the lock. Went with flock over fcntl.'
    const out = await writebackJudgeWarnings(base(), draft(summary, 'Start 2.1'))
    expect(out).toEqual([
      'The summary may report a decision the record does not hold (no decision logged this session): "Went with flock over fcntl.". Log it with sofar_log_decision (chose, over, because); if it is already recorded, ignore this.',
    ])
    const logged = ev('decision_logged', { chose: 'flock', over: 'fcntl', because: 'b' })
    expect(await writebackJudgeWarnings(base(logged), draft(summary, 'Start 2.1'))).toEqual([])
  })

  it('the provider sees only what the rules left open, and warns at 0.9 only', async () => {
    const seen: WireRequest[] = []
    const out = await writebackJudgeWarnings(base(), draft('Went with flock over fcntl. Release is npm publish.', 'continue'), {
      provider: fake({ memory_fact: 0.93 }, 0.1, seen),
    })
    // The rules answered next_action and unlogged_decision; only the memory noul was sent.
    expect(seen.map((r) => Object.keys(r.questions))).toEqual([['memory_fact']])
    expect(out).toHaveLength(3)
    expect(out[2]).toBe(
      'The summary may state an operational fact later sessions need (judged p 0.93 by jev-1.13.0). Promote it with sofar_remember; if it only mattered to this session, ignore this.',
    )

    const judged = await writebackJudgeWarnings(base(), draft('Built the lock.', 'Look into the flaky bits'), {
      provider: fake({ unlogged_decision: 0.95, memory_fact: 0.85 }, 0.95),
    })
    expect(judged).toEqual([
      expect.stringContaining('(judged P(vague) 0.95 by jev-1.13.0): "Look into the flaky bits"'),
      expect.stringContaining('(judged p 0.95 by jev-1.13.0). Log it with sofar_log_decision'),
    ])
    expect(await writebackJudgeWarnings(base(), draft('Built the lock.', 'Look into the flaky bits'), { provider: fake({}, 0.85) })).toEqual([])
  })

  it('a provider that fails leaves the rule lines and never throws', async () => {
    const broken: JudgeProvider = { name: 'cloud', judge: async () => { throw new Error('HTTP 402 plan_required') } }
    const out = await writebackJudgeWarnings(base(), draft('Built the lock.', 'continue'), { provider: broken })
    expect(out).toEqual([expect.stringContaining('names no task, file or command')])
  })
})

describe('the tool ends the session first and only adds lines', () => {
  it('sofar_end_session files the write-back AND warns on a vague next action', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const s = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_update_plan', { plan: { phases: [{ name: 'P1', tasks: [{ id: '1.1', title: 'Lock' }] }] } })
    const ended = await callTool<{ warnings?: string[] }>(client, 'sofar_end_session', {
      session_id: s.body.session_id,
      summary: 'Read the code.',
      next_action: 'continue',
    })
    expect(ended.isError).toBe(false)
    expect(ended.body.warnings).toEqual([expect.stringContaining('next in the plan: 1.1')])
    const types = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l).type)
    expect(types).toContain('session_ended')

    const again = await callTool<Record<string, unknown>>(client, 'sofar_end_session', {
      session_id: s.body.session_id,
      summary: 'Read the code.',
      next_action: 'Start 1.1: write the lock test first',
    })
    expect(again.body).not.toHaveProperty('warnings')
  })
})
