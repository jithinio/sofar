import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportEvents, exportNDJSON, importNDJSON, readEvents } from '../src/core/cursor'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvents, serializeEvent } from '../src/core/log'

const scratch = mkdtempSync(join(tmpdir(), 'sofar-cursor-'))
let n = 0
const fresh = (name: string) => join(scratch, `${n++}-${name}`, 'events.jsonl')

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function ev(i: number): EventEnvelope {
  return makeEvent({
    initiative: 'sync-test',
    session: 'cli',
    source: 'cli',
    actor: 'agent',
    type: 'note_added',
    payload: { text: `note ${i}` },
  })
}

function events(count: number): EventEnvelope[] {
  return Array.from({ length: count }, (_, i) => ev(i))
}

describe('readEvents', () => {
  it('treats a missing file as an empty log', () => {
    expect(readEvents(fresh('missing'))).toEqual({ events: [], warnings: [] })
  })

  it('skips corrupt lines with warnings, keeps valid ones', () => {
    const path = fresh('corrupt')
    const good = events(3)
    appendEvents(path, good)
    writeFileSync(path, 'garbage\n', { flag: 'a' })
    const result = readEvents(path)
    expect(result.events.map((e) => e.id)).toEqual(good.map((e) => e.id))
    expect(result.warnings).toHaveLength(1)
  })
})

describe('export', () => {
  it('exports the full log as ulid-ordered NDJSON without sinceId', () => {
    const path = fresh('full')
    const all = events(5)
    appendEvents(path, all)

    const ndjson = exportNDJSON(path)
    const lines = ndjson.split('\n').filter((l) => l.length > 0)
    expect(lines).toEqual(all.map(serializeEvent))
    expect(ndjson.endsWith('\n')).toBe(true)
  })

  it('exports only events strictly after sinceId', () => {
    const path = fresh('since')
    const all = events(6)
    appendEvents(path, all)

    const cursor = all[2]!.id
    const { events: exported } = exportEvents(path, cursor)
    expect(exported.map((e) => e.id)).toEqual(all.slice(3).map((e) => e.id))
  })

  it('returns an empty stream when the cursor is at the head', () => {
    const path = fresh('head')
    const all = events(3)
    appendEvents(path, all)
    expect(exportNDJSON(path, all[2]!.id)).toBe('')
  })

  it('orders by ulid even when file order differs', () => {
    const path = fresh('shuffled')
    const all = events(4)
    const shuffled = [all[2]!, all[0]!, all[3]!, all[1]!]
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, shuffled.map((e) => serializeEvent(e) + '\n').join(''))
    const { events: exported } = exportEvents(path)
    expect(exported.map((e) => e.id)).toEqual(all.map((e) => e.id))
  })
})

describe('import', () => {
  it('round-trips a full log into a fresh replica (fold-equal)', () => {
    const a = fresh('rt-a')
    const b = fresh('rt-b')
    const all = [
      makeEvent({
        initiative: 'sync-test',
        session: 'cli',
        source: 'cli',
        actor: 'agent',
        type: 'initiative_created',
        payload: { slug: 'sync-test', goal: 'test sync' },
      }),
      ...events(9),
    ]
    appendEvents(a, all)

    const result = importNDJSON(b, exportNDJSON(a))
    expect(result).toEqual({ appended: 10, skipped: 0, warnings: [] })
    expect(foldLog(b).state).toEqual(foldLog(a).state)
  })

  it('is idempotent: re-import appends zero events (acceptance)', () => {
    const a = fresh('idem-a')
    const b = fresh('idem-b')
    appendEvents(a, events(7))

    const stream = exportNDJSON(a)
    const first = importNDJSON(b, stream)
    expect(first.appended).toBe(7)

    const second = importNDJSON(b, stream)
    expect(second).toEqual({ appended: 0, skipped: 7, warnings: [] })
    expect(readEvents(b).events).toHaveLength(7)

    // and importing into the source itself is also a no-op
    const self = importNDJSON(a, stream)
    expect(self.appended).toBe(0)
  })

  it('supports incremental catch-up via sinceId', () => {
    const a = fresh('inc-a')
    const b = fresh('inc-b')
    const first = events(4)
    appendEvents(a, first)
    importNDJSON(b, exportNDJSON(a))

    const cursorOfB = foldLog(b).state.cursor
    const more = events(3)
    appendEvents(a, more)

    const delta = exportNDJSON(a, cursorOfB ?? undefined)
    expect(delta.split('\n').filter((l) => l.length > 0)).toHaveLength(3)

    const result = importNDJSON(b, delta)
    expect(result.appended).toBe(3)
    expect(readEvents(b).events.map((e) => e.id)).toEqual(
      [...first, ...more].map((e) => e.id),
    )
  })

  it('dedupes repeats within a single stream', () => {
    const path = fresh('stream-dup')
    const one = ev(0)
    const stream = serializeEvent(one) + '\n' + serializeEvent(one) + '\n'
    const result = importNDJSON(path, stream)
    expect(result.appended).toBe(1)
    expect(result.skipped).toBe(1)
  })

  it('skips corrupt stream lines with warnings, imports the rest', () => {
    const path = fresh('stream-corrupt')
    const good = events(2)
    const stream = serializeEvent(good[0]!) + '\nnot-json\n' + serializeEvent(good[1]!) + '\n'
    const result = importNDJSON(path, stream)
    expect(result.appended).toBe(2)
    expect(result.warnings).toHaveLength(1)
  })
})
