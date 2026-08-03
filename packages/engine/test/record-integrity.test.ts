import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
// (mkdirSync/writeFileSync also back the Phase 4 ref fixtures below)
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import {
  handlePostTool,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPrompt,
  PARALLEL_WRAP_BUDGET,
} from '../src/cli/event'
import { runDoctor } from '../src/cli/doctor'
import { readGitState } from '../src/core/git'
import { unwrittenSessions } from '../src/projections/templates/status'
import { homeInitiative } from '../src/mcp/context'
import {
  callTool,
  connectServer,
  makeRepoFixture,
  type Fixture,
  type FixtureOptions,
} from './helpers/mcp'

/**
 * record-integrity Phase 1 — hook writes follow a session's HOME initiative,
 * not whatever branch HEAD happens to name (D1, tasks 1.1–1.3).
 *
 * The bug these pin down: MCP writes were pinned by BD58, hooks were not, and
 * a hook runs in a fresh process where the in-memory pin is always null. A
 * branch switch mid-session therefore sent file_touched/command_run to one
 * initiative while decisions and the write-back went to another — 21 of 99
 * sessions in this repo's own record were split that way before the fix.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

/** Create a second initiative directory alongside the fixture's. */
function addInitiative(root: string, slug: string): string {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'events.jsonl')
}

/** Point bindings.json at a different slug — the "branch switch" in effect. */
function rebind(root: string, branch: string, slug: string): void {
  writeFileSync(
    join(root, '.sofar', 'bindings.json'),
    `${JSON.stringify({ [branch]: slug }, null, 2)}\n`,
  )
}

/** Drop bindings.json entirely — an unbound branch. */
function unbind(root: string): void {
  rmSync(join(root, '.sofar', 'bindings.json'), { force: true })
}

/** Register `session` in `slug` with a session_started at `ts`. */
function register(root: string, slug: string, session: string, ts?: string): void {
  const event = makeEvent({
    initiative: slug,
    session,
    source: 'claude-code',
    actor: 'agent',
    type: 'session_started',
    payload: { tool: 'claude-code' },
  })
  appendEvent(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), {
    ...event,
    ...(ts !== undefined ? { ts } : {}),
  })
}

/** Close `session` in `slug` with a write-back, so the split reads as history. */
function endSession(root: string, slug: string, session: string, ts?: string): void {
  const event = makeEvent({
    initiative: slug,
    session,
    source: 'claude-code',
    actor: 'agent',
    type: 'session_ended',
    payload: { session_id: session, summary: 'done', next_action: 'none' },
  })
  appendEvent(join(root, '.sofar', 'initiatives', slug, 'events.jsonl'), {
    ...event,
    ...(ts !== undefined ? { ts } : {}),
  })
}

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

const bashStdin = (session: string, command: string): string =>
  JSON.stringify({
    session_id: session,
    cwd: '/tmp',
    tool_name: 'Bash',
    tool_input: { command },
  })

describe('homeInitiative (1.1)', () => {
  it('prefers the branch-bound initiative when it registered the session', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1', '2026-08-01T10:00:00.000Z')
    register(f.root, 'beta', 'sess-1', '2026-08-01T12:00:00.000Z') // later, but not preferred

    const sofarDir = join(f.root, '.sofar')
    expect(homeInitiative(sofarDir, 'sess-1', 'alpha')).toBe('alpha')
  })

  it('falls through to siblings when the preferred initiative never registered it', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'beta', 'sess-1')

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBe('beta')
  })

  it('takes the LATEST session_started among siblings — a deliberate re-home wins', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    addInitiative(f.root, 'gamma')
    register(f.root, 'beta', 'sess-1', '2026-08-01T10:00:00.000Z')
    register(f.root, 'gamma', 'sess-1', '2026-08-01T18:00:00.000Z')

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBe('gamma')
  })

  it('returns null for an unregistered session, an empty id, and "cli"', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'sess-1')
    const sofarDir = join(f.root, '.sofar')

    expect(homeInitiative(sofarDir, 'never-seen', 'alpha')).toBeNull()
    expect(homeInitiative(sofarDir, '', 'alpha')).toBeNull()
    expect(homeInitiative(sofarDir, 'cli', 'alpha')).toBeNull()
  })

  it('survives a missing initiatives directory and an unreadable log', () => {
    const f = fx({ slug: 'alpha' })
    // A directory where events.jsonl should be a file — readFileSync throws.
    mkdirSync(join(f.root, '.sofar', 'initiatives', 'beta', 'events.jsonl'), { recursive: true })

    expect(homeInitiative(join(f.root, '.sofar'), 'sess-1', 'alpha')).toBeNull()
    expect(homeInitiative(join(f.root, 'nope', '.sofar'), 'sess-1', null)).toBeNull()
  })
})

describe('hook routing follows the session home (1.2)', () => {
  it('keeps a registered session on its home initiative after a branch rebind', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1')

    rebind(f.root, 'main', 'beta') // the branch moved under the live session

    const result = handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    expect(result.exitCode).toBe(0)

    const alpha = logEvents(f.eventsPath).filter((e) => e.type === 'command_run')
    const beta = logEvents(betaLog)
    expect(alpha).toHaveLength(1)
    expect(alpha[0]!.payload).toEqual({ cmd: 'npm test' })
    expect(beta).toHaveLength(0) // the misroute this initiative exists to stop
  })

  it('homes a brand-new session to the current branch and registers it there', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    rebind(f.root, 'main', 'beta')

    handlePostTool(f.root, bashStdin('fresh-sess', 'npm run build'))

    const beta = logEvents(betaLog)
    expect(beta.map((e) => e.type)).toEqual(['session_started', 'command_run'])
    expect(logEvents(f.eventsPath)).toHaveLength(0)
  })

  it('no longer drops a registered session’s events when the branch is unbound', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'sess-1')
    unbind(f.root) // previously: resolveBound → null → event silently discarded

    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))

    expect(logEvents(f.eventsPath).filter((e) => e.type === 'command_run')).toHaveLength(1)
  })

  it('still no-ops for an unregistered session on an unbound branch', () => {
    const f = fx({ slug: 'alpha' })
    unbind(f.root)

    const result = handlePostTool(f.root, bashStdin('fresh-sess', 'npm test'))
    expect(result.exitCode).toBe(0)
    expect(logEvents(f.eventsPath)).toHaveLength(0)
  })

  it('routes the Stop gate and SessionEnd marker to the home initiative too', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-1')
    // Real mechanical work on the home initiative, so the drift gate engages.
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    rebind(f.root, 'main', 'beta')

    // Stop must find the session in alpha (where it lives) and block it.
    const stop = handleStop(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' }))
    expect(stop.exitCode).toBe(2)

    handleSessionEnd(f.root, JSON.stringify({ session_id: 'sess-1', reason: 'clear' }))
    expect(logEvents(f.eventsPath).some((e) => e.type === 'session_closed')).toBe(true)
    expect(logEvents(betaLog)).toHaveLength(0)
  })
})

describe('split-session detection (2.1/2.2)', () => {
  it('fold reports session ids seen but never registered in this log', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'resident')
    // A leaked event: carries a session this log never registered.
    appendEvent(
      f.eventsPath,
      makeEvent({
        initiative: 'alpha',
        session: 'stranger',
        source: 'hook',
        actor: 'agent',
        type: 'command_run',
        payload: { cmd: 'npm test' },
      }),
    )

    const result = foldLog(f.eventsPath)
    expect(result.unregistered_sessions).toEqual(['stranger'])
    expect(result.state.sessions.map((s) => s.id)).toEqual(['resident'])
  })

  it('fold never reports "cli" or a registered session as unregistered', () => {
    const f = fx({ slug: 'alpha' })
    register(f.root, 'alpha', 'resident')
    for (const session of ['cli', 'resident']) {
      appendEvent(
        f.eventsPath,
        makeEvent({
          initiative: 'alpha',
          session,
          source: 'cli',
          actor: 'agent',
          type: 'command_run',
          payload: { cmd: 'ls' },
        }),
      )
    }
    expect(foldLog(f.eventsPath).unregistered_sessions).toEqual([])
  })

  it('doctor FAILS on a torn session that is still open', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-torn')
    register(f.root, 'beta', 'sess-torn')

    // Exit code is not the assertion here — the bare fixture has no wiring, so
    // auditWiring fails regardless. The routing finding's LEVEL is the subject.
    const r = runDoctor(f.root)
    expect(r.stdout).toContain('FAIL  session sess-torn spans 2 initiatives (torn, live)')
    expect(r.stdout).toContain('still OPEN')
  })

  it('doctor WARNS but does not fail once every session in the split has ended (3.2)', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-torn')
    register(f.root, 'beta', 'sess-torn')
    for (const slug of ['alpha', 'beta']) {
      endSession(f.root, slug, 'sess-torn')
    }

    const r = runDoctor(f.root)
    // WARN, not FAIL: settled history must never fail the audit forever.
    expect(r.stdout).toContain('WARN  session sess-torn spans 2 initiatives (torn, history)')
    expect(r.stdout).not.toContain('FAIL  session sess-torn')
    expect(r.stdout).toContain('settled history')
  })

  it('doctor FAILS on a leaked session whose events landed where it is unknown', () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-leak')
    appendEvent(
      betaLog,
      makeEvent({
        initiative: 'beta',
        session: 'sess-leak',
        source: 'hook',
        actor: 'agent',
        type: 'file_touched',
        payload: { path: 'src/x.ts', op: 'edit' },
      }),
    )

    const r = runDoctor(f.root)
    expect(r.stdout).toContain('FAIL  session sess-leak spans 2 initiatives (leaked, live)')
    expect(r.stdout).toContain('events also landed in beta')
  })

  it('doctor reports a clean bill when every session stays in one initiative', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')
    register(f.root, 'alpha', 'sess-a')
    register(f.root, 'beta', 'sess-b')

    expect(runDoctor(f.root).stdout).toContain('no session spans more than one initiative')
  })
})

describe('start_session honours the session home (1.4)', () => {
  it('adopts the hook-registered session instead of re-registering after a rebind', async () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    // Lazy registration: the hook gets there first, on alpha.
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    rebind(f.root, 'main', 'beta') // binding moved before the agent called start_session

    const { client, handle } = await connectServer(f.root)
    try {
      const r = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: 'sess-1',
      })
      expect(r.isError).toBe(false)
      expect(r.body.session_id).toBe('sess-1')
    } finally {
      await client.close()
      await handle.server.close()
    }

    // No second registration in beta — the tear this closes.
    expect(logEvents(betaLog)).toHaveLength(0)
    expect(
      logEvents(f.eventsPath).filter((e) => e.type === 'session_started'),
    ).toHaveLength(1)
  })

  it('still re-homes when an initiative is named explicitly', async () => {
    const f = fx({ slug: 'alpha' })
    const betaLog = addInitiative(f.root, 'beta')
    handlePostTool(f.root, bashStdin('sess-1', 'npm test')) // registers in alpha

    const { client, handle } = await connectServer(f.root)
    try {
      const r = await callTool(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: 'sess-1',
        initiative: 'beta',
      })
      expect(r.isError).toBe(false)
    } finally {
      await client.close()
      await handle.server.close()
    }

    expect(logEvents(betaLog).filter((e) => e.type === 'session_started')).toHaveLength(1)
  })
})

describe('cross-session awareness (Phase 4)', () => {
  /** Give the fixture repo a local + origin ref so git state is readable. */
  function writeRefs(root: string, head: string, origin?: string): void {
    mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${head}\n`)
    if (origin !== undefined) {
      mkdirSync(join(root, '.git', 'refs', 'remotes', 'origin'), { recursive: true })
      writeFileSync(join(root, '.git', 'refs', 'remotes', 'origin', 'main'), `${origin}\n`)
    }
  }

  const sha = (c: string): string => c.repeat(40)

  it('reads git state from refs — synced, unpushed, and never-pushed (4.1)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    expect(readGitState(f.root)).toEqual({
      branch: 'main',
      head: 'aaaaaaa',
      upstream: 'aaaaaaa',
      synced: true,
    })

    writeRefs(f.root, sha('b'), sha('a'))
    expect(readGitState(f.root)?.synced).toBe(false)

    const g = fx({ slug: 'alpha' })
    writeRefs(g.root, sha('c'))
    expect(readGitState(g.root)).toMatchObject({ upstream: null, synced: false })
  })

  it('renders one derived Git line in the status block (4.1)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'sess-1')

    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).stdout
    expect(out).toContain('Git: main @ aaaaaaa — in sync with origin/main')

    writeRefs(f.root, sha('b'), sha('a'))
    expect(
      handleSessionStart(f.root, JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' })).stdout,
    ).toContain('unpushed work')
  })

  it('tells a live session that a sibling wrapped, and whether it is pushed (4.2)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    endSession(f.root, 'alpha', 'sibling')

    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('session sibling wrapped while you worked')
    expect(out).toContain('pushed (in sync with origin/main)')
  })

  it('says NOT pushed when the local tip is ahead of origin (4.2)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('b'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    endSession(f.root, 'alpha', 'sibling')

    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('NOT pushed (origin/main at aaaaaaa)')
  })

  it('still reports a sibling that wrapped AFTER my own write-back (0.13.0)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine', '2026-08-01T10:00:00.000Z')
    endSession(f.root, 'alpha', 'mine', '2026-08-01T10:01:00.000Z') // wrote back mid-flight...
    register(f.root, 'alpha', 'sibling', '2026-08-01T10:02:00.000Z')
    endSession(f.root, 'alpha', 'sibling', '2026-08-01T10:03:00.000Z') // ...sibling wraps after

    // 0.12.1 went silent here, which lost a real parallel wrap-up: writing
    // back does not mean the session stopped working.
    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out).toContain('session sibling wrapped while you worked')
  })

  it('does not re-report a sibling that wrapped BEFORE my last write-back (0.13.0)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine', '2026-08-01T10:00:00.000Z')
    register(f.root, 'alpha', 'sibling', '2026-08-01T10:01:00.000Z')
    endSession(f.root, 'alpha', 'sibling', '2026-08-01T10:02:00.000Z') // wraps first...
    endSession(f.root, 'alpha', 'mine', '2026-08-01T10:03:00.000Z') // ...I absorb it

    // 0.12.0 kept announcing it for the rest of the session's life.
    expect(handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout).toBe('')
  })

  it('keeps next_action and push state when the summary is long (0.12.1 budget order)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    appendEvent(
      f.eventsPath,
      makeEvent({
        initiative: 'alpha',
        session: 'sibling',
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: {
          session_id: 'sibling',
          summary: 'x'.repeat(2000), // swamps the budget on its own
          next_action: 'run the migration',
        },
      }),
    )

    const out = handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout
    expect(out.length).toBeLessThanOrEqual(PARALLEL_WRAP_BUDGET)
    expect(out).toContain('next: run the migration') // survived, un-clipped
    expect(out).toContain('pushed (in sync with origin/main)')
  })

  it('stays silent when no sibling wrapped, and ignores mechanical closes (4.2)', () => {
    const f = fx({ slug: 'alpha' })
    writeRefs(f.root, sha('a'), sha('a'))
    register(f.root, 'alpha', 'mine')
    register(f.root, 'alpha', 'sibling')
    // A bare session_closed is not a write-back — nothing to report.
    handleSessionEnd(f.root, JSON.stringify({ session_id: 'sibling', reason: 'clear' }))

    expect(handleUserPrompt(f.root, JSON.stringify({ session_id: 'mine', cwd: '/tmp' })).stdout).toBe('')
  })

  it('reports EVERY unwritten session, not just the newest (4.3)', () => {
    const f = fx({ slug: 'alpha' })
    // Three sessions with real activity; none writes back.
    for (const id of ['s1', 's2', 's3']) {
      handlePostTool(f.root, bashStdin(id, 'npm test'))
    }
    const state = foldLog(f.eventsPath).state
    expect(unwrittenSessions(state.sessions).map((s) => s.id)).toEqual(['s3', 's2', 's1'])

    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 's3', cwd: '/tmp' })).stdout
    expect(out).toContain('2 other session(s) did work without writing back')
    expect(out).toContain('s2')
    expect(out).toContain('s1')
  })

  it('a single write-back no longer hides the other unwritten sessions (4.3)', () => {
    const f = fx({ slug: 'alpha' })
    for (const id of ['s1', 's2']) handlePostTool(f.root, bashStdin(id, 'npm test'))
    endSession(f.root, 'alpha', 's2') // pre-4.3 this hid s1 from the block entirely

    const out = handleSessionStart(f.root, JSON.stringify({ session_id: 's2', cwd: '/tmp' })).stdout
    expect(out).toContain('1 other session(s) did work without writing back')
    expect(out).toContain('s1')
  })
})

describe('one identity per agent across a mid-conversation write-back (5.1)', () => {
  /**
   * The 0.12.0 defect, end to end: an agent writes back, keeps working, and
   * calls start_session again. Before 5.1 that errored, the agent minted a
   * fresh id, and the record held TWO identities for one agent — which the
   * parallel-wrap line then reported as a sibling that "wrapped while you
   * worked".
   */
  it('adopting after a write-back keeps one identity and reports no phantom sibling', async () => {
    const f = fx({ slug: 'alpha' })
    mkdirSync(join(f.root, '.git', 'refs', 'heads'), { recursive: true })
    writeFileSync(join(f.root, '.git', 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`)
    handlePostTool(f.root, bashStdin('agent-1', 'npm test')) // hook registers it

    const { client, handle } = await connectServer(f.root)
    try {
      await callTool(client, 'sofar_end_session', {
        session_id: 'agent-1',
        summary: 'batch one done',
        next_action: 'start batch two',
      })
      // ...work continues, and the agent re-orients.
      const again = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
        tool: 'claude-code',
        session_id: 'agent-1',
      })
      expect(again.isError).toBe(false)
      expect(again.body.session_id).toBe('agent-1')
    } finally {
      await client.close()
      await handle.server.close()
    }

    // Exactly one identity in the record — no replacement id was minted.
    expect(foldLog(f.eventsPath).state.sessions.map((s) => s.id)).toEqual(['agent-1'])
    // And therefore nothing that looks like a parallel session wrapping.
    expect(
      handleUserPrompt(f.root, JSON.stringify({ session_id: 'agent-1', cwd: '/tmp' })).stdout,
    ).not.toContain('wrapped while you worked')
  })
})

describe('regression guard', () => {
  /**
   * End to end: the exact sequence that produced 21 split sessions in this
   * repo's own record — work, switch branch, keep working, close — must now
   * leave doctor's routing audit clean.
   */
  it('a branch switch mid-session no longer splits the record', () => {
    const f = fx({ slug: 'alpha' })
    addInitiative(f.root, 'beta')

    handlePostTool(f.root, bashStdin('sess-1', 'npm run build')) // registers in alpha
    rebind(f.root, 'main', 'beta') // the switch that used to tear it
    handlePostTool(f.root, bashStdin('sess-1', 'npm test'))
    handleSessionEnd(f.root, JSON.stringify({ session_id: 'sess-1', reason: 'clear' }))

    const r = runDoctor(f.root)
    expect(r.stdout).toContain('no session spans more than one initiative')
    expect(foldLog(f.eventsPath).unregistered_sessions).toEqual([])

    const alpha = logEvents(f.eventsPath).map((e) => e.type)
    expect(alpha).toEqual(['session_started', 'command_run', 'command_run', 'session_closed'])
  })
})
