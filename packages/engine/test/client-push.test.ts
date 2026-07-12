import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readSyncState, writeCredential, writeRemote, type Env } from '../src/client/config'
import { MAX_BATCH_BYTES, MAX_BATCH_LINES, splitBatches } from '../src/client/push'
import { runPush } from '../src/cli/cloud'
import { detectCaps } from '../src/cli/ui'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { startMockCloud, type MockCloud } from './helpers/mock-cloud'

/** Push — batching, genesis-first, cursors, retries, offline queue (sync-client 3.1). */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-client-push-'))
let n = 0
const plain = detectCaps({ env: {}, argv: [], isTTY: false, platform: 'darwin' })
const noSleep = async (): Promise<void> => {}

let mock: MockCloud
beforeEach(async () => {
  if (mock !== undefined) await mock.close()
  mock = await startMockCloud()
})
afterAll(async () => {
  await mock?.close()
  rmSync(scratch, { recursive: true, force: true })
})

function ev(slug: string, text: string): EventEnvelope {
  return makeEvent({ initiative: slug, session: 'cli', source: 'cli', actor: 'agent', type: 'note_added', payload: { text } })
}

interface Fixture {
  root: string
  env: Env
  repoId: string
  logPath: (slug: string) => string
  push: (opts?: { slug?: string; all?: boolean; full?: boolean }) => ReturnType<typeof runPush>
}

/** A linked, logged-in clone with initiative logs — no HTTP needed for setup. */
function fixture(slugs: Record<string, number>): Fixture {
  const root = join(scratch, `${n++}-repo`)
  mkdirSync(root, { recursive: true })
  const env: Env = { XDG_CONFIG_HOME: join(root, '.xdg-config'), XDG_STATE_HOME: join(root, '.xdg-state') }
  const repoId = `repo_fix_${n}`
  mock.repos.set(`align/fix-${n}`, repoId)
  mock.tokens.set(`sfr_fix_${n}`, { scopes: ['sync'] })
  writeRemote(root, { version: 1, api_url: mock.url, org: 'align', name: `fix-${n}`, repo_id: repoId })
  writeCredential(mock.url, { token: `sfr_fix_${n}` }, env)
  for (const [slug, count] of Object.entries(slugs)) {
    appendEvents(
      join(root, '.sofar', 'initiatives', slug, 'events.jsonl'),
      Array.from({ length: count }, (_, i) => ev(slug, `note ${i}`)),
    )
  }
  return {
    root,
    env,
    repoId,
    logPath: (slug) => join(root, '.sofar', 'initiatives', slug, 'events.jsonl'),
    push: (opts = {}) => runPush(root, { slug: 'main', ...opts }, { env, sleep: noSleep }, plain, plain),
  }
}

/** Bodies of the POST …/events requests the mock saw. */
function pushBodies(): string[] {
  return mock.requests.filter((r) => r.method === 'POST' && r.url.includes('/events')).map((r) => r.body)
}

describe('splitBatches', () => {
  it('splits on the 1000-line limit', () => {
    const events = Array.from({ length: MAX_BATCH_LINES + 1 }, (_, i) => ev('main', `n${i}`))
    const batches = splitBatches(events)
    expect(batches.map((b) => b.lines.length)).toEqual([MAX_BATCH_LINES, 1])
    expect(batches[0]!.ids[0]).toBe(events[0]!.id)
    expect(batches[1]!.ids[0]).toBe(events[MAX_BATCH_LINES]!.id)
  })

  it('splits on the 5MB byte limit and keeps every batch under it', () => {
    const big = 'x'.repeat(2 * 1024 * 1024)
    const events = [ev('main', big), ev('main', big), ev('main', big)]
    const batches = splitBatches(events)
    expect(batches.length).toBe(2)
    for (const batch of batches) {
      expect(batch.bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES)
      expect(batch.lines.length).toBeLessThanOrEqual(MAX_BATCH_LINES)
    }
    expect(batches.flatMap((b) => b.ids)).toEqual(events.map((e) => e.id))
  })

  it('gives an oversize single event its own batch rather than dropping it', () => {
    const events = [ev('main', 'small'), ev('main', 'y'.repeat(6 * 1024 * 1024))]
    const batches = splitBatches(events)
    expect(batches.length).toBe(2)
    expect(batches[1]!.lines.length).toBe(1)
  })
})

describe('sofar push', () => {
  it('pushes the whole stream from event zero on first push and persists the ack cursor', async () => {
    const f = fixture({ main: 5 })
    const result = await f.push()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pushed main: 5 new, 0 already on server')
    const serverIds = mock.streamIds(`${f.repoId}/main`)
    expect(serverIds).toHaveLength(5)
    const state = readSyncState(f.root, { api_url: mock.url, repo_id: f.repoId }, f.env)
    expect(state.streams.main?.pushed).toBe(serverIds[4])
  })

  it('pushes only past the ack cursor on subsequent runs', async () => {
    const f = fixture({ main: 3 })
    await f.push()
    mock.requests.length = 0
    appendEvents(f.logPath('main'), [ev('main', 'later-1'), ev('main', 'later-2')])
    const result = await f.push()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pushed main: 2 new')
    const bodies = pushBodies()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.split('\n').filter((l) => l.length > 0)).toHaveLength(2)
    expect(mock.streamIds(`${f.repoId}/main`)).toHaveLength(5)
  })

  it('is idempotent: --full re-push yields accepted=0, duplicates=n, state unchanged', async () => {
    const f = fixture({ main: 4 })
    await f.push()
    const before = mock.streamIds(`${f.repoId}/main`)
    const result = await f.push({ full: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pushed main: 0 new, 4 already on server')
    expect(mock.streamIds(`${f.repoId}/main`)).toEqual(before)
  })

  it('reports up-to-date when nothing is pending', async () => {
    const f = fixture({ main: 2 })
    await f.push()
    const result = await f.push()
    expect(result.stdout).toContain('main: up to date (nothing to push)')
  })

  it('re-sends the SAME batch through 5xx failures, then succeeds', async () => {
    const f = fixture({ main: 3 })
    mock.failEvents = { count: 2, status: 503 }
    const result = await f.push()
    expect(result.exitCode).toBe(0)
    const bodies = pushBodies()
    expect(bodies).toHaveLength(3)
    expect(bodies[0]).toBe(bodies[1])
    expect(bodies[1]).toBe(bodies[2])
    expect(mock.streamIds(`${f.repoId}/main`)).toHaveLength(3)
  })

  it('honors Retry-After on 429', async () => {
    const f = fixture({ main: 1 })
    mock.failEvents = { count: 1, status: 429, retryAfter: '2' }
    const sleeps: number[] = []
    const result = await runPush(
      f.root,
      { slug: 'main' },
      { env: f.env, sleep: async (ms) => void sleeps.push(ms) },
      plain,
      plain,
    )
    expect(result.exitCode).toBe(0)
    expect(sleeps).toContain(2000)
  })

  it('surfaces server-rejected lines loudly without failing the push', async () => {
    const f = fixture({ main: 2 })
    mock.forceInvalidNext = [{ line: 1, code: 'bad_envelope', message: 'scripted rejection' }]
    const result = await f.push()
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('server rejected event')
    expect(result.stderr).toContain('client bug')
    // the cursor still advanced — a rejected line must not wedge the queue
    const state = readSyncState(f.root, { api_url: mock.url, repo_id: f.repoId }, f.env)
    expect(state.streams.main?.pushed).toBeDefined()
  })

  it('maps 401 to a login hint and 404 to a relink hint', async () => {
    const f = fixture({ main: 1 })
    mock.tokens.delete(`sfr_fix_${n}`)
    const unauthorized = await f.push()
    expect(unauthorized.exitCode).toBe(1)
    expect(unauthorized.stderr).toContain('sofar login')

    mock.tokens.set(`sfr_fix_${n}`, { scopes: ['sync'] })
    mock.repos.clear() // repo vanished server-side → 404, never 403
    const gone = await f.push()
    expect(gone.exitCode).toBe(1)
    expect(gone.stderr).toContain('repo not found')
    expect(gone.stderr).toContain('sofar link')
  })

  it('drains the offline queue after downtime with zero loss and no duplicates', async () => {
    const f = fixture({ main: 3 })
    await f.push()

    // API goes down; local work is completely unaffected.
    await mock.stop()
    appendEvents(f.logPath('main'), [ev('main', 'offline-1'), ev('main', 'offline-2')])
    const whileDown = await f.push()
    expect(whileDown.exitCode).toBe(1)
    expect(whileDown.stderr).toContain('queued locally')
    const state = readSyncState(f.root, { api_url: mock.url, repo_id: f.repoId }, f.env)
    const ackedBefore = state.streams.main?.pushed
    expect(mock.streamIds(`${f.repoId}/main`)).toHaveLength(3) // cursor intact, server unchanged

    // API returns → the queue (everything after the ack cursor) drains.
    await mock.restart()
    const drained = await f.push()
    expect(drained.exitCode).toBe(0)
    expect(drained.stdout).toContain('pushed main: 2 new')
    expect(mock.streamIds(`${f.repoId}/main`)).toHaveLength(5)
    expect(readSyncState(f.root, { api_url: mock.url, repo_id: f.repoId }, f.env).streams.main?.pushed).not.toBe(
      ackedBefore,
    )

    // and a re-run finds nothing to do — no duplicate state effects.
    const after = await f.push()
    expect(after.stdout).toContain('up to date')
  })

  it('pushes every initiative with --all', async () => {
    const f = fixture({ alpha: 2, beta: 3 })
    const result = await runPush(f.root, { all: true }, { env: f.env, sleep: noSleep }, plain, plain)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pushed alpha: 2 new')
    expect(result.stdout).toContain('pushed beta: 3 new')
    expect(mock.streamIds(`${f.repoId}/alpha`)).toHaveLength(2)
    expect(mock.streamIds(`${f.repoId}/beta`)).toHaveLength(3)
  })

  it('fails with a link hint when the repo is not linked', async () => {
    const root = join(scratch, `${n++}-unlinked`)
    mkdirSync(root, { recursive: true })
    const result = await runPush(root, { slug: 'main' }, { env: {} }, plain, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('sofar link')
  })
})
