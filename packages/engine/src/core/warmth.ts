import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

/**
 * When a log last GREW — read from its content, never from the filesystem.
 *
 * The gate this feeds decides which initiatives are worth folding on the hook
 * path (speed T2's 100ms end-to-end budget), so it has to be both cheap and
 * honest. mtime is cheap and dishonest: `git checkout` rewrites every
 * events.jsonl in the tree, so one branch switch makes every initiative look
 * warm and collapses the gate back to folding the whole record — the exact
 * cost the gate exists to avoid. A copy, a restore, a backup tool, or a bare
 * `touch` does the same. The log's own last event cannot be moved that way:
 * it is content, and content only changes when someone appends.
 *
 * O(1) in the size of the log. Only the tail is read, so a 5MB record answers
 * as fast as a 5KB one, which is what lets this run across every initiative
 * on a path that must not scale with accumulated history.
 *
 * Returns epoch milliseconds, or null when nothing can be read — an absent
 * log, an empty one, a tail with no parseable event. Null means "assume
 * nothing", and every caller must treat it as such rather than as "cold":
 * the whole point is that a wrong answer here silently drops a warning.
 */

/**
 * Tail window. Sized to hold several events even when payloads are large — a
 * decision's `because` runs to a few KB on its own — with a whole-file
 * fallback below for the pathological case where one line exceeds it.
 */
const TAIL_BYTES = 16_384

/** Read at most `max` bytes from the END of a file. Null if unreadable. */
function readTail(path: string, max: number): { text: string; fromStart: boolean } | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return null
    const length = Math.min(size, max)
    const start = size - length
    const buf = Buffer.allocUnsafe(length)
    readSync(fd, buf, 0, length, start)
    return { text: buf.toString('utf8'), fromStart: start === 0 }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // A close that fails cannot change the answer already read.
      }
    }
  }
}

/**
 * The newest `ts` among the complete lines in a tail chunk, or null.
 *
 * Takes the MAX rather than the last line's value. Appends are chronological
 * in practice, but nothing enforces it — `sofar event append` accepts an
 * explicit ts, and a single backdated correction landing last would otherwise
 * make a live log read as cold, which is the one error direction that loses a
 * warning.
 */
function newestTs(text: string, fromStart: boolean): number | null {
  const parts = text.split('\n')
  // Unless the read reached byte 0, the first fragment is the tail of a line
  // whose beginning was never read — it cannot be parsed and must not be.
  if (!fromStart) parts.shift()

  let newest: number | null = null
  for (const line of parts) {
    if (line.trim().length === 0) continue
    try {
      const raw: unknown = JSON.parse(line)
      if (typeof raw !== 'object' || raw === null) continue
      const ts = (raw as Record<string, unknown>).ts
      if (typeof ts !== 'string') continue
      const ms = Date.parse(ts)
      if (Number.isNaN(ms)) continue
      if (newest === null || ms > newest) newest = ms
    } catch {
      // A corrupt line is skipped exactly as the fold skips it — never fatal,
      // never a reason to call a live log cold.
    }
  }
  return newest
}

/** Epoch ms of the newest event in the log, or null when none can be read. */
export function lastAppendAt(logPath: string, tailBytes: number = TAIL_BYTES): number | null {
  const tail = readTail(logPath, tailBytes)
  if (tail === null) return null

  const found = newestTs(tail.text, tail.fromStart)
  if (found !== null) return found
  if (tail.fromStart) return null

  // One line longer than the whole window, so the tail held no complete line.
  // Rare enough to be worth a second read and too damaging to guess at.
  const whole = readTail(logPath, Number.MAX_SAFE_INTEGER)
  return whole === null ? null : newestTs(whole.text, true)
}

/**
 * Has this log grown inside the window? Null-safe in the direction that keeps
 * warnings: a log whose warmth cannot be determined counts as WARM, so an
 * unreadable tail costs one extra fold rather than a dropped conflict.
 */
export function isWarm(logPath: string, now: number, windowMs: number): boolean {
  const last = lastAppendAt(logPath)
  if (last === null) return true
  return now - last <= windowMs
}
