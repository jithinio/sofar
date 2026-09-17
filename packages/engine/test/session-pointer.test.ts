import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { foldLog } from '../src/core/fold'
import { readSessionPointer, writeSessionPointer } from '../src/core/session-pointer'
import {
  handlePostTool,
  handleSessionEnd,
  handleSessionStart,
  handleUserPrompt,
  runAppend,
  runEventTypes,
  type AppendArgs,
} from '../src/cli/event'
import { AGENTS_PROTOCOL_BLOCK, runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import type { Caps } from '../src/cli/ui'

/**
 * r1-fixes 4.1.3 (L09, D30) — one session id per launch.
 *
 * Round 1: cursor-sofar/r2 logged 20 session_started for 10 launches. Cursor's
 * hooks registered its own session id while the agent, told by the protocol
 * block to pick one, minted a second — so all 10 hook sessions ended without a
 * write-back. PREDICTED: launches with more than 1 session id in Cursor cells
 * = 0; hook sessions without session_ended = 0.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-pointer-'))
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
  return root
}

function boundRepo(): string {
  const root = gitRepo()
  runInit(root, {}, PLAIN, PLAIN)
  runNew(root, 'proj', { bind: true, goal: 'g' }, PLAIN, PLAIN)
  return root
}

const hook = (session: string, fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: session, cwd: '/', ...fields })
const bash = (session: string, command: string): string =>
  hook(session, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } })

function append(root: string, args: Omit<Partial<AppendArgs>, 'payload'> & { type: string; payload: unknown }) {
  const res = runAppend(root, { source: 'cursor', actor: 'agent', ...args, payload: JSON.stringify(args.payload) })
  expect(res.exitCode, res.stderr).toBe(0)
  return JSON.parse(res.stdout) as { ok: true; event_id: string | null; session?: string; already_started?: true }
}

const sessionsOf = (root: string) => foldLog(join(root, '.sofar', 'initiatives', 'proj', 'events.jsonl')).state.sessions

describe('hooks keep the pointer', () => {
  it('SessionStart, UserPromptSubmit and PostToolUse point the worktree at the host session', () => {
    const root = boundRepo()
    handleSessionStart(root, hook('host-1', { hook_event_name: 'SessionStart' }))
    expect(readSessionPointer(root)).toMatchObject({ session: 'host-1', writer: 'hook' })
    handleUserPrompt(root, hook('host-2', { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }))
    expect(readSessionPointer(root)?.session).toBe('host-2')
    handlePostTool(root, bash('host-3', 'ls'))
    expect(readSessionPointer(root)?.session).toBe('host-3')
  })

  it('SessionEnd removes it only when it still names that session', () => {
    const root = boundRepo()
    handleSessionStart(root, hook('host-1', { hook_event_name: 'SessionStart' }))
    handleSessionEnd(root, hook('someone-else', { hook_event_name: 'SessionEnd', reason: 'exit' }))
    expect(readSessionPointer(root)?.session).toBe('host-1')
    handleSessionEnd(root, hook('host-1', { hook_event_name: 'SessionEnd', reason: 'exit' }))
    expect(readSessionPointer(root)).toBeNull()
  })

  it('a repo with no .sofar gets no pointer', () => {
    const root = gitRepo()
    handleSessionStart(root, hook('host-1', { hook_event_name: 'SessionStart' }))
    expect(readSessionPointer(root)).toBeNull()
    expect(existsSync(join(root, '.sofar'))).toBe(false)
  })

  it('lives in the self-ignoring index dir: never shows in git status', () => {
    const root = boundRepo()
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-qm', 'wired'], { cwd: root })
    handleSessionStart(root, hook('host-1', { hook_event_name: 'SessionStart' }))
    expect(existsSync(join(root, '.sofar', '.index', 'session.json'))).toBe(true)
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe('')
  })
})

describe('event append with no --session', () => {
  it('replays the round-1 Cursor launch as ONE session that writes back', () => {
    const root = boundRepo()
    // Cursor fires the Claude-format hooks: orientation, then the agent's first
    // shell call (`sofar status`) — which also registers the hook session.
    handleSessionStart(root, hook('cursor-conv-7', { hook_event_name: 'SessionStart' }))
    handlePostTool(root, bash('cursor-conv-7', 'npm test'))
    // The agent follows the block: no --session anywhere.
    const start = append(root, { type: 'session_started', payload: { tool: 'cursor' } })
    expect(start.session).toBe('cursor-conv-7')
    append(root, { type: 'decision_logged', payload: { chose: 'a', over: 'b', because: 'c' } })
    const end = append(root, { type: 'session_ended', payload: { summary: 's', next_action: 'n' } })
    expect(end.session).toBe('cursor-conv-7')

    const sessions = sessionsOf(root)
    expect(sessions.map((s) => s.id)).toEqual(['cursor-conv-7'])
    expect(sessions[0]!.summary).toBe('s')
  })

  it('a hookless start mints an id, repeats join it, and the next launch after a write-back gets a new one', () => {
    const root = boundRepo()
    const first = append(root, { type: 'session_started', source: 'codex', payload: { tool: 'codex' } })
    expect(first.session).toMatch(/^cli-[0-9A-Z]{26}$/)
    expect(readSessionPointer(root)).toMatchObject({ session: first.session, writer: 'cli' })

    const again = append(root, { type: 'session_started', source: 'codex', payload: { tool: 'codex' } })
    expect(again).toMatchObject({ already_started: true, session: first.session })
    append(root, { type: 'note_added', payload: { text: 'x' } })
    append(root, { type: 'session_ended', payload: { summary: 's1', next_action: 'n1' } })

    const second = append(root, { type: 'session_started', source: 'codex', payload: { tool: 'codex' } })
    expect(second.session).not.toBe(first.session)
    expect(sessionsOf(root).map((s) => [s.id, s.summary])).toEqual([
      [first.session, 's1'],
      [second.session, undefined],
    ])
  })

  it('a start after the hook session ended (SessionEnd missed) mints instead of reviving it', () => {
    const root = boundRepo()
    handlePostTool(root, bash('host-9', 'ls'))
    append(root, { type: 'session_ended', session: 'host-9', payload: { summary: 's', next_action: 'n' } })
    expect(readSessionPointer(root)?.session).toBe('host-9')
    expect(append(root, { type: 'session_started', payload: { tool: 'codex' } }).session).toMatch(/^cli-/)
  })

  it('an explicit --session wins, leaves the pointer alone and prints no session', () => {
    const root = boundRepo()
    writeSessionPointer(root, 'host-1', 'hook')
    const res = append(root, { type: 'session_started', session: 'mine', payload: { tool: 'opencode' } })
    expect(res.session).toBeUndefined()
    expect(readSessionPointer(root)?.session).toBe('host-1')
    expect(sessionsOf(root).map((s) => s.id)).toEqual(['mine'])
  })

  it('with no pointer, a non-start append keeps the old `cli` session', () => {
    const root = boundRepo()
    expect(append(root, { type: 'note_added', payload: { text: 'x' } }).session).toBe('cli')
    expect(readSessionPointer(root)).toBeNull()
  })

  it('an empty --session is still refused', () => {
    const root = boundRepo()
    const res = runAppend(root, { type: 'note_added', payload: '{"text":"x"}', session: '', source: 'cli', actor: 'agent' })
    expect(res.exitCode).toBe(1)
  })
})

describe('the CLI dialect stops asking for an invented id', () => {
  it('no example in the AGENTS block passes --session; only the shared-worktree caveat names it', () => {
    expect(AGENTS_PROTOCOL_BLOCK).not.toContain('--session <session-id>')
    expect(AGENTS_PROTOCOL_BLOCK.match(/--session\b(?!-)/g)).toHaveLength(3) // WITHOUT, without, and the caveat
    expect(AGENTS_PROTOCOL_BLOCK).toContain('never invent an id')
    expect(AGENTS_PROTOCOL_BLOCK).toContain("`sofar event append <slug> --type session_started --source <tool> --payload '{\"tool\":\"<tool>\"}'`")
  })

  it('`sofar event types` usage omits --session', () => {
    const head = runEventTypes().stdout.split('\n')[0]!
    expect(head).not.toContain('--session <id>')
    expect(head).toContain('no --session')
  })

  it('the pointer file is plain JSON a second implementation can read', () => {
    const root = boundRepo()
    writeSessionPointer(root, 'host-1', 'hook')
    const raw = JSON.parse(readFileSync(join(root, '.sofar', '.index', 'session.json'), 'utf8'))
    expect(Object.keys(raw)).toEqual(['session', 'writer', 'ts'])
  })
})
