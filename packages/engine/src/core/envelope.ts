import { monotonicFactory } from 'ulid'
import { gitUserEmail } from './identity'

// Same-millisecond ulids from the default generator are randomly ordered;
// the cursor contract (export "events since id") needs creation order to
// match sort order, so ids must be monotonic within a process.
const ulid = monotonicFactory()

/**
 * Event envelope (SPEC §Envelope) — v1, stable. Payloads evolve (src/schema/),
 * the envelope does not. One JSON object per line in events.jsonl.
 */

export const ENVELOPE_VERSION = 1 as const

export const SOURCES = ['claude-code', 'opencode', 'codex', 'cli', 'hook'] as const
export type Source = (typeof SOURCES)[number]

export const ACTORS = ['agent', 'human'] as const
export type Actor = (typeof ACTORS)[number]

export interface EventEnvelope {
  v: typeof ENVELOPE_VERSION
  /** ulid — sortable, unique */
  id: string
  /** ISO8601 timestamp */
  ts: string
  /** initiative slug */
  initiative: string
  /** session id, or "cli" for direct CLI appends */
  session: string
  source: Source
  actor: Actor
  /**
   * Author identity — `git config user.email` stamped when the event was
   * minted, absent when unavailable (team-readiness T1). Strictly additive:
   * the envelope stays v1 and readers tolerate absence everywhere.
   */
  user?: string
  type: string
  payload: Record<string, unknown>
}

export interface EnvelopeError {
  field: string
  message: string
}

export type EnvelopeValidation =
  | { ok: true; event: EventEnvelope }
  | { ok: false; errors: EnvelopeError[] }

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Structural validation of a decoded log line against the v1 envelope.
 * Does NOT validate payload contents — payload schemas live in src/schema/.
 * Unknown event types pass here; tolerating them is the fold's job.
 */
export function validateEnvelope(value: unknown): EnvelopeValidation {
  if (!isPlainObject(value)) {
    return { ok: false, errors: [{ field: '(root)', message: 'event must be a JSON object' }] }
  }

  const errors: EnvelopeError[] = []

  if (value.v !== ENVELOPE_VERSION) {
    errors.push({ field: 'v', message: `must be ${ENVELOPE_VERSION}` })
  }
  if (typeof value.id !== 'string' || !ULID_RE.test(value.id)) {
    errors.push({ field: 'id', message: 'must be a 26-char ulid' })
  }
  if (
    typeof value.ts !== 'string' ||
    !ISO8601_RE.test(value.ts) ||
    Number.isNaN(Date.parse(value.ts))
  ) {
    errors.push({ field: 'ts', message: 'must be an ISO8601 timestamp' })
  }
  if (typeof value.initiative !== 'string' || value.initiative.length === 0) {
    errors.push({ field: 'initiative', message: 'must be a non-empty slug' })
  }
  if (typeof value.session !== 'string' || value.session.length === 0) {
    errors.push({ field: 'session', message: 'must be a non-empty session id (or "cli")' })
  }
  if (typeof value.source !== 'string' || !(SOURCES as readonly string[]).includes(value.source)) {
    errors.push({ field: 'source', message: `must be one of: ${SOURCES.join(', ')}` })
  }
  if (typeof value.actor !== 'string' || !(ACTORS as readonly string[]).includes(value.actor)) {
    errors.push({ field: 'actor', message: `must be one of: ${ACTORS.join(', ')}` })
  }
  if (value.user !== undefined && (typeof value.user !== 'string' || value.user.length === 0)) {
    errors.push({ field: 'user', message: 'when present, must be a non-empty string' })
  }
  if (typeof value.type !== 'string' || value.type.length === 0) {
    errors.push({ field: 'type', message: 'must be a non-empty event type' })
  }
  if (!isPlainObject(value.payload)) {
    errors.push({ field: 'payload', message: 'must be a JSON object' })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, event: value as unknown as EventEnvelope }
}

export interface MakeEventInput {
  initiative: string
  session: string
  source: Source
  actor: Actor
  type: string
  payload: Record<string, unknown>
}

/**
 * Build a valid envelope with a fresh ulid id and current timestamp.
 * Locally-minted events are stamped with author identity here — imported
 * events never pass through makeEvent, so `sofar import` cannot restamp.
 */
export function makeEvent(input: MakeEventInput): EventEnvelope {
  const user = gitUserEmail()
  const event: EventEnvelope = {
    v: ENVELOPE_VERSION,
    id: ulid(),
    ts: new Date().toISOString(),
    initiative: input.initiative,
    session: input.session,
    source: input.source,
    actor: input.actor,
    ...(user !== undefined ? { user } : {}),
    type: input.type,
    payload: input.payload,
  }
  const check = validateEnvelope(event)
  if (!check.ok) {
    const detail = check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
    throw new Error(`makeEvent produced an invalid envelope — ${detail}`)
  }
  return event
}
