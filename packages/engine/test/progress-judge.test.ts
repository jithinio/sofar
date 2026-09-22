import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { makeEvent } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import type { JudgeProvider, WireAnswer, WireRequest } from '../src/core/judge'
import { appendEvent } from '../src/core/log'
import { drive, DriveFenced } from '../src/driver/drive'
import { judgeProgress, progressRequest, type ProgressEvidence } from '../src/driver/progress-judge'
import { diffStatSince, headOf } from '../src/driver/verify'
import { FakeAdapter } from './helpers/fake-adapter'

/**
 * typed-judge 4.1 — the driver's progress judge (catalogue B1/B2, D8).
 *
 * One describe per property: the evidence goes to the judge without the fold's
 * reason; the rules restate only the record; a model's answers are stored and
 * printed, and a disagreement with the fold warns; a driven run keeps the
 * fold's handoff reason whatever the judge says.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const evidence = (extra: Partial<ProgressEvidence> = {}): ProgressEvidence => ({
  task: { id: '1.1', title: 'Run lock with tests' },
  reason: 'task_done',
  status_before: 'pending',
  status_after: 'done',
  writeback: { summary: 'Built the lock; 12 tests pass.', next_action: 'Start 1.2' },
  diff: '3 files changed, 120 insertions(+), 4 deletions(-)',
  test: 'verification attempt 1: `npm test` passed',
  ...extra,
})

/** Records what it was sent; answers the noul with `done` and the choice with `outcome` at `p`. */
function fake(done: number, outcome = 'task_done', p = 0.8, seen: WireRequest[] = []): JudgeProvider {
  return {
    name: 'cloud',
    async judge(request) {
      seen.push(request)
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, q]): [string, WireAnswer] => {
          if (q.type === 'noul') return [id, { type: 'noul', noul: done }]
          const keys = Object.keys((q as { criteria: Record<string, unknown> }).criteria)
          const rest = (1 - p) / (keys.length - 1)
          const probabilities = Object.fromEntries(keys.map((k) => [k, k === outcome ? p : rest]))
          return [id, { type: 'choice', choice: outcome, probabilities, confidence: 0 }]
        }),
      )
      return { model: 'jev-1.13.0', answers }
    },
  }
}

describe('the request', () => {
  it('carries the evidence and never the fold’s reason', () => {
    const { state } = progressRequest(evidence())
    expect(state).toEqual({
      task: '1.1 Run lock with tests',
      status: 'pending → done',
      write_back: { summary: 'Built the lock; 12 tests pass.', next_action: 'Start 1.2' },
      diff: '3 files changed, 120 insertions(+), 4 deletions(-)',
      test: 'verification attempt 1: `npm test` passed',
    })
    expect(JSON.stringify(state)).not.toContain('task_done')
  })

  it('names what is missing rather than omitting it', () => {
    const { state } = progressRequest(evidence({ writeback: undefined, diff: '', test: undefined }))
    expect(state).toMatchObject({ write_back: 'none: the session did not write back', diff: 'no change to the tree outside the record' })
    expect(state).not.toHaveProperty('test')
  })

  it('the rules restate only the record: verify_failed is not done, needs_user is blocked on the operator', () => {
    const q = (e: ProgressEvidence) => progressRequest(e).questions
    expect(q(evidence({ reason: 'verify_failed' })).task_done!.decide!('')).toEqual({ type: 'noul', noul: 0 })
    expect(q(evidence({ reason: 'needs_user' })).outcome!.decide!('')).toMatchObject({ choice: 'blocked_on_user' })
    expect(q(evidence()).task_done!.decide!('')).toBeNull()
    expect(q(evidence({ reason: 'stall' })).outcome!.decide!('')).toBeNull()
  })
})

describe('the verdict', () => {
  it('without a provider there is nothing to store or print', async () => {
    expect(await judgeProgress(evidence({ reason: 'verify_failed' }), 's1', {})).toEqual({ judgements: [], lines: [] })
  })

  it('stores the model’s answers and prints them; agreement adds no warning', async () => {
    const v = await judgeProgress(evidence(), 's1', { provider: fake(0.92) })
    expect(v.judgements.map((j) => [j.producer, j.model, j.question, j.subject])).toEqual([
      ['sofar-cloud', 'jev-1.13.0', 'task_done', '1.1'],
      ['sofar-cloud', 'jev-1.13.0', 'outcome', '1.1'],
    ])
    expect(v.judgements[0]!.answer).toEqual({ type: 'noul', noul: 0.92 })
    expect(v.judgements[1]!.answer).not.toHaveProperty('legend')
    expect(v.judgements[0]!.state_hash).toMatch(/^[0-9a-f]{64}$/)
    for (const j of v.judgements) expect(validatePayload('judgement_recorded', j).ok).toBe(true)
    expect(v.lines).toEqual(['  judged by jev-1.13.0: task_done p 0.92 · outcome task_done (P 0.80)'])
  })

  it('a rule-answered question is not sent and not stored', async () => {
    const seen: WireRequest[] = []
    const v = await judgeProgress(evidence({ reason: 'needs_user', status_after: 'blocked' }), 's1', { provider: fake(0.1, 'task_done', 0.8, seen) })
    expect(Object.keys(seen[0]!.questions)).toEqual(['task_done'])
    expect(v.judgements.map((j) => j.question)).toEqual(['task_done'])
    expect(v.lines[0]).toBe('  judged by jev-1.13.0: task_done p 0.10 · outcome blocked_on_user (P 1.00)')
  })

  it('warns when the verdict and the fold disagree with conviction', async () => {
    const notDone = await judgeProgress(evidence(), 's1', { provider: fake(0.05, 'partial') })
    expect(notDone.lines[1]).toBe("  warning: 1.1 handed off as done, but judged not done (p 0.05): read session s1's write-back before the next session builds on it")
    const unmarked = await judgeProgress(evidence({ reason: 'stall', status_after: 'active' }), 's1', { provider: fake(0.95) })
    expect(unmarked.lines[1]).toContain('1.1 judged done (p 0.95) though session s1 did not mark it')
    const wrong = await judgeProgress(evidence(), 's1', { provider: fake(0.5, 'wrong_task', 0.93) })
    expect(wrong.lines[1]).toBe('  warning: session s1 judged wrong_task on 1.1 (P 0.93): read its write-back')
    expect((await judgeProgress(evidence(), 's1', { provider: fake(0.15, 'partial', 0.85) })).lines).toHaveLength(1)
  })

  it('a provider that fails yields no verdict and never throws', async () => {
    const broken: JudgeProvider = { name: 'cloud', judge: async () => { throw new Error('HTTP 402 plan_required') } }
    expect(await judgeProgress(evidence(), 's1', { provider: broken })).toEqual({ judgements: [], lines: [] })
  })
})

/** A git repo with one initiative, `demo`, and a two-task plan. */
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-progress-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@e.com')
  git('config', 'user.name', 't')
  writeFileSync(join(root, 'README.md'), 'x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  writeFileSync(path, '')
  const plan = { plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'first', status: 'pending' }] }] } }
  for (const [type, payload] of [['initiative_created', { slug: 'demo', goal: 'g' }], ['plan_updated', plan]] as const) {
    appendEvent(path, makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  return root
}
const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')

describe('the diff base', () => {
  it('counts commits, edits and new files since the launch, never the record', () => {
    const root = repo()
    const head = headOf(root)!
    expect(diffStatSince(root, head)).toBe('')
    writeFileSync(join(root, 'README.md'), 'y\nz\n')
    writeFileSync(join(root, 'new.txt'), 'n\n')
    writeFileSync(join(root, '.sofar', 'scratch.md'), 'x\n')
    expect(diffStatSince(root, head)).toBe('1 file changed, 2 insertions(+), 1 deletion(-), 1 untracked file')
  })
})

describe('in a driven run', () => {
  it('the handoff stays the fold’s; the verdict is stored and printed beside it', async () => {
    const root = repo()
    const adapter = new FakeAdapter({ logPath: logPath(root), initiative: 'demo', session_id: 'w1', write_back: true, complete: true })
    const seen: WireRequest[] = []
    const lines: string[] = []
    const out = await drive(root, 'demo', { adapter, maxSessions: 1, judge: { provider: fake(0.05, 'partial', 0.8, seen) }, onProgress: (l) => lines.push(l) })
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done']) // D5: the judge vetoes nothing
    // The pre-flight (4.2) asks first; the progress request is the one carrying `status`.
    const progressSent = seen.find((r) => typeof r.state === 'object' && r.state !== null && 'status' in r.state)!
    expect(progressSent.state).toMatchObject({ task: '1.1 first', status: 'pending → done', diff: 'no change to the tree outside the record' })
    const events = readFileSync(logPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; session: string; payload: Record<string, unknown> })
    const judged = events.filter((e) => e.type === 'judgement_recorded' && (e.payload.question === 'task_done' || e.payload.question === 'outcome'))
    expect(judged.map((e) => [e.session, e.payload.question, e.payload.subject])).toEqual([
      ['cli', 'task_done', '1.1'],
      ['cli', 'outcome', '1.1'],
    ])
    expect(lines).toContain("  warning: 1.1 handed off as done, but judged not done (p 0.05): read session w1's write-back before the next session builds on it")
    const { state, warnings } = foldLog(logPath(root))
    expect(warnings).toEqual([])
    expect(state.phases[0]!.tasks[0]!.status).toBe('done')
  })

  it('a takeover during the judge wait: the fenced driver appends no judgement and steps down', async () => {
    const root = repo()
    const adapter = new FakeAdapter([
      { logPath: logPath(root), initiative: 'demo', session_id: 'w1', write_back: true, complete: true },
      { logPath: logPath(root), initiative: 'demo', session_id: 'w2', write_back: true, complete: true },
    ])
    const slow: JudgeProvider = {
      name: 'cloud',
      async judge(request) {
        // The pre-flight (4.2) is answered normally; the takeover lands during the progress judge.
        if (!(typeof request.state === 'object' && request.state !== null && 'status' in request.state)) return fake(0.9).judge(request)
        // Another machine's --resume, synced in while the judge was out.
        const run = foldLog(logPath(root)).state.runs.at(-1)!.id
        appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type: 'run_adopted', payload: { run, epoch: 2 }, source: 'cli', actor: 'human' }))
        return fake(0.9).judge(request)
      },
    }
    await expect(drive(root, 'demo', { adapter, judge: { provider: slow } })).rejects.toBeInstanceOf(DriveFenced)
    expect(adapter.sessions).toHaveLength(1)
    // The pre-flight's judgements precede the adoption; nothing follows it.
    const after = readFileSync(logPath(root), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string })
    expect(after.slice(after.findIndex((e) => e.type === 'run_adopted') + 1).map((e) => e.type)).not.toContain('judgement_recorded')
  })

  it('without a provider the run judges nothing and writes no judgement', async () => {
    const root = repo()
    const adapter = new FakeAdapter({ logPath: logPath(root), initiative: 'demo', session_id: 'w1', write_back: true, complete: true })
    await drive(root, 'demo', { adapter, maxSessions: 1, judge: {} })
    expect(readFileSync(logPath(root), 'utf8')).not.toContain('judgement_recorded')
  })
})
