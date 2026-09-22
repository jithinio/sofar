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
import { judgePreflight, preflightRequest, type PreflightInput } from '../src/driver/preflight-judge'
import { FakeAdapter } from './helpers/fake-adapter'

/**
 * typed-judge 4.2/4.3 — the driver's pre-flight (catalogue B3/B4, D12).
 *
 * Advisory by the user's ruling: whatever the judge says, the launch goes
 * ahead as routed. One describe per property: the request carries the task
 * alone; the verdict is stored and printed, warns on an underspecified task,
 * and hints only for what the route left open; a driven run launches anyway,
 * and a takeover during the wait launches nothing.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const input = (extra: Partial<PreflightInput> = {}): PreflightInput => ({ task: { id: '1.1', title: 'Run lock with flock', phase: 'Phase 1' }, ...extra })

/** Answers `specified` with p, the score with all mass on `level`, the choice with `tier` at `pTier`. */
function fake(p: number, level = 2, tier = 'standard', pTier = 0.9, seen: WireRequest[] = []): JudgeProvider {
  return {
    name: 'cloud',
    async judge(request) {
      seen.push(request)
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, q]): [string, WireAnswer] => {
          if (q.type === 'noul') return [id, { type: 'noul', noul: p }]
          if (q.type === 'score') {
            const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === level ? 1 : 0]))
            return [id, { type: 'score', score: level, probabilities, legend: {}, confidence: 1 }]
          }
          const keys = Object.keys(q.criteria)
          const probabilities = Object.fromEntries(keys.map((k) => [k, k === tier ? pTier : (1 - pTier) / (keys.length - 1)]))
          return [id, { type: 'choice', choice: tier, probabilities, confidence: 0 }]
        }),
      )
      return { model: 'jev-1.13.0', answers }
    },
  }
}

describe('the request', () => {
  it('carries the task alone, and the last rejection when it was reopened', () => {
    expect(preflightRequest(input()).state).toEqual({ task: '1.1 Run lock with flock', phase: 'Phase 1' })
    expect(preflightRequest(input({ failure: 'verification attempt 1: `npm test` exit 1' })).state).toMatchObject({ last_check: 'verification attempt 1: `npm test` exit 1' })
    expect(Object.keys(preflightRequest(input()).questions)).toEqual(['specified', 'complexity', 'model'])
  })
})

describe('the verdict', () => {
  const open = { effort: true, model: true }

  it('without a provider there is nothing to store or print', async () => {
    expect(await judgePreflight(input(), open, {})).toEqual({ judgements: [], lines: [] })
  })

  it('stores the three answers, prints them, and hints for what the route left open', async () => {
    const v = await judgePreflight(input(), open, { provider: fake(0.9) })
    expect(v.judgements.map((j) => [j.question, j.subject])).toEqual([
      ['specified', '1.1'],
      ['complexity', '1.1'],
      ['model', '1.1'],
    ])
    for (const j of v.judgements) expect(validatePayload('judgement_recorded', j).ok).toBe(true)
    expect(v.lines).toEqual([
      '  pre-flight by jev-1.13.0: specified p 0.90 · complexity 2.0 of 3 · model standard (P 0.90)',
      '  route hint for 1.1: effort high, a standard model. Not applied; set route {effort, model} on the task, or --effort/--model, to use it',
    ])
  })

  it('warns on an underspecified task, and launches anyway', async () => {
    const v = await judgePreflight(input(), open, { provider: fake(0.05) })
    expect(v.lines[1]).toBe('  warning: 1.1 may not be specified well enough to act on (p 0.05): the session may stop to ask; launching anyway')
  })

  it('no hint for a field the route pinned or the adapter ignores, for no preference, or below the confidence floor', async () => {
    expect((await judgePreflight(input(), { effort: false, model: false }, { provider: fake(0.9) })).lines).toHaveLength(1)
    expect((await judgePreflight(input(), { effort: false, model: true }, { provider: fake(0.9, 1, 'no_preference') })).lines).toHaveLength(1)
    expect((await judgePreflight(input(), { effort: false, model: true }, { provider: fake(0.9, 1, 'fast', 0.5) })).lines).toHaveLength(1)
    expect((await judgePreflight(input(), { effort: true, model: false }, { provider: fake(0.9, 0) })).lines[1]).toContain('effort low')
  })

  it('a provider that fails yields no verdict and never throws', async () => {
    const broken: JudgeProvider = { name: 'cloud', judge: async () => { throw new Error('HTTP 402 plan_required') } }
    expect(await judgePreflight(input(), open, { provider: broken })).toEqual({ judgements: [], lines: [] })
  })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-preflight-'))
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
  const plan = { plan: { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'tbd', status: 'pending' }] }] } }
  for (const [type, payload] of [['initiative_created', { slug: 'demo', goal: 'g' }], ['plan_updated', plan]] as const) {
    appendEvent(path, makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  return root
}
const logPath = (root: string): string => join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl')
const types = (root: string): string[] => readFileSync(logPath(root), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { type: string }).type)

describe('in a driven run', () => {
  it('an underspecified verdict stops nothing: the session launches, and the pre-flight is on the record before it', async () => {
    const root = repo()
    const adapter = new FakeAdapter({ logPath: logPath(root), initiative: 'demo', session_id: 'w1', write_back: true, complete: true })
    const lines: string[] = []
    const out = await drive(root, 'demo', { adapter, maxSessions: 1, judge: { provider: fake(0.05) }, onProgress: (l) => lines.push(l) })
    expect(adapter.sessions).toHaveLength(1)
    expect(out.handoffs.map((h) => h.reason)).toEqual(['task_done'])
    expect(lines).toContain('  warning: 1.1 may not be specified well enough to act on (p 0.05): the session may stop to ask; launching anyway')
    const t = types(root)
    expect(t.indexOf('judgement_recorded')).toBeLessThan(t.indexOf('session_started'))
    expect(foldLog(logPath(root)).warnings).toEqual([])
  })

  it('a takeover during the pre-flight wait: nothing is appended and nothing launches', async () => {
    const root = repo()
    const adapter = new FakeAdapter({ logPath: logPath(root), initiative: 'demo', session_id: 'w1', write_back: true, complete: true })
    const slow: JudgeProvider = {
      name: 'cloud',
      async judge(request) {
        const run = foldLog(logPath(root)).state.runs.at(-1)!.id
        appendEvent(logPath(root), makeEvent({ initiative: 'demo', session: 'cli', type: 'run_adopted', payload: { run, epoch: 2 }, source: 'cli', actor: 'human' }))
        return fake(0.9).judge(request)
      },
    }
    await expect(drive(root, 'demo', { adapter, judge: { provider: slow } })).rejects.toBeInstanceOf(DriveFenced)
    expect(adapter.sessions).toHaveLength(0)
    expect(types(root)).not.toContain('judgement_recorded')
  })
})
