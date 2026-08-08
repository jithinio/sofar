import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { foldLog, openSessionFiles } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { readTier0, refreshTier0 } from '../src/core/index-tier0'
import { initiativeSlugs } from '../src/core/listing'

/**
 * Task 2.1 — Tier 0, the hot tier.
 *
 * The binding test is EQUIVALENCE: whatever Tier 0 reports must be what
 * folding the logs reports, on every fixture and after every incremental step.
 * The index is allowed to be faster; it is never allowed to be different. That
 * includes inheriting the fold's limits — first-touch order, the 20-file cap,
 * sessions only existing once registered — because being "better" here would
 * be a silent divergence from every other surface.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function sofarDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-tier0-'))
  roots.push(root)
  return root
}

function emit(
  dir: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown> = {},
): void {
  const initiativeDir = join(dir, 'initiatives', slug)
  mkdirSync(initiativeDir, { recursive: true })
  const event = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(initiativeDir, 'events.jsonl'), event)
}

const start = (d: string, s: string, sess: string): void => emit(d, s, sess, 'session_started', { tool: 'claude-code' })
const touch = (d: string, s: string, sess: string, path: string): void =>
  emit(d, s, sess, 'file_touched', { path, op: 'edit' })
const end = (d: string, s: string, sess: string): void =>
  emit(d, s, sess, 'session_ended', { session_id: sess, summary: 'x', next_action: 'y' })

/** The same answer, derived the slow honest way. */
function fromLogs(dir: string): { session: string; initiative: string; files: string[] }[] {
  const out: { session: string; initiative: string; files: string[] }[] = []
  for (const slug of initiativeSlugs(dir)) {
    const state = foldLog(join(dir, 'initiatives', slug, 'events.jsonl')).state
    const bySession = new Map<string, string[]>()
    for (const { session, file } of openSessionFiles(state)) {
      const files = bySession.get(session) ?? []
      files.push(file)
      bySession.set(session, files)
    }
    for (const session of state.sessions) {
      if (session.ended !== undefined) continue
      out.push({ session: session.id, initiative: slug, files: bySession.get(session.id) ?? [] })
    }
  }
  out.sort((a, b) =>
    a.initiative === b.initiative ? a.session.localeCompare(b.session) : a.initiative.localeCompare(b.initiative),
  )
  return out
}

describe('Tier 0', () => {
  it('reports open sessions and the files they hold', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    touch(dir, 'alpha', 'A', 'src/env.ts')
    start(dir, 'beta', 'B')
    touch(dir, 'beta', 'B', 'src/env.ts')

    expect(refreshTier0(dir)).toEqual([
      { session: 'A', initiative: 'alpha', files: ['src/env.ts'] },
      { session: 'B', initiative: 'beta', files: ['src/env.ts'] },
    ])
  })

  it('drops a session the moment it wraps', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    touch(dir, 'alpha', 'A', 'src/env.ts')
    expect(refreshTier0(dir)).toHaveLength(1)

    end(dir, 'alpha', 'A')
    expect(refreshTier0(dir)).toEqual([])
  })

  it('equals the from-logs answer after every incremental step', () => {
    // The property the whole index rests on, checked at each append rather
    // than only at the end — a divergence that heals itself would still have
    // been served to somebody.
    const dir = sofarDir()
    const steps: (() => void)[] = [
      () => start(dir, 'alpha', 'A'),
      () => touch(dir, 'alpha', 'A', 'src/env.ts'),
      () => start(dir, 'beta', 'B'),
      () => touch(dir, 'beta', 'B', 'src/env.ts'),
      () => touch(dir, 'beta', 'B', 'src/other.ts'),
      () => start(dir, 'beta', 'C'),
      () => touch(dir, 'beta', 'C', 'src/env.ts'),
      () => end(dir, 'beta', 'B'),
      () => touch(dir, 'alpha', 'A', 'src/third.ts'),
      () => end(dir, 'alpha', 'A'),
    ]
    for (const step of steps) {
      step()
      expect(refreshTier0(dir)).toEqual(fromLogs(dir))
    }
  })

  it('inherits the fold cap rather than storing more', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    for (let i = 0; i < 30; i++) touch(dir, 'alpha', 'A', `src/f${i}.ts`)

    const tier0 = refreshTier0(dir)
    // 20 real paths; the fold's own list adds a "+N more" sentinel that the
    // conflict detector skips, so the indexed list holds the 20 real ones.
    expect(tier0[0]!.files).toHaveLength(20)
    expect(tier0[0]!.files[0]).toBe('src/f0.ts') // FIRST-touch order, not most-recent
    expect(fromLogs(dir)[0]!.files.filter((f) => !f.startsWith('+'))).toEqual(tier0[0]!.files)
  })

  it('dedupes a re-touched path without reordering it', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    touch(dir, 'alpha', 'A', 'a.ts')
    touch(dir, 'alpha', 'A', 'b.ts')
    touch(dir, 'alpha', 'A', 'a.ts')

    expect(refreshTier0(dir)[0]!.files).toEqual(['a.ts', 'b.ts'])
  })

  it('ignores a session that was never registered here', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    touch(dir, 'alpha', 'GHOST', 'src/env.ts') // no session_started for GHOST

    const tier0 = refreshTier0(dir)
    expect(tier0.map((s) => s.session)).toEqual(['A'])
  })

  it('rebuilds rather than merging when a log is rewritten', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    touch(dir, 'alpha', 'A', 'src/env.ts')
    expect(refreshTier0(dir)).toHaveLength(1)

    // A restore or import: same file, different history. Merging into the
    // stale entry is the one way this could silently diverge.
    const log = join(dir, 'initiatives', 'alpha', 'events.jsonl')
    writeFileSync(log, '')
    start(dir, 'alpha', 'Z')
    touch(dir, 'alpha', 'Z', 'src/other.ts')

    expect(refreshTier0(dir)).toEqual([{ session: 'Z', initiative: 'alpha', files: ['src/other.ts'] }])
  })

  it('forgets an initiative that was deleted', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    start(dir, 'beta', 'B')
    expect(refreshTier0(dir)).toHaveLength(2)

    rmSync(join(dir, 'initiatives', 'beta'), { recursive: true, force: true })
    expect(refreshTier0(dir).map((s) => s.initiative)).toEqual(['alpha'])
  })

  it('persists, so a later read needs no logs at all', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    touch(dir, 'alpha', 'A', 'src/env.ts')
    refreshTier0(dir)

    expect(readTier0(dir)).toEqual([{ session: 'A', initiative: 'alpha', files: ['src/env.ts'] }])
  })

  it('reports nothing rather than failing on an absent record', () => {
    expect(readTier0('/nonexistent/sofar-tier0')).toBeNull()
    expect(refreshTier0('/nonexistent/sofar-tier0')).toEqual([])
  })

  it('costs nothing when no log has grown', () => {
    const dir = sofarDir()
    start(dir, 'alpha', 'A')
    touch(dir, 'alpha', 'A', 'src/env.ts')
    const first = refreshTier0(dir)
    // Idempotent: re-running with no appends must not double, drop, or reorder.
    expect(refreshTier0(dir)).toEqual(first)
    expect(refreshTier0(dir)).toEqual(first)
  })
})
