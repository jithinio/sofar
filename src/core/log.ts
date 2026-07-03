import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateEnvelope, type EventEnvelope } from './envelope'

/**
 * Append-only event log I/O (SPEC §Envelope rules).
 *
 * Atomicity contract: each event is serialized to exactly one line and
 * written with a single write() on a fd opened with O_APPEND. POSIX
 * guarantees the kernel advances the offset atomically per write, so
 * concurrent appenders can never interleave within a line. Readers must
 * still tolerate a torn final line (crash mid-write) — the fold does.
 */

/** JSON.stringify escapes all control characters, so this is always one line. */
export function serializeEvent(event: EventEnvelope): string {
  return JSON.stringify(event)
}

export function appendEvent(logPath: string, event: EventEnvelope): void {
  appendEvents(logPath, [event])
}

/**
 * Append a batch. All events are validated up front — an invalid event must
 * never reach the log. Each event is still its own single-write line, so
 * every individual append stays atomic with respect to concurrent writers.
 */
export function appendEvents(logPath: string, events: readonly EventEnvelope[]): void {
  for (const event of events) {
    const check = validateEnvelope(event)
    if (!check.ok) {
      const detail = check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      throw new Error(`refusing to append invalid event — ${detail}`)
    }
  }

  mkdirSync(dirname(logPath), { recursive: true })
  const fd = openSync(logPath, 'a', 0o644) // O_WRONLY | O_CREAT | O_APPEND
  try {
    for (const event of events) {
      const line = Buffer.from(serializeEvent(event) + '\n', 'utf8')
      const written = writeSync(fd, line, 0, line.length)
      if (written !== line.length) {
        throw new Error(
          `short write appending event ${event.id} (${written}/${line.length} bytes) — log may have a torn line`,
        )
      }
    }
  } finally {
    closeSync(fd)
  }
}
