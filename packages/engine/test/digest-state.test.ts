import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { digestState } from '../src/projections/templates/digest-state'
import { renderStatus, type StatusOptions } from '../src/projections/templates/status'
import { initiativeText, shapes, type CorpusSpec } from './conformance/perf/corpus'

/**
 * rust-core 4.4 (session-start B): renderStatus(digestState(s), o) must equal
 * renderStatus(s, o) byte for byte. A template change that reads more of the
 * state goes red here until digest-state.ts widens its cut.
 */

const REPO = join(__dirname, '..', '..', '..')

function realStates(): Array<[string, InitiativeState]> {
  const dir = join(REPO, '.sofar', 'initiatives')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((slug) => existsSync(join(dir, slug, 'events.jsonl')))
    .map((slug) => [slug, foldLines(readFileSync(join(dir, slug, 'events.jsonl'), 'utf8').split('\n'), slug).state])
}

/** team100-shaped records at a size a unit test can fold: many writers, open and unwritten sessions. */
function syntheticStates(): Array<[string, InitiativeState]> {
  const spec: CorpusSpec = { name: 'digest', initiatives: 3, writers: 24, events: 12_000, humanShare: 0.3, tail: 1, seed: 44 }
  return shapes(spec).map((shape, i) => {
    const t = initiativeText(spec, shape, i)
    return [`synthetic:${t.slug}`, foldLines(t.text.split('\n'), t.slug).state]
  })
}

const git = {
  branch: 'main',
  head: 'abc1234',
  headFull: 'abc1234'.padEnd(40, '0'),
  upstream: 'abc1234',
  upstreamFull: 'abc1234'.padEnd(40, '0'),
  synced: true,
}

/** Options that exercise every slot and the cap/yield arithmetic. */
function optionsMatrix(): Array<[string, StatusOptions]> {
  const notices = ['Recent work elsewhere: x (2h ago)', 'Cold resume: last event 3 days ago']
  const neighbours = [{ initiative: 'other', paths: 3, decisions: 2 }]
  const repoRules = [{ initiative: 'other', ordinal: 1, ts: '2026-09-01T00:00:00.000Z', rule: 'Never do the thing.' }]
  return [
    ['none', {}],
    ['session', { sessionId: 's-1' }],
    ['everything', { sessionId: 's-1', git, neighbours, repoRules, notices, repoMemory: '# Repo memory\n\n- a fact\n' }],
    ['huge repo memory', { repoMemory: `# Repo memory\n\n${'- a long operational fact line\n'.repeat(400)}`, notices }],
    ['activity off', { activity: false, sessionId: 's-1' }],
    ['lane', { lane: true, sessionId: 's-1' }],
    ['lane everything', { lane: true, git, notices, repoMemory: '- m\n' }],
  ]
}

describe('digestState renders exactly what the full state renders (rust-core 4.4)', () => {
  const states = [...realStates(), ...syntheticStates()]

  it('has states to check', () => {
    expect(states.length).toBeGreaterThan(5)
  })

  for (const [name, state] of states) {
    it(name, () => {
      const cut = digestState(state)
      // The cache stores JSON: the round trip is what a hit renders from.
      const cached = JSON.parse(JSON.stringify(cut)) as InitiativeState
      for (const [label, options] of optionsMatrix()) {
        const want = renderStatus(state, options)
        expect(renderStatus(cut, options), `${name} / ${label}`).toBe(want)
        expect(renderStatus(cached, options), `${name} / ${label} (JSON)`).toBe(want)
      }
    })
  }

  it('actually cuts: a synthetic team record shrinks', () => {
    const [, state] = syntheticStates()[0]!
    const full = JSON.stringify(state).length
    const cut = JSON.stringify(digestState(state)).length
    expect(cut).toBeLessThan(full / 2)
  })

  it('keeps the edge cases a reader can reach', () => {
    type Session = InitiativeState['sessions'][number]
    const s = (id: string, extra: Partial<Session>): Session => ({
      id,
      tool: 't',
      started: `2026-09-2${id.length}T00:00:00.000Z`,
      unwritten: 0,
      ...extra,
    })
    const act = (f: string) => ({ files: [f], commands: 1, task_changes: [] })
    const base = foldLines([], 'edge').state
    const cases: InitiativeState[] = [
      // open sessions with overlapping files (conflict lines), a written-back one
      { ...base, sessions: [s('a', { activity: act('x') }), s('bb', { activity: act('x') }), s('ccc', { ended: '2026-09-24T00:00:00.000Z', summary: 'done', next_action: 'n1' })] },
      // an unwritten session newer than the last write-back (derived resume line)
      { ...base, sessions: [s('a', { ended: '2026-09-21T01:00:00.000Z', summary: 'old', next_action: 'n' }), s('bb', { ended: '2026-09-22T01:00:00.000Z', activity: act('y') })] },
      // overlapping write-backs with differing next actions (parallel lines)
      { ...base, sessions: [s('a', { ended: '2026-09-29T00:00:00.000Z', summary: 'x', next_action: 'one' }), s('bb', { ended: '2026-09-29T00:00:00.000Z', summary: 'y', next_action: 'two' })] },
    ]
    for (const [i, state] of cases.entries()) {
      for (const [label, options] of optionsMatrix()) {
        expect(renderStatus(digestState(state), options), `case ${i} / ${label}`).toBe(renderStatus(state, options))
      }
    }
  })
})
