import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { schemaFingerprint, SCHEMA_VERSION } from '@sofar/schema'
import { makeEvent, validateEnvelope, type EventEnvelope } from '../src/core/envelope'
import { foldLines } from '../src/core/fold'
import { appendEvent, serializeEvent } from '../src/core/log'
import { exportNDJSON, readEventsSince } from '../src/core/cursor'
import {
  canonicalJSON,
  currentVersion,
  fold,
  foldAll,
  foldFile,
  foldFileSince,
  FOLD_REFUSALS,
  parseSnapshot,
  serializeSnapshot,
  stateOf,
} from '../src/core/snapshot'

/**
 * r1-fixes 5.1 (D20, D21, D22) — the library face of the incremental fold.
 * The cited guarantees live in the black-box suite under
 * test/conformance/fold-parity/; these pin the library API's own laws: a
 * snapshot is derived state with a readable version, a refusal is one of a
 * closed set, and nothing in the fold reads the clock or the environment.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})
afterEach(() => {
  vi.useRealTimers()
})

let clock = Date.parse('2026-09-16T00:00:00Z')
function ev(type: string, payload: Record<string, unknown>, session = 's1'): EventEnvelope {
  clock += 1000
  return { ...makeEvent({ initiative: 'demo', session, source: 'hook', actor: 'agent', type, payload }), ts: new Date(clock).toISOString() }
}

function story(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'demo', goal: 'g' }, 'cli'),
    ev('session_started', { tool: 'claude-code' }),
    ev('plan_updated', { goal: 'g', phases: [{ name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'a' }, { id: '1.2', title: 'b' }] }] }),
    ev('task_status_changed', { id: '1.1', status: 'active' }),
    ev('file_touched', { path: 'src/a.ts', op: 'edit' }),
    ev('decision_logged', { chose: 'x', over: 'y', because: 'z', rule: 'Never do y.', guard: 'path:src/y/**' }),
    ev('file_touched', { path: 'src/y/b.ts', op: 'write' }),
    ev('command_run', { cmd: 'npm test' }),
    ev('task_status_changed', { id: '9.9', status: 'done' }),
    ev('session_ended', { summary: 's', next_action: 'n' }),
  ]
}

const linesOf = (events: readonly EventEnvelope[]): string[] => events.map(serializeEvent)

describe('snapshot laws (D20, D21)', () => {
  it('foldAll then fold(tail) finalizes to the full fold, prefix by prefix, without mutating the input', () => {
    const events = story()
    const all = linesOf(events)
    for (let n = 0; n <= events.length; n++) {
      const base = foldAll(all.slice(0, n), 'demo')
      const before = serializeSnapshot(base)
      const step = fold(base, all.slice(n))
      expect(step.ok).toBe(true)
      if (!step.ok) continue
      const fresh = foldLines([...all, ''], 'demo')
      expect(stateOf(step.snapshot)).toEqual(fresh)
      expect(serializeSnapshot(base)).toBe(before)
      expect(step.snapshot.cursor).toBe(events[events.length - 1]!.id)
      expect(step.snapshot.prefix.lines).toBe(events.length)
    }
  })

  it('the version is a readable field, and a mismatch on parse carries both versions', () => {
    const snap = foldAll(linesOf(story()), 'demo')
    expect(snap.version).toEqual(currentVersion())
    expect(snap.version.schema).toMatch(/^[0-9a-f]{64}$/)
    const text = serializeSnapshot(snap)
    const round = parseSnapshot(text)
    expect(round.ok).toBe(true)
    if (round.ok) expect(stateOf(round.snapshot)).toEqual(stateOf(snap))
    const bumped = text.replace(`"engine":"${snap.version.engine}"`, '"engine":"99.0.0"')
    const refused = parseSnapshot(bumped)
    expect(refused).toEqual({ ok: false, reason: 'version', found: { engine: '99.0.0', schema: snap.version.schema }, expected: currentVersion() })
    const otherSchema = text.replace(snap.version.schema, 'f'.repeat(64))
    expect(parseSnapshot(otherSchema)).toMatchObject({ ok: false, reason: 'version', found: { schema: 'f'.repeat(64) } })
    expect(parseSnapshot('not json')).toMatchObject({ ok: false, reason: 'corrupt' })
    expect(parseSnapshot('{"version":{"engine":"x","schema":"y"}}')).toMatchObject({ ok: false, reason: 'version' })
    // A stale snapshot is refused by fold too, with the closed reason.
    const stale = { ...snap, version: { ...snap.version, engine: '0.0.1' } }
    expect(fold(stale, [])).toMatchObject({ ok: false, reason: 'version' })
  })

  it('refusals are the closed set: out_of_order_id, correction, invalid_line, and nothing is applied on refusal', () => {
    const events = story()
    const snap = foldAll(linesOf(events.slice(0, 6)), 'demo')
    const before = serializeSnapshot(snap)
    expect(FOLD_REFUSALS).toEqual(['version', 'out_of_order_id', 'correction', 'invalid_line', 'cursor_mismatch'])
    const early = { ...events[9]!, id: '00000000000000000000000000' }
    expect(fold(snap, [events[6]!, early])).toMatchObject({ ok: false, reason: 'out_of_order_id' })
    expect(fold(snap, [ev('correction', { ref: events[4]!.id, reason: 'wrong file' })])).toMatchObject({ ok: false, reason: 'correction' })
    expect(fold(snap, ['not json{{{'])).toMatchObject({ ok: false, reason: 'invalid_line' })
    expect(fold(snap, [JSON.stringify({ v: 1, id: 'x' })])).toMatchObject({ ok: false, reason: 'invalid_line' })
    expect(serializeSnapshot(snap)).toBe(before)
    // The refold the refusal asks for is the reference and still works.
    const withCorrection = [...linesOf(events), serializeEvent(ev('correction', { ref: events[4]!.id, reason: 'wrong file' }))]
    expect(stateOf(foldAll(withCorrection, 'demo'))).toEqual(foldLines([...withCorrection, ''], 'demo'))
  })

  it('foldFile + foldFileSince: a file tail applies with a prefix check; a rewritten prefix is cursor_mismatch', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-snap-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const events = story()
    for (const e of events.slice(0, 5)) appendEvent(path, e)
    const snap = foldFile(path, 'demo')
    expect(snap.prefix.lines).toBe(5)
    expect(snap.prefix.sha256).toMatch(/^[0-9a-f]{64}$/)
    for (const e of events.slice(5)) appendEvent(path, e)
    const step = foldFileSince(snap, path)
    expect(step.ok).toBe(true)
    if (step.ok) {
      expect(stateOf(step.snapshot)).toEqual(foldLines(readFileSync(path, 'utf8').split('\n'), 'demo'))
      expect(step.snapshot.prefix.bytes).toBe(readFileSync(path).length)
      expect(step.snapshot.prefix.sha256).toMatch(/^[0-9a-f]{64}$/)
      // Nothing new: applies to itself.
      const again = foldFileSince(step.snapshot, path)
      expect(again.ok && stateOf(again.snapshot)).toEqual(stateOf(step.snapshot))
    }
    expect(foldFileSince(snap, path, 4)).toMatchObject({ ok: false, reason: 'cursor_mismatch' })
    // The prefix moved: a rewrite of an earlier line.
    const text = readFileSync(path, 'utf8')
    writeFileSync(path, text.replace('"path":"src/a.ts"', '"path":"src/z.ts"'))
    expect(foldFileSince(snap, path)).toMatchObject({ ok: false, reason: 'cursor_mismatch' })
    // A value-chained snapshot checks the last line instead.
    const chained = fold(foldFile(join(root, 'missing.jsonl'), 'demo'), linesOf(events.slice(0, 2)))
    expect(chained.ok && chained.snapshot.prefix.sha256.startsWith('chain:')).toBe(true)
    const path2 = join(root, 'two.jsonl')
    for (const e of events.slice(0, 3)) appendEvent(path2, e)
    if (chained.ok) {
      const step2 = foldFileSince(chained.snapshot, path2)
      expect(step2.ok && stateOf(step2.snapshot)).toEqual(foldLines(readFileSync(path2, 'utf8').split('\n'), 'demo'))
    }
  })

  it('a snapshot is not an event, and export never carries one', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-snap-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    for (const e of story()) appendEvent(path, e)
    const snap = foldFile(path, 'demo')
    expect(validateEnvelope(JSON.parse(serializeSnapshot(snap))).ok).toBe(false)
    const out = exportNDJSON(path)
    expect(out).not.toContain('"checkpoint"')
    expect(out.split('\n').filter((l) => l.length > 0).every((l) => validateEnvelope(JSON.parse(l)).ok)).toBe(true)
  })

  it('pure of clock and environment: a frozen clock and an emptied env fold to the same state', () => {
    const lines = linesOf(story())
    const reference = canonicalJSON(stateOf(foldAll(lines, 'demo')))
    vi.useFakeTimers()
    vi.setSystemTime(new Date('1999-01-01T00:00:00Z'))
    const env = process.env
    process.env = {}
    try {
      expect(canonicalJSON(stateOf(foldAll(lines, 'demo')))).toBe(reference)
      const base = foldAll(lines.slice(0, 4), 'demo')
      const step = fold(base, lines.slice(4))
      expect(step.ok && canonicalJSON(stateOf(step.snapshot))).toBe(reference)
    } finally {
      process.env = env
    }
  })

  it('the committed schema fingerprint is the live one, and SCHEMA_VERSION is the package version', () => {
    const committed = readFileSync(join(__dirname, '..', '..', 'schema', 'schema-fingerprint.txt'), 'utf8')
    expect(committed).toBe(schemaFingerprint())
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'schema', 'package.json'), 'utf8')) as { version: string }
    expect(SCHEMA_VERSION).toBe(pkg.version)
    expect(committed.startsWith(`${SCHEMA_VERSION}\n`)).toBe(true)
  })

  it('readEventsSince: the events after a cursor, in id order, without folding', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-snap-'))
    roots.push(root)
    const path = join(root, 'events.jsonl')
    const events = story()
    for (const e of events) appendEvent(path, e)
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json{{{\n`)
    const all = readEventsSince(path)
    expect(all.events.map((e) => e.id)).toEqual(events.map((e) => e.id))
    expect(all.cursor).toBe(events[events.length - 1]!.id)
    expect(all.warnings).toHaveLength(1)
    const tail = readEventsSince(path, events[6]!.id)
    expect(tail.events.map((e) => e.id)).toEqual(events.slice(7).map((e) => e.id))
    const none = readEventsSince(path, all.cursor)
    expect(none.events).toEqual([])
    expect(none.cursor).toBe(all.cursor)
    expect(readEventsSince(join(root, 'nope.jsonl'), 'x')).toEqual({ events: [], cursor: 'x', warnings: [] })
  })
})
