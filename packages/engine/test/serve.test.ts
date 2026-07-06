import { get, type IncomingMessage } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import type { InitiativeState } from '../src/core/fold'
import { startServer, type ServeHandle } from '../src/cli/serve'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Task 4.5 — `harness serve`: /state fold-all, /state/<slug>, 404s, and the
 * Phase 4 acceptance bullet 3: an append pushes an SSE state event within
 * 500ms. Every test closes its server — vitest must exit cleanly.
 */

const roots: string[] = []
const handles: ServeHandle[] = []

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

async function serve(root: string): Promise<ServeHandle> {
  const handle = await startServer({ root, port: 0 }) // ephemeral
  handles.push(handle)
  return handle
}

function seedInitiative(fixture: Fixture, slug: string, goal: string): string {
  const dir = join(fixture.root, '.harness', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'events.jsonl')
  appendEvent(
    logPath,
    makeEvent({
      initiative: slug,
      session: 'cli',
      source: 'cli',
      actor: 'human',
      type: 'initiative_created',
      payload: { slug, goal },
    }),
  )
  return logPath
}

/** Minimal SSE client: resolves when connected, exposes typed-event frames. */
interface SseClient {
  nextStateEvent(timeoutMs: number): Promise<{ slug: string; state: InitiativeState }>
  close(): void
}

function openSse(url: string): Promise<SseClient> {
  return new Promise((resolveClient, rejectClient) => {
    const request = get(`${url}/events`, (res: IncomingMessage) => {
      if (res.statusCode !== 200) {
        rejectClient(new Error(`unexpected SSE status ${res.statusCode}`))
        return
      }
      let buffer = ''
      let connected = false
      const waiters: Array<(frame: { slug: string; state: InitiativeState }) => void> = []
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buffer += chunk
        let sep: number
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          if (!connected && frame.startsWith(':')) {
            connected = true
            resolveClient(client)
            continue
          }
          const eventMatch = /^event: state$/m.exec(frame)
          const dataMatch = /^data: (.+)$/m.exec(frame)
          if (eventMatch && dataMatch) {
            const payload = JSON.parse(dataMatch[1]!) as { slug: string; state: InitiativeState }
            waiters.splice(0).forEach((w) => w(payload))
          }
        }
      })
      const client: SseClient = {
        nextStateEvent(timeoutMs: number) {
          return new Promise((resolveEvent, rejectEvent) => {
            const timer = setTimeout(
              () => rejectEvent(new Error(`no SSE state event within ${timeoutMs}ms`)),
              timeoutMs,
            )
            waiters.push((frame) => {
              clearTimeout(timer)
              resolveEvent(frame)
            })
          })
        },
        close() {
          request.destroy()
        },
      }
    })
    request.on('error', rejectClient)
  })
}

describe('harness serve — /state endpoints', () => {
  it('GET /state folds every initiative; /state/<slug> returns one; unknown 404s', async () => {
    const fixture = fx({ bind: false })
    seedInitiative(fixture, 'alpha', 'first goal')
    seedInitiative(fixture, 'beta', 'second goal')
    const handle = await serve(fixture.root)

    const all = await fetch(`${handle.url}/state`)
    expect(all.status).toBe(200)
    const body = (await all.json()) as { initiatives: Record<string, InitiativeState> }
    // fixture "demo" (empty) + the two seeded ones
    expect(Object.keys(body.initiatives).sort()).toEqual(['alpha', 'beta', 'demo'])
    expect(body.initiatives.alpha).toMatchObject({ slug: 'alpha', goal: 'first goal' })
    expect(body.initiatives.beta).toMatchObject({ slug: 'beta', goal: 'second goal' })
    expect(body.initiatives.demo).toMatchObject({ slug: 'demo', goal: '' }) // no log yet

    const single = await fetch(`${handle.url}/state/alpha`)
    expect(single.status).toBe(200)
    expect((await single.json()) as InitiativeState).toMatchObject({
      slug: 'alpha',
      goal: 'first goal',
      cursor: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/) as unknown as string,
    })

    expect((await fetch(`${handle.url}/state/ghost`)).status).toBe(404)
    expect((await fetch(`${handle.url}/state/../escape`)).status).toBe(404)
    expect((await fetch(`${handle.url}/nope`)).status).toBe(404)
    expect((await fetch(`${handle.url}/state`, { method: 'POST' })).status).toBe(405)
  })

  it('binds 127.0.0.1 only (localhost law)', async () => {
    const fixture = fx({ bind: false })
    const handle = await serve(fixture.root)
    // The listening address is loopback — not 0.0.0.0 / ::.
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`)
    const res = await fetch(`http://127.0.0.1:${handle.port}/state`)
    expect(res.status).toBe(200)
  })
})

describe('harness serve — SSE push on append (acceptance bullet 3)', () => {
  it('an events.jsonl append reaches the SSE client within 500ms', async () => {
    const fixture = fx({ bind: false })
    const logPath = seedInitiative(fixture, 'live', 'watch me')
    const handle = await serve(fixture.root)

    // Generous connect setup: client fully connected before the append.
    const client = await openSse(handle.url)
    try {
      const waiter = client.nextStateEvent(500) // tight push assertion
      const appendedAt = Date.now()
      appendEvent(
        logPath,
        makeEvent({
          initiative: 'live',
          session: 'cli',
          source: 'cli',
          actor: 'agent',
          type: 'note_added',
          payload: { text: 'pushed over SSE' },
        }),
      )
      const frame = await waiter
      const latency = Date.now() - appendedAt
      // eslint-disable-next-line no-console
      console.info(`SSE push latency: ${latency}ms`)
      expect(latency).toBeLessThanOrEqual(500)
      expect(frame.slug).toBe('live')
      expect(frame.state).toMatchObject({ slug: 'live', goal: 'watch me' })
    } finally {
      client.close()
    }
  })

  it('a brand-new initiative (fresh events.jsonl) also triggers a push', async () => {
    const fixture = fx({ bind: false })
    const handle = await serve(fixture.root)
    const client = await openSse(handle.url)
    try {
      const waiter = client.nextStateEvent(500)
      seedInitiative(fixture, 'newborn', 'fresh log') // add, not change
      const frame = await waiter
      expect(frame.slug).toBe('newborn')
      expect(frame.state.goal).toBe('fresh log')
    } finally {
      client.close()
    }
  })

  it('survives client disconnects and closes cleanly with a client attached', async () => {
    const fixture = fx({ bind: false })
    const logPath = seedInitiative(fixture, 'live', 'watch me')
    const handle = await serve(fixture.root)

    const early = await openSse(handle.url)
    early.close() // disconnect immediately — server must not throw on broadcast

    const client = await openSse(handle.url)
    const waiter = client.nextStateEvent(500)
    appendEvent(
      logPath,
      makeEvent({
        initiative: 'live',
        session: 'cli',
        source: 'cli',
        actor: 'agent',
        type: 'note_added',
        payload: { text: 'after a disconnect' },
      }),
    )
    expect((await waiter).slug).toBe('live')
    // close with the second client still connected — afterEach asserts no hang
  })
})
