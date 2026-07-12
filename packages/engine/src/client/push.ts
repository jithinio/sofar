import type { EventEnvelope } from '../core/envelope'
import { serializeEvent } from '../core/log'
import { exportEvents } from '../core/cursor'
import { ApiError, apiRequest, toApiError, withRetries, type FetchLike, type RetryPolicy } from './http'

/**
 * Push — outbound sync (sync-client 3.1, SPEC §Sync client).
 *
 * Wire lines are the engine's canonical envelope JSONL, exactly what
 * events.jsonl holds — never re-serialized through anything else
 * (serializeEvent on envelope-valid events read by the cursor primitive).
 * Per-stream, ulid order, FROM EVENT ZERO on first push: the server refolds
 * the whole stream, and a stream missing its genesis events folds to an
 * empty slug/goal. Batches respect BOTH server limits (≤1000 lines, ≤5MB).
 * Push is idempotent by event id, so 429/5xx/network failures re-send the
 * SAME batch after backoff; the ack cursor advances only on a 2xx, and is
 * persisted per batch via onCursor — the offline queue is simply the log
 * after the cursor.
 */

export const MAX_BATCH_LINES = 1000
export const MAX_BATCH_BYTES = 5 * 1024 * 1024

export interface PushBatch {
  lines: string[]
  ids: string[]
  bytes: number
}

/** Split serialized events into batches under both server limits. */
export function splitBatches(events: readonly EventEnvelope[]): PushBatch[] {
  const batches: PushBatch[] = []
  let current: PushBatch = { lines: [], ids: [], bytes: 0 }
  for (const event of events) {
    const line = serializeEvent(event)
    const size = Buffer.byteLength(line, 'utf8') + 1 // the newline ships too
    const wouldOverflow =
      current.lines.length >= MAX_BATCH_LINES || current.bytes + size > MAX_BATCH_BYTES
    if (wouldOverflow && current.lines.length > 0) {
      batches.push(current)
      current = { lines: [], ids: [], bytes: 0 }
    }
    current.lines.push(line)
    current.ids.push(event.id)
    current.bytes += size
  }
  if (current.lines.length > 0) batches.push(current)
  return batches
}

export interface InvalidLine {
  line: number
  code: string
  message: string
}

export interface PushResponse {
  accepted: number
  duplicates: number
  invalid: InvalidLine[]
  head?: string
}

function decodePushResponse(body: unknown): PushResponse {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Partial<PushResponse>
  return {
    accepted: typeof raw.accepted === 'number' ? raw.accepted : 0,
    duplicates: typeof raw.duplicates === 'number' ? raw.duplicates : 0,
    invalid: Array.isArray(raw.invalid)
      ? raw.invalid.filter((entry): entry is InvalidLine => typeof entry === 'object' && entry !== null)
      : [],
    ...(typeof raw.head === 'string' && raw.head.length > 0 ? { head: raw.head } : {}),
  }
}

export function eventsPathFor(repoId: string, slug: string): string {
  return `/v1/repos/${encodeURIComponent(repoId)}/initiatives/${encodeURIComponent(slug)}/events`
}

export interface PushStreamOptions {
  /** The initiative's events.jsonl. */
  logPath: string
  slug: string
  apiUrl: string
  token: string
  repoId: string
  /** Last acked event id — absent on first push (genesis push). */
  cursor?: string
  /** Persist the ack cursor after every batch the server confirmed. */
  onCursor?: (eventId: string) => void
  /** Non-fatal surface: export warnings, invalid-line reports, retry notices. */
  onWarn?: (message: string) => void
  retry?: RetryPolicy
  fetchImpl?: FetchLike
}

export interface PushReport {
  slug: string
  /** Events past the ack cursor that this run tried to push. */
  pending: number
  accepted: number
  duplicates: number
  /** Server-rejected lines — a client bug, surfaced loudly, never fatal. */
  invalid: number
  batches: number
  /** Server head after the last batch, when reported. */
  head?: string
  /** Final ack cursor (unchanged when nothing was pending). */
  cursor?: string
}

/**
 * Push one initiative stream. Throws ApiError/network errors only after the
 * retry policy is exhausted — everything acked before the failure has already
 * been persisted through onCursor, so the next run resumes, never re-loses.
 */
export async function pushStream(opts: PushStreamOptions): Promise<PushReport> {
  const { events, warnings } = exportEvents(opts.logPath)
  for (const warning of warnings) opts.onWarn?.(`${opts.slug}: ${warning}`)

  const pending = opts.cursor === undefined ? events : events.filter((e) => e.id > opts.cursor!)
  const batches = splitBatches(pending)
  const report: PushReport = {
    slug: opts.slug,
    pending: pending.length,
    accepted: 0,
    duplicates: 0,
    invalid: 0,
    batches: 0,
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
  }

  for (const batch of batches) {
    const response = await sendBatch(opts, batch)
    report.batches += 1
    report.accepted += response.accepted
    report.duplicates += response.duplicates
    report.invalid += response.invalid.length
    if (response.head !== undefined) report.head = response.head
    for (const bad of response.invalid) {
      const id = bad.line >= 1 && bad.line <= batch.ids.length ? batch.ids[bad.line - 1] : undefined
      opts.onWarn?.(
        `${opts.slug}: server rejected event${id !== undefined ? ` ${id}` : ''} (line ${bad.line}): ` +
          `${bad.code ?? 'invalid'} — ${bad.message ?? 'no detail'}. This is a client bug worth reporting.`,
      )
    }
    // The batch is processed (accepted, duplicate, or rejected-as-invalid
    // alike) — advance past it either way, or a rejected line would wedge
    // the queue forever.
    const last = batch.ids[batch.ids.length - 1]!
    report.cursor = last
    opts.onCursor?.(last)
  }
  return report
}

/** POST one batch, retrying the SAME body on 429/5xx/network; split on 413. */
async function sendBatch(opts: PushStreamOptions, batch: PushBatch): Promise<PushResponse> {
  const post = (): Promise<PushResponse> =>
    withRetries(async () => {
      const res = await apiRequest({
        apiUrl: opts.apiUrl,
        path: eventsPathFor(opts.repoId, opts.slug),
        method: 'POST',
        token: opts.token,
        body: batch.lines.join('\n') + '\n',
        contentType: 'application/x-ndjson',
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      })
      if (!res.ok) throw await toApiError(res)
      return decodePushResponse(await res.json().catch(() => ({})))
    }, {
      ...opts.retry,
      onRetry: (err, attempt, delayMs) => {
        opts.retry?.onRetry?.(err, attempt, delayMs)
        opts.onWarn?.(
          `${opts.slug}: push attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}) — retrying same batch in ${Math.round(delayMs / 1000)}s`,
        )
      },
    })

  try {
    return await post()
  } catch (err) {
    // Our splitter enforces the documented limits, so a 413 means the server
    // is stricter than advertised — halve and recurse rather than wedging.
    if (err instanceof ApiError && err.status === 413 && batch.lines.length > 1) {
      const mid = Math.ceil(batch.lines.length / 2)
      const halves: PushBatch[] = [
        {
          lines: batch.lines.slice(0, mid),
          ids: batch.ids.slice(0, mid),
          bytes: batch.lines.slice(0, mid).reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0),
        },
        {
          lines: batch.lines.slice(mid),
          ids: batch.ids.slice(mid),
          bytes: batch.lines.slice(mid).reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0),
        },
      ]
      opts.onWarn?.(`${opts.slug}: server rejected a ${batch.lines.length}-line batch as too large — splitting`)
      const results = [] as PushResponse[]
      for (const half of halves) results.push(await sendBatch(opts, half))
      return {
        accepted: results.reduce((n, r) => n + r.accepted, 0),
        duplicates: results.reduce((n, r) => n + r.duplicates, 0),
        invalid: [
          ...results[0]!.invalid,
          ...results[1]!.invalid.map((bad) => ({ ...bad, line: bad.line + mid })),
        ],
        ...(results[1]!.head !== undefined
          ? { head: results[1]!.head }
          : results[0]!.head !== undefined
            ? { head: results[0]!.head }
            : {}),
      }
    }
    throw err
  }
}
