import { existsSync, readdirSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { basename, join, relative, sep } from 'node:path'
import { watch } from 'chokidar'
import { emptyState, foldLog, type InitiativeState } from '../core/fold'

/**
 * `harness serve [--port 4173]` (task 4.5, SPEC §CLI) — the watcher +
 * localhost JSON state server. node:http only, bound to 127.0.0.1 ONLY
 * (localhost law: JSON on localhost, no UI, no sync, no telemetry).
 *
 * Routes (GET, nothing else):
 *   /state         → { initiatives: { <slug>: InitiativeState } }
 *   /state/<slug>  → single InitiativeState (404 unknown)
 *   /events        → SSE: `event: state` + {slug, state} JSON pushed when a
 *                    chokidar watch sees an events.jsonl append (≤500ms,
 *                    SPEC §Acceptance Phase 4); `: heartbeat` every 15s.
 *
 * startServer is a factory returning {port, close} so tests can run on an
 * ephemeral port and shut down without dangling handles.
 */

export const DEFAULT_PORT = 4173
export const HEARTBEAT_MS = 15_000

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

export async function startServer(options: ServeOptions): Promise<ServeHandle> {
  const initiativesDir = join(options.root, '.harness', 'initiatives')

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

  // --- watcher: append to any .harness/**/events.jsonl → re-fold + push -----
  const watcher = watch(initiativesDir, { ignoreInitial: true })
  watcher.on('all', (event, path) => {
    if (event !== 'add' && event !== 'change') return
    if (basename(path) !== 'events.jsonl') return // projections regenerate too — ignore
    const slug = relative(initiativesDir, path).split(sep)[0]
    if (slug !== undefined && slug.length > 0 && !slug.startsWith('..')) broadcast(slug)
  })

  // --- http ------------------------------------------------------------------
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
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

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? DEFAULT_PORT)

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      clearInterval(heartbeat)
      for (const client of clients) client.end()
      clients.clear()
      await watcher.close()
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()))
        server.closeAllConnections()
      })
    },
  }
}
