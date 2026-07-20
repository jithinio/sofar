import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, join, relative, sep } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { watch } from 'chokidar'
import { emptyState, foldLog, type InitiativeState } from '../core/fold'
import { createSofarServer } from '../mcp/server'
import { type Caps, createStyle, stderrCaps } from './ui'

/**
 * `sofar serve [--port 4173]` (task 4.5, SPEC §CLI) — the watcher +
 * localhost JSON state server. node:http only, bound to 127.0.0.1 ONLY
 * (localhost law: JSON on localhost, no UI, no sync, no telemetry).
 *
 * Routes:
 *   /state         → { initiatives: { <slug>: InitiativeState } }  (GET)
 *   /state/<slug>  → single InitiativeState (404 unknown)          (GET)
 *   /events        → SSE: `event: state` + {slug, state} JSON pushed when a
 *                    chokidar watch sees an events.jsonl append (≤500ms,
 *                    SPEC §Acceptance Phase 4); `: heartbeat` every 15s.
 *   /mcp           → the frozen 7-tool MCP surface over streamable HTTP
 *                    (speed T3): POST for JSON-RPC, GET for the notification
 *                    stream, DELETE for session termination. One FRESH
 *                    SofarServerHandle per MCP session — its own ToolContext
 *                    and active-session pin — so concurrent agent sessions
 *                    on the daemon can never share the BD58 pin (the Phase
 *                    11/12 misroute class). Transport only: the tool surface
 *                    is byte-identical to `sofar mcp` stdio, which remains
 *                    the default registration.
 *
 * startServer is a factory returning {port, close} so tests can run on an
 * ephemeral port and shut down without dangling handles.
 */

export const DEFAULT_PORT = 4173
export const HEARTBEAT_MS = 15_000
export const RECONCILE_MS = 250

const SLUG_PATH_RE = /^[a-z0-9-]+$/ // slugs only — a path segment never walks the fs

export interface ServeOptions {
  root: string
  /** 0 = ephemeral (tests). Default 4173. */
  port?: number
}

export interface ServeHandle {
  port: number
  url: string
  close(): Promise<void>
}

/**
 * One-line startup banner (cli-ui 2.5) for the stderr messaging channel:
 * brand accent on the command name, dim URL/endpoints — quiet. Wording is
 * identical styled or plain, so piped stderr stays byte-identical.
 */
export function renderServeBanner(url: string, caps: Caps = stderrCaps()): string {
  const endpoints = `${url} (GET /state, /state/<slug>, /events SSE, /mcp MCP)`
  if (!caps.color) return `sofar serve: ${endpoints}\n`
  const style = createStyle(true)
  return `${style.accent('sofar serve')}: ${style.dim(endpoints)}\n`
}

export async function startServer(options: ServeOptions): Promise<ServeHandle> {
  const initiativesDir = join(options.root, '.sofar', 'initiatives')

  function listSlugs(): string[] {
    if (!existsSync(initiativesDir)) return []
    return readdirSync(initiativesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  }

  function foldSlug(slug: string): InitiativeState {
    const logPath = join(initiativesDir, slug, 'events.jsonl')
    let state: InitiativeState
    try {
      state = existsSync(logPath) ? foldLog(logPath).state : emptyState()
    } catch {
      state = emptyState() // a torn read must not take the endpoint down
    }
    if (state.slug === '') state.slug = slug
    return state
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  // --- SSE clients -----------------------------------------------------------
  const clients = new Set<ServerResponse>()
  const logVersions = new Map<string, string>()

  function logVersion(slug: string): string | null {
    try {
      const stat = statSync(join(initiativesDir, slug, 'events.jsonl'))
      return `${stat.size}:${stat.mtimeMs}`
    } catch {
      return null
    }
  }

  function rememberCurrentLogs(): void {
    for (const slug of listSlugs()) {
      const version = logVersion(slug)
      if (version !== null) logVersions.set(slug, version)
    }
  }

  function broadcastIfLogChanged(slug: string): void {
    const version = logVersion(slug)
    if (version === null || logVersions.get(slug) === version) return
    logVersions.set(slug, version)
    broadcast(slug)
  }

  function openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    clients.add(res)
    res.on('close', () => clients.delete(res))
  }

  function broadcast(slug: string): void {
    if (clients.size === 0) return
    const frame = `event: state\ndata: ${JSON.stringify({ slug, state: foldSlug(slug) })}\n\n`
    for (const client of clients) client.write(frame)
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref()

  const reconcile = setInterval(() => {
    if (clients.size === 0) return
    for (const slug of listSlugs()) broadcastIfLogChanged(slug)
  }, RECONCILE_MS)
  reconcile.unref()

  // --- watcher: append to any .sofar/**/events.jsonl → re-fold + push -----
  // A directory created and populated in one burst (sofar new) can lose
  // the file's `add` event to a chokidar/fsevents race — the `addDir` for
  // the initiative dir is delivered reliably, so push from it too, waiting
  // briefly for the log to land before folding (bounded, then push anyway).
  function broadcastWhenLogExists(slug: string, tries: number): void {
    if (tries <= 0 || existsSync(join(initiativesDir, slug, 'events.jsonl'))) {
      const version = logVersion(slug)
      if (version !== null) logVersions.set(slug, version)
      broadcast(slug)
      return
    }
    setTimeout(() => broadcastWhenLogExists(slug, tries - 1), 50).unref()
  }

  const watcher = watch(initiativesDir, { ignoreInitial: true })
  watcher.on('all', (event, path) => {
    const rel = relative(initiativesDir, path)
    if (rel.length === 0 || rel.startsWith('..')) return
    const slug = rel.split(sep)[0]
    if (slug === undefined || slug.length === 0) return
    if (event === 'addDir') {
      if (rel === slug) broadcastWhenLogExists(slug, 20) // new initiative dir
      return
    }
    if (event !== 'add' && event !== 'change') return
    if (basename(path) !== 'events.jsonl') return // projections regenerate too — ignore
    const version = logVersion(slug)
    if (version !== null) logVersions.set(slug, version)
    broadcast(slug)
  })

  // --- MCP over streamable HTTP (speed T3) -----------------------------------
  // One transport (and one fresh SofarServerHandle behind it) per MCP
  // session: the per-session ToolContext keeps the BD58 active-session pin
  // isolated between concurrent agent sessions on this daemon.
  const mcpTransports = new Map<string, StreamableHTTPServerTransport>()

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolveBody) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          resolveBody(undefined) // the transport 400s an unparseable body
        }
      })
      req.on('error', () => resolveBody(undefined))
    })
  }

  function mcpError(res: ServerResponse, status: number, message: string): void {
    // JSON-RPC error shape — MCP clients parse this, not our {error} shape.
    json(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null })
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionHeader = req.headers['mcp-session-id']
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined
    try {
      if (req.method === 'POST') {
        const body = await readBody(req)
        const existing = sessionId !== undefined ? mcpTransports.get(sessionId) : undefined
        if (existing !== undefined) {
          await existing.handleRequest(req, res, body)
          return
        }
        if (sessionId === undefined && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              mcpTransports.set(sid, transport)
            },
          })
          transport.onclose = () => {
            if (transport.sessionId !== undefined) mcpTransports.delete(transport.sessionId)
          }
          const handle = createSofarServer({ rootDir: options.root })
          await handle.server.connect(transport)
          await transport.handleRequest(req, res, body)
          return
        }
        mcpError(
          res,
          sessionId === undefined ? 400 : 404,
          sessionId === undefined
            ? 'Bad Request: not an initialize request and no mcp-session-id header'
            : 'Session not found — reinitialize',
        )
        return
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        const transport = sessionId !== undefined ? mcpTransports.get(sessionId) : undefined
        if (transport === undefined) {
          mcpError(
            res,
            sessionId === undefined ? 400 : 404,
            sessionId === undefined ? 'Bad Request: missing mcp-session-id header' : 'Session not found — reinitialize',
          )
          return
        }
        await transport.handleRequest(req, res)
        return
      }
      mcpError(res, 405, 'Method not allowed')
    } catch {
      // a broken MCP exchange must never take the daemon down
      if (!res.headersSent) mcpError(res, 500, 'Internal error')
      else res.end()
    }
  }

  // --- http ------------------------------------------------------------------
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/mcp') {
      void handleMcp(req, res)
      return
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (url.pathname === '/state') {
      const initiatives: Record<string, InitiativeState> = {}
      for (const slug of listSlugs()) initiatives[slug] = foldSlug(slug)
      json(res, 200, { initiatives })
      return
    }
    const single = /^\/state\/([^/]+)$/.exec(url.pathname)
    if (single !== null) {
      const slug = single[1]!
      if (!SLUG_PATH_RE.test(slug) || !existsSync(join(initiativesDir, slug))) {
        json(res, 404, { error: `unknown initiative "${slug}"` })
        return
      }
      json(res, 200, foldSlug(slug))
      return
    }
    if (url.pathname === '/events') {
      openEventStream(res)
      return
    }
    json(res, 404, { error: 'not found' }) // no other routes, no static files, no UI
  })

  await Promise.all([
    new Promise<void>((resolveReady) => {
      watcher.on('ready', () => resolveReady())
    }),
    new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      // localhost law: never bind beyond loopback
      server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', () => resolveListen())
    }),
  ])
  rememberCurrentLogs()

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? DEFAULT_PORT)

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      clearInterval(heartbeat)
      clearInterval(reconcile)
      for (const client of clients) client.end()
      clients.clear()
      // Close MCP sessions before the listener: transport.close() fires
      // onclose, which prunes the map.
      await Promise.all([...mcpTransports.values()].map((transport) => transport.close().catch(() => {})))
      await watcher.close()
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()))
        server.closeAllConnections()
      })
    },
  }
}
