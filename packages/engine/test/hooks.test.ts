import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import {
  handlePostTool,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  STOP_BLOCK_MESSAGE,
} from '../src/cli/event'
import { callTool, connectServer, makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Phase 3 hook surface: shim scripts (3.1) + `harness event` handlers.
 * Handlers are pure-ish ({exitCode, stdout, stderr}) so these tests drive
 * them directly; the built-CLI path is covered by acceptance.phase3.test.ts.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const hooksDir = join(here, '..', 'src', 'hooks')

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

function logEvents(path: string): EventEnvelope[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => JSON.parse(line) as EventEnvelope)
}

const hookStdin = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    session_id: 'claude-sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp',
    ...fields,
  })

describe('hook shims (3.1) — zero logic, exec the CLI (BD4)', () => {
  const shims: Array<[string, string]> = [
    ['session-start.sh', 'session-start'],
    ['post-tool-use.sh', 'post-tool'],
    ['stop.sh', 'stop'],
    ['session-end.sh', 'session-end'],
  ]

  for (const [file, subcommand] of shims) {
    it(`${file} is a POSIX sh shim that execs \`harness event ${subcommand}\``, () => {
      const content = readFileSync(join(hooksDir, file), 'utf8')
      const lines = content.split('\n')
      expect(lines[0]).toBe('#!/bin/sh')
      expect(content).toContain(`exec harness event ${subcommand}`)
      // no logic: nothing but the shebang, comments, and the exec line
      const codeLines = lines.filter((l) => l.trim() !== '' && !l.startsWith('#'))
      expect(codeLines).toEqual([`exec harness event ${subcommand}`])
    })
  }
})

describe('harness event session-start — session registration (BD20)', () => {
  it('appends session_started with envelope.session = Claude session_id, source hook, tool claude-code', () => {
    const fixture = fx()
    const result = handleSessionStart(fixture.root, hookStdin({ hook_event_name: 'SessionStart', source: 'startup' }))
    expect(result.exitCode).toBe(0)

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'session_started',
      payload: { tool: 'claude-code' },
      session: 'claude-sess-1',
      source: 'hook',
      actor: 'agent',
      initiative: fixture.slug,
    })
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions[0]).toMatchObject({ id: 'claude-sess-1', tool: 'claude-code' })
  })

  it('re-fire with the same session_id (resume/compact) does not append a duplicate', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({ source: 'startup' }))
    handleSessionStart(fixture.root, hookStdin({ source: 'resume' }))
    handleSessionStart(fixture.root, hookStdin({ source: 'compact' }))
    expect(logEvents(fixture.eventsPath)).toHaveLength(1)
    expect(foldLog(fixture.eventsPath).warnings).toEqual([])
  })

  it('missing .harness → exit 0, no output, nothing appended (best-effort, BD22)', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.harness'), { recursive: true, force: true })
    const result = handleSessionStart(fixture.root, hookStdin({}))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(existsSync(fixture.eventsPath)).toBe(false)
  })

  it('unbound branch → exit 0, nothing appended', () => {
    const fixture = fx({ bind: false })
    const result = handleSessionStart(fixture.root, hookStdin({}))
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(fixture.eventsPath)).toBe(false)
  })

  it('unreadable stdin or missing session_id → exit 0, no session_started appended', () => {
    const fixture = fx()
    expect(handleSessionStart(fixture.root, 'not json{{{').exitCode).toBe(0)
    expect(handleSessionStart(fixture.root, JSON.stringify({ cwd: '/x' })).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })
})

describe('harness event post-tool — mechanical file/command events (3.3)', () => {
  const postToolStdin = (toolName: string, toolInput: Record<string, unknown>): string =>
    hookStdin({
      hook_event_name: 'PostToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_response: { success: true },
    })

  it('Edit → exactly one file_touched {path, op: edit} (acceptance)', () => {
    const fixture = fx()
    const result = handlePostTool(
      fixture.root,
      postToolStdin('Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' }),
    )
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'file_touched',
      payload: { path: '/repo/src/a.ts', op: 'edit' },
      session: 'claude-sess-1',
      source: 'hook',
      actor: 'agent',
    })
    expect(foldLog(fixture.eventsPath).state.files_touched).toEqual(['/repo/src/a.ts'])
  })

  it('MultiEdit → op edit; Write → op write', () => {
    const fixture = fx()
    handlePostTool(fixture.root, postToolStdin('MultiEdit', { file_path: '/repo/multi.ts' }))
    handlePostTool(fixture.root, postToolStdin('Write', { file_path: '/repo/new.ts', content: 'x' }))

    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => [e.type, e.payload.path, e.payload.op])).toEqual([
      ['file_touched', '/repo/multi.ts', 'edit'],
      ['file_touched', '/repo/new.ts', 'write'],
    ])
  })

  it('Bash → exactly one command_run {cmd} (acceptance)', () => {
    const fixture = fx()
    handlePostTool(fixture.root, postToolStdin('Bash', { command: 'npm test', description: 'run tests' }))

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'command_run',
      payload: { cmd: 'npm test' },
      session: 'claude-sess-1',
      source: 'hook',
    })
    expect(foldLog(fixture.eventsPath).warnings).toEqual([])
  })

  it('unknown tool_name → exit 0, zero appends', () => {
    const fixture = fx()
    expect(handlePostTool(fixture.root, postToolStdin('Read', { file_path: '/x.ts' })).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, postToolStdin('Glob', { pattern: '**' })).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })

  it('missing file_path / command → exit 0, zero appends (defensive parsing)', () => {
    const fixture = fx()
    expect(handlePostTool(fixture.root, postToolStdin('Edit', {})).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, postToolStdin('Bash', {})).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, hookStdin({ hook_event_name: 'PostToolUse' })).exitCode).toBe(0)
    expect(handlePostTool(fixture.root, 'garbage').exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })

  it('missing session_id falls back to envelope session "cli"', () => {
    const fixture = fx()
    handlePostTool(
      fixture.root,
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }),
    )
    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'command_run', session: 'cli', source: 'hook' })
  })

  it('unbound repo → exit 0, nothing appended (BD22)', () => {
    const fixture = fx({ bind: false })
    const result = handlePostTool(fixture.root, postToolStdin('Edit', { file_path: '/x.ts' }))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    expect(existsSync(fixture.eventsPath)).toBe(false)
  })
})

describe('harness event stop — write-back enforcement (3.4, BD2)', () => {
  const stopStdin = (fields: Record<string, unknown> = {}): string =>
    hookStdin({ hook_event_name: 'Stop', stop_hook_active: false, ...fields })

  /** Append a session_ended the way any writer would — straight to the log. */
  function appendSessionEnded(fixture: Fixture, sessionId: string): void {
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: sessionId,
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { session_id: sessionId, summary: 'wrote back', next_action: 'continue 3.4' },
      }),
    )
  }

  it('blocks a started-but-unwritten session: exit 2 with the exact write-back message (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))

    const result = handleStop(fixture.root, stopStdin())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe(STOP_BLOCK_MESSAGE)
    expect(result.stderr).toBe(
      'Write back to the harness record before finishing: call harness_end_session (or update harness.md per protocol).',
    )
    expect(result.stdout).toBe('')
    // the check appends nothing
    expect(logEvents(fixture.eventsPath)).toHaveLength(1)
  })

  it('passes a session that wrote back via a session_ended event (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    appendSessionEnded(fixture, 'claude-sess-1')

    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('passes after the MCP adopt-and-end flow closes the hook-registered session', async () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))

    // blocked before write-back
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(2)

    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'harness_start_session', {
      tool: 'claude-code',
    })
    expect(started.body.session_id).toBe('claude-sess-1') // adopted (BD20)
    await callTool(client, 'harness_end_session', {
      session_id: started.body.session_id,
      summary: 'ended via MCP',
      next_action: 'nothing',
    })
    await client.close()

    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)
  })

  it('stop_hook_active → exit 0 even when the session has not written back (loop guard, acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))

    const result = handleStop(fixture.root, stopStdin({ stop_hook_active: true }))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('unregistered session_id → exit 0 (never block sessions the harness does not govern)', () => {
    const fixture = fx()
    // log exists but this session never registered
    handleSessionStart(fixture.root, hookStdin({ session_id: 'some-other-session' }))
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)

    // empty log entirely
    const fresh = fx()
    expect(handleStop(fresh.root, stopStdin()).exitCode).toBe(0)
  })

  it('a mechanical session_closed is NOT a write-back — stop still blocks', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'claude-sess-1',
        source: 'hook',
        actor: 'agent',
        type: 'session_closed',
        payload: { reason: 'exit' },
      }),
    )
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(2)
  })

  it('unreadable stdin / missing session_id / unbound repo → exit 0 (BD22)', () => {
    const fixture = fx()
    expect(handleStop(fixture.root, '{{{').exitCode).toBe(0)
    expect(handleStop(fixture.root, JSON.stringify({ stop_hook_active: false })).exitCode).toBe(0)

    const unbound = fx({ bind: false })
    expect(handleStop(unbound.root, stopStdin()).exitCode).toBe(0)
  })
})

describe('harness event session-end — mechanical close marker (3.5, BD21)', () => {
  const endStdin = (fields: Record<string, unknown> = {}): string =>
    hookStdin({ hook_event_name: 'SessionEnd', reason: 'exit', ...fields })

  it('appends session_closed; fold marks the session ended without touching next_action', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))

    const before = foldLog(fixture.eventsPath).state
    expect(before.current.next_action).toBeNull()

    const result = handleSessionEnd(fixture.root, endStdin())
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })

    const events = logEvents(fixture.eventsPath)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      type: 'session_closed',
      payload: { reason: 'exit' },
      session: 'claude-sess-1',
      source: 'hook',
      actor: 'agent',
    })

    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    const session = state.sessions.find((s) => s.id === 'claude-sess-1')
    expect(session?.ended).toBeDefined()
    expect(session?.summary).toBeUndefined()
    expect(state.current.next_action).toBeNull() // never fabricated (BD21)
  })

  it('missing reason defaults to "unknown"', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    handleSessionEnd(fixture.root, hookStdin({ hook_event_name: 'SessionEnd' }))
    expect(logEvents(fixture.eventsPath)[1]).toMatchObject({
      type: 'session_closed',
      payload: { reason: 'unknown' },
    })
  })

  it('unregistered session → exit 0, nothing appended (no orphan close markers)', () => {
    const fixture = fx()
    const result = handleSessionEnd(fixture.root, endStdin())
    expect(result.exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(0)
  })

  it('already-ended session (write-back done) → exit 0, no duplicate close', async () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))

    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'harness_start_session', {
      tool: 'claude-code',
    })
    await callTool(client, 'harness_end_session', {
      session_id: started.body.session_id,
      summary: 'wrote back first',
      next_action: 'proceed to 3.6',
    })
    await client.close()

    handleSessionEnd(fixture.root, endStdin())
    const events = logEvents(fixture.eventsPath)
    expect(events.map((e) => e.type)).toEqual(['session_started', 'session_ended'])

    // next_action from the write-back survives untouched
    expect(foldLog(fixture.eventsPath).state.current.next_action).toBe('proceed to 3.6')
  })

  it('unreadable stdin / missing session_id / unbound repo → exit 0 (BD22)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    expect(handleSessionEnd(fixture.root, 'not-json').exitCode).toBe(0)
    expect(handleSessionEnd(fixture.root, JSON.stringify({ reason: 'exit' })).exitCode).toBe(0)
    expect(logEvents(fixture.eventsPath)).toHaveLength(1)

    const unbound = fx({ bind: false })
    expect(handleSessionEnd(unbound.root, endStdin())).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
  })
})
