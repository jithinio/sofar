import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { schemaFingerprint, validatePayload } from '@sofar/schema'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { RELEVANCE_CARRY, rankByRelevance, refreshRelevance, relevance, type RelevanceRow } from '../src/core/index-relevance'
import { THRESHOLDS, type JudgeProvider, type WireRequest } from '../src/core/judge'
import { serializeEvent } from '../src/core/log'
import { relevanceJudgements, relevanceRequest } from '../src/core/relevance-judge'
import { createToolContext } from '../src/mcp/context'
import { endSessionJudged } from '../src/mcp/end-session'
import { callTool, connectServer, makeRepoFixture } from './helpers/mcp'

/**
 * typed-judge 5.1 — stored relevance (catalogue C1; the D10 contract with
 * memory-lead B1; scope D11).
 *
 * One describe per property: the schema types `about`; code selects what is
 * judged and never a retired decision; only model answers are stored; the
 * index keeps the latest row per subject and its reader never returns a
 * retired one; ranking only orders and adds; the write-back stores rows with a
 * provider and nothing without one.
 */

function ev(type: string, payload: Record<string, unknown>, initiative = 'demo'): EventEnvelope {
  return makeEvent({ initiative, session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload })
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  const stamped = events.map((e, i) => ({ ...e, id: `0000000000${String(i + 1).padStart(16, '0')}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString() }))
  return foldLines(stamped.map(serializeEvent), 'demo').state
}

const plan = (status = 'pending') =>
  ev('plan_updated', { plan: { phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'Run lock with flock', status }] }] } })
const decide = (chose: string, extra: Record<string, unknown> = {}) => ev('decision_logged', { chose, over: 'x', because: 'b', ...extra })

/** Answers every forwarded noul with `p[id]` (default 0.9). */
function fake(p: Record<string, number> = {}, seen: WireRequest[] = []): JudgeProvider {
  return {
    name: 'cloud',
    async judge(request) {
      seen.push(request)
      return { model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul' as const, noul: p[id] ?? 0.9 }])) }
    },
  }
}

describe('the schema types `about`', () => {
  const row = (about: unknown) => ({ producer: 'sofar-cloud', model: 'm', question: 'relevance', subject: 'D1', about, answer: { type: 'noul', noul: 0.9 } })
  it('accepts task and repo-relative file targets, and nothing else', () => {
    for (const about of ['task:1.1', 'file:packages/engine/src/x.ts', 'file:docs/a b.md']) expect(validatePayload('judgement_recorded', row(about)).ok, about).toBe(true)
    for (const about of ['file:/abs/x.ts', 'task:', 'other', '']) expect(validatePayload('judgement_recorded', row(about)).ok, about).toBe(false)
    expect(validatePayload('judgement_recorded', { ...row('task:1.1'), about: undefined }).ok).toBe(true)
  })

  it('the hashed fields line names it, and the committed fingerprint follows', () => {
    expect(schemaFingerprint()).toContain('about? (task:<id> | file:<repo-relative path>)')
  })
})

describe('code selects the candidates', () => {
  it('in-force decisions, live memories and notes; subjects qualified per D10', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      plan(),
      decide('flock on the lock file'),
      decide('keep the lock file empty', { supersedes: 'D1' }), // retires D1
      ev('memory_promoted', { text: 'old fact' }),
      ev('memory_promoted', { text: 'lock files live in the state dir', supersedes: 'demo M1' }),
    ])
    const built = relevanceRequest(state, [{ id: '01NOTE', ts: '2026-01-01T00:00:09.000Z', text: 'flock is advisory on NFS' }])!
    expect(built.task).toMatchObject({ id: '1.1', title: 'Run lock with flock' })
    expect(built.asked.map((c) => [c.key, c.subject])).toEqual([
      ['D2', 'D2'],
      ['M2', 'demo M2'],
      ['N1', '01NOTE'],
    ])
    expect(Object.keys(built.request.questions)).toEqual(['rel_D2', 'rel_M2', 'rel_N1'])
    expect(built.request.state).toMatchObject({ task: '1.1 Run lock with flock' })
  })

  it('no next task, nothing to ask', () => {
    const state = foldOf([ev('initiative_created', { slug: 'demo', goal: 'g' }), plan('done'), decide('flock')])
    expect(relevanceRequest(state, [])).toBeNull()
  })

  it('8 per kind: the BM25 hit stays though oldest, the newest fill the rest', () => {
    const filler = Array.from({ length: 12 }, (_, i) => decide(`option ${i} for area ${i}`))
    const state = foldOf([ev('initiative_created', { slug: 'demo', goal: 'g' }), plan(), decide('flock on the lock file'), ...filler])
    const keys = relevanceRequest(state, [])!.asked.map((c) => c.key)
    expect(keys).toHaveLength(8)
    expect(keys).toContain('D1')
    expect(keys).toContain('D13')
  })
})

describe('only model answers are stored', () => {
  const state = () => foldOf([ev('initiative_created', { slug: 'demo', goal: 'g' }), plan(), decide('flock on the lock file')])

  it('without a provider nothing is judged or stored', async () => {
    expect(await relevanceJudgements(state(), [], {})).toEqual([])
  })

  it('with one, every answer becomes a valid row about the next task', async () => {
    const rows = await relevanceJudgements(state(), [], { provider: fake({ rel_D1: 0.93 }) })
    expect(rows).toEqual([
      { producer: 'sofar-cloud', model: 'jev-1.13.0', question: 'relevance', subject: 'D1', about: 'task:1.1', answer: { type: 'noul', noul: 0.93 }, state_hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ])
    expect(validatePayload('judgement_recorded', rows[0]).ok).toBe(true)
  })

  it('a provider that fails stores nothing and never throws', async () => {
    const broken: JudgeProvider = { name: 'cloud', judge: async () => { throw new Error('HTTP 402 plan_required') } }
    expect(await relevanceJudgements(state(), [], { provider: broken })).toEqual([])
  })
})

/** A .sofar dir with `demo` and `other`, each holding the given events. */
function sofarDirWith(root: string, logs: Record<string, EventEnvelope[]>): string {
  const sofarDir = join(root, '.sofar')
  for (const [slug, events] of Object.entries(logs)) {
    const dir = join(sofarDir, 'initiatives', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.jsonl'), events.map((e) => serializeEvent(e) + '\n').join(''))
  }
  return sofarDir
}
const judged = (subject: string, about: string, noul: number, initiative = 'demo', question = 'relevance') =>
  ev('judgement_recorded', { producer: 'sofar-cloud', model: 'jev-1.13.0', question, subject, about, answer: { type: 'noul', noul } }, initiative)

describe('the index keeps the latest row, and the reader never returns a retired one', () => {
  it('latest per subject, strongest first; bare D-handles qualified; other questions ignored', () => {
    const root = makeRepoFixture().root
    const sofarDir = sofarDirWith(root, {
      demo: [
        ev('initiative_created', { slug: 'demo', goal: 'g' }),
        judged('D1', 'task:1.1', 0.3),
        judged('D1', 'task:1.1', 0.95),
        judged('demo M2', 'task:1.1', 0.85),
        judged('D3', 'task:1.1', 0.9, 'demo', 'task_done'),
      ],
    })
    const rows = relevance(refreshRelevance(sofarDir), { about: 'task:1.1', initiative: 'demo', retired: new Set() })
    expect(rows.map((r) => [r.subject, r.p])).toEqual([
      ['demo D1', 0.95],
      ['demo M2', 0.85],
    ])
  })

  it('task rows belong to their initiative; file rows are repo-wide; retired handles never come back', () => {
    const root = makeRepoFixture().root
    const sofarDir = sofarDirWith(root, {
      demo: [ev('initiative_created', { slug: 'demo', goal: 'g' }), judged('D1', 'task:1.1', 0.9), judged('D2', 'file:src/lock.ts', 0.9)],
      other: [ev('initiative_created', { slug: 'other', goal: 'g' }, 'other'), judged('D1', 'task:1.1', 0.9, 'other'), judged('D4', 'file:src/lock.ts', 0.8, 'other')],
    })
    const index = refreshRelevance(sofarDir)
    expect(relevance(index, { about: 'task:1.1', initiative: 'demo', retired: new Set() }).map((r) => r.subject)).toEqual(['demo D1'])
    expect(relevance(index, { about: 'file:src/lock.ts', retired: new Set() }).map((r) => r.subject)).toEqual(['demo D2', 'other D4'])
    expect(relevance(index, { about: 'file:src/lock.ts', retired: new Set(['demo D2']) }).map((r) => r.subject)).toEqual(['other D4'])
  })

  it('a later append extends the tier from its cursor', () => {
    const root = makeRepoFixture().root
    const sofarDir = sofarDirWith(root, { demo: [ev('initiative_created', { slug: 'demo', goal: 'g' }), judged('D1', 'task:1.1', 0.4)] })
    refreshRelevance(sofarDir)
    appendFileSync(join(sofarDir, 'initiatives', 'demo', 'events.jsonl'), serializeEvent(judged('D1', 'task:1.1', 0.9)) + '\n')
    expect(relevance(refreshRelevance(sofarDir), { about: 'task:1.1', initiative: 'demo', retired: new Set() })[0]!.p).toBe(0.9)
  })
})

describe('ranking only orders and adds', () => {
  const row = (subject: string, p: number): RelevanceRow => ({ subject, p, model: 'm', id: subject })
  it('keeps every candidate, even at a low p; adds a stranger only at the carry threshold', () => {
    const ranked = rankByRelevance(['demo D1', 'demo D2', 'demo D3'], [row('demo D2', 0.95), row('demo D3', 0.05), row('demo D9', 0.85), row('demo D8', 0.7)])
    expect(ranked).toEqual(['demo D2', 'demo D9', 'demo D1', 'demo D3'])
  })

  it('the carry threshold is the measured one, restated so hooks never reach core/judge', () => {
    expect(RELEVANCE_CARRY).toBe(THRESHOLDS.relevance_carry)
    const source = readFileSync(join(__dirname, '..', 'src', 'core', 'index-relevance.ts'), 'utf8')
    expect(source).not.toMatch(/from '\.\/(judge|relevance-judge|decision-judge|writeback-judge|filing-judge)'/)
  })
})

describe('the write-back stores rows with a provider, and nothing without one', () => {
  async function setup() {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const s = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_update_plan', { plan: { phases: [{ name: 'P1', tasks: [{ id: '1.1', title: 'Run lock with flock' }] }] } })
    await callTool(client, 'sofar_log_decision', { chose: 'flock on the lock file', over: 'fcntl', because: 'OS releases it' })
    return { fixture, session: s.body.session_id }
  }
  const judgements = (path: string) =>
    readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> }).filter((e) => e.type === 'judgement_recorded')

  it('with a provider: one row per answer, about the next task, readable through the index', async () => {
    const { fixture, session } = await setup()
    const seen: WireRequest[] = []
    const ctx = createToolContext(fixture.root)
    const out = await endSessionJudged(ctx, { session_id: session, summary: 'Read the code.', next_action: 'Start 1.1: flock in core/lock.ts' }, { provider: fake({ rel_D1: 0.92 }, seen) })
    expect(out.ok).toBe(true)
    const rows = judgements(fixture.eventsPath)
    expect(rows.map((e) => [e.payload.subject, e.payload.about, (e.payload.answer as { noul: number }).noul])).toEqual([['D1', 'task:1.1', 0.92]])
    const index = refreshRelevance(join(fixture.root, '.sofar'))
    expect(relevance(index, { about: 'task:1.1', initiative: fixture.slug, retired: new Set() })[0]).toMatchObject({ subject: 'demo D1', p: 0.92 })
  })

  it('without one: nothing', async () => {
    const { fixture, session } = await setup()
    await endSessionJudged(createToolContext(fixture.root), { session_id: session, summary: 's', next_action: 'Start 1.1: flock in core/lock.ts' }, {})
    expect(judgements(fixture.eventsPath)).toEqual([])
  })
})
