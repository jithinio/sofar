import { importNDJSON } from '../core/cursor'
import { apiRequest, toApiError, withRetries, type FetchLike, type RetryPolicy } from './http'
import { eventsPathFor } from './push'

/**
 * Pull — inbound sync (sync-client 3.2, SPEC §Sync client).
 *
 * Pages GET …/events?since=<cursor>&limit=<n> in ulid order; every response
 * carries an X-Sofar-Cursor header, and an EMPTY body with the same cursor
 * means caught up. Lines are engine-canonical envelopes, imported with
 * `sofar import` semantics — dedupe by id, so re-pulling (or pulling your
 * own pushed events back) is always safe; skipping own-source events would
 * be an optimization, never a correctness requirement. The inbound cursor
 * is persisted per page AFTER the import lands (crash between the two
 * re-pulls a page — dedupe absorbs it; the reverse order could lose one).
 * It is tracked separately from the push ack cursor.
 */

export const CURSOR_HEADER = 'x-sofar-cursor'
export const DEFAULT_PULL_LIMIT = 1000

export interface PullStreamOptions {
  /** The initiative's events.jsonl (created on first import when absent). */
  logPath: string
  slug: string
  apiUrl: string
  token: string
  repoId: string
  /** Inbound cursor — absent pulls from genesis. */
  cursor?: string
  /** Page size (server default 1000, max 5000). */
  limit?: number
  /** Persist the inbound cursor after each imported page. */
  onCursor?: (cursor: string) => void
  /** Non-fatal surface: import warnings, retry notices. */
  onWarn?: (message: string) => void
  retry?: RetryPolicy
  fetchImpl?: FetchLike
}

export interface PullReport {
  slug: string
  /** Envelope lines the server sent. */
  fetched: number
  /** New events appended to the local log. */
  appended: number
  /** Lines already present locally (dedupe by id). */
  skipped: number
  pages: number
  /** Final inbound cursor (unchanged when the server sent none). */
  cursor?: string
}

export async function pullStream(opts: PullStreamOptions): Promise<PullReport> {
  const limit = opts.limit ?? DEFAULT_PULL_LIMIT
  const report: PullReport = {
    slug: opts.slug,
    fetched: 0,
    appended: 0,
    skipped: 0,
    pages: 0,
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
  }

  let since = opts.cursor
  for (;;) {
    const page = await withRetries(async () => {
      const query = new URLSearchParams()
      if (since !== undefined) query.set('since', since)
      query.set('limit', String(limit))
      const res = await apiRequest({
        apiUrl: opts.apiUrl,
        path: `${eventsPathFor(opts.repoId, opts.slug)}?${query.toString()}`,
        method: 'GET',
        accept: 'application/x-ndjson',
        token: opts.token,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      })
      if (!res.ok) throw await toApiError(res)
      return { body: await res.text(), cursor: res.headers.get(CURSOR_HEADER) }
    }, {
      ...opts.retry,
      onRetry: (err, attempt, delayMs) => {
        opts.retry?.onRetry?.(err, attempt, delayMs)
        opts.onWarn?.(
          `${opts.slug}: pull attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}) — retrying in ${Math.round(delayMs / 1000)}s`,
        )
      },
    })
    report.pages += 1

    if (page.body.trim().length === 0) {
      // Caught up. The header still moves the cursor forward (same value as
      // the last page, or the head on a since-only probe).
      if (page.cursor !== null && page.cursor.length > 0 && page.cursor !== report.cursor) {
        report.cursor = page.cursor
        opts.onCursor?.(page.cursor)
      }
      return report
    }

    const lines = page.body.split('\n').filter((l) => l.trim().length > 0)
    const result = importNDJSON(opts.logPath, page.body)
    for (const warning of result.warnings) opts.onWarn?.(`${opts.slug}: ${warning}`)
    report.fetched += lines.length
    report.appended += result.appended
    report.skipped += result.skipped

    if (page.cursor === null || page.cursor.length === 0) {
      opts.onWarn?.(`${opts.slug}: server sent no ${CURSOR_HEADER} header — stopping after this page`)
      return report
    }
    if (page.cursor === since) {
      // Defensive: a non-empty page that does not advance the cursor would
      // loop forever; trust the dedupe and stop.
      opts.onWarn?.(`${opts.slug}: server cursor did not advance — stopping`)
      return report
    }
    report.cursor = page.cursor
    opts.onCursor?.(page.cursor)
    since = page.cursor
  }
}
