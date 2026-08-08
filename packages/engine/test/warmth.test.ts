import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isWarm, lastAppendAt } from '../src/core/warmth'

/**
 * Task 1.1 — the warm-log signal the cross-initiative gate rides on.
 *
 * The headline test is the git one. The whole reason this reads content
 * instead of mtime is that `git checkout` rewrites every events.jsonl in the
 * tree, and an mtime gate would then call the entire record warm and fold all
 * of it on the hook path — the exact cost the gate exists to avoid.
 *
 * The second theme is direction of error. Every ambiguous case must resolve
 * toward WARM, because a log wrongly called cold is not folded, and a conflict
 * that is not folded is a warning the user never sees.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const HOUR = 60 * 60 * 1000
const NOW = Date.parse('2026-08-08T12:00:00.000Z')

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-warmth-'))
  roots.push(root)
  return root
}

/** A log whose events carry the given timestamps, one JSON object per line. */
function logWith(timestamps: string[], padding = 0): string {
  const path = join(scratch(), 'events.jsonl')
  const lines = timestamps.map((ts, i) =>
    JSON.stringify({ v: 1, id: `id-${i}`, ts, type: 'note_added', payload: { text: 'x'.repeat(padding) } }),
  )
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

describe('warm-log signal', () => {
  it('reads the newest event time from the log', () => {
    const path = logWith(['2026-08-01T09:00:00.000Z', '2026-08-08T11:00:00.000Z'])
    expect(lastAppendAt(path)).toBe(Date.parse('2026-08-08T11:00:00.000Z'))
  })

  it('is unmoved by a filesystem timestamp rewrite (the git checkout case)', () => {
    // A cold log: last event a week before NOW.
    const path = logWith(['2026-08-01T09:00:00.000Z'])
    expect(isWarm(path, NOW, 12 * HOUR)).toBe(false)

    // `git checkout` rewrites the file and stamps mtime NOW. An mtime gate
    // would now call this warm and fold it; the content has not changed, so
    // this must not move.
    utimesSync(path, new Date(NOW), new Date(NOW))
    expect(isWarm(path, NOW, 12 * HOUR)).toBe(false)
    expect(lastAppendAt(path)).toBe(Date.parse('2026-08-01T09:00:00.000Z'))
  })

  it('takes the newest timestamp, not the last line', () => {
    // `sofar event append` accepts an explicit ts, so a backdated correction
    // can land last. Trusting the final line would call a live log cold.
    const path = logWith([
      '2026-08-08T11:00:00.000Z',
      '2026-08-08T11:30:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ])
    expect(lastAppendAt(path)).toBe(Date.parse('2026-08-08T11:30:00.000Z'))
    expect(isWarm(path, NOW, 12 * HOUR)).toBe(true)
  })

  it('ignores the partial first line the tail read cuts through', () => {
    // 400 events with fat payloads puts the window's start mid-line. The
    // fragment must be dropped, not parsed, and the answer must still be right.
    const stamps = Array.from({ length: 400 }, (_, i) =>
      new Date(Date.parse('2026-08-08T00:00:00.000Z') + i * 1000).toISOString(),
    )
    const path = logWith(stamps, 200)
    expect(lastAppendAt(path)).toBe(Date.parse('2026-08-08T00:06:39.000Z'))
  })

  it('falls back to the whole file when one line exceeds the tail window', () => {
    // A single event bigger than the window — the tail holds no complete line
    // at all, so the cheap read cannot answer and the full read must.
    const path = logWith(['2026-08-08T11:00:00.000Z'], 40_000)
    expect(lastAppendAt(path)).toBe(Date.parse('2026-08-08T11:00:00.000Z'))
  })

  it('skips corrupt lines exactly as the fold does', () => {
    const path = join(scratch(), 'events.jsonl')
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: '2026-08-08T11:00:00.000Z' }),
        '{ not json at all',
        JSON.stringify({ ts: 'not-a-date' }),
        JSON.stringify({ noTsField: true }),
      ].join('\n'),
    )
    expect(lastAppendAt(path)).toBe(Date.parse('2026-08-08T11:00:00.000Z'))
  })

  it('returns null for an absent, empty, or unparseable log', () => {
    expect(lastAppendAt(join(scratch(), 'nope.jsonl'))).toBeNull()

    const empty = join(scratch(), 'events.jsonl')
    writeFileSync(empty, '')
    expect(lastAppendAt(empty)).toBeNull()

    const junk = join(scratch(), 'events.jsonl')
    writeFileSync(junk, 'not json\nstill not json\n')
    expect(lastAppendAt(junk)).toBeNull()
  })

  it('counts an unreadable log as WARM so ambiguity never drops a warning', () => {
    // The error direction that matters: a log we cannot read costs one extra
    // fold, never a conflict the user was not told about.
    expect(isWarm(join(scratch(), 'nope.jsonl'), NOW, 12 * HOUR)).toBe(true)
  })

  it('treats the window boundary as inclusive', () => {
    const path = logWith(['2026-08-08T00:00:00.000Z'])
    expect(isWarm(path, NOW, 12 * HOUR)).toBe(true)
    expect(isWarm(path, NOW, 12 * HOUR - 1)).toBe(false)
  })
})
