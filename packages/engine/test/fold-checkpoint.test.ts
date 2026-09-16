import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { appendEvent, serializeEvent } from '../src/core/log'
import {
  appendToCheckpoint,
  countLines,
  decodeLines,
  finalizeFold,
  foldLines,
  replayDecoded,
} from '../src/core/fold'
import { createToolContext } from '../src/mcp/context'
import { makeRepoFixture } from './helpers/mcp'

/**
 * r1-fixes 2.7 (D17) — one replay per log per process.
 *
 * Every appending hook and tool folded the log twice: once in the handler,
 * once in regenerateProjections. The checkpoint keeps the replay and applies
 * the appended event to it; finalize derives on a clone. PREDICTED: post-tool
 * and session-end fold time p50 −40% or better on a ~10 MB record, projection
 * bytes unchanged — which is what the equivalence below pins.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

let clock = Date.parse('2026-09-16T00:00:00Z')
function ev(type: string, payload: Record<string, unknown>, session = 's1'): EventEnvelope {
  clock += 1000
  const e = makeEvent({ initiative: 'demo', session, source: 'hook', actor: 'agent', type, payload })
  return { ...e, ts: new Date(clock).toISOString() }
}

/** A log that exercises every side table: plan, tasks, decisions with guards, sessions, corrections, orphans. */
function story(): EventEnvelope[] {
  const events: EventEnvelope[] = []
  events.push(ev('initiative_created', { slug: 'demo', goal: 'the goal' }, 'cli'))
  events.push(ev('session_started', { tool: 'claude-code' }))
  events.push(
    ev('plan_updated', {
      goal: 'the goal',
      phases: [
        { name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'first' }, { id: '1.2', title: 'second' }] },
        { name: 'Phase 2', tasks: [{ id: '2.1', title: 'third' }] },
      ],
    }),
  )
  events.push(ev('task_status_changed', { id: '1.1', status: 'active' }))
  events.push(ev('file_touched', { path: 'src/a.ts', op: 'edit' }))
  events.push(
    ev('decision_logged', {
      chose: 'keep schema in packages/schema',
      over: 'shapes in the engine',
      because: 'one home',
      rule: 'Never put shapes in the engine.',
      guard: 'path:packages/engine/src/shapes/**',
    }),
  )
  events.push(ev('file_touched', { path: 'packages/engine/src/shapes/x.ts', op: 'write' })) // crosses the guard
  events.push(ev('command_run', { cmd: 'npm test' }))
  events.push(ev('task_status_changed', { id: '9.9', status: 'done' })) // orphan — not in the plan
  events.push(ev('task_status_changed', { id: '1.2', status: 'blocked', note: 'waiting on 1.1' }))
  events.push(ev('session_started', { tool: 'codex' }, 's2'))
  events.push(ev('file_touched', { path: 'src/a.ts', op: 'edit' }, 's2'))
  events.push(ev('note_added', { text: 'a note' }, 's2'))
  events.push(ev('command_run', { cmd: 'git status' }, 'ghost')) // unregistered session
  events.push(ev('memory_promoted', { text: 'the test command is npm test' }))
  events.push(ev('task_status_changed', { id: '1.1', status: 'done' }))
  events.push(ev('session_ended', { summary: 'did 1.1', next_action: 'do 1.2' }))
  events.push(ev('session_closed', { reason: 'other' }, 's2'))
  return events
}

const linesOf = (events: readonly EventEnvelope[]): string[] => [...events.map(serializeEvent), '']

describe('checkpoint append ≡ fresh fold (D17)', () => {
  it('for every prefix of a story, appending the next line matches folding the whole', () => {
    const events = story()
    const all = linesOf(events)
    for (let n = 1; n <= events.length; n++) {
      const prefix = linesOf(events.slice(0, n - 1))
      const cp = replayDecoded(decodeLines(prefix), 'demo', countLines(prefix))
      const advanced = appendToCheckpoint(cp, all[n - 1]!)
      expect(advanced, `event ${n} (${events[n - 1]!.type})`).not.toBeNull()
      const fresh = foldLines(linesOf(events.slice(0, n)), 'demo')
      expect(finalizeFold(advanced!)).toEqual(fresh)
    }
  })

  it('a checkpoint advanced many times equals one fresh fold, and finalizing twice changes nothing', () => {
    const events = story()
    const cp = replayDecoded(decodeLines(['']), 'demo', 0)
    for (const line of linesOf(events).slice(0, -1)) expect(appendToCheckpoint(cp, line)).not.toBeNull()
    const first = finalizeFold(cp)
    const second = finalizeFold(cp)
    expect(first).toEqual(foldLines(linesOf(events), 'demo'))
    expect(second).toEqual(first)
    // The clone is the caller's: mutating it leaves the checkpoint untouched.
    first.state.goal = 'mutated'
    first.edges.length = 0
    expect(finalizeFold(cp)).toEqual(second)
  })

  it('refuses what it cannot prove: a correction, an out-of-order id, a rejected line', () => {
    const events = story()
    const lines = linesOf(events)
    const cp = () => replayDecoded(decodeLines(lines), 'demo', countLines(lines))
    const correction = serializeEvent(ev('correction', { ref: events[4]!.id, reason: 'wrong file' }))
    expect(appendToCheckpoint(cp(), correction)).toBeNull()
    const early = { ...ev('command_run', { cmd: 'ls' }), id: '00000000000000000000000000' }
    expect(appendToCheckpoint(cp(), serializeEvent(early))).toBeNull()
    expect(appendToCheckpoint(cp(), 'not json{{{')).toBeNull()
    expect(appendToCheckpoint(cp(), JSON.stringify({ v: 1, id: 'x' }))).toBeNull()
    // The fresh fold of the same appends is still the reference, and still works.
    expect(foldLines([...lines.slice(0, -1), correction, ''], 'demo').state.sessions[0]!.activity!.files).not.toContain('src/a.ts')
  })

  it('an appended line gets the line number a fresh read gives it (warnings agree)', () => {
    const events = story()
    const lines = linesOf(events)
    const cp = replayDecoded(decodeLines(lines), 'demo', countLines(lines))
    // A plan that drops a resolved task's status warns with the line number.
    const plan = serializeEvent(
      ev('plan_updated', { goal: 'g', phases: [{ name: 'Phase 1', tasks: [{ id: '1.1', title: 'first' }] }] }),
    )
    const advanced = appendToCheckpoint(cp, plan)!
    const fresh = foldLines([...lines.slice(0, -1), plan, ''], 'demo')
    expect(finalizeFold(advanced).warnings).toEqual(fresh.warnings)
    expect(fresh.warnings.some((w) => w.startsWith(`line ${events.length + 1}:`))).toBe(true)
  })
})

describe('ToolContext fold cache (D17)', () => {
  function repo() {
    const f = makeRepoFixture()
    roots.push(f.root)
    return f
  }

  it('appendAndProject folds once per append: the state after equals a fresh fold, projections byte-identical', () => {
    const f = repo()
    const ctx = createToolContext(f.root)
    ctx.appendAndProject(f.slug, 'initiative_created', { slug: f.slug, goal: 'g' }, { session: 'cli', source: 'cli', actor: 'human' })
    ctx.registerSession(f.slug, 's1', { tool: 'claude-code' }, { source: 'hook' })
    for (let i = 0; i < 5; i++) ctx.appendAndProject(f.slug, 'file_touched', { path: `src/${i}.ts`, op: 'edit' }, { session: 's1', source: 'hook' })
    ctx.appendAndProject(f.slug, 'decision_logged', { chose: 'a', over: 'b', because: 'c' }, { session: 's1' })
    const cached = ctx.foldState(f.slug)
    const fresh = foldLines(readFileSync(f.eventsPath, 'utf8').split('\n'), f.slug).state
    expect(cached).toEqual(fresh)
    // A second context regenerating from disk writes the same bytes.
    const plan = readFileSync(join(f.initiativeDir, 'plan.md'), 'utf8')
    const decisions = readFileSync(join(f.initiativeDir, 'decisions.md'), 'utf8')
    const other = createToolContext(f.root)
    other.appendAndProject(f.slug, 'note_added', { text: 'n' }, { session: 's1' })
    ctx.appendAndProject(f.slug, 'note_added', { text: 'm' }, { session: 's1' }) // after a foreign append: miss, refold
    expect(ctx.foldState(f.slug)).toEqual(foldLines(readFileSync(f.eventsPath, 'utf8').split('\n'), f.slug).state)
    expect(readFileSync(join(f.initiativeDir, 'plan.md'), 'utf8')).toBe(plan)
    expect(readFileSync(join(f.initiativeDir, 'decisions.md'), 'utf8')).toBe(decisions)
  })

  it('sees writes it did not make: a direct append, a rewrite, a deleted log', () => {
    const f = repo()
    const ctx = createToolContext(f.root)
    ctx.appendAndProject(f.slug, 'initiative_created', { slug: f.slug, goal: 'g' }, { session: 'cli', source: 'cli', actor: 'human' })
    expect(ctx.foldState(f.slug).decisions).toHaveLength(0)
    appendEvent(f.eventsPath, ev('decision_logged', { chose: 'x', over: 'y', because: 'z' }, 'cli'))
    expect(ctx.foldState(f.slug).decisions).toHaveLength(1)
    // Same size, different content, different mtime: the log was rewritten.
    const text = readFileSync(f.eventsPath, 'utf8')
    writeFileSync(f.eventsPath, text.replace('"chose":"x"', '"chose":"q"'))
    const st = statSync(f.eventsPath)
    utimesSync(f.eventsPath, st.atime, new Date(st.mtimeMs + 5000))
    expect(ctx.foldState(f.slug).decisions[0]!.chose).toBe('q')
    rmSync(f.eventsPath)
    expect(ctx.foldState(f.slug).decisions).toHaveLength(0)
  })

  it('a correction appended through the context refolds rather than misapplies', () => {
    const f = repo()
    const ctx = createToolContext(f.root)
    ctx.appendAndProject(f.slug, 'initiative_created', { slug: f.slug, goal: 'g' }, { session: 'cli', source: 'cli', actor: 'human' })
    const bad = ctx.appendAndProject(f.slug, 'decision_logged', { chose: 'x', over: 'y', because: 'z' }, { session: 'cli' })
    expect(ctx.foldState(f.slug).decisions).toHaveLength(1)
    ctx.appendAndProject(f.slug, 'correction', { ref: bad.id, reason: 'wrong' }, { session: 'cli' })
    expect(ctx.foldState(f.slug).decisions).toHaveLength(0)
    expect(ctx.foldState(f.slug)).toEqual(foldLines(readFileSync(f.eventsPath, 'utf8').split('\n'), f.slug).state)
  })

  it('the cache is bounded and a missing log dir never throws', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-foldcache-'))
    roots.push(root)
    mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
    const ctx = createToolContext(root)
    for (let i = 0; i < 12; i++) {
      mkdirSync(ctx.initiativeDir(`i${i}`), { recursive: true })
      ctx.appendAndProject(`i${i}`, 'initiative_created', { slug: `i${i}`, goal: 'g' }, { session: 'cli', source: 'cli', actor: 'human' })
    }
    for (let i = 0; i < 12; i++) expect(ctx.foldState(`i${i}`).goal).toBe('g')
    expect(ctx.foldState('never').slug).toBe('never')
  })
})
