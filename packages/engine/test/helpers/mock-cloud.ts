import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { validateEnvelope } from '../../src/core/envelope'

/**
 * In-process mock of api.sofar.sh — the contract-test fixture (sync-client
 * 5.1). Implements the wire shapes the sofar-cloud server ships (verified
 * against its handlers, Jul 2026): RFC-8628 device flow with OAuth
 * flat-string errors, /v1 nested {"error":{code,message}} envelopes, token
 * mint, idempotent repo create, NDJSON push (1000-line/5MB 413s, per-line
 * bad_json/bad_envelope invalids, dedupe by id), since-cursor pull with
 * X-Sofar-Cursor (echoing `since` when caught up, omitted when null), and
 * the doorbell SSE (data rings + `: heartbeat` comments). Ingest reuses the
 * engine's REAL validateEnvelope, so client and mock can never drift on what
 * a valid line is.
 *
 * `stop()` closes the listener but keeps all state; `restart()` re-listens
 * on the SAME port — the downtime-drill primitive.
 */

const MAX_BATCH_BYTES = 5 * 1024 * 1024
const MAX_BATCH_LINES = 1000

export interface RecordedRequest {
  method: string
  url: string
  body: string
}

export interface MockDeviceCode {
  deviceCode: string
  userCode: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  polls: number
}

export interface FailureScript {
  /** Remaining /v1 events requests to fail. */
  count: number
  status: number
  code?: string
  retryAfter?: string
}

export interface MockCloud {
  url: string
  port: number
  /** Every request the server saw, in order (bodies included). */
  requests: RecordedRequest[]
  orgs: Set<string>
  /** Session bearer tokens (device-flow access_tokens). */
  sessions: Set<string>
  /** sfr_ machine tokens → scopes. */
  tokens: Map<string, { scopes: string[] }>
  /** "org/name" → repo_id. */
  repos: Map<string, string>
  /** "repoId/slug" → (event id → serialized line). */
  streams: Map<string, Map<string, string>>
  deviceCodes: Map<string, MockDeviceCode>
  /** Script the next /v1 events requests to fail (429/5xx drills). */
  failEvents: FailureScript | null
  /** Force the next push response to report these invalid lines. */
  forceInvalidNext: { line: number; code: string; message: string }[] | null
  /** Emit one slow_down on the next token poll. */
  slowDownOnce: boolean
  heartbeatMs: number
  approveDevice(userCode: string): void
  denyDevice(userCode: string): void
  expireDevice(userCode: string): void
  /** Ring doorbell subscribers of a stream key ("repoId/slug"). */
  ring(streamKey: string, head: string): void
  /** Sorted event ids of a stream (assertion helper). */
  streamIds(streamKey: string): string[]
  stop(): Promise<void>
  restart(): Promise<void>
  close(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function v1Error(res: ServerResponse, status: number, code: string, message: string, headers: Record<string, string> = {}): void {
  json(res, status, { error: { code, message } }, headers)
}

/** OAuth flat-string error — the device endpoints' dialect. */
function oauthError(res: ServerResponse, code: string, description: string): void {
  json(res, 400, { error: code, error_description: description })
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startMockCloud(opts: { orgs?: string[]; heartbeatMs?: number } = {}): Promise<MockCloud> {
  const subscribers = new Map<string, Set<ServerResponse>>()
  const sockets = new Set<Socket>()
  let counter = 0

  const mock: MockCloud = {
    url: '',
    port: 0,
    requests: [],
    orgs: new Set(opts.orgs ?? ['align']),
    sessions: new Set(),
    tokens: new Map(),
    repos: new Map(),
    streams: new Map(),
    deviceCodes: new Map(),
    failEvents: null,
    forceInvalidNext: null,
    slowDownOnce: false,
    heartbeatMs: opts.heartbeatMs ?? 25_000,
    approveDevice(userCode) {
      for (const dc of mock.deviceCodes.values()) if (dc.userCode === userCode) dc.status = 'approved'
    },
    denyDevice(userCode) {
      for (const dc of mock.deviceCodes.values()) if (dc.userCode === userCode) dc.status = 'denied'
    },
    expireDevice(userCode) {
      for (const dc of mock.deviceCodes.values()) if (dc.userCode === userCode) dc.status = 'expired'
    },
    ring(streamKey, head) {
      for (const res of subscribers.get(streamKey) ?? []) {
        res.write(`data: ${JSON.stringify({ stream: streamKey, head })}\n\n`)
      }
    },
    streamIds(streamKey) {
      return [...(mock.streams.get(streamKey)?.keys() ?? [])].sort()
    },
    stop() {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        sockets.clear()
        server.close(() => resolve())
      })
    },
    restart() {
      server = createServer(safeHandler)
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      return new Promise((resolve) => server.listen(mock.port, '127.0.0.1', () => resolve()))
    },
    async close() {
      await mock.stop()
    },
  }

  function bearerOf(req: IncomingMessage): string | null {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
    return header.slice('Bearer '.length)
  }

  /** /v1 auth: sfr_ token or session bearer; null = 401 already sent. */
  function authScopes(req: IncomingMessage, res: ServerResponse): string[] | null {
    const bearer = bearerOf(req)
    if (bearer !== null) {
      const token = mock.tokens.get(bearer)
      if (token !== undefined) return token.scopes
      if (mock.sessions.has(bearer)) return ['sync', 'read']
    }
    v1Error(res, 401, 'unauthorized', 'bad or missing credentials')
    return null
  }

  function hasScope(scopes: string[], needed: 'sync' | 'read'): boolean {
    return needed === 'read' ? scopes.includes('read') || scopes.includes('sync') : scopes.includes('sync')
  }

  function repoExists(repoId: string): boolean {
    return [...mock.repos.values()].includes(repoId)
  }

  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req)
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    mock.requests.push({ method: req.method ?? '', url: req.url ?? '', body })
    const path = url.pathname

    // --- device flow -------------------------------------------------------
    if (req.method === 'POST' && path === '/api/auth/device/code') {
      const parsed = JSON.parse(body || '{}') as { client_id?: string }
      if (parsed.client_id !== 'sofar-cli') return oauthError(res, 'invalid_client', 'Invalid client ID')
      const deviceCode = randomBytes(20).toString('hex')
      const userCode = randomBytes(4).toString('hex').toUpperCase()
      mock.deviceCodes.set(deviceCode, { deviceCode, userCode, status: 'pending', polls: 0 })
      return json(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${mock.url}/device`,
        verification_uri_complete: `${mock.url}/device?user_code=${userCode}`,
        expires_in: 1800,
        interval: 5,
      })
    }

    if (req.method === 'POST' && path === '/api/auth/device/token') {
      const parsed = JSON.parse(body || '{}') as { grant_type?: string; device_code?: string; client_id?: string }
      if (parsed.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code' || parsed.client_id !== 'sofar-cli') {
        return oauthError(res, 'invalid_grant', 'Invalid grant')
      }
      const dc = parsed.device_code !== undefined ? mock.deviceCodes.get(parsed.device_code) : undefined
      if (dc === undefined) return oauthError(res, 'invalid_grant', 'Unknown device code')
      dc.polls += 1
      if (mock.slowDownOnce) {
        mock.slowDownOnce = false
        return oauthError(res, 'slow_down', 'Polling too fast')
      }
      if (dc.status === 'pending') return oauthError(res, 'authorization_pending', 'Authorization pending')
      if (dc.status === 'denied') return oauthError(res, 'access_denied', 'The user denied the request')
      if (dc.status === 'expired') return oauthError(res, 'expired_token', 'Device code expired')
      const accessToken = `sess_${randomBytes(16).toString('hex')}`
      mock.sessions.add(accessToken)
      return json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 604800, scope: '' })
    }

    // --- /v1 ----------------------------------------------------------------
    if (path === '/v1/tokens' && req.method === 'POST') {
      const bearer = bearerOf(req)
      if (bearer === null || (!mock.sessions.has(bearer) && !mock.tokens.has(bearer))) {
        return v1Error(res, 401, 'unauthorized', 'bad or missing credentials')
      }
      if (!mock.sessions.has(bearer)) {
        return v1Error(res, 403, 'session_required', 'tokens are minted with a session, not a token')
      }
      const parsed = JSON.parse(body || '{}') as { name?: unknown; scopes?: unknown }
      const name = typeof parsed.name === 'string' ? parsed.name : 'cli'
      const scopes = Array.isArray(parsed.scopes) ? (parsed.scopes as string[]) : ['sync']
      if (scopes.length === 0 || scopes.some((s) => s !== 'sync' && s !== 'read')) {
        return v1Error(res, 422, 'bad_request', 'scopes must be a non-empty subset of sync, read')
      }
      const token = `sfr_${randomBytes(24).toString('base64url')}`
      mock.tokens.set(token, { scopes })
      return json(res, 201, { token_id: `tok_${++counter}`, token, name, scopes })
    }

    if (path === '/v1/repos' && req.method === 'POST') {
      const scopes = authScopes(req, res)
      if (scopes === null) return
      if (!hasScope(scopes, 'sync')) return v1Error(res, 403, 'insufficient_scope', 'requires sync scope')
      const parsed = JSON.parse(body || '{}') as { org?: unknown; name?: unknown }
      if (typeof parsed.org !== 'string' || typeof parsed.name !== 'string') {
        return v1Error(res, 422, 'bad_request', 'org and name required')
      }
      if (!mock.orgs.has(parsed.org)) return v1Error(res, 404, 'not_found', 'unknown org')
      const key = `${parsed.org}/${parsed.name}`
      const existing = mock.repos.get(key)
      if (existing !== undefined) return json(res, 200, { repo_id: existing })
      const repoId = `repo_${++counter}`
      mock.repos.set(key, repoId)
      return json(res, 201, { repo_id: repoId })
    }

    const eventsMatch = /^\/v1\/repos\/([^/]+)\/initiatives\/([^/]+)\/events$/.exec(path)
    if (eventsMatch !== null) {
      const repoId = decodeURIComponent(eventsMatch[1]!)
      const slug = decodeURIComponent(eventsMatch[2]!)
      const streamKey = `${repoId}/${slug}`
      const scopes = authScopes(req, res)
      if (scopes === null) return
      if (mock.failEvents !== null && mock.failEvents.count > 0) {
        mock.failEvents.count -= 1
        const { status, code, retryAfter } = mock.failEvents
        if (mock.failEvents.count === 0) mock.failEvents = null
        return v1Error(res, status, code ?? 'scripted_failure', 'scripted failure', {
          ...(retryAfter !== undefined ? { 'retry-after': retryAfter } : {}),
        })
      }
      if (!repoExists(repoId)) return v1Error(res, 404, 'not_found', 'unknown repo')

      if (req.method === 'POST') {
        if (!hasScope(scopes, 'sync')) return v1Error(res, 403, 'insufficient_scope', 'requires sync scope')
        if (Buffer.byteLength(body, 'utf8') > MAX_BATCH_BYTES) {
          return v1Error(res, 413, 'batch_too_large', 'over 5MB')
        }
        const lines = body.split('\n').filter((l) => l.trim().length > 0)
        if (lines.length > MAX_BATCH_LINES) return v1Error(res, 413, 'batch_too_large', 'over 1000 lines')
        const stream = mock.streams.get(streamKey) ?? new Map<string, string>()
        mock.streams.set(streamKey, stream)
        const invalid: { line: number; code: string; message: string }[] = []
        let accepted = 0
        let duplicates = 0
        lines.forEach((line, i) => {
          let decoded: unknown
          try {
            decoded = JSON.parse(line)
          } catch (err) {
            invalid.push({ line: i + 1, code: 'bad_json', message: err instanceof Error ? err.message : 'bad json' })
            return
          }
          const check = validateEnvelope(decoded)
          if (!check.ok) {
            invalid.push({
              line: i + 1,
              code: 'bad_envelope',
              message: check.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
            })
            return
          }
          if (stream.has(check.event.id)) {
            duplicates += 1
            return
          }
          stream.set(check.event.id, line)
          accepted += 1
        })
        if (mock.forceInvalidNext !== null) {
          invalid.push(...mock.forceInvalidNext)
          mock.forceInvalidNext = null
        }
        const ids = [...stream.keys()].sort()
        const head = ids.length > 0 ? ids[ids.length - 1]! : null
        if (accepted > 0 && head !== null) mock.ring(streamKey, head)
        return json(res, 200, { accepted, duplicates, invalid, head })
      }

      if (req.method === 'GET') {
        if (!hasScope(scopes, 'read')) return v1Error(res, 403, 'insufficient_scope', 'requires read scope')
        const since = url.searchParams.get('since')
        const limitRaw = Number(url.searchParams.get('limit') ?? '1000')
        const limit = Number.isFinite(limitRaw) ? Math.min(5000, Math.max(1, Math.trunc(limitRaw))) : 1000
        const stream = mock.streams.get(streamKey)
        if (stream === undefined) return v1Error(res, 404, 'not_found', 'not found')
        const ids = [...stream.keys()].sort().filter((id) => since === null || id > since)
        const page = ids.slice(0, limit)
        const cursor = page.length > 0 ? page[page.length - 1]! : (since ?? null)
        const bodyOut = page.length > 0 ? page.map((id) => stream.get(id)!).join('\n') + '\n' : ''
        res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          ...(cursor !== null ? { 'x-sofar-cursor': cursor } : {}),
        })
        return void res.end(bodyOut)
      }
    }

    if (path === '/v1/doorbell' && req.method === 'GET') {
      const scopes = authScopes(req, res)
      if (scopes === null) return
      if (!hasScope(scopes, 'read')) return v1Error(res, 403, 'insufficient_scope', 'requires read scope')
      const streamsParam = url.searchParams.get('streams') ?? ''
      const keys = streamsParam.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      if (keys.length === 0) return v1Error(res, 422, 'bad_request', 'streams required')
      for (const key of keys) {
        const repoId = key.split('/')[0]!
        if (!repoExists(repoId)) return v1Error(res, 404, 'not_found', 'not found')
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      for (const key of keys) {
        const set = subscribers.get(key) ?? new Set<ServerResponse>()
        set.add(res)
        subscribers.set(key, set)
      }
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), mock.heartbeatMs)
      heartbeat.unref?.()
      res.on('close', () => {
        clearInterval(heartbeat)
        for (const key of keys) subscribers.get(key)?.delete(res)
      })
      return
    }

    v1Error(res, 404, 'not_found', 'not found')
  }

  /** A malformed test request must fail that request, not the process. */
  function safeHandler(req: IncomingMessage, res: ServerResponse): void {
    void handler(req, res).catch((err: unknown) => {
      if (!res.headersSent) v1Error(res, 500, 'internal', err instanceof Error ? err.message : String(err))
      else res.end()
    })
  }

  let server: Server = createServer(safeHandler)
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  mock.port = (server.address() as AddressInfo).port
  mock.url = `http://127.0.0.1:${mock.port}`
  return mock
}
