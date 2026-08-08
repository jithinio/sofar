import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { buildGraph, whyFile } from '../src/core/graph'
import {
  findFrom,
  reachFrom,
  refreshReach,
  resolveSeed,
  REACH_MAX_HOPS,
  type ReachHit,
  type ReachResult,
} from '../src/core/index-reach'
import { appendEvent } from '../src/core/log'
import { runFind } from '../src/cli/find'
import { callTool, connectServer, makeRepoFixture } from './helpers/mcp'

/**
 * record-index 3.4 — `sofar find`: traversal from a seed, with citations.
 *
 * Two properties carry the task, and the tests are built around them.
 *
 * EVERY RESULT CITES THE EVENT THAT PRODUCED ITS EDGE. Not a plausible id — the
 * event is looked up in the log here and checked to be of the type and about
 * the subject the edge claims. That is what makes this retrieval auditable
 * rather than persuasive (D1's whole argument against embeddings), so it is
 * tested as a property over every hit rather than on a sample.
 *
 * THE INDEXED ANSWER EQUALS THE FROM-LOGS ONE. buildGraph is the comparator, as
 * it was for 3.1: its `cites` edges and whyFile's touchers are the same facts
 * this index keys, and a disagreement would make the index a second truth.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function repo(): { root: string; sofar: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-reach-'))
  roots.push(root)
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  return { root, sofar }
}

function event(
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts?: string,
): EventEnvelope {
  const made = makeEvent({
    initiative: slug,
    session,
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
  return ts === undefined ? made : { ...made, ts }
}

function emit(sofar: string, slug: string, e: EventEnvelope): EventEnvelope {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  appendEvent(join(dir, 'events.jsonl'), e)
  return e
}

const start = (sofar: string, slug: string, session: string): EventEnvelope =>
  emit(sofar, slug, event(slug, session, 'session_started', { tool: 'claude-code' }))

const touch = (sofar: string, slug: string, session: string, path: string, ts?: string): EventEnvelope =>
  emit(sofar, slug, event(slug, session, 'file_touched', { path, op: 'edit' }, ts))

const decide = (
  sofar: string,
  slug: string,
  session: string,
  extra: Record<string, unknown> = {},
): EventEnvelope =>
  emit(
    sofar,
    slug,
    event(slug, session, 'decision_logged', {
      chose: 'the indexed path',
      over: 'the swept one',
      because: 'cost',
      ...extra,
    }),
  )

const note = (sofar: string, slug: string, session: string, text: string): EventEnvelope =>
  emit(sofar, slug, event(slug, session, 'note_added', { text }))

/** Every event in the record, by id — the citation check reads from here. */
function eventsById(sofar: string): Map<string, EventEnvelope> {
  const byId = new Map<string, EventEnvelope>()
  const dir = join(sofar, 'initiatives')
  for (const slug of readFileSafe(dir)) {
    const log = join(dir, slug, 'events.jsonl')
    let raw: string
    try {
      raw = readFileSync(log, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue
      const e = JSON.parse(line) as EventEnvelope
      byId.set(e.id, e)
    }
  }
  return byId
}

function readFileSafe(dir: string): string[] {
  try {
    return require('node:fs').readdirSync(dir) as string[]
  } catch {
    return []
  }
}

const allHits = (result: ReachResult): ReachHit[] => result.groups.flatMap((g) => g.hits)
const kind = (result: ReachResult, k: ReachHit['kind']): ReachHit[] =>
  result.groups.find((g) => g.kind === k)?.hits ?? []

function find(sofar: string, query: string, hops?: number): ReachResult {
  const index = refreshReach(sofar)
  return reachFrom(index, resolveSeed(index, query), hops)
}

describe('3.4 traversal — every result cites the event behind its edge', () => {
  it('names a real event of the right type for every hit', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    touch(sofar, 'alpha', 'A', '/repo/src/core/fold.ts')
    touch(sofar, 'beta', 'B', '/repo/src/core/fold.ts')
    decide(sofar, 'alpha', 'A')
    note(sofar, 'beta', 'B', 'the fold replays in ulid order')

    const result = find(sofar, '/repo/src/core/fold.ts')
    const byId = eventsById(sofar)
    expect(allHits(result).length).toBeGreaterThan(4)

    for (const hit of allHits(result)) {
      const cited = byId.get(hit.via.event_id)
      expect(cited, `${hit.id} cites ${hit.via.event_id}`).toBeDefined()
      // The cited event must be the KIND of event the edge claims produced it.
      const expected = {
        touched: 'file_touched',
        decided: 'decision_logged',
        noted: 'note_added',
        cites: 'decision_logged',
        cited_by: 'decision_logged',
      }[hit.via.kind]
      expect(cited!.type).toBe(expected)
    }
  })

  it('cites the most recent touch, and counts every one of them', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts', '2026-01-01T10:00:00.000Z')
    const latest = touch(sofar, 'alpha', 'A', 'src/a.ts', '2026-01-01T12:00:00.000Z')

    const sessions = kind(find(sofar, 'src/a.ts'), 'session')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.via.event_id).toBe(latest.id)
    expect(sessions[0]!.touches).toBe(2)
  })

  it('cites the decision itself when reporting the record that holds it', () => {
    // An initiative is reported because a member was reached; citing the member's
    // reaching edge would name an event in ANOTHER log, which is no evidence at
    // all that this record holds it.
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const first = decide(sofar, 'alpha', 'A')
    decide(sofar, 'beta', 'B', { because: 'as alpha D1 settled' })

    const held = kind(find(sofar, 'alpha D1', 1), 'initiative')
    expect(held.map((h) => h.label)).toContain('alpha')
    expect(held.find((h) => h.label === 'alpha')!.via.event_id).toBe(first.id)
  })
})

describe('3.4 traversal — hop budget and shape', () => {
  it('reaches sessions at one hop and their decisions at two', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    decide(sofar, 'alpha', 'A')

    const one = find(sofar, 'src/a.ts', 1)
    expect(kind(one, 'session')).toHaveLength(1)
    expect(kind(one, 'decision')).toHaveLength(0)

    const two = find(sofar, 'src/a.ts', 2)
    expect(kind(two, 'decision')).toHaveLength(1)
    expect(kind(two, 'decision')[0]!.hops).toBe(2)
  })

  it('clamps the budget rather than trusting it', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    expect(find(sofar, 'src/a.ts', 99).hops).toBe(REACH_MAX_HOPS)
    expect(find(sofar, 'src/a.ts', 0).hops).toBe(2)
    expect(find(sofar, 'src/a.ts', -3).hops).toBe(1)
  })

  it('never travels THROUGH an initiative — a hub is a destination, not a corridor', () => {
    // alpha and beta share nothing but the record they live in. If initiative
    // nodes were traversable, beta's decision would be two hops from alpha's
    // file and every record would be adjacent to every other.
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    start(sofar, 'alpha', 'Z')
    decide(sofar, 'alpha', 'Z')

    const reached = find(sofar, 'src/a.ts', REACH_MAX_HOPS)
    expect(kind(reached, 'initiative').map((h) => h.label)).toEqual(['alpha'])
    expect(kind(reached, 'decision')).toEqual([])
  })

  it('expands an initiative SEED to what it holds', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    decide(sofar, 'alpha', 'A')
    note(sofar, 'alpha', 'A', 'an operational fact')

    const held = find(sofar, 'alpha', 1)
    expect(held.seed.kind).toBe('initiative')
    expect(kind(held, 'decision')).toHaveLength(1)
    expect(kind(held, 'note')).toHaveLength(1)
    expect(kind(held, 'file').map((h) => h.label)).toEqual(['src/a.ts'])
    expect(kind(held, 'session').map((h) => h.label)).toEqual(['A'])
    for (const hit of allHits(held)) expect(hit.via.event_id).not.toBe('')
  })

  it('dates a hit by when the THING happened, not when the edge did', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const old = decide(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    decide(sofar, 'beta', 'B', { because: 'settled by alpha D1' })

    const cited = kind(find(sofar, 'beta D1', 1), 'decision')
    expect(cited).toHaveLength(1)
    // Reached because a LATER decision cited it; the row is dated by its own event.
    expect(cited[0]!.ts).toBe(old.ts)
    expect(cited[0]!.via.kind).toBe('cites')
  })
})

describe('3.4 citations — the same edges buildGraph derives', () => {
  it('links a cross-initiative citation both ways, and never to the future', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const target = decide(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    const citing = decide(sofar, 'beta', 'B', { because: 'per alpha D1, the index is derived' })
    // A handle naming a decision that does not exist resolves to nothing.
    decide(sofar, 'beta', 'B', { because: 'per alpha D9' })

    const fromTarget = kind(find(sofar, 'alpha D1', 1), 'decision')
    expect(fromTarget.map((h) => h.id)).toEqual([`decision:${citing.id}`])
    expect(fromTarget[0]!.via).toMatchObject({ kind: 'cited_by', event_id: citing.id })

    const fromCiting = kind(find(sofar, 'beta D1', 1), 'decision')
    expect(fromCiting.map((h) => h.id)).toEqual([`decision:${target.id}`])
    expect(fromCiting[0]!.via).toMatchObject({ kind: 'cites', event_id: citing.id })

    // Same set of decision→decision citations the record graph derives.
    const graphCites = buildGraph(root)
      .edges.filter((e) => e.kind === 'cites' && e.to.startsWith('decision:'))
      .map((e) => `${e.from}->${e.to}`)
      .sort()
    const index = refreshReach(sofar)
    const indexCites: string[] = []
    for (const [from, edges] of index.edges) {
      for (const e of edges) if (e.kind === 'cites') indexCites.push(`${from}->${e.to}`)
    }
    expect(indexCites.sort()).toEqual(graphCites)
  })

  it('binds qualifiers against the slugs that exist NOW, not when it was indexed', () => {
    // A word qualifies only if it names an initiative, and `sofar new` changes
    // that answer. Resolving at index time would freeze the old reading, and
    // the index would disagree with the graph forever after.
    const { sofar } = repo()
    start(sofar, 'beta', 'B')
    decide(sofar, 'beta', 'B') // beta D1 — the home-bound reading of a bare "D1"
    const citing = decide(sofar, 'beta', 'B', { because: 'gamma D1 said so' })
    refreshReach(sofar)

    // "gamma" is not a slug yet, so the handle stays home-bound to beta.
    expect(kind(find(sofar, 'beta D1', 1), 'decision').map((h) => h.id)).toEqual([
      `decision:${citing.id}`,
    ])

    // gamma arrives, holding a decision older than the citation (an import, or
    // a merge) — nothing cites the future, so an equally-late one would not
    // resolve and would prove nothing about binding.
    start(sofar, 'gamma', 'C')
    const gamma = emit(sofar, 'gamma', {
      ...event('gamma', 'C', 'decision_logged', { chose: 'x', over: 'y', because: 'z' }),
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    })

    expect(kind(find(sofar, 'gamma D1', 1), 'decision').map((h) => h.id)).toEqual([
      `decision:${citing.id}`,
    ])
    // …and beta D1 loses the citation it only ever had by default.
    expect(kind(find(sofar, 'beta D1', 1), 'decision')).toEqual([])
    expect(gamma.id).toBe('01AAAAAAAAAAAAAAAAAAAAAAAA')
  })
})

describe('3.4 seeds — literal, ordered, never a search', () => {
  it('resolves a path across every checkout that recorded it', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', '/Users/x/harness/src/cli/doctor.ts')
    touch(sofar, 'alpha', 'A', '/Users/x/sofar/src/cli/doctor.ts')
    touch(sofar, 'alpha', 'A', '/Users/x/sofar/src/cli/other.ts')

    const seed = resolveSeed(refreshReach(sofar), 'src/cli/doctor.ts')
    expect(seed.kind).toBe('file')
    expect(seed.ids).toEqual(
      whyFile(buildGraph(root), 'src/cli/doctor.ts').matched_paths.map((p) => `file:${p}`),
    )
  })

  it('accepts node ids, slugs, session ids and decision handles', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    const decision = decide(sofar, 'alpha', 'A')
    const index = refreshReach(sofar)

    expect(resolveSeed(index, 'file:src/a.ts')).toMatchObject({ kind: 'file' })
    expect(resolveSeed(index, 'session:A')).toMatchObject({ kind: 'session', ids: ['session:A'] })
    expect(resolveSeed(index, 'A')).toMatchObject({ kind: 'session' })
    expect(resolveSeed(index, 'alpha')).toMatchObject({ kind: 'initiative' })
    expect(resolveSeed(index, 'alpha D1').ids).toEqual([`decision:${decision.id}`])
    expect(resolveSeed(index, 'alpha#D1').ids).toEqual([`decision:${decision.id}`])
    expect(resolveSeed(index, 'D1', { initiative: 'alpha' }).ids).toEqual([`decision:${decision.id}`])
  })

  it('misses rather than guesses', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    const index = refreshReach(sofar)

    for (const query of ['', 'src/nope.ts', 'D1', 'alpha D9', 'session:nope', 'decision:01ZZZ']) {
      const seed = resolveSeed(index, query)
      expect(seed.kind, query).toBeNull()
      expect(reachFrom(index, seed).groups).toEqual([])
    }
  })
})

describe('3.4 the reach half stays equal to a cold build', () => {
  function cold(sofar: string): ReachResult {
    rmSync(join(sofar, '.index'), { recursive: true, force: true })
    return find(sofar, 'src/a.ts')
  }

  it('after appends, and after a correction withdraws a decision', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    const withdrawn = decide(sofar, 'alpha', 'A', { chose: 'withdrawn' })
    decide(sofar, 'alpha', 'A', { chose: 'kept' })
    expect(find(sofar, 'src/a.ts')).toEqual(cold(sofar))

    emit(sofar, 'alpha', event('alpha', 'A', 'correction', { ref: withdrawn.id, reason: 'logged in error' }))
    const after = find(sofar, 'src/a.ts')
    expect(kind(after, 'decision').map((h) => h.label)).toEqual(['kept'])
    // And the survivor is renumbered to D1, exactly as the fold renumbers it.
    expect(kind(after, 'decision')[0]!.ordinal).toBe(1)
    expect(after).toEqual(cold(sofar))
  })

  it('keeps its own cursor file, so asking a question moves nothing else', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    refreshReach(sofar)
    const dir = join(sofar, '.index')
    expect(readFileSafe(dir).sort()).toEqual(['.gitignore', 'meta-reach.json', 'reach.json'])
  })

  it('ignores cli-sourced touches, exactly as the touched edge does', () => {
    const { sofar } = repo()
    emit(sofar, 'alpha', event('alpha', 'cli', 'file_touched', { path: 'src/a.ts', op: 'edit' }))
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    expect(kind(find(sofar, 'src/a.ts'), 'session').map((h) => h.label)).toEqual(['A'])
  })
})

describe('3.4 `sofar find` — offered, never asserted', () => {
  it('says what the edge is, cites the event, and never claims relevance', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const touched = touch(sofar, 'alpha', 'A', 'src/a.ts')
    decide(sofar, 'alpha', 'A', { chose: 'the indexed path' })

    const out = runFind(root, 'src/a.ts', {}, { color: false, unicode: false, animate: false })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('offered as worth reading, never as a rule')
    expect(out.stdout).toContain(`event ${touched.id}`)
    expect(out.stdout).toContain('the indexed path')
    // Nothing on the surface may state that a decision is ABOUT the seed.
    expect(out.stdout).not.toMatch(/about this file|applies to|you must/i)
  })

  it('names the seed vocabulary when nothing denotes the query', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')

    const out = runFind(root, 'authentication', {}, { color: false, unicode: false, animate: false })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('nothing in the record denotes that seed')
    expect(out.stdout).toContain('never a search term')
  })

  it('rejects a hop budget that is not a whole number in range', () => {
    const { root } = repo()
    expect(runFind(root, 'src/a.ts', { hops: 0 }).exitCode).toBe(1)
    expect(runFind(root, 'src/a.ts', { hops: 1.5 }).exitCode).toBe(1)
  })

  it('refuses to run outside a record', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-noreach-'))
    roots.push(root)
    const out = runFind(root, 'src/a.ts')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('run `sofar init` first')
  })

  it('findFrom refreshes and answers in one call', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    expect(findFrom(sofar, 'src/a.ts', { hops: 1 }).reached).toBe(1)
  })
})

describe('3.4 sofar_find — the agent-facing surface', () => {
  it('answers over MCP, appends nothing, and rejects a budget out of range', async () => {
    const fixture = makeRepoFixture()
    roots.push(fixture.root)
    const sofar = join(fixture.root, '.sofar')
    start(sofar, fixture.slug, 'A')
    const touched = touch(sofar, fixture.slug, 'A', 'src/a.ts')
    decide(sofar, fixture.slug, 'A', { chose: 'the indexed path' })
    const before = readFileSync(fixture.eventsPath, 'utf8')

    const { client } = await connectServer(fixture.root)
    const { isError, body } = await callTool<ReachResult>(client, 'sofar_find', {
      seed: 'src/a.ts',
      hops: 2,
    })
    expect(isError).toBe(false)
    expect(body.seed.kind).toBe('file')
    const decisions = body.groups.find((g) => g.kind === 'decision')!.hits
    expect(decisions[0]!.label).toBe('the indexed path')
    expect(decisions[0]!.via.event_id).toBeDefined()
    expect(body.groups.find((g) => g.kind === 'session')!.hits[0]!.via.event_id).toBe(touched.id)
    // A read is a read: the log is byte-identical after it.
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe(before)

    const bad = await callTool(client, 'sofar_find', { seed: 'src/a.ts', hops: 9 })
    expect(bad.isError).toBe(true)
  })

  it('will not resolve a bare D<n> from the branch — a read says nothing rather than the wrong thing', async () => {
    const fixture = makeRepoFixture()
    roots.push(fixture.root)
    const sofar = join(fixture.root, '.sofar')
    start(sofar, fixture.slug, 'A')
    decide(sofar, fixture.slug, 'A')

    const { client } = await connectServer(fixture.root)
    const bare = await callTool<ReachResult>(client, 'sofar_find', { seed: 'D1' })
    expect(bare.body.seed.kind).toBeNull()
    const scoped = await callTool<ReachResult>(client, 'sofar_find', {
      seed: 'D1',
      initiative: fixture.slug,
    })
    expect(scoped.body.seed.kind).toBe('decision')
  })
})
