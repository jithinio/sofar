import { join } from 'node:path'
import { ACTIVITY_LIST_CAP } from './adjacency'
import {
  INDEX_SCHEMA_VERSION,
  readIndexFile,
  readIndexMeta,
  writeIndexFile,
  writeIndexMeta,
  type IndexMeta,
} from './index-store'
import { readSince, type IndexedEvent } from './index-tail'
import { initiativeSlugs } from './listing'

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
  /** slug → session id → files held, in the fold's own order. */
  initiatives: Record<string, Record<string, string[]>>
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

/** Apply one event to a slug's open-session map, exactly as the fold would. */
function apply(open: Record<string, string[]>, ev: IndexedEvent): void {
  if (ev.session.length === 0) return
  switch (ev.type) {
    case 'session_started':
      if (open[ev.session] === undefined) open[ev.session] = []
      return
    case 'session_ended':
    case 'session_closed':
      delete open[ev.session]
      return
    case 'file_touched': {
      const files = open[ev.session]
      if (files === undefined) return // never registered here — not the fold's session
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
 * cursor check and nothing else.
 *
 * A `full` read means the tail reader could not corroborate its cursor (cold
 * start, rewritten log, restore), so that initiative's prior entry is DISCARDED
 * and rebuilt from the whole log. Merging into stale state there is the one way
 * this could silently diverge from truth, so it never merges.
 */
export function refreshTier0(sofarDir: string): Tier0Session[] {
  const meta: IndexMeta = readIndexMeta(sofarDir) ?? { version: INDEX_SCHEMA_VERSION, cursors: {} }
  const prior = readIndexFile<Tier0Disk>(sofarDir, TIER0_FILE, isTier0Disk)
  const next: Tier0Disk = { version: INDEX_SCHEMA_VERSION, initiatives: {} }

  for (const slug of initiativeSlugs(sofarDir)) {
    const log = join(sofarDir, 'initiatives', slug, 'events.jsonl')
    const cursor = meta.cursors[slug] ?? null
    const read = readSince(log, cursor)

    // Resume from what we had, unless the reader had to start over.
    const open: Record<string, string[]> =
      read.full || prior === null ? {} : { ...structuredCloneish(prior.initiatives[slug]) }

    for (const ev of read.events) apply(open, ev)

    next.initiatives[slug] = open
    if (read.cursor !== null) meta.cursors[slug] = read.cursor
    else delete meta.cursors[slug]
  }

  // Initiatives that vanished must not linger in the cursor map.
  for (const slug of Object.keys(meta.cursors)) {
    if (next.initiatives[slug] === undefined) delete meta.cursors[slug]
  }

  writeIndexFile(sofarDir, TIER0_FILE, next)
  writeIndexMeta(sofarDir, meta)
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
      out.push({ session, initiative, files: [...files] })
    }
  }
  out.sort((a, b) =>
    a.initiative === b.initiative ? a.session.localeCompare(b.session) : a.initiative.localeCompare(b.initiative),
  )
  return out
}

/** Copy one slug's map so a resume never mutates the object read from disk. */
function structuredCloneish(v: Record<string, string[]> | undefined): Record<string, string[]> {
  if (v === undefined) return {}
  const out: Record<string, string[]> = {}
  for (const [k, files] of Object.entries(v)) out[k] = [...files]
  return out
}
