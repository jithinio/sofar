import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import { LESSON_MAX, LESSON_RUNNER_UP_RATIO, relevantLessons } from '../src/core/lessons'
import { handlePostTool, handleUserPrompt, LESSON_LINE_BUDGET } from '../src/cli/event'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * r1-fixes 3.3 (D16) — relevant lessons at the prompt.
 *
 * C3 (bench-refresh) is the per-decision re-violation rate. The digest shows
 * every rejected approach once at SessionStart; by the prompt that re-proposes
 * one it is tens of thousands of tokens back. This surfaces the lesson at the
 * point of use, with the words that matched, and no model. PREDICTED: C3 +5
 * pts; ≤5 ms per prompt (measured 1.2–1.5 ms on a 16-decision record).
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function fx(): Fixture {
  const f = makeRepoFixture()
  roots.push(f.root)
  return f
}

const SESSION = 'claude-sess-1'

function append(f: Fixture, type: string, payload: Record<string, unknown>, session = SESSION): void {
  appendEvent(
    f.eventsPath,
    makeEvent({ initiative: f.slug, session, source: 'hook', actor: 'agent', type, payload }),
  )
}

function register(f: Fixture, session = SESSION): void {
  append(f, 'session_started', { tool: 'claude-code' }, session)
}

/** Three decisions: the middle one is the lesson every probe below re-proposes. */
function decided(f: Fixture): void {
  append(f, 'decision_logged', {
    chose: 'keep the envelope source enum closed',
    over: 'widening SOURCES with cursor and every other agent name',
    because: 'older readers skip an unknown source line as corrupt',
  })
  append(f, 'decision_logged', {
    chose: 'redact credentials from captured commands before the append',
    over: 'scrubbing the committed log afterwards with a rewrite',
    because: 'the log is append-only and committed, so a secret that lands is in every clone',
  })
  append(f, 'decision_logged', {
    chose: 'a per-session lock keyed by slug and session id',
    over: 'locking every append, or a native flock dependency',
    because: 'appends are already atomic; only the check-then-append needs exclusion',
  })
}

const prompt = (text: string, session = SESSION): string =>
  JSON.stringify({ session_id: session, hook_event_name: 'UserPromptSubmit', prompt: text, cwd: '/tmp' })

describe('relevantLessons — the ranking (D16)', () => {
  it('a prompt that re-proposes a rejected approach in the subject\'s words finds that decision first', () => {
    const f = fx()
    decided(f)
    const state = foldLog(f.eventsPath).state
    const hits = relevantLessons(state, 'we could just rewrite the committed log to scrub the credential out')
    expect(hits[0]).toMatchObject({ handle: 'D2', text: 'scrubbing the committed log afterwards with a rewrite' })
    // The words are the asker's own, strongest first — the reason the line can be argued with.
    expect(hits[0]!.terms).toContain('rewrite')
    expect(hits[0]!.terms.length).toBeGreaterThanOrEqual(2)
    expect(hits.length).toBeLessThanOrEqual(LESSON_MAX)
  })

  it('renders nothing for a prompt with no subject, or one sharing a single common word', () => {
    const f = fx()
    decided(f)
    const state = foldLog(f.eventsPath).state
    expect(relevantLessons(state, 'continue')).toEqual([])
    expect(relevantLessons(state, 'yes')).toEqual([])
    expect(relevantLessons(state, '')).toEqual([])
    // "log" alone appears in two of three decisions — one shared word is coincidence.
    expect(relevantLessons(state, 'show me the log')).toEqual([])
  })

  it('a runner-up far below the top hit is dropped; a close one stays', () => {
    const f = fx()
    decided(f)
    const state = foldLog(f.eventsPath).state
    const hits = relevantLessons(state, 'widen the SOURCES enum for cursor agent names and also rewrite the log')
    expect(hits[0]!.handle).toBe('D1')
    for (const h of hits.slice(1)) expect(h.score).toBeGreaterThanOrEqual(hits[0]!.score * LESSON_RUNNER_UP_RATIO)
  })

  it('a stall handoff is a lesson too: its detail matches on its own words', () => {
    const f = fx()
    register(f)
    append(f, 'run_started', { run: '01J00000000000000000000000', adapter: 'codex', policy: 'task' }, 'cli')
    append(f, 'handoff', {
      run: '01J00000000000000000000000',
      session_id: SESSION,
      reason: 'stall',
      detail: 'exit 1 — stderr: ENOENT spawning codex: PATH has no codex binary',
    }, 'cli')
    const state = foldLog(f.eventsPath).state
    const hits = relevantLessons(state, 'spawn codex with the binary from PATH')
    expect(hits[0]).toMatchObject({ handle: `session ${SESSION} (stall)` })
    expect(hits[0]!.text).toContain('ENOENT')
    // A clean handoff is not a failure, and carries no lesson.
    const g = fx()
    register(g)
    append(g, 'run_started', { run: '01J00000000000000000000000', adapter: 'codex', policy: 'task' }, 'cli')
    append(g, 'handoff', { run: '01J00000000000000000000000', session_id: SESSION, reason: 'task_done', detail: 'exit 0 spawning codex from PATH' }, 'cli')
    expect(relevantLessons(foldLog(g.eventsPath).state, 'spawn codex with the binary from PATH')).toEqual([])
  })
})

describe('sofar event user-prompt — the lessons line (r1-fixes 3.3, D16)', () => {
  it('renders the handle, the rejected approach and the matched words; appends nothing', () => {
    const f = fx()
    register(f)
    decided(f)
    const before = foldLog(f.eventsPath).state
    const out = handleUserPrompt(f.root, prompt('let us rewrite the committed log to scrub that credential'))
    expect(out.exitCode).toBe(0)
    const line = out.stdout.split('\n').find((l) => l.includes('ruled out before'))
    expect(line).toBeDefined()
    expect(line).toContain('[D2] scrubbing the committed log afterwards with a rewrite')
    expect(line).toMatch(/\(matched: [^)]*rewrite/)
    expect(line).toContain('full text in decisions.md')
    expect(line!.length).toBeLessThanOrEqual(LESSON_LINE_BUDGET)
    expect(foldLog(f.eventsPath).state).toEqual(before)
  })

  it('no prompt field, a bare prompt, or an unregistered session → no lessons line', () => {
    const f = fx()
    register(f)
    decided(f)
    const noPrompt = JSON.stringify({ session_id: SESSION, hook_event_name: 'UserPromptSubmit', cwd: '/tmp' })
    expect(handleUserPrompt(f.root, noPrompt).stdout).not.toContain('ruled out before')
    expect(handleUserPrompt(f.root, prompt('continue')).stdout).not.toContain('ruled out before')
    expect(handleUserPrompt(f.root, prompt('rewrite the committed log to scrub it', 'nobody')).stdout).toBe('')
  })

  it('sits after a guard crossing and before the concurrent-edit hazard', () => {
    const f = fx()
    register(f)
    register(f, 'claude-sess-2')
    append(f, 'decision_logged', {
      chose: 'schema stays in packages/schema/src',
      over: 'defining payload shapes inside the engine package',
      because: 'one home for every shape',
      rule: 'Never define payload shapes outside packages/schema/src.',
      guard: 'path:packages/engine/src/shapes/**',
    })
    decided(f)
    const edit = (session: string, path: string): void => {
      handlePostTool(
        f.root,
        JSON.stringify({ session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path } }),
      )
    }
    edit(SESSION, 'packages/engine/src/shapes/new.ts') // crosses the guard
    edit(SESSION, 'src/shared.ts') // conflicts with the sibling below
    edit('claude-sess-2', 'src/shared.ts')
    const out = handleUserPrompt(f.root, prompt('define the payload shapes inside the engine package and rewrite the committed log')).stdout
    const guard = out.indexOf('guard crossed')
    const lesson = out.indexOf('ruled out before')
    const conflict = out.indexOf('src/shared.ts')
    expect(guard).toBeGreaterThan(-1)
    expect(lesson).toBeGreaterThan(guard)
    expect(conflict).toBeGreaterThan(lesson)
  })
})
