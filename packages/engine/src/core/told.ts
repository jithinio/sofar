import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir } from './index-store'

/**
 * What a session has already been told (memory-lead 2.1, D6): one entry per
 * (decision, subject) that a PostToolUse notice named, on a read or an edit.
 *
 * Reads append nothing to the record, so unlike the edit's lastTouch there is
 * no event to reconstruct this from. It lives in the derived index instead,
 * which makes it disposable in the safe direction: a lost, corrupt or raced
 * file re-tells a decision and never silences one. SessionStart deletes the
 * file on `compact` and `clear`, because the context that held the notices is
 * gone.
 */

const TOLD_DIR = 'told'
const TOLD_VERSION = 1

/** One told pair. The subject is the repo-relative path the notice named. */
export function toldKey(decisionId: string, subject: string): string {
  return `${decisionId} ${subject}`
}

function toldFile(sofarDir: string, session: string): string {
  return join(indexDir(sofarDir), TOLD_DIR, `${session.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
}

/** The pairs this session was told; empty for `cli` or when nothing usable is on disk. */
export function readTold(sofarDir: string, session: string): Set<string> {
  if (session === 'cli') return new Set()
  try {
    const raw = JSON.parse(readFileSync(toldFile(sofarDir, session), 'utf8')) as { v?: unknown; told?: unknown }
    if (raw.v !== TOLD_VERSION || !Array.isArray(raw.told)) return new Set()
    return new Set(raw.told.filter((k): k is string => typeof k === 'string'))
  } catch {
    return new Set()
  }
}

/** Add pairs to the session's set. Silent on failure: the cost of a lost write is one repeat. */
export function addTold(sofarDir: string, session: string, keys: readonly string[]): void {
  if (session === 'cli' || keys.length === 0) return
  try {
    const told = readTold(sofarDir, session)
    for (const key of keys) told.add(key)
    ensureIndexDir(sofarDir)
    mkdirSync(join(indexDir(sofarDir), TOLD_DIR), { recursive: true })
    writeFileAtomic(toldFile(sofarDir, session), `${JSON.stringify({ v: TOLD_VERSION, told: [...told] })}\n`)
  } catch {
    // See the header: a set that cannot be written re-tells.
  }
}

/** Forget what the session was told, because its context was compacted or cleared. */
export function clearTold(sofarDir: string, session: string): void {
  try {
    rmSync(toldFile(sofarDir, session), { force: true })
  } catch {
    // Nothing to forget.
  }
}
