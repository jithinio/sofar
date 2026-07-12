import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { writeCredential, writeRemote, type Env } from '../src/client/config'
import { runDoorbell, type DoorbellRing } from '../src/client/doorbell'
import { runPullWatch, runPush } from '../src/cli/cloud'
import { detectCaps } from '../src/cli/ui'
import { readEvents } from '../src/core/cursor'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { startMockCloud, type MockCloud } from './helpers/mock-cloud'

/**
 * Doorbell SSE client (sync-client 3.3): rings dispatch, heartbeats don't,
 * reconnect does a catch-up, and `sofar pull --watch` turns rings into
 * since-cursor pulls. Notification only — a missed doorbell never loses data.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-client-doorbell-'))
let n = 0
const plain = detectCaps({ env: {}, argv: [], isTTY: false, platform: 'darwin' })
const noSleep = async (): Promise<void> => {}

let mock: MockCloud
beforeEach(async () => {
  if (mock !== undefined) await mock.close()
  mock = await startMockCloud({ heartbeatMs: 20 })
})
afterAll(async () => {
  await mock?.close()
  rmSync(scratch, { recursive: true, force: true })
})

function ev(slug: string, text: string): EventEnvelope {
  return makeEvent({ initiative: slug, session: 'cli', source: 'cli', actor: 'agent', type: 'note_added', payload: { text } })
}

function until<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const withTimeout = <T>(p: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms))])

describe('runDoorbell', () => {
  function repoFixture(): string {
    const repoId = `repo_bell_${++n}`
    mock.repos.set(`align/bell-${n}`, repoId)
    mock.tokens.set(`sfr_bell_${repoId}`, { scopes: ['sync'] })
    return repoId
  }

  it('connects, survives heartbeats, and dispatches data rings', async () => {
    const repoId = repoFixture()
    const controller = new AbortController()
    const connected = until<void>()
    const rang = until<DoorbellRing>()
    const rings: DoorbellRing[] = []

    const done = runDoorbell({
      apiUrl: mock.url,
      token: `sfr_bell_${repoId}`,
      streams: [`${repoId}/main`],
      signal: controller.signal,
      onConnect: () => connected.resolve(),
      onRing: (ring) => {
        rings.push(ring)
        rang.resolve(ring)
      },
    })

    await withTimeout(connected.promise)
    // several heartbeats pass without dispatching anything
    await new Promise((r) => setTimeout(r, 80))
    expect(rings).toHaveLength(0)

    mock.ring(`${repoId}/main`, '01HEAD')
    const ring = await withTimeout(rang.promise)
    expect(ring).toEqual({ stream: `${repoId}/main`, head: '01HEAD' })

    controller.abort()
    await withTimeout(done)
  })

  it('reconnects after a drop and fires the catch-up hook again', async () => {
    const repoId = repoFixture()
    const controller = new AbortController()
    let connects = 0
    const twice = until<void>()
    const warns: string[] = []

    const done = runDoorbell({
      apiUrl: mock.url,
      token: `sfr_bell_${repoId}`,
      streams: [`${repoId}/main`],
      signal: controller.signal,
      sleep: noSleep,
      onConnect: async () => {
        connects += 1
        if (connects === 1) {
          await mock.stop() // drop every open connection
          await mock.restart()
        }
        if (connects >= 2) twice.resolve()
      },
      onRing: () => {},
      onWarn: (w) => warns.push(w),
    })

    await withTimeout(twice.promise)
    expect(connects).toBeGreaterThanOrEqual(2)
    expect(warns.some((w) => w.includes('reconnecting'))).toBe(true)
    controller.abort()
    await withTimeout(done)
  })

  it('throws on 401 instead of retrying forever', async () => {
    const repoId = repoFixture()
    const controller = new AbortController()
    await expect(
      withTimeout(
        runDoorbell({
          apiUrl: mock.url,
          token: 'sfr_wrong',
          streams: [`${repoId}/main`],
          signal: controller.signal,
          onRing: () => {},
        }),
      ),
    ).rejects.toMatchObject({ status: 401 })
    controller.abort()
  })
})

describe('sofar pull --watch', () => {
  it('does the catch-up pull on connect, then pulls on every ring', async () => {
    const repoId = `repo_watch_${++n}`
    mock.repos.set(`align/watch-${n}`, repoId)
    mock.tokens.set(`sfr_watch_${repoId}`, { scopes: ['sync'] })

    const mkClone = (name: string): { root: string; env: Env } => {
      const root = join(scratch, `${n}-${name}`)
      mkdirSync(root, { recursive: true })
      const env: Env = { XDG_CONFIG_HOME: join(root, '.xdg-config'), XDG_STATE_HOME: join(root, '.xdg-state') }
      writeRemote(root, { version: 1, api_url: mock.url, org: 'align', name: `watch-${n}`, repo_id: repoId })
      writeCredential(mock.url, { token: `sfr_watch_${repoId}` }, env)
      return { root, env }
    }

    // writer seeds one event before the watcher starts (the catch-up case)
    const writer = mkClone('writer')
    const writerLog = join(writer.root, '.sofar', 'initiatives', 'main', 'events.jsonl')
    appendEvents(writerLog, [ev('main', 'before-watch')])
    await runPush(writer.root, { slug: 'main' }, { env: writer.env, sleep: noSleep }, plain, plain)

    const watcher = mkClone('watcher')
    const watcherLog = join(watcher.root, '.sofar', 'initiatives', 'main', 'events.jsonl')
    const controller = new AbortController()
    const lines: string[] = []
    const gotLive = until<void>()

    const watch = runPullWatch(
      watcher.root,
      { slug: 'main' },
      {
        env: watcher.env,
        sleep: noSleep,
        signal: controller.signal,
        onLine: (line) => {
          lines.push(line)
          if (readEvents(watcherLog).events.length >= 2) gotLive.resolve()
        },
        onWarnLine: () => {},
      },
      plain,
      plain,
    )

    // the writer pushes while the watcher is connected → server rings → watcher pulls
    const pushLive = async (): Promise<void> => {
      // wait until the catch-up pull proves the subscription is live
      while (readEvents(watcherLog).events.length < 1) await new Promise((r) => setTimeout(r, 10))
      appendEvents(writerLog, [ev('main', 'while-watching')])
      await runPush(writer.root, { slug: 'main' }, { env: writer.env, sleep: noSleep }, plain, plain)
    }
    await withTimeout(Promise.all([pushLive(), gotLive.promise]))

    const pulled = readEvents(watcherLog).events.map((e) => (e.payload as { text: string }).text)
    expect(pulled).toEqual(['before-watch', 'while-watching'])
    expect(lines.some((l) => l.includes('pulled main: 1 new'))).toBe(true)

    controller.abort()
    expect(await withTimeout(watch)).toBeUndefined()
  })
})
