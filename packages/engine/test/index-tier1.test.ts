import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { buildGraph, whyFile } from '../src/core/graph'
import {
  guardsForSubject,
  neighbouringInitiatives,
  readTier1,
  refreshTier1,
  touchersOfPath,
} from '../src/core/index-tier1'
import { refreshTier0 } from '../src/core/index-tier0'
import { appendEvent, serializeEvent } from '../src/core/log'

/**
 * record-index 3.1 — Tier 1, the graph materialized and keyed.
 *
 * The binding property is the same one Tier 0 lives by: whatever the index
 * says, folding the logs must say. Here the comparator is buildGraph itself —
 * whyFile for the derived half, the fold's own guard bookkeeping for the
 * declared half — because those are the surfaces whose answers users already
 * see, and an index that disagreed with them would be a second truth.
 *
 * The adversarial half is where the value is. An incremental pass is only
 * sound while the log is an append-only, id-ordered prefix of itself, and a
 * real record breaks both: a `correction` withdraws an event that was already
 * applied (24 of them in this repo's own logs), and `merge=union` interleaves
 * two branches' lines out of ulid order. Each must land on the same answer a
 * cold build gives, or the index quietly reports work the record has taken
 * back.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A repo root (graph reads rootDir/.sofar; the index reads the .sofar dir). */
function repo(): { root: string; sofar: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-tier1-'))
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
  const made = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  return ts === undefined ? made : { ...made, ts }
}

function emit(sofar: string, slug: string, e: EventEnvelope): EventEnvelope {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  appendEvent(join(dir, 'events.jsonl'), e)
  return e
}

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

const start = (sofar: string, slug: string, session: string): EventEnvelope =>
  emit(sofar, slug, event(slug, session, 'session_started', { tool: 'claude-code' }))

describe('3.1 Tier 1 — derived relevance (path → who touched it)', () => {
  it('matches whyFile across initiatives, session for session', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    start(sofar, 'beta', 'B')
    touch(sofar, 'alpha', 'A', '/repo/src/core/fold.ts', '2026-01-01T10:00:00.000Z')
    touch(sofar, 'alpha', 'A', '/repo/src/core/fold.ts', '2026-01-01T10:05:00.000Z')
    touch(sofar, 'beta', 'B', '/repo/src/core/fold.ts', '2026-01-01T11:00:00.000Z')
    // The same session working from a second initiative — the join no
    // per-initiative fold can make.
    touch(sofar, 'beta', 'A', '/repo/src/core/fold.ts', '2026-01-01T12:00:00.000Z')

    const indexed = touchersOfPath(refreshTier1(sofar), '/repo/src/core/fold.ts')
    const folded = whyFile(buildGraph(root), '/repo/src/core/fold.ts')

    expect(indexed.sessions).toEqual(folded.sessions)
    expect(indexed.omitted).toBe(folded.omitted.sessions)
    expect(indexed.matched_paths).toEqual(folded.matched_paths)
    expect(indexed.sessions.find((s) => s.session_id === 'A')).toMatchObject({
      initiatives: ['alpha', 'beta'],
      touches: 3,
      ts: '2026-01-01T12:00:00.000Z',
    })
  })

  it('resolves a bare filename to every recorded path, like resolveFileNodes', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', '/Users/x/harness/src/cli/doctor.ts')
    touch(sofar, 'alpha', 'A', '/Users/x/sofar/src/cli/doctor.ts')
    touch(sofar, 'alpha', 'A', '/Users/x/sofar/src/cli/other.ts')

    const indexed = touchersOfPath(refreshTier1(sofar), 'src/cli/doctor.ts')
    const folded = whyFile(buildGraph(root), 'src/cli/doctor.ts')
    expect(indexed.matched_paths).toEqual(folded.matched_paths)
    expect(indexed.matched_paths).toHaveLength(2)
  })

  it('reports a path no log ever touched as not found', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')

    const indexed = touchersOfPath(refreshTier1(sofar), 'src/never.ts')
    const folded = whyFile(buildGraph(root), 'src/never.ts')
    expect(indexed.found).toBe(folded.found)
    expect(indexed.sessions).toEqual([])
  })

  it('drops cli-sourced touches, exactly as the touched edge does', () => {
    const { root, sofar } = repo()
    emit(sofar, 'alpha', event('alpha', 'cli', 'file_touched', { path: 'src/a.ts', op: 'edit' }))
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')

    const indexed = touchersOfPath(refreshTier1(sofar), 'src/a.ts')
    expect(indexed.sessions.map((s) => s.session_id)).toEqual(['A'])
    expect(indexed.sessions).toEqual(whyFile(buildGraph(root), 'src/a.ts').sessions)
  })

  it('names the other initiatives working in the same files', () => {
    const { sofar } = repo()
    for (const [slug, session] of [['alpha', 'A'], ['beta', 'B'], ['gamma', 'C']] as const) {
      start(sofar, slug, session)
      touch(sofar, slug, session, 'src/shared.ts')
    }
    touch(sofar, 'beta', 'B', 'src/only-beta.ts')

    const neighbours = neighbouringInitiatives(refreshTier1(sofar), ['src/shared.ts'], 'alpha')
    expect(neighbours).toEqual([
      { initiative: 'beta', paths: 1 },
      { initiative: 'gamma', paths: 1 },
    ])
  })
})

describe('3.1 Tier 1 — declared relevance (which decision guards this)', () => {
  it('finds a guard logged in ANOTHER initiative, which the fold structurally cannot', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    decide(sofar, 'alpha', 'A', {
      rule: 'Schema lives ONLY in packages/schema/src.',
      guard: 'path:packages/schema/**',
    })
    start(sofar, 'beta', 'B')

    const index = refreshTier1(sofar)
    const hits = guardsForSubject(index, 'path', '/repo/packages/schema/src/events.ts')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      initiative: 'alpha',
      ordinal: 1,
      rule: 'Schema lives ONLY in packages/schema/src.',
    })

    // The fold's own guard check sees nothing here: beta's log holds no such
    // decision, which is the gap this tier exists to close.
    const betaState = foldLog(join(sofar, 'initiatives', 'beta', 'events.jsonl')).state
    expect(betaState.guard_violations).toEqual([])
  })

  it('carries the D<n> handle the fold hands out, counting unguarded decisions too', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    decide(sofar, 'alpha', 'A') // D1 — no guard
    decide(sofar, 'alpha', 'A', { rule: 'Never touch dist.', guard: 'path:dist/**' }) // D2
    // The fold's own ordinal for the same decision, from a crossing.
    emit(sofar, 'alpha', event('alpha', 'A', 'file_touched', { path: '/repo/dist/cli.js', op: 'edit' }))

    const index = refreshTier1(sofar)
    const state = foldLog(join(sofar, 'initiatives', 'alpha', 'events.jsonl')).state
    expect(index.guards[0]!.ordinal).toBe(2)
    expect(state.guard_violations[0]!.decision).toBe(index.guards[0]!.ordinal)
    expect(state.guard_violations[0]!.rule).toBe(index.guards[0]!.rule)
  })

  it('honours exemptions and domains', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    decide(sofar, 'alpha', 'A', {
      rule: 'TypeScript everywhere except schema.',
      guard: 'path:**/*.ts,!packages/schema/src/**',
    })
    decide(sofar, 'alpha', 'A', { rule: 'Never publish by hand.', guard: 'cmd:*npm publish*' })

    const index = refreshTier1(sofar)
    expect(guardsForSubject(index, 'path', '/repo/packages/engine/src/a.ts')).toHaveLength(1)
    expect(guardsForSubject(index, 'path', '/repo/packages/schema/src/a.ts')).toEqual([])
    expect(guardsForSubject(index, 'cmd', 'npm publish -w sofar.sh')).toHaveLength(1)
    expect(guardsForSubject(index, 'path', 'npm publish -w sofar.sh')).toEqual([])
  })

  it('ignores a decision whose rule or guard is missing, like the fold', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    decide(sofar, 'alpha', 'A', { guard: 'path:**/*.ts' }) // guard without a rule
    expect(refreshTier1(sofar).guards).toEqual([])
  })
})

describe('3.1 the incremental pass stays equal to a cold build', () => {
  /** The same answer, derived from nothing. */
  function cold(sofar: string): ReturnType<typeof refreshTier1> {
    rmSync(join(sofar, '.index'), { recursive: true, force: true })
    return refreshTier1(sofar)
  }

  function sameAsCold(sofar: string, path: string): void {
    const incremental = touchersOfPath(refreshTier1(sofar), path)
    const guards = refreshTier1(sofar).guards
    const rebuilt = cold(sofar)
    expect(incremental).toEqual(touchersOfPath(rebuilt, path))
    expect(guards).toEqual(rebuilt.guards)
  }

  it('after each append', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    refreshTier1(sofar)
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    sameAsCold(sofar, 'src/a.ts')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    decide(sofar, 'alpha', 'A', { rule: 'r', guard: 'path:src/**' })
    sameAsCold(sofar, 'src/a.ts')
  })

  it('when a correction voids an event a previous pass already applied', () => {
    // The retroactive case: the index cannot un-apply, so it must rebuild.
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const touched = touch(sofar, 'alpha', 'A', 'src/withdrawn.ts')
    expect(touchersOfPath(refreshTier1(sofar), 'src/withdrawn.ts').found).toBe(true)

    emit(sofar, 'alpha', event('alpha', 'A', 'correction', { ref: touched.id, reason: 'wrong path logged' }))

    const after = touchersOfPath(refreshTier1(sofar), 'src/withdrawn.ts')
    expect(after.found).toBe(false)
    expect(after.sessions).toEqual(whyFile(buildGraph(root), 'src/withdrawn.ts').sessions)
    sameAsCold(sofar, 'src/withdrawn.ts')
  })

  it('when a correction voids a decision, renumbering nothing', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    const first = decide(sofar, 'alpha', 'A', { rule: 'withdrawn', guard: 'path:src/**' })
    decide(sofar, 'alpha', 'A', { rule: 'kept', guard: 'path:src/**' })
    refreshTier1(sofar)

    emit(sofar, 'alpha', event('alpha', 'A', 'correction', { ref: first.id, reason: 'logged in error' }))

    const guards = refreshTier1(sofar).guards
    const state = foldLog(join(sofar, 'initiatives', 'alpha', 'events.jsonl')).state
    expect(guards.map((g) => g.rule)).toEqual(['kept'])
    // The fold renumbers too — the voided decision is not in state.decisions.
    expect(state.decisions).toHaveLength(1)
    expect(guards[0]!.ordinal).toBe(1)
  })

  it('when a merge interleaves two branches out of ulid order', () => {
    // `merge=union` on events.jsonl is this project's own merge strategy, and
    // it appends B's block after A's however the ids compare. The fold replays
    // in ulid order, so an incremental pass that trusted file order would
    // order the record differently from every other surface.
    const { sofar } = repo()
    const dir = join(sofar, 'initiatives', 'alpha')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'events.jsonl')

    const early = event('alpha', 'A', 'session_started', { tool: 'claude-code' })
    const late = event('alpha', 'A', 'file_touched', { path: 'src/a.ts', op: 'edit' })
    writeFileSync(log, `${[early, late].map(serializeEvent).join('\n')}\n`)
    expect(touchersOfPath(refreshTier1(sofar), 'src/a.ts').found).toBe(true)

    // A DECISION whose id sorts before everything already consumed. Ordinals
    // are the order-sensitive part: the fold replays in ulid order, so this
    // one is D1 and pushes the rest down. Appending it as the newest would
    // hand out `D<n>` handles that resolve to different decisions than every
    // other surface shows.
    decide(sofar, 'alpha', 'A', { rule: 'second', guard: 'path:src/**' })
    refreshTier1(sofar)
    const backdated: EventEnvelope = {
      ...event('alpha', 'A', 'decision_logged', {
        chose: 'x',
        over: 'y',
        because: 'z',
        rule: 'first',
        guard: 'path:src/**',
      }),
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    }
    writeFileSync(log, `${readFileSync(log, 'utf8')}${serializeEvent(backdated)}\n`)

    const merged = refreshTier1(sofar)
    const state = foldLog(log).state
    expect(merged.guards.map((g) => [g.ordinal, g.rule])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ])
    expect(state.decisions.map((d) => d.rule)).toEqual(['first', 'second'])
    sameAsCold(sofar, 'src/a.ts')
  })

  it('remembers a void whose target only arrives later', () => {
    // Import brings events in whatever order the exporter had them, so a
    // correction can be consumed before the event it withdraws exists here.
    // The void has to outlive the pass that saw it, or the target lands as
    // live work the moment it arrives.
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const targetId = '01ZZZZZZZZZZZZZZZZZZZZZZZZ' // sorts after everything already consumed
    emit(sofar, 'alpha', event('alpha', 'A', 'correction', { ref: targetId, reason: 'withdrawn upstream' }))
    refreshTier1(sofar)

    const log = join(sofar, 'initiatives', 'alpha', 'events.jsonl')
    const late: EventEnvelope = {
      ...event('alpha', 'A', 'file_touched', { path: 'src/late.ts', op: 'edit' }),
      id: targetId,
    }
    writeFileSync(log, `${readFileSync(log, 'utf8')}${serializeEvent(late)}\n`)

    expect(touchersOfPath(refreshTier1(sofar), 'src/late.ts').found).toBe(false)
    expect(whyFile(buildGraph(root), 'src/late.ts').found).toBe(false)
  })

  it('skips an event the fold skips for an invalid payload', () => {
    const { root, sofar } = repo()
    start(sofar, 'alpha', 'A')
    const dir = join(sofar, 'initiatives', 'alpha')
    const broken = { ...event('alpha', 'A', 'file_touched', { path: 'src/a.ts', op: 'edit' }), payload: {} }
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${readFileSync(join(dir, 'events.jsonl'), 'utf8')}${JSON.stringify(broken)}\n`,
    )

    expect(touchersOfPath(refreshTier1(sofar), 'src/a.ts').found).toBe(false)
    expect(whyFile(buildGraph(root), 'src/a.ts').found).toBe(false)
  })

  it('keeps its own cursors, so no tier consumes another tier\'s events', () => {
    // Tier 0 refreshing first must not advance Tier 1 past the same events.
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')

    refreshTier0(sofar)
    refreshTier0(sofar)
    expect(touchersOfPath(refreshTier1(sofar), 'src/a.ts').found).toBe(true)
    expect(refreshTier0(sofar).map((s) => s.session)).toEqual(['A'])
  })

  it('reads back from disk without a refresh, and cold-starts when absent', () => {
    const { sofar } = repo()
    start(sofar, 'alpha', 'A')
    touch(sofar, 'alpha', 'A', 'src/a.ts')
    refreshTier1(sofar)

    expect(touchersOfPath(readTier1(sofar)!, 'src/a.ts').found).toBe(true)
    rmSync(join(sofar, '.index'), { recursive: true, force: true })
    expect(readTier1(sofar)).toBeNull()
    expect(touchersOfPath(refreshTier1(sofar), 'src/a.ts').found).toBe(true)
  })
})
