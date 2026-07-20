import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog, freshnessTotal } from '../src/core/fold'
import {
  COLD_RESUME_GAP_MS,
  COLD_RESUME_MIN_TRANSCRIPT_BYTES,
  handlePostTool,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPrompt,
  NUDGE_DRIFT_MIN,
  STOP_BLOCK_MESSAGE,
} from '../src/cli/event'
import { STATUS_CHAR_LIMIT } from '../src/projections/templates/status'
import { callTool, connectServer, makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Phase 3 hook surface: shim scripts (3.1) + `sofar event` handlers.
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
    ['user-prompt-submit.sh', 'user-prompt'],
    ['post-tool-use.sh', 'post-tool'],
    ['stop.sh', 'stop'],
    ['session-end.sh', 'session-end'],
  ]

  for (const [file, subcommand] of shims) {
    it(`${file} is a POSIX sh shim that execs \`sofar event ${subcommand}\``, () => {
      const content = readFileSync(join(hooksDir, file), 'utf8')
      const lines = content.split('\n')
      expect(lines[0]).toBe('#!/bin/sh')
      expect(content).toContain(`exec sofar event ${subcommand}`)
      // no logic: nothing but the shebang, comments, and the exec line
      const codeLines = lines.filter((l) => l.trim() !== '' && !l.startsWith('#'))
      expect(codeLines).toEqual([`exec sofar event ${subcommand}`])
    })
  }
})

describe('sofar event session-start — session registration (BD20) + context injection (3.2)', () => {
  it('appends session_started with envelope.session = Claude session_id, source hook, tool claude-code', () => {
    const fixture = fx()
    const result = handleSessionStart(fixture.root, hookStdin({ hook_event_name: 'SessionStart', source: 'startup' }))
    expect(result.exitCode).toBe(0)

    // stdout is the status projection — the injected context (3.2, BD3)
    expect(result.stdout).toContain(`# Sofar status: ${fixture.slug}`)
    expect(result.stdout.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
    // the adopt-by-id delivery line (7.1, BD43): the agent reads its id here
    expect(result.stdout).toContain(
      'Session: claude-sess-1 — when calling sofar_start_session, pass this as session_id.',
    )

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

  it('re-fire with the same session_id (resume/compact) does not append a duplicate but still prints context', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({ source: 'startup' }))
    handleSessionStart(fixture.root, hookStdin({ source: 'resume' }))
    const compacted = handleSessionStart(fixture.root, hookStdin({ source: 'compact' }))
    expect(logEvents(fixture.eventsPath)).toHaveLength(1)
    expect(foldLog(fixture.eventsPath).warnings).toEqual([])
    expect(compacted.stdout).toContain('# Sofar status:') // re-injection after compact
  })

  it('missing .sofar → exit 0, no output, nothing appended (best-effort, BD22)', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.sofar'), { recursive: true, force: true })
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

describe('cold-resume advisory (felt-cost 2.1/2.2) — resume-only, read-side, best-effort', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Register the session (record's last event = real now) + a transcript at the size floor. */
  function coldSetup(transcriptBytes = COLD_RESUME_MIN_TRANSCRIPT_BYTES): {
    fixture: Fixture
    transcript: string
  } {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({ source: 'startup' }))
    const transcript = join(fixture.root, 'transcript.jsonl')
    writeFileSync(transcript, 'x'.repeat(transcriptBytes))
    return { fixture, transcript }
  }

  function jumpAhead(ms: number): void {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + ms))
  }

  it('cold record + substantial transcript → one advisory line ABOVE the untouched status block', () => {
    const { fixture, transcript } = coldSetup()
    jumpAhead(2 * COLD_RESUME_GAP_MS)

    const compact = handleSessionStart(fixture.root, hookStdin({ source: 'compact' }))
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(resume.exitCode).toBe(0)
    expect(resume.stdout.startsWith('⚠ Cold resume: ~2h since this record\'s last event')).toBe(true)
    expect(resume.stdout).toContain('re-warms at full input price')
    // composes AROUND the block: everything after the advisory is byte-identical
    // to a compact re-fire of the same record (felt-cost 1.2 pins the block)
    expect(resume.stdout.endsWith(compact.stdout)).toBe(true)
    expect(logEvents(fixture.eventsPath)).toHaveLength(1) // no duplicate registration
  })

  it('gaps ≥48h render as days', () => {
    const { fixture, transcript } = coldSetup()
    jumpAhead(72 * 60 * 60 * 1000)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(resume.stdout).toContain('~3d since this record\'s last event')
  })

  it('warm record (gap under the TTL) → no advisory', () => {
    const { fixture, transcript } = coldSetup()
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(resume.stdout.startsWith('# Sofar status:')).toBe(true)
  })

  it('startup and compact sources never advise, even cold with a big transcript', () => {
    const { fixture, transcript } = coldSetup()
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    for (const source of ['startup', 'compact']) {
      const result = handleSessionStart(fixture.root, hookStdin({ source, transcript_path: transcript }))
      expect(result.stdout.startsWith('# Sofar status:')).toBe(true)
    }
  })

  it('small transcript → cheap re-warm, no advisory', () => {
    const { fixture, transcript } = coldSetup(COLD_RESUME_MIN_TRANSCRIPT_BYTES - 1)
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(resume.stdout.startsWith('# Sofar status:')).toBe(true)
  })

  it('missing transcript file → best-effort silence (no advisory, exit 0)', () => {
    const { fixture } = coldSetup()
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: join(fixture.root, 'nope.jsonl') }),
    )
    expect(resume.exitCode).toBe(0)
    expect(resume.stdout.startsWith('# Sofar status:')).toBe(true)
  })

  it('torn trailing log line is skipped when measuring the gap (fold-style tolerance)', () => {
    const { fixture, transcript } = coldSetup()
    appendFileSync(fixture.eventsPath, '{"v":1,"id":"torn')
    jumpAhead(2 * COLD_RESUME_GAP_MS)
    const resume = handleSessionStart(
      fixture.root,
      hookStdin({ source: 'resume', transcript_path: transcript }),
    )
    expect(resume.stdout.startsWith('⚠ Cold resume:')).toBe(true)
  })
})

describe('sofar event user-prompt — batch-complete nudge (felt-cost 4.1/4.2, D5)', () => {
  /** Registered session + n mechanical drift events since the last write-back. */
  function drifted(n: number): Fixture {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({ source: 'startup' }))
    for (let i = 0; i < n; i++) {
      handlePostTool(
        fixture.root,
        hookStdin({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: `cmd ${i}` } }),
      )
    }
    return fixture
  }

  it('drift ≥ threshold → ONE additionalContext line naming the drift and sofar_end_session', () => {
    const fixture = drifted(NUDGE_DRIFT_MIN)
    const before = readFileSync(fixture.eventsPath, 'utf8')
    const result = handleUserPrompt(fixture.root, hookStdin({}))
    expect(result.exitCode).toBe(0)
    // session_started + N drift events all count toward the total
    expect(result.stdout).toContain('record events since the last write-back')
    expect(result.stdout).toContain('sofar_end_session')
    expect(result.stdout.includes('\n')).toBe(false) // one line
    // read-side: the nudge itself appends nothing
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe(before)
  })

  it('drift below threshold → silence', () => {
    const fixture = drifted(0)
    expect(handleUserPrompt(fixture.root, hookStdin({}))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('write-back resets the drift → silence until the next batch accumulates', () => {
    const fixture = drifted(NUDGE_DRIFT_MIN)
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'claude-sess-1',
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { summary: 'batch one done', next_action: 'start batch two' },
      }),
    )
    expect(handleUserPrompt(fixture.root, hookStdin({})).stdout).toBe('')
  })

  it('unregistered session → not ours to nudge, even with drift', () => {
    const fixture = drifted(NUDGE_DRIFT_MIN)
    const result = handleUserPrompt(fixture.root, hookStdin({ session_id: 'someone-else' }))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('unbound repo / unreadable stdin → silence, exit 0 (BD22)', () => {
    const unbound = fx({ bind: false })
    expect(handleUserPrompt(unbound.root, hookStdin({}))).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    const fixture = drifted(NUDGE_DRIFT_MIN)
    expect(handleUserPrompt(fixture.root, 'not json{{{')).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })
})

describe('sofar event post-tool — mechanical file/command events (3.3)', () => {
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

describe('sofar event stop — write-back enforcement (3.4, BD2)', () => {
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

  /** Seed gate-relevant drift the way a real session does — a PostToolUse Edit. */
  function seedDrift(fixture: Fixture, sessionId = 'claude-sess-1'): void {
    handlePostTool(
      fixture.root,
      hookStdin({
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/drift.ts', old_string: 'a', new_string: 'b' },
      }),
    )
  }

  it('blocks a started-but-unwritten session with drift: exit 2 with the exact write-back message (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    seedDrift(fixture)

    const result = handleStop(fixture.root, stopStdin())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe(STOP_BLOCK_MESSAGE)
    expect(result.stderr).toBe(
      'Write back to the sofar record before finishing: call sofar_end_session (or append session_ended via `sofar event append`).',
    )
    expect(result.stdout).toBe('')
    // the check appends nothing
    expect(logEvents(fixture.eventsPath)).toHaveLength(2)
  })

  it('passes a session that wrote back via a session_ended event (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    seedDrift(fixture)
    appendSessionEnded(fixture, 'claude-sess-1')

    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('passes after the MCP adopt-and-end flow closes the hook-registered session', async () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    seedDrift(fixture)

    // blocked before write-back
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(2)

    const { client } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'claude-sess-1', // the id from the injected context line
    })
    expect(started.body.session_id).toBe('claude-sess-1') // adopted by id (BD43)
    await callTool(client, 'sofar_end_session', {
      session_id: started.body.session_id,
      summary: 'ended via MCP',
      next_action: 'nothing',
    })
    await client.close()

    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)
  })

  it('stop_hook_active → exit 0 even when the session has not written back with drift (loop guard, acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    seedDrift(fixture) // drift armed — only the loop guard lets this exit 0

    const result = handleStop(fixture.root, stopStdin({ stop_hook_active: true }))
    expect(result).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('unregistered session_id → exit 0 (never block sessions the sofar does not govern)', () => {
    const fixture = fx()
    // log exists (with drift) but this session never registered
    handleSessionStart(fixture.root, hookStdin({ session_id: 'some-other-session' }))
    seedDrift(fixture, 'some-other-session')
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)

    // empty log entirely
    const fresh = fx()
    expect(handleStop(fresh.root, stopStdin()).exitCode).toBe(0)
  })

  it('a mechanical session_closed is NOT a write-back — stop still blocks a drifted session', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    seedDrift(fixture)
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

describe('sofar event stop — drift gate (speed T1)', () => {
  const stopStdin = (fields: Record<string, unknown> = {}): string =>
    hookStdin({ hook_event_name: 'Stop', stop_hook_active: false, ...fields })

  /** Append one record event via the writer path (source cli unless given). */
  function appendRecord(
    fixture: Fixture,
    type: string,
    payload: Record<string, unknown>,
    session = 'cli',
    source: 'cli' | 'claude-code' | 'hook' = 'cli',
  ): void {
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session,
        source,
        actor: 'agent',
        type,
        payload,
      }),
    )
  }

  it('zero-event session ends ungated: exit 0, no stderr, no session_ended required (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))

    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
    // the gate appends nothing — the log still holds only the registration
    expect(logEvents(fixture.eventsPath)).toHaveLength(1)
  })

  it('read-only session ends ungated: uncounted lifecycle/plan-structure events never gate (T1 decision)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    // events since (never-)write-back that are NOT mutation-class: another
    // session's lifecycle pair and a plan-structure update
    appendRecord(fixture, 'session_started', { tool: 'claude-code' }, 'other-sess', 'hook')
    appendRecord(fixture, 'session_closed', { reason: 'exit' }, 'other-sess', 'hook')
    appendRecord(fixture, 'plan_updated', {
      plan: { goal: 'g', phases: [{ name: 'P1', tasks: [{ id: 'T1', title: 't' }] }] },
    })

    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('one task update since the write-back gates: exit 2 with the exact BD2 message (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    appendRecord(fixture, 'task_added', { id: 'T1', title: 'the task', phase: 'P1' })
    // an EARLIER session wrote back — the stopping session stays unwritten
    appendRecord(fixture, 'session_started', { tool: 'claude-code' }, 'earlier-sess', 'hook')
    appendRecord(
      fixture,
      'session_ended',
      { session_id: 'earlier-sess', summary: 'seeded', next_action: 'work T1' },
      'earlier-sess',
      'claude-code',
    )
    // task_added is uncounted; the status change after the write-back is the drift
    appendRecord(fixture, 'task_status_changed', { id: 'T1', status: 'active' })

    const result = handleStop(fixture.root, stopStdin())
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe(STOP_BLOCK_MESSAGE)
  })

  it('drift computation error gates (fail closed) — a throw or NaN is never a silent skip (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    // zero real drift: without the failure this session would end ungated
    expect(handleStop(fixture.root, stopStdin()).exitCode).toBe(0)

    const thrown = handleStop(fixture.root, stopStdin(), () => {
      throw new Error('drift computation broke')
    })
    expect(thrown.exitCode).toBe(2)
    expect(thrown.stderr).toBe(STOP_BLOCK_MESSAGE)

    expect(handleStop(fixture.root, stopStdin(), () => Number.NaN).exitCode).toBe(2)
  })

  it('in-flow write-back at drift ≥5 then an eventless turn ends silently (acceptance)', () => {
    const fixture = fx()
    handleSessionStart(fixture.root, hookStdin({}))
    for (const cmd of ['npm test', 'npm run build', 'git status']) {
      handlePostTool(
        fixture.root,
        hookStdin({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd } }),
      )
    }
    for (const file of ['src/a.ts', 'src/b.ts']) {
      handlePostTool(
        fixture.root,
        hookStdin({
          hook_event_name: 'PostToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: file, old_string: 'a', new_string: 'b' },
        }),
      )
    }
    // drift 5 → the UserPromptSubmit nudge fires (the in-flow prompt)
    expect(handleUserPrompt(fixture.root, hookStdin({})).stdout).toContain('write back now')
    // the agent writes back in-flow
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: 'claude-sess-1',
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { summary: 'batch complete', next_action: 'answer follow-ups' },
      }),
    )
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)

    // one Q&A turn later (no events): Stop ends the session silently
    expect(handleStop(fixture.root, stopStdin())).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  })

  it('a concurrent unwritten session with own activity stays gated after another write-back resets the counter (Phase 7 independent gates)', () => {
    const fixture = fx()
    const S1 = 'concurrent-s1'
    const S2 = 'concurrent-s2'
    const S3 = 'concurrent-s3'
    for (const id of [S1, S2, S3]) handleSessionStart(fixture.root, hookStdin({ session_id: id }))
    // S2 does real work; S3 never touches anything
    handlePostTool(
      fixture.root,
      hookStdin({
        session_id: S2,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'src/s2.ts', old_string: 'a', new_string: 'b' },
      }),
    )
    // S1 writes back — the shared freshness counter resets
    appendEvent(
      fixture.eventsPath,
      makeEvent({
        initiative: fixture.slug,
        session: S1,
        source: 'claude-code',
        actor: 'agent',
        type: 'session_ended',
        payload: { summary: 'S1 done', next_action: 'S2 continues' },
      }),
    )
    expect(freshnessTotal(foldLog(fixture.eventsPath).state.freshness)).toBe(0)

    // S2 (own activity) still gates; S3 (nothing) ends silently
    const gated = handleStop(fixture.root, stopStdin({ session_id: S2 }))
    expect(gated.exitCode).toBe(2)
    expect(gated.stderr).toBe(STOP_BLOCK_MESSAGE)
    expect(handleStop(fixture.root, stopStdin({ session_id: S3 }))).toEqual({
      exitCode: 0,
      stdout: '',
      stderr: '',
    })
  })
})

describe('sofar event session-end — mechanical close marker (3.5, BD21)', () => {
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
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'claude-sess-1', // adopt-by-id (BD43)
    })
    await callTool(client, 'sofar_end_session', {
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
