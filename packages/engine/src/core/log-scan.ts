import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Reading a log's new bytes without folding it (in-session-drive D2,
 * drive-visibility 2.2, 3.1, 3.4), in core/ so the hot-path readers — the
 * `--await` hook among them — reach it without importing the driver.
 */

/**
 * How often a driver waiting on a session looks for `sofar drive --stop`
 * (in-session-drive D2) and for another driver's adoption of its run
 * (drive-visibility 2.2). Either is someone who has already decided, so
 * seconds matter more than they do for the gauge, and a tick is a stat.
 */
export const STOP_POLL_MS = 2_000

/**
 * The bytes a line must contain for the byte scan to fold: a stop request, or
 * an adoption that may have taken the run from this driver. Nothing else a
 * session appends can change what the driver does next while it waits.
 */
export const RUN_EVENT_MARKERS = ['"run_stop_requested"', '"run_adopted"'] as const

/**
 * A scan of the bytes appended to a log since the last call: true when they
 * name one of `markers`. It stats the log and reads only what is new, so a
 * caller that ticks every few seconds for hours costs a stat per tick, and
 * folds only when the new bytes are worth it. It decides nothing — the caller
 * folds and reads — it only says when the fold is worth asking.
 */
export function appendedBytesScan(path: string, from: number, markers: readonly string[]): () => boolean {
  let offset = from
  // A marker can straddle two reads; carrying the longest one's length back covers that.
  const carryLength = Math.max(...markers.map((m) => m.length))
  let carry = ''
  return () => {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return false
    }
    if (size <= offset) {
      offset = size
      return false
    }
    const fd = openSync(path, 'r')
    let text: string
    try {
      const bytes = Buffer.alloc(size - offset)
      readSync(fd, bytes, 0, bytes.length, offset)
      text = carry + bytes.toString('utf8')
    } finally {
      closeSync(fd)
    }
    offset = size
    carry = text.slice(-carryLength)
    return markers.some((marker) => text.includes(marker))
  }
}
