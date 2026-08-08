import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  INDEX_SCHEMA_VERSION,
  cursorPlausible,
  ensureIndexDir,
  readIndexMeta,
  writeIndexMeta,
} from '../src/core/index-store'
import { readSince } from '../src/core/index-tail'

/**
 * Phase 1 — the incremental core.
 *
 * The whole design rests on one claim: reading only what a log grew by returns
 * exactly what reading all of it would have. So the tests are equivalences,
 * not behaviours — incremental must equal full, on every path, including the
 * paths where the cursor is a lie.
 *
 * The adversarial half matters more than the happy half. A cursor is a number
 * on disk that outlives the file it describes; imports, rewrites, restores and
 * truncations all leave one pointing somewhere plausible and wrong. Every such
 * case must fall back to a full read, because an index that can be talked into
 * a wrong answer is worse than no index at all.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-index-'))
  roots.push(root)
  return root
}

let seq = 0
function event(type: string, extra: Record<string, unknown> = {}): string {
  seq++
  return JSON.stringify({
    v: 1,
    id: `01AAAAAAAA${String(seq).padStart(6, '0')}`,
    ts: '2026-08-08T12:00:00.000Z',
    initiative: 'demo',
    session: 'S1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload: extra,
  })
}

function freshLog(events: string[]): string {
  const dir = scratch()
  const path = join(dir, 'events.jsonl')
  writeFileSync(path, events.length === 0 ? '' : `${events.join('\n')}\n`)
  return path
}

describe('incremental read', () => {
  it('reads everything on a cold start', () => {
    const log = freshLog([event('session_started'), event('file_touched', { path: 'a.ts' })])
    const read = readSince(log, null)

    expect(read.full).toBe(true)
    expect(read.events).toHaveLength(2)
    expect(read.cursor).not.toBeNull()
  })

  it('reads only what was appended since the cursor', () => {
    const log = freshLog([event('session_started'), event('file_touched', { path: 'a.ts' })])
    const first = readSince(log, null)

    appendFileSync(log, `${event('file_touched', { path: 'b.ts' })}\n`)
    const second = readSince(log, first.cursor)

    expect(second.full).toBe(false)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]!.payload.path).toBe('b.ts')
  })

  it('returns nothing when the log has not grown', () => {
    const log = freshLog([event('session_started')])
    const first = readSince(log, null)
    const second = readSince(log, first.cursor)

    expect(second.events).toEqual([])
    expect(second.full).toBe(false)
    expect(second.cursor).toEqual(first.cursor)
  })

  it('incremental equals full, across many appends', () => {
    // The core equivalence: replaying in chunks must land where one big read
    // lands, or every downstream answer diverges from truth over time.
    const log = freshLog([event('session_started')])
    let cursor = readSince(log, null).cursor
    const incremental: string[] = []

    for (let i = 0; i < 25; i++) {
      appendFileSync(log, `${event('file_touched', { path: `f${i}.ts` })}\n`)
      const step = readSince(log, cursor)
      incremental.push(...step.events.map((e) => e.id))
      cursor = step.cursor
    }

    const full = readSince(log, null)
    expect([full.events[0]!.id, ...incremental]).toEqual(full.events.map((e) => e.id))
  })

  it('falls back to a full read when the offset does not land on its event', () => {
    // A rewritten log: same size class, entirely different content. The stored
    // offset is still a valid position, and points at the wrong line.
    const log = freshLog([event('session_started'), event('file_touched', { path: 'a.ts' })])
    const cursor = readSince(log, null).cursor!

    writeFileSync(log, `${[event('note_added', { text: 'rewritten' }), event('note_added', { text: 'again' })].join('\n')}\n`)
    const read = readSince(log, cursor)

    expect(read.full).toBe(true)
    expect(read.events.map((e) => e.payload.text)).toEqual(['rewritten', 'again'])
  })

  it('falls back when the log shrank beneath the cursor', () => {
    const log = freshLog(Array.from({ length: 10 }, () => event('file_touched', { path: 'a.ts' })))
    const cursor = readSince(log, null).cursor!

    writeFileSync(log, `${event('session_started')}\n`)
    const read = readSince(log, cursor)

    expect(read.full).toBe(true)
    expect(read.events).toHaveLength(1)
  })

  it('keeps byte offsets correct through non-ASCII prose', () => {
    // Decision prose is full of em dashes and arrows. A UTF-16 length here
    // would drift from the file position and misplace every later cursor.
    const log = freshLog([event('decision_logged', { because: 'em — dash, arrow → and ünïcode' })])
    const first = readSince(log, null)

    appendFileSync(log, `${event('note_added', { text: 'after' })}\n`)
    const second = readSince(log, first.cursor)

    expect(second.full).toBe(false)
    expect(second.events).toHaveLength(1)
    expect(second.events[0]!.payload.text).toBe('after')
  })

  it('skips corrupt lines without losing the tail', () => {
    const log = freshLog([event('session_started')])
    appendFileSync(log, '{ not json\n')
    appendFileSync(log, `${event('note_added', { text: 'survived' })}\n`)

    const read = readSince(log, null)
    expect(read.events.map((e) => e.payload.text ?? null)).toEqual([null, 'survived'])
  })

  it('handles an absent or empty log without throwing', () => {
    expect(readSince(join(scratch(), 'nope.jsonl'), null)).toEqual({ events: [], cursor: null, full: true })
    expect(readSince(freshLog([]), null).cursor).toBeNull()
  })
})

describe('index store', () => {
  it('ignores itself so no repo .gitignore has to know', () => {
    const root = scratch()
    mkdirSync(join(root, '.sofar'), { recursive: true })
    const dir = ensureIndexDir(join(root, '.sofar'))
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('round-trips cursors', () => {
    const sofar = join(scratch(), '.sofar')
    writeIndexMeta(sofar, { version: INDEX_SCHEMA_VERSION, cursors: { demo: { id: 'x', offset: 10, size: 20 } } })
    expect(readIndexMeta(sofar)?.cursors.demo).toEqual({ id: 'x', offset: 10, size: 20 })
  })

  it('cold-starts on a version bump rather than misreading', () => {
    const sofar = join(scratch(), '.sofar')
    writeIndexMeta(sofar, { version: INDEX_SCHEMA_VERSION, cursors: {} })
    const path = join(sofar, '.index', 'meta.json')
    writeFileSync(path, JSON.stringify({ version: INDEX_SCHEMA_VERSION + 1, cursors: { demo: { id: 'x', offset: 1, size: 2 } } }))
    expect(readIndexMeta(sofar)).toBeNull()
  })

  it('cold-starts on corruption, absence, and malformed cursors', () => {
    const sofar = join(scratch(), '.sofar')
    expect(readIndexMeta(sofar)).toBeNull() // absent

    ensureIndexDir(sofar)
    writeFileSync(join(sofar, '.index', 'meta.json'), '{ broken')
    expect(readIndexMeta(sofar)).toBeNull() // corrupt

    // A cursor whose fields changed type is dropped; the file still loads.
    writeFileSync(
      join(sofar, '.index', 'meta.json'),
      JSON.stringify({ version: INDEX_SCHEMA_VERSION, cursors: { a: { id: 'ok', offset: 0, size: 0 }, b: { id: 5 } } }),
    )
    const meta = readIndexMeta(sofar)
    expect(Object.keys(meta!.cursors)).toEqual(['a'])
  })

  it('calls a cursor implausible once its log shrinks or vanishes', () => {
    const log = freshLog([event('session_started')])
    const cursor = readSince(log, null).cursor!
    expect(cursorPlausible(log, cursor)).toBe(true)

    writeFileSync(log, '')
    expect(cursorPlausible(log, cursor)).toBe(false)
    expect(cursorPlausible(join(scratch(), 'gone.jsonl'), cursor)).toBe(false)
  })
})
