import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import {
  crossConflictsForSession,
  crossInitiativeFileConflicts,
  warmInitiatives,
} from '../src/core/cross-conflicts'

/**
 * Task 2.1 — concurrent-edit hazards across the initiative boundary.
 *
 * Two properties carry this: it must find what per-slug detection structurally
 * cannot, and it must not re-report what per-slug detection already found —
 * a same-initiative conflict surfacing here too would double every warning
 * the user already gets.
 *
 * The gate is tested as a COST control, never as a correctness one: ungated
 * and gated must agree on every initiative the gate admits, so the window can
 * only ever change which logs are read, never what counts as a conflict.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const NOW = Date.parse('2026-08-08T12:00:00.000Z')
const HOUR = 3_600_000
const WINDOW = 12 * HOUR

interface Touch {
  session: string
  file: string
  /** Hours before NOW. */
  hoursAgo?: number
  ended?: boolean
}

function record(spec: Record<string, Touch[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-cross-'))
  roots.push(root)
  for (const [slug, touches] of Object.entries(spec)) {
    const dir = join(root, 'initiatives', slug)
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'events.jsonl')
    const started = new Set<string>()

    const emit = (session: string, type: string, payload: Record<string, unknown>, ts: string): void => {
      const event = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
      appendEvent(log, { ...event, ts })
    }

    for (const t of touches) {
      const ts = new Date(NOW - (t.hoursAgo ?? 1) * HOUR).toISOString()
      if (!started.has(t.session)) {
        started.add(t.session)
        emit(t.session, 'session_started', { tool: 'claude-code' }, ts)
      }
      emit(t.session, 'file_touched', { path: t.file, op: 'edit' }, ts)
      if (t.ended === true) {
        emit(t.session, 'session_ended', { session_id: t.session, summary: 's', next_action: 'n' }, ts)
      }
    }
  }
  return root
}

describe('cross-initiative conflicts', () => {
  it('finds what per-slug detection structurally cannot', () => {
    const root = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/env.ts' }],
    })

    const conflicts = crossInitiativeFileConflicts(root, { now: NOW })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.path).toBe('src/env.ts')
    expect(conflicts[0]!.initiatives).toEqual(['alpha', 'beta'])
    expect(conflicts[0]!.holders.map((h) => h.session).sort()).toEqual(['A', 'B'])
  })

  it('does not re-report a conflict inside one initiative', () => {
    // openSessionFileConflicts already warns about this one; surfacing it here
    // too would double every existing warning.
    const root = record({ alpha: [{ session: 'A', file: 'src/env.ts' }, { session: 'B', file: 'src/env.ts' }] })
    expect(crossInitiativeFileConflicts(root, { now: NOW })).toEqual([])
  })

  it('ignores a file only one initiative holds', () => {
    const root = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/other.ts' }],
    })
    expect(crossInitiativeFileConflicts(root, { now: NOW })).toEqual([])
  })

  it('treats an ended session as wrapped, across initiatives too', () => {
    const root = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/env.ts', ended: true }],
    })
    expect(crossInitiativeFileConflicts(root, { now: NOW })).toEqual([])
  })

  it('re-admits the caller past its own mid-flight write-back', () => {
    // The writeback-collisions 2.1 rule, holding across the boundary: a
    // session that wrote back and kept working is still in the file.
    const root = record({
      alpha: [{ session: 'A', file: 'src/env.ts', ended: true }],
      beta: [{ session: 'B', file: 'src/env.ts' }],
    })
    expect(crossInitiativeFileConflicts(root, { now: NOW })).toEqual([])
    expect(crossConflictsForSession(root, 'A', { now: NOW })).toHaveLength(1)
  })

  it('reports only the conflicts the asking session is party to', () => {
    const root = record({
      alpha: [{ session: 'A', file: 'src/env.ts' }],
      beta: [{ session: 'B', file: 'src/env.ts' }, { session: 'B', file: 'src/other.ts' }],
      gamma: [{ session: 'C', file: 'src/other.ts' }],
    })
    expect(crossInitiativeFileConflicts(root, { now: NOW })).toHaveLength(2)
    expect(crossConflictsForSession(root, 'A', { now: NOW }).map((c) => c.path)).toEqual(['src/env.ts'])
  })

  it('gate changes which logs are READ, never what counts as a conflict', () => {
    const root = record({
      alpha: [{ session: 'A', file: 'src/env.ts', hoursAgo: 1 }],
      beta: [{ session: 'B', file: 'src/env.ts', hoursAgo: 100 }],
    })

    // Ungated sees both and reports the conflict.
    expect(crossInitiativeFileConflicts(root, { now: NOW })).toHaveLength(1)
    // Gated never reads beta's log, so the pair never forms.
    expect(warmInitiatives(root, { now: NOW, window: WINDOW })).toEqual(['alpha'])
    expect(crossInitiativeFileConflicts(root, { now: NOW, window: WINDOW })).toEqual([])
  })

  it('gate keeps every initiative that grew inside the window', () => {
    const root = record({
      alpha: [{ session: 'A', file: 'src/env.ts', hoursAgo: 1 }],
      beta: [{ session: 'B', file: 'src/env.ts', hoursAgo: 11 }],
    })
    expect(warmInitiatives(root, { now: NOW, window: WINDOW })).toEqual(['alpha', 'beta'])
    expect(crossInitiativeFileConflicts(root, { now: NOW, window: WINDOW })).toHaveLength(1)
  })

  it('degrades to silence on an unreadable record', () => {
    expect(crossInitiativeFileConflicts('/nonexistent/sofar-cross', { now: NOW })).toEqual([])
  })
})
