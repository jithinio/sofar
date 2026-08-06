import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, overlappingWritebacks, type InitiativeState } from '../src/core/fold'
import { appendEvent, serializeEvent } from '../src/core/log'
import type { ParallelWriteback } from '../src/core/fold'
import { callTool, connectServer, makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * writeback-collisions 1.2 — sofar_end_session reports colliding parallel
 * write-backs to the WRITER, at write time.
 *
 * The gap this closes: overlappingWritebacks was read-side only, so a
 * collision first surfaced at the NEXT SessionStart — to a fresh agent
 * holding neither session's reasoning, handed two next actions and no way to
 * tell whether they conflict, duplicate, or compose. The agent that CAN
 * answer that is the one that just wrote, and it is still alive when the tool
 * returns.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

/**
 * Append an event with an EXPLICIT ts. Same-process mints all land in one
 * millisecond, so every interval these tests care about is set by hand; only
 * the write-backs under test are stamped live, and "now" is always after the
 * seeded past.
 */
function seed(
  root: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): void {
  const event = makeEvent({
    initiative: 'demo',
    session,
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
  appendEvent(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), { ...event, ts })
}

/**
 * Seeded session intervals sit in a FIXED, well-past window. The write-backs
 * under test are stamped live by makeEvent, and overlap is decided against
 * those live timestamps — so a seed dated "today" silently stops overlapping
 * whenever the suite runs before that hour, and the collision vanishes for a
 * reason that has nothing to do with the code under test.
 */
const SEED_A_START = '2026-01-02T10:00:00.000Z'
const SEED_B_START = '2026-01-02T10:00:01.000Z'
const SEED_A_END = '2026-01-02T10:05:00.000Z'
const SEED_B_START_LATER = '2026-01-02T10:06:00.000Z'

interface EndResult {
  ok: true
  event_id: string
  parallel_writebacks?: ParallelWriteback[]
}

async function endVia(
  root: string,
  session: string,
  next_action: string,
): Promise<CallBody> {
  const { client, handle } = await connectServer(root)
  try {
    const { isError, body } = await callTool<EndResult>(client, 'sofar_end_session', {
      session_id: session,
      summary: `${session} summary`,
      next_action,
    })
    return { isError, body }
  } finally {
    await handle.server.close()
  }
}

interface CallBody {
  isError: boolean
  body: EndResult
}

// ---------------------------------------------------------------------------
// End-to-end through the MCP tool surface.
// ---------------------------------------------------------------------------

describe('1.2 end_session reports collisions to the writer', () => {
  it('first writer sees nothing, second sees the first', async () => {
    const f = fx()
    // Both sessions open before either wraps — genuinely parallel threads.
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)

    const first = await endVia(f.root, 'A', 'publish 0.20.0')
    expect(first.isError).toBe(false)
    // Nothing to collide with yet: B has not written back.
    expect(first.body.parallel_writebacks).toBeUndefined()

    const second = await endVia(f.root, 'B', 'rewrite the serve tests')
    expect(second.isError).toBe(false)
    expect(second.body.parallel_writebacks).toHaveLength(1)
    expect(second.body.parallel_writebacks![0]).toMatchObject({
      session_id: 'A',
      tool: 'claude-code',
      next_action: 'publish 0.20.0',
    })
    expect(typeof second.body.parallel_writebacks![0]!.ended).toBe('string')
  })

  it('omits the field entirely rather than returning an empty array', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)

    const { body } = await endVia(f.root, 'A', 'ship it')
    // The pre-1.2 shape, byte for byte — the ordinary case must not shift.
    expect(body).toEqual({ ok: true, event_id: body.event_id })
    expect('parallel_writebacks' in body).toBe(false)
  })

  it('agreement is not a collision', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)

    const first = await endVia(f.root, 'A', 'publish 0.20.0')
    const second = await endVia(f.root, 'B', 'publish 0.20.0')
    expect(first.body.parallel_writebacks).toBeUndefined()
    expect(second.body.parallel_writebacks).toBeUndefined()
  })

  it('a session that ended before this one started is history, not a collision', async () => {
    const f = fx()
    // A opens and closes entirely in the past; B only starts afterwards.
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(
      f.root,
      'A',
      'session_ended',
      { session_id: 'A', summary: 'sa', next_action: 'the old thread' },
      SEED_A_END,
    )
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START_LATER)

    const { body } = await endVia(f.root, 'B', 'the new thread')
    expect(body.parallel_writebacks).toBeUndefined()
  })

  it('reports without changing the log — read-side, no new event type', async () => {
    const f = fx()
    seed(f.root, 'A', 'session_started', { tool: 'claude-code' }, SEED_A_START)
    seed(f.root, 'B', 'session_started', { tool: 'opencode' }, SEED_B_START)
    await endVia(f.root, 'A', 'publish 0.20.0')
    await endVia(f.root, 'B', 'rewrite the serve tests')

    const types = eventsIn(f.root).map((e) => e.type)
    expect(types).toEqual(['session_started', 'session_started', 'session_ended', 'session_ended'])
  })
})

function eventsIn(root: string): EventEnvelope[] {
  return readFileSync(join(root, '.sofar', 'initiatives', 'demo', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

// ---------------------------------------------------------------------------
// The reference-session contract, where the MCP path cannot control the clock.
// ---------------------------------------------------------------------------

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

function at(e: EventEnvelope, ts: string): EventEnvelope {
  return { ...e, ts }
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

/** A and B start together and END IN THE SAME MILLISECOND — the ambiguous tie. */
function tiedSessions(): EventEnvelope[] {
  return [
    at(ev('initiative_created', { slug: 'demo', goal: 'g' }), '2026-08-06T10:00:00.000Z'),
    at(ev('session_started', { tool: 'claude-code' }, { session: 'A' }), '2026-08-06T10:00:01.000Z'),
    at(ev('session_started', { tool: 'opencode' }, { session: 'B' }), '2026-08-06T10:00:02.000Z'),
    at(
      ev('session_ended', { summary: 'sa', next_action: 'thread A' }, { session: 'A' }),
      '2026-08-06T10:30:00.000Z',
    ),
    at(
      ev('session_ended', { summary: 'sb', next_action: 'thread B' }, { session: 'B' }),
      '2026-08-06T10:30:00.000Z',
    ),
  ]
}

describe('1.2 reference session pins the comparison', () => {
  it('a millisecond tie reports the sibling from BOTH sides', () => {
    const state = foldOf(tiedSessions())
    // Without a reference the winner is decided by session order — B, here.
    expect(overlappingWritebacks(state).map((w) => w.session_id)).toEqual(['A'])
    // With the caller pinned, each side is told about the other. This is the
    // whole point: a writer must never be told "no collision" because an
    // unrelated ordering happened to crown it.
    expect(overlappingWritebacks(state, 'A').map((w) => w.session_id)).toEqual(['B'])
    expect(overlappingWritebacks(state, 'B').map((w) => w.session_id)).toEqual(['A'])
  })

  it('an id naming no next_action-bearing session falls back to the winner', () => {
    const state = foldOf(tiedSessions())
    const fallback = overlappingWritebacks(state, 'no-such-session')
    expect(fallback).toEqual(overlappingWritebacks(state))
  })

  it('read surfaces are unchanged — the default reference is still the winner', () => {
    const events = [
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'A' }),
      ev('session_started', { tool: 'opencode' }, { session: 'B' }),
      ev('session_ended', { summary: 'sa', next_action: 'publish 0.3.1' }, { session: 'A' }),
      ev('session_ended', { summary: 'sb', next_action: 'verify the tag' }, { session: 'B' }),
    ]
    const state = foldOf(events)
    expect(overlappingWritebacks(state)).toEqual(overlappingWritebacks(state, undefined))
    expect(overlappingWritebacks(state)).toHaveLength(1)
    expect(overlappingWritebacks(state)[0]!.session_id).toBe('A')
  })
})
