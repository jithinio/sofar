/**
 * Private diagnostics ROW shape (self-improve D2, D3).
 *
 * A row is an observation about one tool call, hook firing or MCP call that
 * is too rich, too voluminous or too sensitive for the record: error text,
 * host error flags, call counts including read-only and self-recording
 * tools, injected bytes. Rows live in a per-clone store OUTSIDE the repo
 * (§Diagnostics store) and are never events — by construction, not by
 * filtering:
 *
 * - no `id`, no `v`, no `type`, no `payload`, no `source`, no `actor`: a row
 *   fails validateEnvelope on six fields at once, so a row that somehow
 *   reaches an import stream is skipped as an invalid envelope;
 * - `kind` is drawn from DIAGNOSTIC_KINDS, which shares no member with
 *   EVENT_TYPES, and the schema test pins that disjointness.
 *
 * This file is schema (CLAUDE.md: schema lives ONLY in packages/schema/src),
 * whatever its storage. The engine's store code validates every row through
 * validateDiagnosticRow before writing and never widens the shape.
 */

import { EVENT_TYPES } from './events'

export const DIAGNOSTIC_SCHEMA_VERSION = 1

export const DIAGNOSTIC_KINDS = ['tool_outcome', 'tool_failure', 'mcp_call', 'injection'] as const
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number]

/** Bound on stored error text, in UTF-16 code units, AFTER redaction (D2 (5)). */
export const DIAGNOSTIC_ERROR_CLIP = 512
/** Bound on a command's leading token as stored in `head`. */
export const DIAGNOSTIC_HEAD_CLIP = 64

/** Host that produced the observation — the agent tool, when the hook says. */
export interface DiagnosticHost {
  tool: string
  version?: string
}

/**
 * A tool call the host reported back to a PostToolUse-class hook.
 * `ok`/`exit` are the same facts D2 lets the durable event carry; here they
 * sit next to what the event may NOT carry (error text, output size, the
 * self-recording commands the record exempts).
 */
export interface ToolOutcomeData {
  /** Host tool name as the hook reported it (Bash, Edit, mcp__x__y, …). */
  tool: string
  /** true = host reported success, false = failure, null = the host said nothing either way. */
  ok: boolean | null
  /** Process exit status when the host supplies one as a number; null otherwise. */
  exit: number | null
  /** Leading token of a command (`git`, `npm`, `sofar`) — the denominator D3 (4) recovers. */
  head?: string
  /** The command was self-recording (record-hygiene D1) and appended no event. */
  exempt?: boolean
  /** The host reported the call interrupted. */
  interrupted?: boolean
  /** Bytes of stdout+stderr the host returned, when it returned text. */
  out_bytes?: number
  /** Redacted, clipped error text — never tool arguments, never transcripts. */
  error?: string
}

/** A PostToolUseFailure-class report: the call failed before or while running. */
export interface ToolFailureData {
  tool: string
  head?: string
  exempt?: boolean
  /** Redacted, clipped error text. */
  error: string
  /** Host said the failure was an interrupt; null when it did not say. */
  interrupt: boolean | null
}

/** One MCP tool call the sofar server handled — success or typed rejection. */
export interface McpCallData {
  tool: string
  ok: boolean
  /** ToolError code on rejection (invalid_input, unknown_tool, io_error, …). */
  code?: string
  /** Wall-clock milliseconds inside the handler. */
  ms?: number
}

/** What a hook injected into the model's context — the size half of a memory-use signal. */
export interface InjectionData {
  hook: string
  /** UTF-16 length of everything the hook wrote to stdout. */
  bytes: number
  /** UTF-16 length of the repo-memory portion, when the hook rendered one. */
  memory_bytes?: number
}

export interface DiagnosticDataByKind {
  tool_outcome: ToolOutcomeData
  tool_failure: ToolFailureData
  mcp_call: McpCallData
  injection: InjectionData
}

export interface DiagnosticRow<K extends DiagnosticKind = DiagnosticKind> {
  /** Row schema version — spelled `d`, never `v`, so no reader mistakes it for an envelope. */
  d: typeof DIAGNOSTIC_SCHEMA_VERSION
  /** ISO-8601 observation time. */
  ts: string
  /** Engine version that wrote the row. */
  engine: string
  host?: DiagnosticHost
  /** Hex clone key — the same hash the store directory is named by. */
  clone: string
  /** Initiative the observation was attributed to; `_unbound` when none resolved. */
  initiative: string
  /** Session id the host reported; `cli` when none. */
  session: string
  kind: K
  data: DiagnosticDataByKind[K]
}

export type DiagnosticValidation = { ok: true } | { ok: false; errors: string[] }

export function isDiagnosticKind(kind: unknown): kind is DiagnosticKind {
  return typeof kind === 'string' && (DIAGNOSTIC_KINDS as readonly string[]).includes(kind)
}

/** Every diagnostic kind is guaranteed NOT to be an event type (D2 (3)). */
export function diagnosticKindsDisjointFromEvents(): boolean {
  const events = new Set<string>(EVENT_TYPES)
  return DIAGNOSTIC_KINDS.every((kind) => !events.has(kind))
}

/** Clip text to `max` code units, marking the cut so a reader never mistakes a clip for the whole. */
export function clipDiagnosticText(text: string, max = DIAGNOSTIC_ERROR_CLIP): string {
  if (text.length <= max) return text
  const marker = '…[clipped]'
  return text.slice(0, Math.max(0, max - marker.length)) + marker
}

type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const optStr = (value: unknown): boolean => value === undefined || typeof value === 'string'
const optBool = (value: unknown): boolean => value === undefined || typeof value === 'boolean'
const optNum = (value: unknown): boolean =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value))
const boolOrNull = (value: unknown): boolean => value === null || typeof value === 'boolean'
const numOrNull = (value: unknown): boolean =>
  value === null || (typeof value === 'number' && Number.isFinite(value))

const dataValidators: Record<DiagnosticKind, (d: Obj, e: string[]) => void> = {
  tool_outcome(d, e) {
    if (!str(d.tool)) e.push('data.tool: must be a non-empty string')
    if (!boolOrNull(d.ok)) e.push('data.ok: must be a boolean or null')
    if (!numOrNull(d.exit)) e.push('data.exit: must be a number or null')
    if (!optStr(d.head)) e.push('data.head: must be a string')
    if (!optBool(d.exempt)) e.push('data.exempt: must be a boolean')
    if (!optBool(d.interrupted)) e.push('data.interrupted: must be a boolean')
    if (!optNum(d.out_bytes)) e.push('data.out_bytes: must be a number')
    if (!optStr(d.error)) e.push('data.error: must be a string')
    if (typeof d.error === 'string' && d.error.length > DIAGNOSTIC_ERROR_CLIP) {
      e.push(`data.error: must be clipped to ${DIAGNOSTIC_ERROR_CLIP} characters`)
    }
  },
  tool_failure(d, e) {
    if (!str(d.tool)) e.push('data.tool: must be a non-empty string')
    if (!optStr(d.head)) e.push('data.head: must be a string')
    if (!optBool(d.exempt)) e.push('data.exempt: must be a boolean')
    if (typeof d.error !== 'string') e.push('data.error: must be a string')
    else if (d.error.length > DIAGNOSTIC_ERROR_CLIP) {
      e.push(`data.error: must be clipped to ${DIAGNOSTIC_ERROR_CLIP} characters`)
    }
    if (!boolOrNull(d.interrupt)) e.push('data.interrupt: must be a boolean or null')
  },
  mcp_call(d, e) {
    if (!str(d.tool)) e.push('data.tool: must be a non-empty string')
    if (typeof d.ok !== 'boolean') e.push('data.ok: must be a boolean')
    if (!optStr(d.code)) e.push('data.code: must be a string')
    if (!optNum(d.ms)) e.push('data.ms: must be a number')
  },
  injection(d, e) {
    if (!str(d.hook)) e.push('data.hook: must be a non-empty string')
    if (typeof d.bytes !== 'number' || !Number.isFinite(d.bytes) || d.bytes < 0) {
      e.push('data.bytes: must be a non-negative number')
    }
    if (!optNum(d.memory_bytes)) e.push('data.memory_bytes: must be a number')
  },
}

/**
 * Validate a row before it is stored. Unknown extra keys inside `data` are
 * tolerated (rows are private and forward-compatible); the envelope-shaped
 * keys `v`, `id`, `type` and `payload` are REJECTED at the top level so a row
 * can never drift toward looking like an event.
 */
export function validateDiagnosticRow(value: unknown): DiagnosticValidation {
  if (!isObj(value)) return { ok: false, errors: ['row: must be a JSON object'] }
  const errors: string[] = []
  if (value.d !== DIAGNOSTIC_SCHEMA_VERSION) errors.push(`d: must be ${DIAGNOSTIC_SCHEMA_VERSION}`)
  for (const forbidden of ['v', 'id', 'type', 'payload', 'source', 'actor']) {
    if (forbidden in value) errors.push(`${forbidden}: envelope field — a diagnostics row must never carry it`)
  }
  if (typeof value.ts !== 'string' || Number.isNaN(Date.parse(value.ts))) {
    errors.push('ts: must be an ISO8601 timestamp')
  }
  if (!str(value.engine)) errors.push('engine: must be a non-empty string')
  if (value.host !== undefined) {
    if (!isObj(value.host) || !str(value.host.tool) || !optStr(value.host.version)) {
      errors.push('host: must be {tool, version?}')
    }
  }
  if (!str(value.clone)) errors.push('clone: must be a non-empty string')
  if (!str(value.initiative)) errors.push('initiative: must be a non-empty string')
  if (!str(value.session)) errors.push('session: must be a non-empty string')
  if (!isDiagnosticKind(value.kind)) {
    errors.push(`kind: must be one of ${DIAGNOSTIC_KINDS.join('|')}`)
  } else if (!isObj(value.data)) {
    errors.push('data: must be a JSON object')
  } else {
    dataValidators[value.kind](value.data, errors)
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
