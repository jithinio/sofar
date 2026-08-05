import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, type InitiativeState } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import {
  INITIATIVE_STATUSES,
  isClosedInitiativeStatus,
  validatePayload,
} from '../../schema/src/events'

/**
 * initiative-lifecycle acceptance: an initiative can be closed.
 *
 * The governing constraint mirrors task-drop-state's: a record that was never
 * closed must fold exactly as it always did — `active` is the default, so the
 * event's absence is indistinguishable from the state before it existed.
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

function foldOf(events: EventEnvelope[]): InitiativeState {
  return foldLines(events.map(serializeEvent)).state
}

const created = (): EventEnvelope[] => [ev('initiative_created', { slug: 'demo', goal: 'g' })]

describe('initiative status schema (2.1)', () => {
  it('has exactly the two terminal words tasks and phases use, plus active', () => {
    expect([...INITIATIVE_STATUSES]).toEqual(['active', 'done', 'dropped'])
    expect(isClosedInitiativeStatus('done')).toBe(true)
    expect(isClosedInitiativeStatus('dropped')).toBe(true)
    expect(isClosedInitiativeStatus('active')).toBe(false)
    // `blocked` is deliberately NOT an initiative status — blocked tasks say it.
    expect(isClosedInitiativeStatus('blocked')).toBe(false)
  })

  it('accepts done with and without a note', () => {
    expect(validatePayload('initiative_status_changed', { status: 'done' }).ok).toBe(true)
    expect(
      validatePayload('initiative_status_changed', { status: 'done', note: 'shipped in 0.19' }).ok,
    ).toBe(true)
  })

  it('requires a reason for dropped (task-drop-state D3)', () => {
    const bare = validatePayload('initiative_status_changed', { status: 'dropped' })
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.errors.join(' ')).toMatch(/note: required when status is "dropped"/)

    const empty = validatePayload('initiative_status_changed', { status: 'dropped', note: '' })
    expect(empty.ok).toBe(false)

    expect(
      validatePayload('initiative_status_changed', { status: 'dropped', note: 'superseded by X' })
        .ok,
    ).toBe(true)
  })

  it('rejects a status outside the set, and a non-string note', () => {
    const bad = validatePayload('initiative_status_changed', { status: 'archived' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.join(' ')).toMatch(/active\|done\|dropped/)

    expect(validatePayload('initiative_status_changed', { status: 'done', note: 7 }).ok).toBe(false)
  })
})

describe('fold: initiative status (2.2)', () => {
  it('defaults to active with no status event — an untouched log is unchanged', () => {
    const state = foldOf(created())
    expect(state.status).toBe('active')
    expect(state.status_ts).toBeNull()
    expect(state.status_note).toBeNull()
  })

  it('records the status, when it was set, and why', () => {
    const close = ev('initiative_status_changed', { status: 'done', note: 'goal met' })
    const state = foldOf([...created(), close])
    expect(state.status).toBe('done')
    expect(state.status_ts).toBe(close.ts)
    expect(state.status_note).toBe('goal met')
  })

  it('carries a drop reason', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'dropped', note: 'subsumed by record-graph' }),
    ])
    expect(state.status).toBe('dropped')
    expect(state.status_note).toBe('subsumed by record-graph')
  })

  it('reopening is just another event, and clears the closure it undoes', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'done', note: 'goal met' }),
      ev('initiative_status_changed', { status: 'active' }),
    ])
    expect(state.status).toBe('active')
    expect(state.status_note).toBeNull()
    expect(state.status_ts).not.toBeNull() // when it reopened, not when it closed
  })

  it('the last status wins, and closing does not disturb the rest of the fold', () => {
    const state = foldOf([
      ...created(),
      ev('initiative_status_changed', { status: 'done', note: 'first' }),
      ev('note_added', { text: 'after the close' }),
      ev('initiative_status_changed', { status: 'dropped', note: 'second' }),
    ])
    expect(state.status).toBe('dropped')
    expect(state.status_note).toBe('second')
    expect(state.goal).toBe('g')
    expect(state.freshness.notes.some((n) => n.text === 'after the close')).toBe(true)
  })

  it('an invalid status event is skipped with a warning, leaving the record active', () => {
    const { state, warnings } = foldLines(
      [...created(), ev('initiative_status_changed', { status: 'dropped' })].map(serializeEvent),
    )
    expect(state.status).toBe('active')
    expect(warnings.join(' ')).toMatch(/invalid initiative_status_changed payload/)
  })
})
