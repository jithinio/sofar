import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog } from '../src/core/fold'
import { handlePostTool, handleSessionStart, unboundNotice } from '../src/cli/event'
import { runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import type { Caps } from '../src/cli/ui'
import { createToolContext } from '../src/mcp/context'
import { startSession } from '../src/mcp/start-session'
import { STATUS_CHAR_LIMIT } from '../src/projections/templates/status'

/**
 * r1-fixes 1.1 — the first session in a freshly initialised repo.
 *
 * Round 1: Claude S1 cells injected 0 chars at SessionStart (no initiative
 * yet), so the session had no id to adopt and no hint to follow. It spent
 * turns discovering `sofar new`, then called sofar_start_session with no id —
 * a second identity beside the one the PostToolUse hook registers. PREDICTED:
 * −3 to −4 turns on S1 and no split sessions.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** A git repo on `main` after `sofar init`, with no initiative. */
function initedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-first-session-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  }
  git('init', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  writeFileSync(join(root, 'README.md'), 'x\n')
  git('add', '-A')
  git('commit', '-m', 'init')
  runInit(root, {}, PLAIN, PLAIN)
  return root
}

const hook = (root: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: 'claude-s1', cwd: root, ...extra })

describe('SessionStart before any initiative exists (r1-fixes 1.1)', () => {
  it('injects the Session id and the create → adopt → plan moves, in that order', () => {
    const root = initedRepo()
    const out = handleSessionStart(root, hook(root))
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toMatch(/^# Sofar: no initiative yet/)
    // The same adopt-by-id line the status block carries, byte for byte.
    expect(out.stdout).toContain(
      'Session: claude-s1 — when calling sofar_start_session, pass this as session_id.',
    )
    const create = out.stdout.indexOf('sofar new <slug> --goal')
    const adopt = out.stdout.indexOf('sofar_start_session with the session_id above')
    const plan = out.stdout.indexOf('sofar_update_plan')
    expect(create).toBeGreaterThan(-1)
    expect(adopt).toBeGreaterThan(create)
    expect(plan).toBeGreaterThan(adopt)
    expect(out.stdout).toMatch(/one initiative for the project or roadmap/)
    // Nothing to switch to, so the switch move is not offered.
    expect(out.stdout).not.toMatch(/sofar switch/)
    expect(out.stdout.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })

  it('stays small — it is paid on every first session', () => {
    const root = initedRepo()
    expect(handleSessionStart(root, hook(root)).stdout.length).toBeLessThan(700)
  })

  it('appends nothing (record-hygiene D2)', () => {
    const root = initedRepo()
    handleSessionStart(root, hook(root))
    expect(runNew(root, 'probe', { bind: false }, PLAIN, PLAIN).exitCode).toBe(0)
    const state = foldLog(join(root, '.sofar', 'initiatives', 'probe', 'events.jsonl')).state
    expect(state.sessions).toEqual([])
  })

  it('without a hook session id, the hint still renders but names no id', () => {
    const root = initedRepo()
    const text = unboundNotice(root, null)
    expect(text).toMatch(/no initiative yet/)
    expect(text).not.toMatch(/^Session:/m)
    expect(text).not.toMatch(/session_id above/)
    expect(text).toMatch(/2\. sofar_start_session\n/)
  })

  it('clips an oversized session id rather than trusting its size', () => {
    const root = initedRepo()
    const text = unboundNotice(root, 'x'.repeat(5_000))
    expect(text.length).toBeLessThan(1_000)
  })

  it('following the hint yields exactly ONE session — hook and MCP agree', () => {
    const root = initedRepo()
    handleSessionStart(root, hook(root))
    // 1. create (binds main); the `sofar new` Bash call itself is exempt.
    expect(runNew(root, 'boopada', { bind: true, goal: 'the project' }, PLAIN, PLAIN).exitCode).toBe(0)
    // 2. adopt with the injected id.
    const ctx = createToolContext(root)
    expect(startSession(ctx, { tool: 'claude-code', session_id: 'claude-s1' })).toEqual({
      session_id: 'claude-s1',
    })
    // Work follows; the hook sees the same id.
    handlePostTool(
      root,
      hook(root, { tool_name: 'Write', tool_input: { file_path: join(root, 'a.ts') } }),
    )
    const { state, warnings } = foldLog(join(root, '.sofar', 'initiatives', 'boopada', 'events.jsonl'))
    expect(state.sessions.map((s) => s.id)).toEqual(['claude-s1'])
    expect(warnings).toEqual([])
  })

  it('the split it prevents: an id-less start beside hook registration is TWO sessions', () => {
    const root = initedRepo()
    runNew(root, 'boopada', { bind: true, goal: 'the project' }, PLAIN, PLAIN)
    const minted = startSession(createToolContext(root), { tool: 'claude-code' }).session_id
    handlePostTool(
      root,
      hook(root, { tool_name: 'Write', tool_input: { file_path: join(root, 'a.ts') } }),
    )
    const { state } = foldLog(join(root, '.sofar', 'initiatives', 'boopada', 'events.jsonl'))
    expect(state.sessions.map((s) => s.id).sort()).toEqual([minted, 'claude-s1'].sort())
  })
})

describe('the unbound notice with records present also carries the id (r1-fixes 1.1)', () => {
  it('names the id and asks for it on sofar_start_session', () => {
    const root = initedRepo()
    runNew(root, 'demo', { bind: false }, PLAIN, PLAIN)
    const out = handleSessionStart(root, hook(root))
    expect(out.stdout).toMatch(/^# Sofar: this branch is not bound to an initiative/)
    expect(out.stdout).toContain('Session: claude-s1 — when calling sofar_start_session')
    expect(out.stdout).toMatch(/sofar switch <slug>.*demo/)
    expect(out.stdout).toMatch(/Then call sofar_start_session with the session_id above\./)
  })
})
