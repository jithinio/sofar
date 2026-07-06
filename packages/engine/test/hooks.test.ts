import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import type { EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { handleSessionStart } from '../src/cli/event'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

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
