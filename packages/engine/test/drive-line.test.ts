import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { driveLine, handleUserPrompt, SUBCOMMANDS } from '../src/cli/event'
import { driveSeenPath } from '../src/core/drive-seen'
import { makeEvent } from '../src/core/envelope'
import { foldLog, type InitiativeState, type SessionState } from '../src/core/fold'
import { appendEvent } from '../src/core/log'
import { claimRunLock, type RunLockOptions } from '../src/core/run-lock'
import { NUDGE_ENV } from '../src/driver/nudge'

/**
 * The prompt's drive line (drive-visibility 3.2): how the session's
 * initiative's run stands, printed only when the run moved since this session
 * last saw it — and the lock is probed only when it prints, since on Linux a
 * probe is a subprocess and the per-prompt path spawns nothing
 * unconditionally.
 */

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const SESSION = 'sess-drive-line'

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

interface Repo {
  root: string
  log: string
  /** A state base of the test's own: the lock and the seen marks live there. */
  env: { XDG_STATE_HOME: string }
}

function repo(): Repo {
  const root = temp('sofar-drive-line-')
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  mkdirSync(dir, { recursive: true })
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, '')
  const r = { root, log, env: { XDG_STATE_HOME: temp('sofar-drive-line-state-') } }
  append(r, 'initiative_created', { slug: 'demo', goal: 'g' })
  append(r, 'plan_updated', {
    plan: {
      goal: 'g',
      phases: [{ name: 'P1', status: 'active', tasks: ['1.1', '1.2', '1.3'].map((id) => ({ id, title: `task ${id}`, status: 'pending' })) }],
    },
  })
  return r
}

function append(r: Repo, type: string, payload: Record<string, unknown>, session = 'cli'): void {
  appendEvent(r.log, makeEvent({ initiative: 'demo', session, type, payload, source: 'cli', actor: 'agent' }))
}

function startSession(r: Repo): void {
  appendEvent(r.log, makeEvent({ initiative: 'demo', session: SESSION, type: 'session_started', payload: { tool: 'claude-code' }, source: 'hook', actor: 'agent' }))
}

function openRun(r: Repo): string {
  const run = ulid()
  append(r, 'run_started', { run, adapter: 'fake', policy: 'task' })
  return run
}

function folded(r: Repo): { state: InitiativeState; me: SessionState } {
  const state = foldLog(r.log).state
  return { state, me: state.sessions.find((s) => s.id === SESSION)! }
}

function line(r: Repo, env: Record<string, string> = r.env, lock?: RunLockOptions): string | null {
  const { state, me } = folded(r)
  return driveLine(r.root, state, me, env, lock)
}

describe('the drive line (drive-visibility 3.2)', () => {
  it('is silent with no run, and for a run that stopped before this session began', async () => {
    const r = repo()
    startSession(r)
    expect(line(r)).toBeNull()

    const s = repo()
    const run = openRun(s)
    append(s, 'run_stopped', { run, reason: 'closed' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    startSession(s)
    expect(line(s)).toBeNull()
  })

  it('speaks on the first prompt, then only when the run moves — a handoff, a task done, the task in flight', async () => {
    const r = repo()
    const run = openRun(r)
    startSession(r)
    const claim = await claimRunLock(r.root, run, { env: r.env })
    expect(claim.kind).toBe('claimed')
    try {
      expect(line(r)).toBe(`sofar drive: run ${run} running · 0 handoffs · now on 1.1 · 0/3`)
      expect(line(r)).toBeNull()

      // The session's own work moves nothing the line shows.
      append(r, 'note_added', { text: 'unrelated' }, SESSION)
      expect(line(r)).toBeNull()

      append(r, 'task_status_changed', { id: '1.1', status: 'done' })
      append(r, 'handoff', { run, session_id: 'S1', reason: 'task_done', task: '1.1' })
      expect(line(r)).toBe(`sofar drive: run ${run} running · 1 handoff · now on 1.2 · 1/3`)
      expect(line(r)).toBeNull()
    } finally {
      if (claim.kind === 'claimed') claim.lock.release()
    }
  })

  it('says a run stopped since this session began once, with its reason and no task in flight', () => {
    const r = repo()
    const run = openRun(r)
    startSession(r)
    expect(line(r)).toContain('liveness unknown · 0 handoffs · now on 1.1')
    append(r, 'task_status_changed', { id: '1.1', status: 'blocked', note: 'which region?' })
    append(r, 'handoff', { run, session_id: 'S1', reason: 'needs_user', task: '1.1' })
    append(r, 'run_stopped', { run, reason: 'needs_user', note: '1.1 is blocked — read its note' })
    expect(line(r)).toBe(`sofar drive: run ${run} stopped: needs_user · 1 handoff · 0/3`)
    expect(line(r)).toBeNull()
  })

  it('never reads a run with no lock here as gone, and names a free lock driver gone', async () => {
    const r = repo()
    const run = openRun(r)
    startSession(r)
    expect(line(r)).toContain(`run ${run} liveness unknown ·`)
    const died = await claimRunLock(r.root, run, { env: r.env })
    if (died.kind === 'claimed') died.lock.release()
    // The death moved nothing in the record; the next news carries it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    append(r, 'task_status_changed', { id: '1.1', status: 'active' })
    append(r, 'handoff', { run, session_id: 'S1', reason: 'stall', task: '1.1' })
    expect(line(r)).toMatch(new RegExp(`^sofar drive: run ${run} (driver gone|running) · 1 handoff`))
  })

  it('repeats the line when the mark is lost or cannot be written — never silences it', () => {
    const r = repo()
    openRun(r)
    startSession(r)
    expect(line(r)).not.toBeNull()
    expect(line(r)).toBeNull()
    rmSync(driveSeenPath(r.root, r.env)!)
    expect(line(r)).not.toBeNull()

    // A state base that is a file: nothing can be written under it.
    const blocked = join(temp('sofar-drive-line-file-'), 'state')
    writeFileSync(blocked, '')
    const env = { XDG_STATE_HOME: blocked }
    expect(line(r, env)).not.toBeNull()
    expect(line(r, env)).not.toBeNull()
  })

  it('is silent in a session the driver launched', () => {
    const r = repo()
    openRun(r)
    startSession(r)
    expect(line(r, { ...r.env, [NUDGE_ENV]: '/tmp/sofar-drive-x/nudge' })).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('probes the lock only when the line prints — a quiet prompt spawns nothing', () => {
    const r = repo()
    const run = openRun(r)
    startSession(r)
    // The lock file a driver left, and a flock(1) that counts its calls.
    mkdirSync(join(r.env.XDG_STATE_HOME, 'sofar', 'runs'), { recursive: true })
    writeFileSync(join(r.env.XDG_STATE_HOME, 'sofar', 'runs', `${run}.lock`), '')
    const bin = temp('sofar-drive-line-bin-')
    const count = join(bin, 'count')
    writeFileSync(join(bin, 'flock'), `#!/bin/sh\necho x >> "${count}"\nexit 0\n`)
    chmodSync(join(bin, 'flock'), 0o755)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
    const calls = (): number => {
      try {
        return readFileSync(count, 'utf8').split('\n').filter(Boolean).length
      } catch {
        return 0
      }
    }
    expect(line(r, r.env, { primitive: 'flock1' })).toContain('driver gone')
    expect(calls()).toBe(1)
    for (let i = 0; i < 3; i++) expect(line(r, r.env, { primitive: 'flock1' })).toBeNull()
    expect(calls()).toBe(1)
  })

  it('reaches the prompt hook, for Claude Code and for Codex', () => {
    const r = repo()
    const run = openRun(r)
    startSession(r)
    vi.stubEnv('XDG_STATE_HOME', r.env.XDG_STATE_HOME)
    vi.stubEnv(NUDGE_ENV, '')
    const out = handleUserPrompt(r.root, JSON.stringify({ session_id: SESSION, prompt: 'hi' }))
    expect(out.stdout).toContain(`sofar drive: run ${run} liveness unknown · 0 handoffs · now on 1.1 · 0/3`)

    append(r, 'task_status_changed', { id: '1.1', status: 'done' })
    const codex = SUBCOMMANDS.find((c) => c.name === 'user-prompt')!.handler(r.root, JSON.stringify({ session_id: SESSION, prompt: 'hi' }), 'codex')
    const context = (JSON.parse(codex.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    expect(context).toContain(`sofar drive: run ${run} liveness unknown · 0 handoffs · now on 1.2 · 1/3`)
  })
})
