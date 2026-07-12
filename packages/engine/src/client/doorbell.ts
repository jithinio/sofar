import { ApiError, defaultSleep, toApiError, type FetchLike, type Sleep } from './http'

/**
 * Doorbell — the SSE notification channel (sync-client 3.3, SPEC §Sync
 * client). NOTIFICATION ONLY: data always flows through pull. `data:` events
 * are {"stream":"<repo_id>/<slug>","head":"<ulid>"}; `: heartbeat` comments
 * arrive every ~25s. On any ring — and on every (re)connect after a drop —
 * the caller does a since-cursor pull, so a missed doorbell can never lose
 * data. Hand-rolled minimal SSE reader over fetch (zero new dependencies,
 * sync-client D3): data/comment lines are all this endpoint speaks.
 */

export interface DoorbellRing {
  stream: string
  head: string
}

export interface DoorbellOptions {
  apiUrl: string
  token: string
  /** Stream keys, "<repo_id>/<slug>". */
  streams: string[]
  /** A data event arrived — pull that stream. Rings are dispatched serially. */
  onRing: (ring: DoorbellRing) => void | Promise<void>
  /** Fired on EVERY successful (re)connect — do the catch-up pull here. */
  onConnect?: () => void | Promise<void>
  /**
   * Fired after a non-fatal drop or failed attempt, before the backoff
   * sleep. Doing the same catch-up pull here degrades the doorbell to
   * capped-backoff polling when the SSE channel is unusable (idle-killed
   * connections, buffering proxies) — data still flows, only through pull.
   */
  onGap?: () => void | Promise<void>
  onWarn?: (message: string) => void
  /** Abort to stop the loop (runDoorbell then resolves). */
  signal: AbortSignal
  /**
   * Consider the connection dead after this long without bytes (heartbeats
   * come every ~25s). 0 disables the watchdog. Default 90s.
   */
  idleTimeoutMs?: number
  fetchImpl?: FetchLike
  sleep?: Sleep
}

export function doorbellPath(streams: string[]): string {
  return `/v1/doorbell?streams=${encodeURIComponent(streams.join(','))}`
}

/**
 * Subscribe until aborted. Reconnects with capped exponential backoff on any
 * drop; auth/authz failures (401/404) throw instead of looping — they need a
 * human, not a retry.
 */
export async function runDoorbell(opts: DoorbellOptions): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  const idleTimeoutMs = opts.idleTimeoutMs ?? 90_000
  let backoffMs = 1000

  while (!opts.signal.aborted) {
    const controller = new AbortController()
    const abortNow = (): void => controller.abort()
    opts.signal.addEventListener('abort', abortNow, { once: true })
    let watchdog: NodeJS.Timeout | undefined
    const kick = (): void => {
      if (idleTimeoutMs <= 0) return
      if (watchdog !== undefined) clearTimeout(watchdog)
      watchdog = setTimeout(abortNow, idleTimeoutMs)
      watchdog.unref?.()
    }

    try {
      const res = await fetchImpl(`${opts.apiUrl}${doorbellPath(opts.streams)}`, {
        headers: {
          authorization: `Bearer ${opts.token}`,
          accept: 'text/event-stream',
        },
        signal: controller.signal,
      })
      if (!res.ok) throw await toApiError(res)
      if (res.body === null) throw new Error('doorbell response had no body')

      backoffMs = 1000 // a successful connect resets the ladder
      await opts.onConnect?.() // catch-up pull — a drop can never have lost data
      kick()

      const decoder = new TextDecoder()
      let buffer = ''
      let dataLines: string[] = []
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        kick()
        buffer += decoder.decode(chunk, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (line.length === 0) {
            await dispatch(dataLines, opts)
            dataLines = []
          } else if (line.startsWith(':')) {
            // heartbeat comment — the kick above already fed the watchdog
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''))
          }
          // other SSE fields (event:, id:, retry:) — not part of this contract
        }
      }
      await dispatch(dataLines, opts) // stream ended mid-event — flush what we have
    } catch (err) {
      if (opts.signal.aborted) return
      if (err instanceof ApiError && (err.status === 401 || err.status === 404)) throw err
      opts.onWarn?.(
        `doorbell connection lost (${err instanceof Error ? err.message : String(err)}) — reconnecting in ${Math.round(backoffMs / 1000)}s`,
      )
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
      opts.signal.removeEventListener('abort', abortNow)
    }

    if (opts.signal.aborted) return
    try {
      await opts.onGap?.()
    } catch (err) {
      opts.onWarn?.(`catch-up pull failed (${err instanceof Error ? err.message : String(err)})`)
    }
    if (opts.signal.aborted) return
    await sleep(backoffMs)
    backoffMs = Math.min(backoffMs * 2, 30_000)
  }
}

async function dispatch(dataLines: string[], opts: DoorbellOptions): Promise<void> {
  if (dataLines.length === 0) return
  const raw = dataLines.join('\n')
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    opts.onWarn?.(`doorbell sent unparseable data (${raw.slice(0, 120)}) — ignored`)
    return
  }
  const ring = decoded as Partial<DoorbellRing> | null
  if (
    typeof ring !== 'object' || ring === null ||
    typeof ring.stream !== 'string' || ring.stream.length === 0 ||
    typeof ring.head !== 'string'
  ) {
    opts.onWarn?.(`doorbell sent an unexpected event shape — ignored`)
    return
  }
  await opts.onRing({ stream: ring.stream, head: ring.head })
}
