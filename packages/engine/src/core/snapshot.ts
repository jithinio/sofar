import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { schemaFingerprint } from '@sofar/schema'
import { version as ENGINE_VERSION } from '../../package.json'
import type { GraphEdge } from './adjacency'
import { validateEnvelope, type EventEnvelope } from './envelope'
import {
  appendToCheckpoint,
  countLines,
  decodeLines,
  finalizeFold,
  replayDecoded,
  type FoldCheckpoint,
  type FoldResult,
  type InitiativeState,
  type OrphanTaskEvent,
} from './fold'
import { compareCodePoints, serializeEvent } from './log'

/**
 * The public incremental fold (r1-fixes 5.1, D20, D21, D22): the CLI's own
 * fold, retained between calls as a VERSIONED snapshot, so a consumer that
 * holds one applies the tail instead of replaying the stream — cloud ingest
 * per append, the Mac app per refresh, without a process spawn or a full
 * fold.
 *
 * Laws (D20's rule): a snapshot is DERIVED state. It is not an event and
 * never validates as one, the engine never writes it under .sofar/, and
 * export, import and sync never carry it. Its version — the engine version
 * and a hash of the committed schema fingerprint — is a readable field, and
 * a mismatch on parse is a refusal carrying both versions (D21): the
 * consumer refolds, and can count why. Nothing here reads the clock or the
 * environment: every timestamp in a folded state comes from an event.
 *
 * Exactness is the 2.7 checkpoint's: `fold` applies a tail through the same
 * loop body the CLI uses, and refuses — with one of a closed set of reasons
 * (D22) — any tail the fast path cannot prove equal to a full fold: an id
 * below the cursor, a correction, a line the decoder rejects, a file whose
 * prefix no longer matches the bytes the snapshot folded. A refusal means
 * "refold from all events", never "close enough".
 */

/** Both halves readable, both compared on parse (D21). */
export interface SnapshotVersion {
  engine: string
  /** sha256 over packages/schema/schema-fingerprint.txt, byte for byte (D22). */
  schema: string
}

/** The bytes a snapshot folded (D22): what a file tail is checked against. */
export interface SnapshotPrefix {
  /** UTF-8 bytes consumed, through the last consumed line's newline. */
  bytes: number
  /**
   * sha256 of those bytes when the snapshot came from a file or a full fold
   * of values; `chain:<sha256 of "<previous>\n<tail>">` after a value tail,
   * whose earlier bytes the fold no longer holds. A file check recognises
   * the chained form and falls back to the last-line hash.
   */
  sha256: string
  /** Lines consumed. */
  lines: number
  /** sha256 of the last consumed line, without its newline; '' when no line. */
  last_line_sha256: string
}

export interface Snapshot {
  version: SnapshotVersion
  /** Greatest event id folded — the cursor a since-read continues from; '' on an empty fold. */
  cursor: string
  prefix: SnapshotPrefix
  slug: string
  /** The retained replay. Opaque to consumers; `stateOf` reads it. */
  checkpoint: FoldCheckpoint
}

/** Closed (D22): a second implementation must emit exactly these. */
export const FOLD_REFUSALS = ['version', 'out_of_order_id', 'correction', 'invalid_line', 'cursor_mismatch'] as const
export type FoldRefusal = (typeof FOLD_REFUSALS)[number]

export type FoldStep = { ok: true; snapshot: Snapshot } | { ok: false; reason: FoldRefusal; detail: string }

export type ParsedSnapshot =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; reason: 'version'; found: SnapshotVersion; expected: SnapshotVersion }
  | { ok: false; reason: 'corrupt'; detail: string }

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

let schemaHash: string | undefined
/** Computed once per process from the live fingerprint, which a test pins to the committed file. */
export function currentSchemaHash(): string {
  if (schemaHash === undefined) schemaHash = sha256(schemaFingerprint())
  return schemaHash
}

export function currentVersion(): SnapshotVersion {
  return { engine: ENGINE_VERSION, schema: currentSchemaHash() }
}

/** A text's lines as a file read splits them, and the prefix they occupy. */
function splitText(text: string): { lines: string[]; prefix: SnapshotPrefix } {
  const lines = text.split('\n')
  const count = countLines(lines)
  const consumed = count === 0 ? '' : `${lines.slice(0, count).join('\n')}\n`
  const last = count === 0 ? '' : lines[count - 1]!
  return {
    lines,
    prefix: {
      bytes: Buffer.byteLength(consumed, 'utf8'),
      sha256: sha256(consumed),
      lines: count,
      last_line_sha256: count === 0 ? '' : sha256(last),
    },
  }
}

function toText(input: readonly EventEnvelope[] | readonly string[]): string {
  let text = ''
  for (const item of input) text += `${typeof item === 'string' ? item : serializeEvent(item)}\n`
  return text
}

function fromText(text: string, slug: string): Snapshot {
  const { lines, prefix } = splitText(text)
  const checkpoint = replayDecoded(decodeLines(lines), slug, prefix.lines)
  return { version: currentVersion(), cursor: checkpoint.lastId, prefix, slug, checkpoint }
}

/** The full fold of events or raw lines, retained: what every incremental step starts from. */
export function foldAll(input: readonly EventEnvelope[] | readonly string[], slug = ''): Snapshot {
  return fromText(toText(input), slug)
}

/** The full fold of a log file's bytes; a missing file is an empty log. */
export function foldFile(logPath: string, slug = ''): Snapshot {
  return fromText(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '', slug)
}

/** Deep copy: `fold` never mutates the snapshot it was given. */
function cloneCheckpoint(cp: FoldCheckpoint): FoldCheckpoint {
  return {
    slug: cp.slug,
    state: structuredClone(cp.state),
    warnings: cp.warnings.slice(),
    voided: new Set(cp.voided),
    blockNotes: new Map(cp.blockNotes),
    edges: cp.edges.slice(),
    seenSessions: new Set(cp.seenSessions),
    orphanCandidates: cp.orphanCandidates.map((o) => ({ ...o })),
    guardCache: new Map(cp.guardCache),
    guardSeen: new Set(cp.guardSeen),
    lastId: cp.lastId,
    lineCount: cp.lineCount,
  }
}

function versionRefusal(snapshot: Snapshot): FoldStep | null {
  const expected = currentVersion()
  if (snapshot.version.engine === expected.engine && snapshot.version.schema === expected.schema) return null
  return {
    ok: false,
    reason: 'version',
    detail: `snapshot is engine ${snapshot.version.engine} schema ${snapshot.version.schema.slice(0, 12)}; this is engine ${expected.engine} schema ${expected.schema.slice(0, 12)}`,
  }
}

/**
 * Apply a tail (as text). Every refusal is decided BEFORE anything is
 * applied, so a tail is applied whole or not at all, and the input snapshot
 * is never mutated: a refusal costs nothing but the refold it asks for. The
 * prefix after a value tail is CHAINED (see SnapshotPrefix.sha256); a file
 * caller replaces it with the plain hash it can compute.
 */
function applyText(snapshot: Snapshot, tail: string): FoldStep {
  const refused = versionRefusal(snapshot)
  if (refused !== null) return refused
  const consumed = tail.length === 0 || tail.endsWith('\n') ? tail : `${tail}\n`
  const lines = consumed.length === 0 ? [] : consumed.slice(0, -1).split('\n')
  let last = snapshot.cursor
  const kept: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      return { ok: false, reason: 'invalid_line', detail: 'a tail line is not JSON' }
    }
    const check = validateEnvelope(decoded)
    if (!check.ok) {
      return {
        ok: false,
        reason: 'invalid_line',
        detail: `a tail line is not an envelope: ${check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
      }
    }
    if (check.event.type === 'correction') {
      return { ok: false, reason: 'correction', detail: `event ${check.event.id} is a correction, which voids an event already folded` }
    }
    if (check.event.id < last) {
      return { ok: false, reason: 'out_of_order_id', detail: `event ${check.event.id} precedes the cursor ${last}` }
    }
    last = check.event.id
    kept.push(line)
  }
  const cp = cloneCheckpoint(snapshot.checkpoint)
  // Line numbers advance over every tail line, blank ones included, exactly
  // as a file read numbers them; only non-blank lines are applied.
  let lineNo = cp.lineCount
  for (const raw of lines) {
    lineNo += 1
    if (raw.trim().length === 0) continue
    cp.lineCount = lineNo - 1
    if (appendToCheckpoint(cp, raw.trim()) === null) {
      return { ok: false, reason: 'invalid_line', detail: 'the decoder rejected a tail line the pre-check accepted' }
    }
  }
  cp.lineCount = lineNo
  const lastLine = lines.length > 0 ? lines[lines.length - 1]! : undefined
  const prefix: SnapshotPrefix = {
    bytes: snapshot.prefix.bytes + Buffer.byteLength(consumed, 'utf8'),
    sha256: consumed.length === 0 ? snapshot.prefix.sha256 : `chain:${sha256(`${snapshot.prefix.sha256}\n${consumed}`)}`,
    lines: cp.lineCount,
    last_line_sha256: lastLine !== undefined ? sha256(lastLine) : snapshot.prefix.last_line_sha256,
  }
  return { ok: true, snapshot: { version: snapshot.version, cursor: cp.lastId, prefix, slug: snapshot.slug, checkpoint: cp } }
}

/** Apply a tail of events or raw lines. See applyText for the refusal rules. */
export function fold(snapshot: Snapshot, events: readonly EventEnvelope[] | readonly string[]): FoldStep {
  return applyText(snapshot, toText(events))
}

/**
 * Apply what a log FILE has gained since the snapshot (D22): the file's
 * first `prefix.bytes` bytes must still hash to `prefix.sha256` — the record
 * is append-only, so a prefix that moved means a rewrite, a different file
 * or a snapshot from another clone — else `cursor_mismatch`. `since`, when
 * given, must equal the snapshot's line count. The result carries the plain
 * hash of the file's consumed bytes.
 */
export function foldFileSince(snapshot: Snapshot, logPath: string, since?: number): FoldStep {
  const refused = versionRefusal(snapshot)
  if (refused !== null) return refused
  if (since !== undefined && since !== snapshot.prefix.lines) {
    return { ok: false, reason: 'cursor_mismatch', detail: `since ${since}, but the snapshot consumed ${snapshot.prefix.lines} line(s)` }
  }
  const buffer = existsSync(logPath) ? readFileSync(logPath) : Buffer.alloc(0)
  if (buffer.length < snapshot.prefix.bytes) {
    return { ok: false, reason: 'cursor_mismatch', detail: `the file holds ${buffer.length} byte(s), fewer than the ${snapshot.prefix.bytes} the snapshot folded` }
  }
  const head = buffer.subarray(0, snapshot.prefix.bytes)
  if (snapshot.prefix.sha256.startsWith('chain:')) {
    const lastLine = lastLineOf(head)
    if ((lastLine === undefined ? '' : sha256(lastLine)) !== snapshot.prefix.last_line_sha256) {
      return { ok: false, reason: 'cursor_mismatch', detail: 'the last folded line is not where the snapshot left it' }
    }
  } else if (sha256(head) !== snapshot.prefix.sha256) {
    return { ok: false, reason: 'cursor_mismatch', detail: `the first ${snapshot.prefix.bytes} byte(s) no longer hash to what the snapshot folded` }
  }
  const tail = buffer.subarray(snapshot.prefix.bytes).toString('utf8')
  const step = applyText(snapshot, tail)
  if (!step.ok) return step
  const consumedBytes = step.snapshot.prefix.bytes
  const consumed = buffer.length >= consumedBytes ? buffer.subarray(0, consumedBytes) : Buffer.concat([buffer, Buffer.from('\n')])
  return { ok: true, snapshot: { ...step.snapshot, prefix: { ...step.snapshot.prefix, sha256: sha256(consumed) } } }
}

function lastLineOf(bytes: Buffer): string | undefined {
  const text = bytes.toString('utf8')
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  if (trimmed.length === 0) return undefined
  const at = trimmed.lastIndexOf('\n')
  return at === -1 ? trimmed : trimmed.slice(at + 1)
}

/** The folded state — finalize on a clone, so the snapshot stays reusable and the result is the caller's. */
export function stateOf(snapshot: Snapshot): FoldResult {
  const result = finalizeFold(snapshot.checkpoint)
  if (result.state.slug === '') result.state.slug = snapshot.slug
  return result
}

/** Keys sorted by code point recursively, arrays in order — what a golden holds (D22 (6)). */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodePoints)) {
      const v = (value as Record<string, unknown>)[key]
      if (v !== undefined) out[key] = sortKeysDeep(v)
    }
    return out
  }
  return value
}

/** Canonical JSON: JSON.stringify(sortKeysDeep(v), null, 2), verbatim (D22 (6)). */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2)
}

/** The serialized layout. Not a record format: bump the engine version to change it. */
interface SnapshotWire {
  version: SnapshotVersion
  cursor: string
  prefix: SnapshotPrefix
  slug: string
  checkpoint: {
    slug: string
    state: InitiativeState
    warnings: string[]
    voided: string[]
    blockNotes: [string, string][]
    edges: GraphEdge[]
    seenSessions: string[]
    orphanCandidates: OrphanTaskEvent[]
    guardSeen: string[]
    lastId: string
    lineCount: number
  }
}

export function serializeSnapshot(snapshot: Snapshot): string {
  const cp = snapshot.checkpoint
  const wire: SnapshotWire = {
    version: snapshot.version,
    cursor: snapshot.cursor,
    prefix: snapshot.prefix,
    slug: snapshot.slug,
    checkpoint: {
      slug: cp.slug,
      state: cp.state,
      warnings: cp.warnings,
      voided: [...cp.voided],
      blockNotes: [...cp.blockNotes],
      edges: cp.edges,
      seenSessions: [...cp.seenSessions],
      orphanCandidates: cp.orphanCandidates,
      // The guard cache is a compile cache: rebuilt on demand, never carried.
      guardSeen: [...cp.guardSeen],
      lastId: cp.lastId,
      lineCount: cp.lineCount,
    },
  }
  return JSON.stringify(wire)
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Parse a serialized snapshot. A version mismatch is a REFUSAL carrying both
 * versions (D21) — the consumer refolds and can count why — never a stale
 * read; corrupt text is a refusal too.
 */
export function parseSnapshot(text: string): ParsedSnapshot {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'corrupt', detail: 'not JSON' }
  }
  if (!isObj(raw) || !isObj(raw.version) || typeof raw.version.engine !== 'string' || typeof raw.version.schema !== 'string') {
    return { ok: false, reason: 'corrupt', detail: 'no readable version' }
  }
  const found: SnapshotVersion = { engine: raw.version.engine, schema: raw.version.schema }
  const expected = currentVersion()
  if (found.engine !== expected.engine || found.schema !== expected.schema) return { ok: false, reason: 'version', found, expected }
  const cp = raw.checkpoint
  const prefix = raw.prefix
  if (
    !isObj(cp) ||
    !isObj(prefix) ||
    typeof prefix.bytes !== 'number' ||
    typeof prefix.sha256 !== 'string' ||
    typeof prefix.lines !== 'number' ||
    typeof prefix.last_line_sha256 !== 'string' ||
    typeof raw.cursor !== 'string' ||
    typeof raw.slug !== 'string' ||
    typeof cp.slug !== 'string' ||
    !isObj(cp.state) ||
    !Array.isArray(cp.warnings) ||
    !Array.isArray(cp.voided) ||
    !Array.isArray(cp.blockNotes) ||
    !Array.isArray(cp.edges) ||
    !Array.isArray(cp.seenSessions) ||
    !Array.isArray(cp.orphanCandidates) ||
    !Array.isArray(cp.guardSeen) ||
    typeof cp.lastId !== 'string' ||
    typeof cp.lineCount !== 'number'
  ) {
    return { ok: false, reason: 'corrupt', detail: "checkpoint shape is not this engine's" }
  }
  const w = cp as unknown as SnapshotWire['checkpoint']
  const checkpoint: FoldCheckpoint = {
    slug: w.slug,
    state: w.state,
    warnings: w.warnings,
    voided: new Set(w.voided),
    blockNotes: new Map(w.blockNotes),
    edges: w.edges,
    seenSessions: new Set(w.seenSessions),
    orphanCandidates: w.orphanCandidates,
    guardCache: new Map(),
    guardSeen: new Set(w.guardSeen),
    lastId: w.lastId,
    lineCount: w.lineCount,
  }
  return {
    ok: true,
    snapshot: {
      version: found,
      cursor: raw.cursor,
      prefix: { bytes: prefix.bytes, sha256: prefix.sha256, lines: prefix.lines, last_line_sha256: prefix.last_line_sha256 },
      slug: raw.slug,
      checkpoint,
    },
  }
}
