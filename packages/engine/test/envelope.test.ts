import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_VERSION,
  makeEvent,
  validateEnvelope,
  type EventEnvelope,
} from '../src/core/envelope'

function valid(): EventEnvelope {
  return makeEvent({
    initiative: 'sofar-build',
    session: 'cli',
    source: 'cli',
    actor: 'agent',
    type: 'note_added',
    payload: { text: 'hello' },
  })
}

describe('makeEvent', () => {
  it('produces a valid envelope with ulid id and ISO8601 ts', () => {
    const event = valid()
    expect(event.v).toBe(ENVELOPE_VERSION)
    expect(event.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false)
    expect(validateEnvelope(event).ok).toBe(true)
  })

  it('produces sortable ids (ulid ordering matches creation order)', () => {
    const a = valid()
    const b = valid()
    expect(a.id < b.id).toBe(true)
  })
})

describe('validateEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    const result = validateEnvelope(valid())
    expect(result.ok).toBe(true)
  })

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 42, 'string', [], true]) {
      expect(validateEnvelope(bad).ok).toBe(false)
    }
  })

  const cases: Array<[string, Partial<Record<keyof EventEnvelope, unknown>>]> = [
    ['wrong version', { v: 2 }],
    ['missing id', { id: undefined }],
    ['malformed ulid', { id: 'not-a-ulid' }],
    ['ulid with excluded chars (I,L,O,U)', { id: 'ILOU'.repeat(6) + 'AB' }],
    ['non-ISO ts', { ts: 'July 3rd 2026' }],
    ['numeric ts', { ts: 1751500000000 }],
    ['empty initiative', { initiative: '' }],
    ['empty session', { session: '' }],
    ['unknown source', { source: 'cursor' }],
    ['unknown actor', { actor: 'robot' }],
    ['empty type', { type: '' }],
    ['array payload', { payload: [] }],
    ['null payload', { payload: null }],
  ]

  for (const [name, patch] of cases) {
    it(`rejects ${name}`, () => {
      const result = validateEnvelope({ ...valid(), ...patch })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0)
    })
  }

  it('reports every invalid field, not just the first', () => {
    const result = validateEnvelope({ ...valid(), v: 9, source: 'nope', payload: null })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const fields = result.errors.map((e) => e.field)
      expect(fields).toContain('v')
      expect(fields).toContain('source')
      expect(fields).toContain('payload')
    }
  })

  it('passes unknown event types (tolerance is the fold\'s job)', () => {
    const result = validateEnvelope({ ...valid(), type: 'some_future_event' })
    expect(result.ok).toBe(true)
  })
})
