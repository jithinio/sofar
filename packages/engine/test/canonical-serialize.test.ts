import { describe, expect, it } from 'vitest'
import { validateEnvelope, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'

/**
 * 0.9.1 — canonical envelope serialization (SPEC §Envelope).
 *
 * serializeEvent must be a pure function of the envelope VALUE, independent
 * of key insertion order: envelope fields in fixed schema order, payload
 * keys sorted by code point recursively, arrays in order, no whitespace.
 * Pinned because sofar-cloud stores payloads in Postgres jsonb (which
 * reorders object keys) and reconstructs wire lines through this same
 * function — writer and puller must emit identical bytes for identical
 * events, or the git-committed events.jsonl diverges between machines.
 */

// Real lines from this repo's own committed record, written by the 0.9.0
// append path (String.raw: the first line carries \" escapes that must reach
// the comparison verbatim). Single-key payloads, so their written form is
// already canonical — the byte-parity anchors for committed history.
const LINE_WITH_USER = String.raw`{"v":1,"id":"01KXB7RRQQY4KVJFN1256PC4PP","ts":"2026-07-12T13:20:20.216Z","initiative":"sync-client","session":"46131e4b-130b-4919-b64d-e619205d2a2c","source":"hook","actor":"agent","user":"dev@jithin.io","type":"command_run","payload":{"cmd":"sofar new sync-client --goal \"Ship the v2 sync client (sofar-cloud Phase 5.1, the D14 seam): sofar login via RFC-8628 device flow, sofar link, push/pull sync with offline queue + doorbell SSE against api.sofar.sh, importable @alignlabs/sofar/client subpath — release as 0.9.0\" 2>&1"}}`
const LINE_WITHOUT_USER = String.raw`{"v":1,"id":"01KX8DMPAB49SRV8DXJTVWVAH2","ts":"2026-07-11T11:05:14.827Z","initiative":"cli-ui","session":"39e49fe8-6f91-44be-ae8f-98246524c005","source":"hook","actor":"agent","type":"command_run","payload":{"cmd":"sofar new cli-ui"}}`

// A historical line whose payload keys were INSERTED unsorted ({slug, goal}).
// Canonical form re-sorts the payload — envelope order and semantics are
// untouched, but bytes differ. Forward-only law: such lines are never
// rewritten in place (append-only) and pull dedupes them by id, so the
// re-sort only ever shows in fresh serializations (push wire, export).
const LINE_UNSORTED_PAYLOAD = String.raw`{"v":1,"id":"01KX8DMP89TBNP1WPVKZDRGEJF","ts":"2026-07-11T11:05:14.762Z","initiative":"cli-ui","session":"cli","source":"cli","actor":"human","type":"initiative_created","payload":{"slug":"cli-ui","goal":"(goal not recorded yet — set one with sofar_update_plan)"}}`

function parseEnvelope(line: string): EventEnvelope {
  const check = validateEnvelope(JSON.parse(line))
  if (!check.ok) throw new Error(`fixture is not a valid envelope: ${JSON.stringify(check.errors)}`)
  return check.event
}

// Deterministic PRNG (mulberry32) — the shuffle property must not flake.
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Rebuild with key insertion order shuffled at every depth; arrays untouched. */
function shuffleKeysDeep(value: unknown, rand: () => number): unknown {
  if (Array.isArray(value)) return value.map((entry) => shuffleKeysDeep(entry, rand))
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[keys[i], keys[j]] = [keys[j] as string, keys[i] as string]
    }
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      out[key] = shuffleKeysDeep((value as Record<string, unknown>)[key], rand)
    }
    return out
  }
  return value
}

/** Postgres jsonb key order: length first, then bytewise — applied recursively. */
function jsonbReorderDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonbReorderDeep)
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length
      return a < b ? -1 : a > b ? 1 : 0
    })
    const out: Record<string, unknown> = {}
    for (const key of keys) {
      out[key] = jsonbReorderDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

// Nested payload exercising every canonical rule at once: unsorted object
// keys at several depths, objects inside arrays, mixed scalar types.
const RICH: EventEnvelope = {
  v: 1,
  id: '01KXB7RRNCAPMW5KCWN5FZFZP2',
  ts: '2026-07-12T13:20:20.141Z',
  initiative: 'canon',
  session: 'sess-1',
  source: 'cli',
  actor: 'agent',
  user: 'dev@example.com',
  type: 'plan_updated',
  payload: {
    zeta: { b: 2, a: 1, nested: { y: true, x: null } },
    plan: {
      goal: 'exercise canonical form',
      phases: [
        { name: 'Build', status: 'active', tasks: [{ id: '1.1', title: 't', status: 'done' }] },
        { name: 'Ship', tasks: [] },
      ],
    },
    alpha: [{ y: 1, x: 2 }, 3, 'four', [5, { b: 6, a: 7 }]],
  },
}

describe('canonical serializeEvent (0.9.1)', () => {
  it('is invariant under key-order shuffling at every depth', () => {
    const canonical = serializeEvent(RICH)
    for (let seed = 1; seed <= 25; seed++) {
      const rand = mulberry32(seed)
      const shuffled = shuffleKeysDeep(JSON.parse(canonical), rand)
      expect(serializeEvent(parseEnvelope(JSON.stringify(shuffled)))).toBe(canonical)
    }
  })

  it('makes jsonb key reordering invisible', () => {
    const canonical = serializeEvent(RICH)
    const throughJsonb = parseEnvelope(JSON.stringify(jsonbReorderDeep(JSON.parse(canonical))))
    expect(serializeEvent(throughJsonb)).toBe(canonical)
  })

  it('makes the observed live jsonb divergence invisible (decision payload)', () => {
    // Observed live: {"chose":…,"over":…,"because":…} pulled back from jsonb
    // as {"over":…,"chose":…,"because":…} (length-first order). Both must
    // serialize to the same bytes.
    const base = {
      v: 1 as const,
      id: '01KXB7RRNCAPMW5KCWN5FZFZP3',
      ts: '2026-07-12T13:20:20.141Z',
      initiative: 'canon',
      session: 'cli',
      source: 'cli' as const,
      actor: 'human' as const,
      type: 'decision_logged',
    }
    const asWritten: EventEnvelope = {
      ...base,
      payload: { chose: 'plain fold', over: 'incremental cache', because: 'simpler' },
    }
    const asPulled: EventEnvelope = {
      ...base,
      payload: { over: 'incremental cache', chose: 'plain fold', because: 'simpler' },
    }
    expect(serializeEvent(asPulled)).toBe(serializeEvent(asWritten))
    // And the canonical payload really is code-point sorted:
    expect(serializeEvent(asWritten)).toContain('"payload":{"because":"simpler","chose":"plain fold","over":"incremental cache"}')
  })

  it('is idempotent: serialize → parse → serialize is stable', () => {
    const once = serializeEvent(RICH)
    const twice = serializeEvent(parseEnvelope(once))
    expect(twice).toBe(once)
    expect(serializeEvent(parseEnvelope(twice))).toBe(once)
  })

  it('byte-matches committed history: 0.9.0 append-path lines round-trip (user present and absent)', () => {
    expect(serializeEvent(parseEnvelope(LINE_WITH_USER))).toBe(LINE_WITH_USER)
    expect(serializeEvent(parseEnvelope(LINE_WITHOUT_USER))).toBe(LINE_WITHOUT_USER)
  })

  it('re-sorts a historical payload written with unsorted keys — envelope order and semantics intact', () => {
    const reserialized = serializeEvent(parseEnvelope(LINE_UNSORTED_PAYLOAD))
    // Envelope prefix (everything before payload) is byte-identical…
    const prefix = LINE_UNSORTED_PAYLOAD.slice(0, LINE_UNSORTED_PAYLOAD.indexOf('"payload":'))
    expect(reserialized.startsWith(prefix)).toBe(true)
    // …payload keys land sorted ({goal, slug} instead of the written {slug, goal})…
    expect(reserialized.indexOf('"goal"')).toBeLessThan(reserialized.indexOf('"slug"'))
    // …and nothing semantic moved.
    expect(JSON.parse(reserialized)).toEqual(JSON.parse(LINE_UNSORTED_PAYLOAD))
  })

  it('writes envelope fields in fixed schema order, user before type only when present', () => {
    const withUser = serializeEvent(RICH)
    expect(withUser.startsWith('{"v":1,"id":"01KXB7RRNCAPMW5KCWN5FZFZP2","ts":"2026-07-12T13:20:20.141Z","initiative":"canon","session":"sess-1","source":"cli","actor":"agent","user":"dev@example.com","type":"plan_updated","payload":{')).toBe(true)

    const { user: _dropped, ...rest } = RICH
    const withoutUser = serializeEvent(rest as EventEnvelope)
    expect(withoutUser).not.toContain('"user"')
    expect(withoutUser).toContain('"actor":"agent","type":"plan_updated"')
  })

  it('preserves arrays in their original order', () => {
    expect(serializeEvent(RICH)).toContain('"alpha":[{"x":2,"y":1},3,"four",[5,{"a":7,"b":6}]]')
  })

  it('preserves unknown envelope fields after the known ones instead of dropping them', () => {
    // `user` was itself added post-v1 as a strictly-additive field. A future
    // additive field must survive an older client's pull → re-serialize, or
    // sync would silently strip it from the log.
    const withExtra = JSON.parse(LINE_WITHOUT_USER) as Record<string, unknown>
    withExtra.org = 'alignlabs'
    const line = serializeEvent(parseEnvelope(JSON.stringify(withExtra)))
    expect(line.endsWith(',"org":"alignlabs"}')).toBe(true)
    expect(serializeEvent(parseEnvelope(line))).toBe(line)
  })
})
