import { existsSync, readFileSync } from 'node:fs'
import { validateEnvelope, type EventEnvelope } from './envelope'
import { appendEvents, serializeEvent } from './log'

/**
 * Cursor primitive (SPEC §Cursor) — the entire future sync interface.
 * export(sinceId?) → NDJSON of events with id > sinceId, ordered by ulid.
 * import(stream)   → appends events not already present (dedupe by id).
 * Both are per-initiative: one call operates on one events.jsonl.
 */

export interface ReadEventsResult {
  events: EventEnvelope[]
  warnings: string[]
}

/**
 * Read every envelope-valid event from a log, in file order, tolerating
 * corrupt lines (same rules as the fold). A missing file is an empty log —
 * a fresh replica has no events yet.
 */
export function readEvents(logPath: string): ReadEventsResult {
  if (!existsSync(logPath)) return { events: [], warnings: [] }

  const events: EventEnvelope[] = []
  const warnings: string[] = []
  readFileSync(logPath, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const line = raw.trim()
      if (line.length === 0) return
      let decoded: unknown
      try {
        decoded = JSON.parse(line)
      } catch {
        warnings.push(`line ${index + 1}: unparseable JSON — skipped`)
        return
      }
      const check = validateEnvelope(decoded)
      if (!check.ok) {
        warnings.push(`line ${index + 1}: invalid envelope — skipped`)
        return
      }
      events.push(check.event)
    })
  return { events, warnings }
}

export interface ExportResult {
  events: EventEnvelope[]
  warnings: string[]
}

/** Events with id strictly after sinceId, ordered by ulid (lexicographic). */
export function exportEvents(logPath: string, sinceId?: string): ExportResult {
  const { events, warnings } = readEvents(logPath)
  const filtered = sinceId === undefined ? events : events.filter((e) => e.id > sinceId)
  filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { events: filtered, warnings }
}

/** NDJSON form of exportEvents — one event per line, trailing newline when non-empty. */
export function exportNDJSON(logPath: string, sinceId?: string): string {
  const { events } = exportEvents(logPath, sinceId)
  if (events.length === 0) return ''
  return events.map(serializeEvent).join('\n') + '\n'
}

export interface ImportResult {
  appended: number
  skipped: number
  warnings: string[]
}

/**
 * Import an NDJSON stream into a log. Events whose ids already exist in the
 * target (or repeat within the stream) are skipped — re-importing the same
 * stream is a no-op. New events are appended in ulid order.
 */
export function importNDJSON(logPath: string, stream: string): ImportResult {
  const warnings: string[] = []
  const existing = new Set(readEvents(logPath).events.map((e) => e.id))

  const fresh: EventEnvelope[] = []
  let skipped = 0
  stream.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (line.length === 0) return
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      warnings.push(`stream line ${index + 1}: unparseable JSON — skipped`)
      return
    }
    const check = validateEnvelope(decoded)
    if (!check.ok) {
      warnings.push(`stream line ${index + 1}: invalid envelope — skipped`)
      return
    }
    if (existing.has(check.event.id)) {
      skipped++
      return
    }
    existing.add(check.event.id) // also dedupes within the stream itself
    fresh.push(check.event)
  })

  fresh.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (fresh.length > 0) appendEvents(logPath, fresh)
  return { appended: fresh.length, skipped, warnings }
}
