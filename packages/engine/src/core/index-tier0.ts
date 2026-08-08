import { ACTIVITY_LIST_CAP } from './adjacency'
import { passOverRecord } from './index-pass'
import { DEFAULT_META_FILE, INDEX_SCHEMA_VERSION, readIndexFile, writeIndexFile } from './index-store'
import { type IndexedEvent } from './index-tail'

/**
 * Tier 0: which sessions are OPEN, and which files they hold (record-index 2.1).
 *
 * The hot tier, and deliberately the smallest useful thing. It answers exactly
 * one question — the one the shim path needs and cannot currently afford —
 * and answers it from a file measured in bytes rather than megabytes. Open
 * sessions are a tiny population however large the record grows: a session
 * that ended leaves, and what remains is bounded by how many agents are
 * working right now, not by how much has ever been recorded.
 *
 * FAITHFUL, NOT BETTER. Everything here mirrors the fold's semantics exactly,
 * including its limits: files are deduped in FIRST-TOUCH order and capped at
 * ACTIVITY_LIST_CAP, because that is what SessionActivity.touched does and
 * what openSessionFileConflicts therefore sees. Storing more would be an
 * improvement that broke the property the whole index rests on — that an
 * indexed answer equals the from-logs answer. If those caps should be larger,
 * the fold is the place to change, and this follows it.
 *
 * Sessions are created ONLY by session_started, matching the fold: an event
 * carrying a session id that was never registered here is `unregistered` to
 * the record, and inventing a session for it would make this disagree with
 * every other surface.
 */

const TIER0_FILE = 'open.json'

interface Tier0Disk {
  version: number
  /**
   * slug → session id → files held in the fold's own order, or NULL once the
   * session is known and finished.
   *
   * Finished sessions are remembered rather than forgotten because the fold
   * remembers them, and the difference is observable: `session_started` for an
   * id the log already knows is SKIPPED, so a start arriving after an end
   * leaves the session ended. Deleting the entry instead would let that start
   * re-open a session the record considers closed — which is exactly what a
   * union-merged log produces, since replay is in ulid order and a sibling
   * branch's write-back can sort ahead of the start it belongs to.
   */
  initiatives: Record<string, Record<string, string[] | null>>
}

/** One open session and the files it holds. */
export interface Tier0Session {
  session: string
  initiative: string
  files: string[]
}

function isTier0Disk(v: unknown): v is Tier0Disk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

/**
 * Apply one event to a slug's session map, exactly as the fold would.
 *
 * The lifecycle is copied from applyEvent rather than approximated, because
 * every one of its asymmetries is observable in the open set:
 *  - `session_started` for an id the log already knows is SKIPPED, so it can
 *    never re-open a finished session.
 *  - `session_ended` names its subject in the PAYLOAD (the write-back tool
 *    takes session_id explicitly, and this record has a mistyped one to prove
 *    it), and creates a finished stub when that subject was never started.
 *  - `session_closed` — the mechanical SessionEnd fallback — creates no stub
 *    and is ignored for a session this log never registered.
 */
function apply(sessions: Record<string, string[] | null>, ev: IndexedEvent): void {
  switch (ev.type) {
    case 'session_started':
      if (ev.session.length === 0) return
      if (sessions[ev.session] === undefined) sessions[ev.session] = []
      return
    case 'session_ended': {
      const named = ev.payload.session_id
      const subject = typeof named === 'string' && named.length > 0 ? named : ev.session
      if (subject.length === 0) return
      sessions[subject] = null
      return
    }
    case 'session_closed':
      if (ev.session.length === 0) return
      if (sessions[ev.session] === undefined) return // no stub for an unknown session
      sessions[ev.session] = null
      return
    case 'file_touched': {
      const files = sessions[ev.session]
      // undefined: never registered here — not the fold's session.
      // null: registered and finished — the fold attaches the touch, and
      // openSessionFiles then filters the session out, so the open set is the
      // same either way.
      if (files === undefined || files === null) return
      const path = ev.payload.path
      if (typeof path !== 'string' || path.length === 0) return
      // First-touch order, deduped, capped: SessionActivity.touched's contract.
      if (files.includes(path)) return
      if (files.length >= ACTIVITY_LIST_CAP) return
      files.push(path)
      return
    }
    default:
      return
  }
}

/**
 * Bring Tier 0 up to date and return it.
 *
 * Cost is O(events appended since last call) per initiative — the point of the
 * whole exercise. An initiative whose log has not grown contributes one cheap
 * stat and nothing else.
 *
 * Every judgment about whether resuming is SOUND lives in index-pass.ts, which
 * this shares with every other tier: a cursor that no longer describes its
 * file, a tail that arrives out of ulid order, a correction that voids
 * something already applied. All of them rebuild this initiative from its
 * whole log rather than merging into state that may already be wrong.
 */
export function refreshTier0(sofarDir: string): Tier0Session[] {
  const prior = readIndexFile<Tier0Disk>(sofarDir, TIER0_FILE, isTier0Disk)
  const { states, changed } = passOverRecord<Record<string, string[] | null>>(
    sofarDir,
    DEFAULT_META_FILE,
    prior === null ? null : prior.initiatives,
    { empty: () => ({}), clone: cloneSessions, apply },
  )

  const next: Tier0Disk = { version: INDEX_SCHEMA_VERSION, initiatives: states }
  if (changed) writeIndexFile(sofarDir, TIER0_FILE, next)
  return flatten(next)
}

/** Read Tier 0 without refreshing. Null when there is nothing usable on disk. */
export function readTier0(sofarDir: string): Tier0Session[] | null {
  const disk = readIndexFile<Tier0Disk>(sofarDir, TIER0_FILE, isTier0Disk)
  return disk === null ? null : flatten(disk)
}

function flatten(disk: Tier0Disk): Tier0Session[] {
  const out: Tier0Session[] = []
  for (const [initiative, sessions] of Object.entries(disk.initiatives)) {
    for (const [session, files] of Object.entries(sessions)) {
      if (files === null) continue // known and finished — not open
      out.push({ session, initiative, files: [...files] })
    }
  }
  out.sort((a, b) =>
    a.initiative === b.initiative ? a.session.localeCompare(b.session) : a.initiative.localeCompare(b.initiative),
  )
  return out
}

/** Copy one slug's map so a resume never mutates the object read from disk. */
function cloneSessions(v: Record<string, string[] | null>): Record<string, string[] | null> {
  const out: Record<string, string[] | null> = {}
  for (const [k, files] of Object.entries(v)) out[k] = files === null ? null : [...files]
  return out
}
