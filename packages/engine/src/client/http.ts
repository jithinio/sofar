/**
 * HTTP core for the sync client (sync-client 1.2, SPEC §Sync client).
 *
 * Native fetch only (Node >=18 — zero new dependencies, sync-client D3).
 * /v1 errors are `{"error":{"code":"snake_case","message":"…"}}`; the device
 * endpoints speak OAuth-style `{"error":"code"}` — toApiError normalizes
 * both. Retries are reserved for the cases where re-sending the SAME request
 * is safe and useful: 429 (honoring Retry-After), 5xx, and network failures.
 * Everything else is the caller's problem to explain (401 → login hint,
 * 404 → honest not-found-or-not-a-member copy).
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class ApiError extends Error {
  readonly status: number
  /** snake_case server code, or `http_<status>` when the body carried none. */
  readonly code: string
  /** Parsed Retry-After (ms), when the response carried one. */
  readonly retryAfterMs: number | undefined

  constructor(status: number, code: string, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

/** Retry-After is either delta-seconds or an HTTP-date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

/** Normalize an error body — `{"error":{code,message}}` or OAuth `{"error":"code"}`. */
export function errorParts(body: unknown): { code?: string; message?: string } {
  if (typeof body !== 'object' || body === null) return {}
  const err = (body as { error?: unknown }).error
  if (typeof err === 'string') {
    const description = (body as { error_description?: unknown }).error_description
    return { code: err, ...(typeof description === 'string' ? { message: description } : {}) }
  }
  if (typeof err === 'object' && err !== null) {
    const { code, message } = err as { code?: unknown; message?: unknown }
    return {
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof message === 'string' ? { message } : {}),
    }
  }
  return {}
}

/** Build the ApiError for a non-2xx response (consumes the body). */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown
  try {
    body = await readJsonCapped(res) // an error body is still a body a server controls
  } catch {
    body = undefined
  }
  const { code, message } = errorParts(body)
  return new ApiError(
    res.status,
    code ?? `http_${res.status}`,
    message ?? code ?? `HTTP ${res.status}`,
    parseRetryAfter(res.headers.get('retry-after')),
  )
}

export interface RequestOptions {
  apiUrl: string
  /** Path starting with '/'. */
  path: string
  method?: string
  /** Bearer credential — the sfr_ token, or the device flow's access_token. */
  token?: string
  /** JSON body (serialized here) — exclusive with `body`. */
  json?: unknown
  /** Raw body (NDJSON batches). */
  body?: string
  contentType?: string
  accept?: string
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/**
 * One request, no status-based throw — network failures reject, HTTP errors
 * come back as the Response so callers that poll (device flow) can read them.
 */
export async function apiRequest(opts: RequestOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike)
  const headers: Record<string, string> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  if (opts.accept !== undefined) headers.accept = opts.accept
  let body: string | undefined
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json)
    headers['content-type'] = opts.contentType ?? 'application/json'
  } else if (opts.body !== undefined) {
    body = opts.body
    headers['content-type'] = opts.contentType ?? 'application/x-ndjson'
  }
  return fetchImpl(`${opts.apiUrl}${opts.path}`, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  })
}

/**
 * Ceiling on any single response this client will buffer.
 *
 * `res.json()`/`res.text()` read until the server stops sending, so a server
 * that never stops is a memory-exhaustion primitive aimed at the CLI. 32 MB is
 * far above a real page — the server caps a push batch at 5 MB and a pull page
 * at 5000 events — and far below anything that hurts.
 */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

/** Body as text, aborting the moment it grows past `maxBytes`. */
export async function readTextCapped(res: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  const body = res.body as ReadableStream<Uint8Array> | null
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        throw new ApiError(res.status, 'response_too_large', `response exceeded ${maxBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Capped JSON read; undefined when the body is absent or not JSON. */
export async function readJsonCapped(res: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
  const text = await readTextCapped(res, maxBytes)
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** JSON request that throws a typed ApiError on any non-2xx status. */
export async function apiJson<T>(opts: RequestOptions): Promise<T> {
  const res = await apiRequest(opts)
  if (!res.ok) throw await toApiError(res)
  return (await readJsonCapped(res)) as T
}

// ---------------------------------------------------------------------------
// Retry/backoff — 429 (Retry-After honored), 5xx, network. Never other 4xx.
// ---------------------------------------------------------------------------

export type Sleep = (ms: number) => Promise<void>

export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export interface RetryPolicy {
  /** Total attempts including the first (default 5). */
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  sleep?: Sleep
  /** Surface each retry ("waiting …ms after <reason>") without failing. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void
}

/** Is re-sending the same request safe and worthwhile for this failure? */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500
  // Anything that never produced a Response: DNS failure, refused connection,
  // reset mid-body, watchdog abort — fetch rejects with a TypeError/AbortError.
  return true
}

export async function withRetries<T>(fn: () => Promise<T>, policy: RetryPolicy = {}): Promise<T> {
  const attempts = Math.max(1, policy.attempts ?? 5)
  const base = policy.baseDelayMs ?? 1000
  const cap = policy.maxDelayMs ?? 30_000
  const sleep = policy.sleep ?? defaultSleep
  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === attempts || !isRetryable(err)) throw err
      const backoff = Math.min(cap, base * 2 ** (attempt - 1))
      const delayMs =
        err instanceof ApiError && err.retryAfterMs !== undefined
          ? Math.min(cap, Math.max(err.retryAfterMs, 0))
          : backoff
      policy.onRetry?.(err, attempt, delayMs)
      await sleep(delayMs)
    }
  }
  throw lastErr // unreachable, satisfies control-flow analysis
}
