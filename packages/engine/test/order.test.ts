import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines, openSessionFileConflicts } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { byCodeUnit } from '../src/core/order'

/**
 * r1-fixes 5.2 (rust-core D6) — one string order for every shared surface.
 *
 * Rust orders `str` by bytes; for the paths, slugs and ids here that is
 * UTF-16 code-unit order, and `localeCompare` (ICU collation) disagrees on
 * exactly the inputs a real record will eventually hold: mixed case and
 * punctuation. Every fixture before this was lowercase ASCII, where the two
 * agree — which is why nothing failed and why this test exists.
 */

describe('byCodeUnit', () => {
  it('orders by UTF-16 code units — uppercase before lowercase, punctuation by its code', () => {
    const paths = ['readme.md', 'Zed.ts', 'a.ts', 'README.md']
    expect(paths.slice().sort(byCodeUnit)).toEqual(['README.md', 'Zed.ts', 'a.ts', 'readme.md'])
    // ICU ties `a-b` with `ab` at the primary level; code units put '-' (0x2D) before 'b'.
    expect(['ab', 'a-b', 'a_b', 'a1'].sort(byCodeUnit)).toEqual(['a-b', 'a1', 'a_b', 'ab'])
    expect(byCodeUnit('same', 'same')).toBe(0)
  })
  it('is plain `<`/`>` on strings, not code points: a surrogate pair sorts below U+FF5E', () => {
    // '😀' (😀, U+1F600) vs '～' (U+FF5E): code POINTS say 😀 is greater;
    // code UNITS compare 0xD83D against 0xFF5E and say it is smaller. Rust's
    // text::cmp_utf16 agrees with the units — that is the contract.
    expect(byCodeUnit('😀', '～')).toBe(-1)
  })
})

describe('shared surfaces sort by code units', () => {
  const ev = (type: string, payload: Record<string, unknown>, session: string) =>
    makeEvent({ initiative: 'demo', session, source: 'hook', actor: 'agent', type, payload })
  const stamped = (events: EventEnvelope[]) =>
    events.map((e, i) => ({ ...e, id: `0000000000${String(i + 1).padStart(16, '0')}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString() }))

  it('openSessionFileConflicts lists README.md before Zed.ts before readme.md', () => {
    const events = stamped([
      ev('initiative_created', { slug: 'demo', goal: 'g' }, 'A'),
      ev('session_started', { tool: 'claude-code' }, 'A'),
      ev('session_started', { tool: 'codex' }, 'B'),
      ...['readme.md', 'Zed.ts', 'README.md'].flatMap((path) => [
        ev('file_touched', { path, op: 'edit' }, 'A'),
        ev('file_touched', { path, op: 'edit' }, 'B'),
      ]),
    ])
    const state = foldLines(events.map(serializeEvent), 'demo').state
    expect(openSessionFileConflicts(state).map((c) => c.path)).toEqual(['README.md', 'Zed.ts', 'readme.md'])
  })
})
