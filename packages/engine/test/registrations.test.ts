import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cachedRegistrationIn } from '../src/core/registrations'
import { registrationIn } from '../src/mcp/context'

/**
 * rust-core 4.4 (D35): the tail-read registration cache must give exactly
 * registrationIn's answer after every kind of change a log can see.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function repo(): { sofarDir: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), 'sofar-reg-'))
  roots.push(root)
  const sofarDir = join(root, '.sofar')
  mkdirSync(join(sofarDir, 'initiatives', 'x'), { recursive: true })
  return { sofarDir, log: join(sofarDir, 'initiatives', 'x', 'events.jsonl') }
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const SESSIONS = ['s-1', 's-2', 'é-3', '__proto__', 'constructor', 's-1x']

function line(r: () => number, n: number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const session = pick(SESSIONS)
  const id = `01M${String(n).padStart(23, '0')}`
  const ts = `2026-09-23T00:00:${String(n % 60).padStart(2, '0')}.000Z`
  switch (Math.floor(r() * 9)) {
    case 0:
      return 'not json {'
    case 1:
      return JSON.stringify({ id, ts, type: 'note_added', session, payload: { text: 'a\nb' } })
    case 2: // the type spelled through a \u escape: registrationIn accepts it
      return JSON.stringify({ id, ts, type: 'session_started', session }).replace('session_started', 'session\\u005fstarted')
    case 3: // the session spelled through an escape: registrationIn's pre-filter skips it
      return JSON.stringify({ id, ts, type: 'session_started', session: 'x' }).replace('"session":"x"', `"session":"\\u0073${session.slice(1)}"`)
    case 4:
      return JSON.stringify({ id: 7, ts, type: 'session_started', session })
    case 5:
      return JSON.stringify([id, 'session_started'])
    case 6:
      return ''
    default:
      return JSON.stringify({ v: 1, id, ts, type: 'session_started', session, payload: { tool: 't' } })
  }
}

describe('registration cache (rust-core 4.4, D35)', () => {
  it('equals registrationIn after appends, torn tails, rewrites and corruption', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = rng(seed)
      const { sofarDir, log } = repo()
      writeFileSync(log, '')
      let n = 0
      let clock = 1_700_000_000
      const touch = () => {
        clock += 1
        utimesSync(log, clock, clock)
      }
      for (let step = 0; step < 60; step++) {
        const op = r()
        if (op < 0.6) {
          const lines = Array.from({ length: 1 + Math.floor(r() * 4) }, () => line(r, n++))
          appendFileSync(log, `${lines.join('\n')}\n`)
        } else if (op < 0.75) {
          appendFileSync(log, line(r, n++)) // torn: no newline yet
        } else if (op < 0.85) {
          appendFileSync(log, '\n')
        } else if (op < 0.93) {
          // A rewrite that keeps the length: a different registration under the same size.
          const text = readFileSync(log, 'utf8')
          writeFileSync(log, text.replace(/s-1/, 's-2'))
        } else {
          writeFileSync(log, `${line(r, n++)}\n`) // truncated and replaced
        }
        touch()
        for (const s of [...SESSIONS, 'missing', 'toString']) {
          const want = registrationIn(log, s)
          expect(cachedRegistrationIn(sofarDir, 'x', log, s, registrationIn), `seed ${seed} step ${step} ${s}`).toEqual(want)
        }
      }
    }
  })

  it('a corrupt or foreign cache file is a rescan, never an answer', () => {
    const { sofarDir, log } = repo()
    writeFileSync(log, `${JSON.stringify({ id: 'A', ts: 't1', type: 'session_started', session: 's-1' })}\n`)
    expect(cachedRegistrationIn(sofarDir, 'x', log, 's-1', registrationIn)).toEqual({ id: 'A', ts: 't1' })
    const cache = join(sofarDir, '.index', 'registrations', 'x.json')
    const good = JSON.parse(readFileSync(cache, 'utf8')) as Record<string, unknown>
    for (const bad of [
      'nope',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, offset: 10 ** 9 }),
      JSON.stringify({ ...good, last: { start: 0, sha256: 'x' }, offset: 1 }),
      JSON.stringify({ ...good, first: { 's-1': { id: 1, ts: 't' } } }),
    ]) {
      writeFileSync(cache, bad)
      expect(cachedRegistrationIn(sofarDir, 'x', log, 's-1', registrationIn)).toEqual({ id: 'A', ts: 't1' })
    }
  })

  it('a grown log whose head or last consumed line changed is rescanned', () => {
    const reg = (id: string, session: string) => `${JSON.stringify({ id, ts: id, type: 'session_started', session })}\n`
    for (const edit of ['head', 'last'] as const) {
      const { sofarDir, log } = repo()
      writeFileSync(log, reg('A', 's-1') + reg('B', 's-2'))
      expect(cachedRegistrationIn(sofarDir, 'x', log, 's-1', registrationIn)).toEqual({ id: 'A', ts: 'A' })
      // Rewrite either the first or the last consumed line, then grow the log.
      const rewritten = edit === 'head' ? reg('C', 's-1') + reg('B', 's-2') : reg('A', 's-1') + reg('D', 's-2')
      writeFileSync(log, rewritten + reg('E', 's-3'))
      for (const s of ['s-1', 's-2', 's-3']) {
        expect(cachedRegistrationIn(sofarDir, 'x', log, s, registrationIn), `${edit} ${s}`).toEqual(registrationIn(log, s))
      }
    }
  })

  it('a missing log answers as registrationIn does', () => {
    const { sofarDir, log } = repo()
    expect(cachedRegistrationIn(sofarDir, 'x', log, 's-1', registrationIn)).toBeNull()
  })
})
