import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'

/**
 * Phase 13 acceptance (D-sync-1) — the convergent fold: replay order is
 * NORMATIVELY ulid id order, so the same event SET folds to a deep-equal
 * state on every replica regardless of file arrival order. Riders:
 * (a) writers mint monotonic ulids within a process (creation order survives
 *     the sort);
 * (b) fold is total under cross-machine clock skew — causally-misordered
 *     events resolve by id order through the normal skip-with-warning
 *     tolerance, never fatally.
 */

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({
    initiative: 'demo',
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
    ...overrides,
  })
}

/** A two-writer storyline: interleaved sessions, tasks, notes, a correction. */
function eventSet(): EventEnvelope[] {
  const bad = ev('note_added', { text: 'wrong — retracted' }, { session: 'W2' })
  return [
    ev('initiative_created', { slug: 'demo', goal: 'converge' }),
    ev('plan_updated', {
      plan: {
        phases: [
          { name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'a' }, { id: '1.2', title: 'b' }] },
        ],
      },
    }),
    ev('session_started', { tool: 'claude-code' }, { session: 'W1' }),
    ev('session_started', { tool: 'opencode' }, { session: 'W2' }),
    ev('task_status_changed', { id: '1.1', status: 'active' }, { session: 'W1' }),
    ev('file_touched', { path: 'src/a.ts', op: 'edit' }, { session: 'W1' }),
    ev('file_touched', { path: 'src/b.ts', op: 'edit' }, { session: 'W2' }),
    bad,
    ev('correction', { ref: bad.id, reason: 'retracted' }, { session: 'W2' }),
    ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'W1' }),
    ev('session_ended', { summary: 'w1 done', next_action: 'next from W1' }, { session: 'W1' }),
    ev('note_added', { text: 'post write-back drift' }, { session: 'W2' }),
    ev('decision_logged', { chose: 'c', over: 'o', because: 'b' }, { session: 'W2' }),
  ]
}

/** Deterministic in-place shuffle — tests must not use Math.random. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('convergent fold (13.1, D-sync-1)', () => {
  it('same event set, shuffled file orders → deep-equal states', () => {
    const events = eventSet()
    const reference = foldLines(events.map(serializeEvent)).state
    for (const seed of [1, 7, 42]) {
      const reordered = shuffled(events, seed)
      const folded = foldLines(reordered.map(serializeEvent)).state
      expect(folded).toEqual(reference)
    }
  })

  it('merged two-writer logs converge: A++B, B++A, and interleaved fold identically', () => {
    const events = eventSet()
    const w1 = events.filter((e) => e.session !== 'W2')
    const w2 = events.filter((e) => e.session === 'W2')

    const ab = foldLines([...w1, ...w2].map(serializeEvent)).state
    const ba = foldLines([...w2, ...w1].map(serializeEvent)).state
    const mixed = foldLines(shuffled(events, 99).map(serializeEvent)).state

    expect(ba).toEqual(ab)
    expect(mixed).toEqual(ab)
    // Convergence includes the cursor: max id, not last file line.
    const maxId = events.map((e) => e.id).sort().at(-1)
    expect(ab.cursor).toBe(maxId)
    expect(ba.cursor).toBe(maxId)
  })

  it('monotonic writer (rider a): same-process ids strictly increase, even same-millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => ev('note_added', { text: 'n' }).id)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
  })

  it('skew tolerance (rider b): a status change sorting before its task_added resolves by skip-with-warning, totally', () => {
    const base = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('plan_updated', { plan: { phases: [{ name: 'P1', status: 'active', tasks: [] }] } }),
    ]
    const add = ev('task_added', { phase: 'P1', id: 's.1', title: 'skewed' })
    const change = ev('task_status_changed', { id: 's.1', status: 'done' })
    // Simulate a skewed writer: swap ids so the change sorts BEFORE the add.
    const skewedChange = { ...change, id: add.id }
    const skewedAdd = { ...add, id: change.id }
    // Both file orders — the skew must resolve identically from either.
    const forward = foldLines([...base, skewedChange, skewedAdd].map(serializeEvent))
    const backward = foldLines([...base, skewedAdd, skewedChange].map(serializeEvent))

    expect(forward.warnings.some((w) => w.includes('task "s.1" not found'))).toBe(true)
    expect(forward.state).toEqual(backward.state)
    // The change was skipped (id order put it first); the task exists, pending.
    const task = forward.state.phases[0]!.tasks.find((t) => t.id === 's.1')
    expect(task?.status).toBe('pending')
    // The plan absorbed the id, so this is ordering, not a misroute orphan.
    expect(forward.orphan_task_events).toEqual([])
    expect(backward.orphan_task_events).toEqual([])
  })

  it('duplicate ids (pre-dedupe merge artifact) keep file order via the stable sort — still deterministic', () => {
    const original = ev('note_added', { text: 'first copy' })
    const duplicate = { ...original }
    const log = [ev('initiative_created', { slug: 'demo', goal: 'g' }), original, duplicate]
    const a = foldLines(log.map(serializeEvent))
    const b = foldLines(log.map(serializeEvent))
    expect(a.state).toEqual(b.state)
  })
})
