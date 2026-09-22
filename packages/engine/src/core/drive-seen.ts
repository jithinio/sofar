import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * What each session last saw of its initiative's run (drive-visibility 3.2):
 * the mark that lets the prompt's drive line speak only when the run moved.
 *
 * Per-clone state, outside the repo (SPEC §Driver, watching a run): a mark is
 * about one session on one machine, so it is never committed, and a lost one
 * costs a repeated line. The failure direction is the rule here, and it is the
 * opposite of shipwatch's: a mark that cannot be read counts as never seen, and
 * one that cannot be written is news again next prompt, so the line REPEATS —
 * it never goes silent on a run that moved.
 *
 * Sessions sharing a clone share this file. Two prompts in the same instant can
 * revert each other's marks, which again only repeats a line.
 */

/** Bump on ANY change to the on-disk shape — a mismatch reads as no marks. */
export const DRIVE_SEEN_VERSION = 1

/** Marks kept before the least recently marked are evicted; an evicted session sees its line once more. */
export const DRIVE_SEEN_MAX_MARKS = 64

interface Mark {
  seen: string
  seq: number
}

/** `<state base>/drive-seen/<clone key>.json`, or null where that would sit inside the repo. */
export function driveSeenPath(rootDir: string, env: StateEnv = process.env): string | null {
  const path = join(stateBase(env), 'drive-seen', `${cloneKey(rootDir)}.json`)
  return resolvesInside(path, rootDir) ? null : path
}

function readMarks(path: string): Record<string, Mark> {
  let disk: unknown
  try {
    disk = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  if (typeof disk !== 'object' || disk === null) return {}
  const d = disk as { version?: unknown; marks?: unknown }
  if (d.version !== DRIVE_SEEN_VERSION || typeof d.marks !== 'object' || d.marks === null) return {}
  const marks: Record<string, Mark> = {}
  for (const [id, mark] of Object.entries(d.marks as Record<string, unknown>)) {
    const m = mark as Partial<Mark> | null
    if (typeof m?.seen === 'string' && typeof m.seq === 'number' && Number.isFinite(m.seq)) marks[id] = { seen: m.seen, seq: m.seq }
  }
  return marks
}

/**
 * Whether `seen` is news to this session, marking it seen when it is. Writes
 * only on news, so a prompt on an unchanged run costs one small read.
 */
export function noteDriveSeen(rootDir: string, sessionId: string, seen: string, env: StateEnv = process.env): boolean {
  const path = driveSeenPath(rootDir, env)
  if (path === null) return true
  const marks = readMarks(path)
  if (marks[sessionId]?.seen === seen) return false
  let seq = 0
  for (const mark of Object.values(marks)) if (mark.seq > seq) seq = mark.seq
  marks[sessionId] = { seen, seq: seq + 1 }
  const ids = Object.keys(marks)
  const kept: Record<string, Mark> = {}
  for (const id of ids.sort((a, b) => marks[b]!.seq - marks[a]!.seq).slice(0, DRIVE_SEEN_MAX_MARKS)) kept[id] = marks[id]!
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, JSON.stringify({ version: DRIVE_SEEN_VERSION, marks: kept }))
  } catch {
    // Unwritable: this run is news again next prompt, which is the safe direction.
  }
  return true
}
