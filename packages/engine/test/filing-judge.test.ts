import { describe, expect, it } from 'vitest'
import { citesNothing, evidenceWarnings, filingRequest, filingWarnings, type FiledEntry } from '../src/core/filing-judge'
import type { JudgeProvider, WireAnswer, WireRequest } from '../src/core/judge'
import { callTool, connectServer, makeRepoFixture } from './helpers/mcp'

/**
 * typed-judge 3.3 — the filing judge (catalogue A4/A5, SPEC §Judge; D7).
 *
 * One describe per property: the free-path rules claim only the certain cases,
 * in the warning direction; the provider sees only what they left open and
 * warns at the provisional threshold; every tool appends first, stays bare
 * unless a line renders, and the write-back batch is judged as its own tools
 * would judge it.
 */

const note = (text: string, label = 'This note'): FiledEntry => ({ kind: 'note', label, text })
const decision = (chose: string, over: string, label = 'D1'): FiledEntry => ({ kind: 'decision', label, text: { chose, over, because: 'b' } })

describe('the free-path rules claim only the certain cases', () => {
  it('no note, or completion words only, cites nothing', () => {
    for (const n of [undefined, '', '  ', 'done', 'Finished.', 'LGTM, works', 'implemented and complete']) expect(citesNothing(n), String(n)).toBe(true)
  })

  it('anything more is left to the judge', () => {
    for (const n of ['full suite 2549 passed', 'commit 75170a7', 'tests pass', 'Implemented the lock', 'criteria met, see `npm test`']) expect(citesNothing(n), n).toBe(false)
  })

  it('a note or memory with an uncited choice over an alternative is a decision; a decision is never ruled on', () => {
    const decide = (e: FiledEntry) => filingRequest(e).questions.kind!.decide!(filingRequest(e).state)
    expect(decide(note('Built the lock. Went with flock over fcntl.'))).toMatchObject({ choice: 'decision' })
    expect(decide({ kind: 'memory', label: 'demo M1', text: 'The user ruled usesofar over sofarhq.' })).toMatchObject({ choice: 'decision' })
    expect(decide(note('Went with flock over fcntl, per D2.'))).toBeNull()
    expect(decide(decision('the test command is npm test', 'none'))).toBeNull()
  })

  it('the state is the entry alone, never what it was filed as', () => {
    expect(filingRequest(decision('flock', 'fcntl')).state).toEqual({ entry: { chose: 'flock', over: 'fcntl', because: 'b' } })
    expect(filingRequest(note('a finding')).state).toEqual({ entry: 'a finding' })
  })
})

/** Records what it was sent; answers the choice with `kinds` and the noul with `evidence`. */
function fake(kinds: Record<string, number>, evidence = 0.9, seen: WireRequest[] = []): JudgeProvider {
  return {
    name: 'cloud',
    async judge(request) {
      seen.push(request)
      const answers = Object.fromEntries(
        Object.entries(request.questions).map(([id, q]): [string, WireAnswer] => [
          id,
          q.type === 'choice'
            ? { type: 'choice', choice: 'note', probabilities: { decision: 0, operational_fact: 0, note: 0, ...kinds }, confidence: 0 }
            : { type: 'noul', noul: evidence },
        ]),
      )
      return { model: 'jev-1.13.0', answers }
    },
  }
}

describe('answers become warnings', () => {
  it('free path: a note or memory holding a decision warns with its sentence; a decision is silent', async () => {
    const out = await filingWarnings([
      note('Built the lock. Went with flock over fcntl.'),
      { kind: 'memory', label: 'demo M1', text: 'The user ruled usesofar over sofarhq.' },
      decision('the test command is npm test', 'none'),
    ])
    expect(out).toEqual([
      'This note reads as a decision (a choice over an alternative, citing no decision): "Went with flock over fcntl.". Log it with sofar_log_decision (chose, over, because) so it reaches the digest; the note stays as filed.',
      'demo M1 reads as a decision (a choice over an alternative, citing no decision): "The user ruled usesofar over sofarhq.". Log it with sofar_log_decision (chose, over, because) so it reaches the digest; the memory stays as filed.',
    ])
  })

  it('the provider sees only what the rule left open, and warns on another kind at 0.9 only', async () => {
    const seen: WireRequest[] = []
    const out = await filingWarnings([note('Went with flock over fcntl.'), decision('the test command is npm test', 'none', 'D4')], {
      provider: fake({ operational_fact: 0.95, decision: 0.05 }, 0.9, seen),
    })
    expect(seen).toHaveLength(1) // the note was the rule's
    expect(out[1]).toBe(
      'D4 reads as an operational fact later sessions need (judged P(operational_fact) 0.95 by jev-1.13.0). Promote it with sofar_remember so later sessions get it from repo memory; the decision stays as filed.',
    )
    expect(await filingWarnings([decision('x', 'y')], { provider: fake({ decision: 0.95, note: 0.05 }) })).toEqual([]) // filed right
    expect(await filingWarnings([decision('x', 'y')], { provider: fake({ note: 0.85, decision: 0.15 }) })).toEqual([])
  })

  it('evidence: no note and bare completion warn on the free path; the provider warns at p ≤ 0.1', async () => {
    expect(await evidenceWarnings([{ id: '2.1', title: 't' }, { id: '2.2', title: 't', note: 'done' }, { id: '2.3', title: 't', note: '12 passed' }])).toEqual([
      "2.1 marked done without cited evidence (no note). Name the passing test run, the commit or the acceptance criteria met: sofar_update_task again with a note, or a note on the write-back's tasks entry.",
      expect.stringContaining('2.2 marked done without cited evidence (the note only asserts completion)'),
    ])
    const three = await evidenceWarnings(['1.1', '1.2', '1.3'].map((id) => ({ id, title: 't' })))
    expect(three).toEqual([expect.stringMatching(/^1\.1, 1\.2 and 1\.3 marked done without cited evidence \(no note\)/)])
    const judged = await evidenceWarnings([{ id: '2.4', title: 't', note: 'rewired the adapter' }], { provider: fake({}, 0.05) })
    expect(judged).toEqual([expect.stringContaining('(judged P(evidence) 0.05 by jev-1.13.0)')])
    expect(await evidenceWarnings([{ id: '2.4', title: 't', note: 'rewired the adapter' }], { provider: fake({}, 0.2) })).toEqual([])
  })

  it('a provider that fails leaves the rule lines and never throws', async () => {
    const broken: JudgeProvider = { name: 'cloud', judge: async () => { throw new Error('HTTP 402 plan_required') } }
    expect(await evidenceWarnings([{ id: '2.1', title: 't' }, { id: '2.2', title: 't', note: 'rewired it' }], { provider: broken })).toEqual([
      expect.stringContaining('(no note)'),
    ])
    expect(await filingWarnings([decision('x', 'y')], { provider: broken })).toEqual([])
  })
})

describe('the tools append first and stay bare unless a line renders', () => {
  async function setup() {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const s = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_update_plan', {
      plan: { phases: [{ name: 'P1', tasks: [{ id: '1.1', title: 'Lock' }, { id: '1.2', title: 'Tests' }, { id: '1.3', title: 'Docs' }] }] },
    })
    return { client, session: s.body.session_id }
  }

  it('sofar_update_task: done without evidence warns; active and done with a check stay bare', async () => {
    const { client } = await setup()
    expect((await callTool(client, 'sofar_update_task', { task_id: '1.1', status: 'active' })).body).toEqual({ ok: true, event_id: expect.any(String) })
    const bare = await callTool<{ warnings?: string[] }>(client, 'sofar_update_task', { task_id: '1.1', status: 'done' })
    expect(bare.isError).toBe(false)
    expect(bare.body.warnings).toEqual([expect.stringContaining('1.1 marked done without cited evidence (no note)')])
    const proven = await callTool(client, 'sofar_update_task', { task_id: '1.2', status: 'done', note: 'suite 12 passed' })
    expect(proven.body).toEqual({ ok: true, event_id: expect.any(String) })
  })

  it('sofar_add_note and sofar_remember name what they filed', async () => {
    const { client } = await setup()
    const n = await callTool<{ warnings?: string[] }>(client, 'sofar_add_note', { text: 'Went with flock over fcntl.' })
    expect(n.body.warnings).toEqual([expect.stringContaining('This note reads as a decision')])
    const m = await callTool<{ warnings?: string[] }>(client, 'sofar_remember', { text: 'The user ruled usesofar over sofarhq.' })
    expect(m.body.warnings).toEqual([expect.stringContaining('demo M1 reads as a decision')])
    expect((await callTool(client, 'sofar_add_note', { text: 'Read the adapter code.' })).body).toEqual({ ok: true, event_id: expect.any(String) })
  })

  it('sofar_end_session judges its batch as the tools would', async () => {
    const { client, session } = await setup()
    const ended = await callTool<{ warnings?: string[] }>(client, 'sofar_end_session', {
      session_id: session,
      summary: 'Built the lock.',
      next_action: 'Start 1.3: write the docs page',
      tasks: [
        { task_id: '1.1', status: 'done' },
        { task_id: '1.2', status: 'done', note: 'suite 12 passed' },
      ],
      memories: ['The user ruled usesofar over sofarhq.'],
      notes: ['Went with flock over fcntl.'],
    })
    expect(ended.isError).toBe(false)
    expect(ended.body.warnings).toEqual([
      expect.stringContaining('demo M1 reads as a decision'),
      expect.stringContaining('notes[0] reads as a decision'),
      expect.stringContaining('1.1 marked done without cited evidence'),
    ])
  })
})
