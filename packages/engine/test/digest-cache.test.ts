import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { handleSessionStart } from '../src/cli/event'
import { cachedDigestState, DIGEST_CACHE_VERSION } from '../src/core/digest-cache'
import { makeEvent } from '../src/core/envelope'
import { foldLines } from '../src/core/fold'
import { indexDir } from '../src/core/index-store'
import { appendEvents } from '../src/core/log'
import { digestState } from '../src/projections/templates/digest-state'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/** rust-core 4.4 (session-start B): the digest cache changes no byte of the hook's output. */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture()
  roots.push(fixture.root)
  return fixture
}

const ev = (type: string, session: string, payload: Record<string, unknown>) =>
  makeEvent({ initiative: 'x', session, source: 'claude-code', actor: 'agent', type, payload })

function seeded(): Fixture {
  const f = fx()
  appendEvents(f.eventsPath, [
    ev('plan_updated', 'cli', {
      plan: { goal: 'g', phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'a', status: 'active' }, { id: '1.2', title: 'b', status: 'pending' }] }] },
    }),
    ev('session_started', 'old', { tool: 'claude-code' }),
    ev('file_touched', 'old', { path: 'src/a.ts', op: 'edit' }),
    ev('session_ended', 'old', { summary: 'did a', next_action: 'do b' }),
    ev('session_started', 'open-1', { tool: 'claude-code' }),
    ev('file_touched', 'open-1', { path: 'src/b.ts', op: 'edit' }),
  ])
  return f
}

const input = (session: string) => JSON.stringify({ session_id: session, hook_event_name: 'SessionStart', source: 'startup' })
const cacheFile = (f: Fixture) => join(indexDir(join(f.root, '.sofar')), 'digest', `${f.slug}.json`)
// ctx.foldState names the slug on the state; foldLines alone leaves it empty.
const fullFold = (f: Fixture) => () => ({ ...foldLines(readFileSync(f.eventsPath, 'utf8').split('\n'), f.slug).state, slug: f.slug })

describe('session-start digest cache (rust-core 4.4)', () => {
  it('a miss and a hit print the same block, and a hit folds nothing', () => {
    const f = seeded()
    const first = handleSessionStart(f.root, input('s-new'))
    expect(existsSync(cacheFile(f))).toBe(true)
    const second = handleSessionStart(f.root, input('s-new'))
    expect(second.stdout).toBe(first.stdout)
    expect(first.stdout).toContain('Next action: do b')
    let folds = 0
    const hit = cachedDigestState(join(f.root, '.sofar'), f.slug, f.eventsPath, () => {
      folds += 1
      return fullFold(f)()
    })
    expect(folds).toBe(0)
    expect(hit).toEqual(JSON.parse(JSON.stringify(digestState(fullFold(f)()))))
  })

  it('an append is a miss: the block reflects the new event', () => {
    const f = seeded()
    handleSessionStart(f.root, input('s-new'))
    appendEvents(f.eventsPath, [ev('session_ended', 'open-1', { summary: 'did b', next_action: 'ship it' })])
    const out = handleSessionStart(f.root, input('s-new'))
    expect(out.stdout).toContain('Next action: ship it')
    rmSync(cacheFile(f), { force: true })
    expect(handleSessionStart(f.root, input('s-new')).stdout).toBe(out.stdout)
  })

  it('a corrupt, mis-shaped or foreign-version file is a miss, never an error', () => {
    const f = seeded()
    const want = handleSessionStart(f.root, input('s-new')).stdout
    const good = JSON.parse(readFileSync(cacheFile(f), 'utf8')) as Record<string, unknown>
    for (const bad of [
      'nope',
      JSON.stringify({ ...good, v: DIGEST_CACHE_VERSION + 1 }),
      JSON.stringify({ ...good, schema: 'other' }),
      JSON.stringify({ ...good, state: { ...(good.state as object), sessions: null } }),
      JSON.stringify({ ...good, state: null }),
    ]) {
      writeFileSync(cacheFile(f), bad)
      expect(handleSessionStart(f.root, input('s-new')).stdout).toBe(want)
    }
  })
})
