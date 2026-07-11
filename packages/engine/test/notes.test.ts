import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { renderFullStatus, renderStatus, STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { callTool, callToolText, connectServer, makeRepoFixture } from './helpers/mcp'

/**
 * Notes-in-digest acceptance (SPEC §Acceptance "Notes surfacing"):
 *   4.1 fold selection (since-write-back window, straddle, void, determinism)
 *   4.2 render surfacing (budget, count cap, clip, absence, 10k worst case,
 *       digest/SessionStart parity via the shared renderStatus seam)
 * plus the incident regression the initiative exists for: a note recorded
 * after the write-back must reach the next session's orientation surfaces.
 */

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({ initiative: 'demo', session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload, ...overrides })
}

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

/** A write-back with a note on each side of it — the straddle storyline. */
function straddleStoryline(): { events: EventEnvelope[]; post: EventEnvelope[] } {
  const post = [
    ev('note_added', { text: 'correction one' }, { session: 'cli', source: 'cli', actor: 'human' }),
    ev('note_added', { text: 'correction two' }),
  ]
  const events = [
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    ev('session_started', { tool: 'claude-code' }),
    ev('note_added', { text: 'absorbed by the write-back' }),
    ev('session_ended', { summary: 'built the thing', next_action: 'ship the thing' }),
    ...post,
  ]
  return { events, post }
}

/** The notes section of a status render: header + its "- " lines. */
function notesSection(text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('Notes'))
  if (start === -1) return []
  const section = [lines[start]!]
  for (let i = start + 1; i < lines.length && lines[i]!.startsWith('- '); i++) {
    section.push(lines[i]!)
  }
  return section
}

// ---------------------------------------------------------------------------
// 4.1 fold selection.
// ---------------------------------------------------------------------------

describe('fold note selection (4.1)', () => {
  it('selects only notes after the last write-back, {ts, text} in log order, any session/source', () => {
    const { events, post } = straddleStoryline()
    const state = foldOf(events)
    expect(state.freshness.notes).toEqual(post.map((e) => ({ ts: e.ts, text: (e.payload as { text: string }).text })))
    expect(state.freshness.events_since_writeback.notes).toBe(state.freshness.notes.length)
  })

  it('a new write-back clears the selection (notes absorbed)', () => {
    const { events } = straddleStoryline()
    const state = foldOf([...events, ev('session_ended', { summary: 's2', next_action: 'n2' })])
    expect(state.freshness.notes).toEqual([])
    expect(state.freshness.events_since_writeback.notes).toBe(0)
  })

  it('a never-written-back log selects every note (nothing has absorbed anything)', () => {
    const state = foldOf([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('note_added', { text: 'seed context' }),
      ev('note_added', { text: 'watch out for X' }),
    ])
    expect(state.freshness.last_writeback_ts).toBeNull()
    expect(state.freshness.notes.map((n) => n.text)).toEqual(['seed context', 'watch out for X'])
  })

  it('a voided (corrected) note is never selected; an invalid payload is skipped', () => {
    const { events } = straddleStoryline()
    const bad = ev('note_added', { text: 'wrong — retracted' })
    const state = foldOf([
      ...events,
      bad,
      ev('correction', { ref: bad.id }),
      ev('note_added', { nope: true }), // invalid payload — skipped with warning
    ])
    expect(state.freshness.notes.map((n) => n.text)).toEqual(['correction one', 'correction two'])
    expect(state.freshness.events_since_writeback.notes).toBe(2)
  })

  it('replay is deterministic: same log → deep-equal notes', () => {
    const lines = straddleStoryline().events.map(serializeEvent)
    expect(foldLines(lines).state).toEqual(foldLines(lines).state)
  })
})

// ---------------------------------------------------------------------------
// 4.2 render surfacing.
// ---------------------------------------------------------------------------

describe('renderStatus — budgeted notes section (4.2)', () => {
  it('renders selected notes directly under the staleness line (drift signal + content together)', () => {
    const status = renderStatus(foldOf(straddleStoryline().events))
    const lines = status.split('\n')
    const stale = lines.findIndex((l) => l.startsWith('⚠ next action may be stale'))
    expect(stale).toBeGreaterThan(-1)
    expect(lines[stale + 1]).toBe('Notes since write-back:')
    expect(status).toContain('correction one')
    expect(status).toContain('correction two')
  })

  it('is absent when the write-back postdates every note', () => {
    const { events } = straddleStoryline()
    const status = renderStatus(foldOf([...events, ev('session_ended', { summary: 's2', next_action: 'n2' })]))
    expect(notesSection(status)).toEqual([])
    expect(status).not.toContain('absorbed by the write-back')
  })

  it('renders on a never-written-back record with the plain "Notes" header', () => {
    const status = renderStatus(
      foldOf([
        ev('initiative_created', { slug: 'demo', goal: 'g' }),
        ev('note_added', { text: 'seed context' }),
      ]),
    )
    expect(status).not.toContain('⚠ next action may be stale')
    expect(notesSection(status)[0]).toBe('Notes:')
    expect(status).toContain('seed context')
  })

  it('count-caps to the newest 5 with a "(last K of N)" label', () => {
    const { events } = straddleStoryline()
    const more = Array.from({ length: 5 }, (_, i) => ev('note_added', { text: `late note ${i}` }))
    const status = renderStatus(foldOf([...events, ...more]))
    const section = notesSection(status)
    expect(section[0]).toBe('Notes since write-back (last 5 of 7):')
    expect(section).toHaveLength(6) // header + 5 entries
    expect(status).not.toContain('correction one') // oldest two dropped
    expect(status).not.toContain('correction two')
    expect(status).toContain('late note 0')
    expect(status).toContain('late note 4')
  })

  it('clips each entry to its line budget', () => {
    const { events } = straddleStoryline()
    const status = renderStatus(foldOf([...events, ev('note_added', { text: 'x'.repeat(2_000) })]))
    const line = status.split('\n').find((l) => l.startsWith('- ') && l.includes('xxx'))
    expect(line).toBeDefined()
    expect(line!.length).toBeLessThanOrEqual(2 + 200) // "- " + NOTE_LINE_BUDGET
    expect(line!.endsWith('…')).toBe(true)
  })

  it('holds the 10k cap under a pathological pile of huge notes', () => {
    const state = foldOf(straddleStoryline().events)
    state.freshness.notes = Array.from({ length: 200 }, (_, i) => ({
      ts: '2026-07-11T00:00:00.000Z',
      text: `note ${i} ${'n'.repeat(500)}`,
    }))
    const status = renderStatus(state)
    expect(status).toContain('(last 5 of 200)')
    expect(status.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('digest and SessionStart render the identical section (shared seam)', () => {
    const state = foldOf(straddleStoryline().events)
    const digest = renderStatus(state) // get_state digest call shape
    const sessionStart = renderStatus(state, { sessionId: 'sess-hook', repoMemory: 'remember the thing' })
    expect(notesSection(digest)).toEqual(notesSection(sessionStart))
    expect(notesSection(digest).length).toBeGreaterThan(0)
  })
})

describe('renderFullStatus — uncapped notes section (4.2)', () => {
  it('renders every selected note with full timestamp and no count cap or clip', () => {
    const { events } = straddleStoryline()
    const long = 'x'.repeat(2_000)
    const more = [
      ...Array.from({ length: 5 }, (_, i) => ev('note_added', { text: `late note ${i}` })),
      ev('note_added', { text: long }),
    ]
    const state = foldOf([...events, ...more])
    const status = renderFullStatus(state)
    expect(status).toContain(`Notes since write-back (${state.freshness.notes.length}):`)
    expect(status).toContain(`- ${state.freshness.notes[0]!.ts} correction one`)
    expect(status).toContain('correction two')
    expect(status).toContain('late note 4')
    expect(status).toContain(long) // uncapped: the full text survives
  })

  it('collapses a multi-line note to one list line', () => {
    const { events } = straddleStoryline()
    const status = renderFullStatus(foldOf([...events, ev('note_added', { text: 'line one\n  line two' })]))
    expect(status).toContain('line one line two')
  })

  it('is absent when no notes are selected', () => {
    const { events } = straddleStoryline()
    const status = renderFullStatus(foldOf([...events, ev('session_ended', { summary: 's2', next_action: 'n2' })]))
    expect(status).not.toContain('Notes')
  })
})

// ---------------------------------------------------------------------------
// Incident regression (2026-07-11): a note recorded after the write-back must
// reach the next session's orientation — end-to-end over MCP.
// ---------------------------------------------------------------------------

describe('incident regression — post-write-back note reaches the digest', () => {
  it('end_session → add_note → get_state digest surfaces the correction beside the stale next_action', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 'released',
      next_action: 'publish 0.5.0 to npm',
    })
    await callTool(client, 'sofar_add_note', { text: '0.5.0 already published — next_action is stale' })

    const { isError, text } = await callToolText(client, 'sofar_get_state', {})
    expect(isError).toBe(false)
    expect(text).toContain('Next action: publish 0.5.0 to npm')
    expect(text).toContain('⚠ next action may be stale')
    expect(text).toContain('Notes since write-back:')
    expect(text).toContain('0.5.0 already published — next_action is stale')
    await client.close()
  })
})
