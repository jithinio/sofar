import { validatePayload } from '@sofar/schema'
import { describe, expect, it } from 'vitest'
import { type EventEnvelope, makeEvent } from '../src/core/envelope'
import { foldLines } from '../src/core/fold'

/**
 * typed-judge 2.4 — `judgement_recorded` is ENRICHMENT (SPEC §Judge "Stored
 * judgements", §Acceptance criteria "Stored judgements").
 *
 * Two clauses, each a test: the fold neither warns about it nor lets it touch
 * state or drift (replay stays a pure function of recorded FACTS, and a
 * judgement is an opinion about them); and the schema refuses a judgement
 * that could not be read back — no producer, no model version, an answer of
 * no known type.
 */

function ev(type: string, payload: Record<string, unknown>, session = 'sess-1'): EventEnvelope {
  return makeEvent({ initiative: 'typed-judge', session, source: 'claude-code', actor: 'agent', type, payload })
}

function storyline(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'typed-judge', goal: 'judge' }),
    ev('plan_updated', { plan: { phases: [{ name: 'Phase 1', tasks: [{ id: '1.1', title: 'measure' }] }] } }),
    ev('session_started', { tool: 'claude-code' }),
    ev('decision_logged', { chose: 'a', over: 'b', because: 'c' }),
    ev('session_ended', { summary: 'done', next_action: 'next' }),
  ]
}

const judgement = (subject: string) =>
  ev('judgement_recorded', {
    producer: 'sofar-cloud',
    model: 'jev-1.13.0',
    question: 'relevance',
    subject,
    answer: { type: 'noul', noul: 0.91 },
    state_hash: 'a'.repeat(64),
  })

const lines = (events: EventEnvelope[]) => events.map((e) => JSON.stringify(e))

describe('judgement_recorded folds as enrichment', () => {
  it('appends no warning, changes no state field, and does not stale the next action', () => {
    const base = storyline()
    const without = foldLines(lines(base), 'typed-judge')
    const decisionId = base[3]!.id
    const withJudgement = foldLines(lines([...base, judgement(decisionId), judgement('1.1')]), 'typed-judge')

    expect(withJudgement.warnings).toEqual(without.warnings)
    expect(withJudgement.warnings).toEqual([])
    // The cursor moves (envelope-valid events always advance it); nothing else does.
    const { cursor: c1, ...stateWithout } = without.state
    const { cursor: c2, ...stateWith } = withJudgement.state
    expect(c2).not.toBe(c1)
    expect(stateWith).toEqual(stateWithout)
    expect(withJudgement.state.freshness.events_since_writeback).toEqual(without.state.freshness.events_since_writeback)
    expect(withJudgement.state.freshness.unattributed_mutations).toBe(without.state.freshness.unattributed_mutations)
  })

  it('a judgement after the write-back leaves the session owing nothing', () => {
    const base = storyline()
    const folded = foldLines(lines([...base, judgement('1.1')]), 'typed-judge')
    const session = folded.state.sessions.find((s) => s.id === 'sess-1')
    expect(session?.unwritten ?? 0).toBe(0)
  })
})

describe('judgement_recorded payload validation', () => {
  const valid = {
    producer: 'deterministic',
    model: 'deterministic',
    question: 'progress',
    subject: '1.1',
    answer: { type: 'choice', choice: 'done', probabilities: { done: 0.7, partial: 0.3 }, confidence: 0.4 },
  }

  it('accepts each answer type in its wire shape', () => {
    expect(validatePayload('judgement_recorded', valid)).toEqual({ ok: true })
    expect(validatePayload('judgement_recorded', { ...valid, answer: { type: 'noul', noul: 0 } })).toEqual({ ok: true })
    expect(
      validatePayload('judgement_recorded', {
        ...valid,
        answer: { type: 'score', score: 1.4, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 }, confidence: 0.25 },
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a missing producer or model, a choice outside its own distribution, and an unknown answer type', () => {
    const bad = (payload: Record<string, unknown>): string[] => {
      const r = validatePayload('judgement_recorded', payload)
      return r.ok ? [] : r.errors
    }
    expect(bad({ ...valid, producer: '' })).toEqual(expect.arrayContaining([expect.stringMatching(/^producer/)]))
    expect(bad({ ...valid, model: undefined })).toEqual(expect.arrayContaining([expect.stringMatching(/^model/)]))
    expect(bad({ ...valid, answer: { ...valid.answer, choice: 'elsewhere' } })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^answer\.choice/)]),
    )
    expect(bad({ ...valid, answer: { type: 'essay', text: 'no' } })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^answer\.type/)]),
    )
    expect(bad({ ...valid, answer: { type: 'noul', noul: 1.5 } })).toEqual(
      expect.arrayContaining([expect.stringMatching(/^answer\.noul/)]),
    )
    expect(bad({ ...valid, state_hash: '' })).toEqual(expect.arrayContaining([expect.stringMatching(/^state_hash/)]))
  })
})
