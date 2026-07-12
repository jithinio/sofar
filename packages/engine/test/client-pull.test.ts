import { existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { readSyncState, writeCredential, writeRemote, type Env } from '../src/client/config'
import { pullStream } from '../src/client/pull'
import { runPull, runPush } from '../src/cli/cloud'
import { runStatus } from '../src/cli/status'
import { detectCaps } from '../src/cli/ui'
import { readEvents } from '../src/core/cursor'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { appendEvents } from '../src/core/log'
import { startMockCloud, type MockCloud } from './helpers/mock-cloud'

/**
 * Pull — since-cursor paging, dedupe import, separate cursors, and the
 * round-trip acceptance: push → pull into a fresh clone → zero-diff status
 * (sync-client 3.2, SPEC §Acceptance).
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-client-pull-'))
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

function ev(slug: string, type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({ initiative: slug, session: 'cli', source: 'cli', actor: 'agent', type, payload })
}

interface Clone {
  root: string
  env: Env
  logPath: (slug: string) => string
  pull: (opts?: { slug?: string; all?: boolean; full?: boolean; limit?: number }) => ReturnType<typeof runPull>
  push: (opts?: { slug?: string }) => ReturnType<typeof runPush>
}

let repoSeq = 0
/** Two clones of one linked repo share repoId; each has its own env/state. */
function makeClone(repoId: string, name: string): Clone {
  const root = join(scratch, `${n++}-${name}`)
  mkdirSync(root, { recursive: true })
  const env: Env = { XDG_CONFIG_HOME: join(root, '.xdg-config'), XDG_STATE_HOME: join(root, '.xdg-state') }
  writeRemote(root, { version: 1, api_url: mock.url, org: 'align', name, repo_id: repoId })
  writeCredential(mock.url, { token: `sfr_pull_${repoId}` }, env)
  return {
    root,
    env,
    logPath: (slug) => join(root, '.sofar', 'initiatives', slug, 'events.jsonl'),
    pull: (opts = {}) => runPull(root, { slug: 'main', ...opts }, { env, sleep: noSleep }, plain, plain),
    push: (opts = {}) => runPush(root, { slug: 'main', ...opts }, { env, sleep: noSleep }, plain, plain),
  }
}

function linkedRepo(): string {
  const repoId = `repo_pull_${++repoSeq}`
  mock.repos.set(`align/pull-${repoSeq}`, repoId)
  mock.tokens.set(`sfr_pull_${repoId}`, { scopes: ['sync'] })
  return repoId
}

describe('sofar pull', () => {
  it('round-trips: push from one clone, pull since genesis into a fresh clone, zero-diff status', async () => {
    const repoId = linkedRepo()
    const source = makeClone(repoId, 'source')
    const events = [
      ev('main', 'initiative_created', { slug: 'main', goal: 'round-trip proof' }),
      ev('main', 'plan_updated', { plan: { phases: [{ name: 'P1', tasks: [{ id: '1.1', title: 'prove it' }] }] } }),
      ev('main', 'task_status_changed', { id: '1.1', status: 'done' }),
      ev('main', 'note_added', { text: 'pushed from source' }),
    ]
    appendEvents(source.logPath('main'), events)
    expect((await source.push()).exitCode).toBe(0)

    const clone = makeClone(repoId, 'fresh-clone')
    expect(existsSync(clone.logPath('main'))).toBe(false)
    const result = await clone.pull()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pulled main: 4 new, 0 already local')

    // byte-identical event set, deep-equal fold, zero-diff status
    expect(readEvents(clone.logPath('main')).events).toEqual(readEvents(source.logPath('main')).events)
    expect(foldLog(clone.logPath('main')).state).toEqual(foldLog(source.logPath('main')).state)
    const statusA = runStatus(source.root, 'main')
    const statusB = runStatus(clone.root, 'main')
    expect(statusB.stdout).toBe(statusA.stdout)
    // projections regenerated in the fresh clone
    expect(existsSync(join(clone.root, '.sofar', 'initiatives', 'main', 'plan.md'))).toBe(true)
  })

  it('pages with since + X-Sofar-Cursor, persisting the cursor after every page', async () => {
    const repoId = linkedRepo()
    const source = makeClone(repoId, 'pager-source')
    appendEvents(source.logPath('main'), Array.from({ length: 5 }, (_, i) => ev('main', 'note_added', { text: `n${i}` })))
    await source.push()

    const clone = makeClone(repoId, 'pager-clone')
    mock.requests.length = 0
    const cursors: string[] = []
    const report = await pullStream({
      logPath: clone.logPath('main'),
      slug: 'main',
      apiUrl: mock.url,
      token: `sfr_pull_${repoId}`,
      repoId,
      limit: 2,
      onCursor: (c) => cursors.push(c),
    })
    expect(report).toMatchObject({ fetched: 5, appended: 5, skipped: 0, pages: 4 }) // 2+2+1 + caught-up probe
    const pulls = mock.requests.filter((r) => r.method === 'GET' && r.url.includes('/events'))
    expect(pulls.length).toBe(4)
    expect(pulls[0]!.url).not.toContain('since=')
    expect(pulls[1]!.url).toContain('since=')
    expect(readEvents(clone.logPath('main')).events).toHaveLength(5)
    const serverIds = mock.streamIds(`${repoId}/main`)
    expect(cursors).toEqual([serverIds[1], serverIds[3], serverIds[4]]) // one persist per imported page
    expect(report.cursor).toBe(serverIds[4])
  })

  it('is caught-up-cheap: a second pull moves nothing', async () => {
    const repoId = linkedRepo()
    const source = makeClone(repoId, 'cheap-source')
    appendEvents(source.logPath('main'), [ev('main', 'note_added', { text: 'once' })])
    await source.push()
    const clone = makeClone(repoId, 'cheap-clone')
    await clone.pull()
    const again = await clone.pull()
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('main: up to date')
  })

  it('dedupes by id: pulling your own pushed events back is a no-op (--full)', async () => {
    const repoId = linkedRepo()
    const clone = makeClone(repoId, 'self')
    appendEvents(clone.logPath('main'), Array.from({ length: 3 }, (_, i) => ev('main', 'note_added', { text: `n${i}` })))
    await clone.push()
    const result = await clone.pull({ full: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('pulled main: 0 new, 3 already local')
    expect(readEvents(clone.logPath('main')).events).toHaveLength(3)
  })

  it('keeps the inbound cursor separate from the push ack cursor', async () => {
    const repoId = linkedRepo()
    const a = makeClone(repoId, 'writer-a')
    const b = makeClone(repoId, 'writer-b')
    appendEvents(a.logPath('main'), [ev('main', 'note_added', { text: 'from a' })])
    await a.push()
    await b.pull()
    appendEvents(b.logPath('main'), [ev('main', 'note_added', { text: 'from b' })])
    await b.push()

    const state = readSyncState(b.root, { api_url: mock.url, repo_id: repoId }, b.env)
    expect(state.streams.main?.pushed).toBeDefined()
    expect(state.streams.main?.pulled).toBeDefined()
    expect(state.streams.main?.pushed).not.toBe(state.streams.main?.pulled)

    // convergence: a pulls b's event, both replicas fold identically
    await a.pull()
    expect(foldLog(a.logPath('main')).state).toEqual(foldLog(b.logPath('main')).state)
  })

  it('retries 5xx and keeps local state untouched on hard failure', async () => {
    const repoId = linkedRepo()
    const source = makeClone(repoId, 'retry-source')
    appendEvents(source.logPath('main'), [ev('main', 'note_added', { text: 'x' })])
    await source.push()

    const clone = makeClone(repoId, 'retry-clone')
    mock.failEvents = { count: 2, status: 502 }
    const ok = await clone.pull()
    expect(ok.exitCode).toBe(0)
    expect(readEvents(clone.logPath('main')).events).toHaveLength(1)

    const other = makeClone(repoId, 'down-clone')
    await mock.stop()
    const down = await other.pull()
    expect(down.exitCode).toBe(1)
    expect(down.stderr).toContain('local state is unaffected')
    expect(existsSync(other.logPath('main'))).toBe(false)
    await mock.restart()
  })

  it('maps an unknown stream to the honest 404', async () => {
    const repoId = linkedRepo()
    const clone = makeClone(repoId, 'no-stream')
    const result = await clone.pull({ slug: 'never-pushed' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('repo not found')
  })
})
