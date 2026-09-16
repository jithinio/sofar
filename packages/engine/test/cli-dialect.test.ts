import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  EVENT_TYPE_REFERENCE,
  EVENT_TYPES,
  validatePayload,
  type KnownEventType,
} from '../../schema/src/events'
import { validateEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { runAppend, runEventTypes } from '../src/cli/event'
import { AGENTS_PROTOCOL_BLOCK, runInit } from '../src/cli/init'
import { runNew } from '../src/cli/new'
import type { Caps } from '../src/cli/ui'

/**
 * r1-fixes 1.3 — the CLI dialect an MCP-less agent (Codex, Cursor, OpenCode)
 * drives sofar through.
 *
 * Round 1: Codex discovered payload shapes by trial, Cursor named its
 * initiative after one roadmap item and never wrote a plan, and `--source
 * cursor` was refused. PREDICTED: Codex S1 −13 tool calls; Codex and Cursor
 * create a project initiative WITH a plan in ≥2/3 reps.
 */

const PLAIN: Caps = { color: false, unicode: true, animate: false }
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function initedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-dialect-'))
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

/** Every `--payload '<json>'` in a text, in order. */
function payloadsIn(text: string): { type: string | null; json: string }[] {
  const out: { type: string | null; json: string }[] = []
  for (const m of text.matchAll(/(?:--type (\w+)[^\n`]*?)?--payload '([^']*)'/g)) {
    if (!m[2]!.startsWith('{')) continue // a `'<json>'` usage placeholder, not an example
    out.push({ type: m[1] ?? null, json: m[2]! })
  }
  return out
}

/** An enum placeholder like "pending|active|done" stands for its first option. */
function firstOption(value: unknown): unknown {
  if (typeof value === 'string' && /^[a-z_]+(\|[a-z_]+)+$/.test(value)) return value.split('|')[0]
  if (Array.isArray(value)) return value.map(firstOption)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, firstOption(v)]))
  }
  return value
}

/** The source enum sofar 0.32.0 validates envelopes against — frozen here on purpose. */
const SOURCES_KNOWN_TO_0_32 = ['claude-code', 'opencode', 'codex', 'cli', 'hook']

describe('the payload reference (schema-side, r1-fixes 1.3)', () => {
  it('covers every event type, and every example validates against its own validator', () => {
    expect(Object.keys(EVENT_TYPE_REFERENCE).sort()).toEqual([...EVENT_TYPES].sort())
    for (const type of EVENT_TYPES) {
      const ref = EVENT_TYPE_REFERENCE[type]
      expect(validatePayload(type, ref.example), type).toEqual({ ok: true })
      expect(ref.summary.length, type).toBeGreaterThan(0)
      expect(ref.fields.length, type).toBeGreaterThan(0)
      if (ref.writer === 'command') expect(ref.via, type).toBeDefined()
    }
  })

  it('every example survives single-quoting in a shell', () => {
    for (const type of EVENT_TYPES) {
      expect(JSON.stringify(EVENT_TYPE_REFERENCE[type].example), type).not.toContain("'")
    }
  })

  it('names every required field of each agent-written type', () => {
    // A field the validator demands but the grammar never names is exactly
    // the trial-and-error this reference exists to end. Probe it: removing
    // any single top-level key from the example must either still validate
    // (the key was optional) or be named in `fields`.
    for (const type of EVENT_TYPES) {
      const ref = EVENT_TYPE_REFERENCE[type]
      for (const key of Object.keys(ref.example)) {
        const { [key]: _drop, ...rest } = ref.example
        if (!validatePayload(type, rest).ok) expect(ref.fields, `${type}.${key}`).toMatch(new RegExp(`\\b${key}\\b`))
      }
    }
  })
})

describe('sofar event types (r1-fixes 1.3)', () => {
  it('lists every agent-written type with its fields and example, and fences off the rest', () => {
    const out = runEventTypes()
    expect(out.exitCode).toBe(0)
    const agentTypes = EVENT_TYPES.filter((t) => EVENT_TYPE_REFERENCE[t].writer === 'agent')
    for (const t of agentTypes) {
      expect(out.stdout).toContain(`${t} — `)
      expect(out.stdout).toContain(`--payload '${JSON.stringify(EVENT_TYPE_REFERENCE[t].example)}'`)
    }
    const never = out.stdout.slice(out.stdout.indexOf('WRITTEN FOR YOU'))
    for (const t of ['file_touched', 'command_run', 'session_closed', 'run_started', 'handoff', 'run_stopped']) {
      expect(never).toContain(t)
    }
    expect(out.stdout).toMatch(/initiative_created → sofar new <slug> --goal/)
    expect(out.stdout).toMatch(/memory_promoted → sofar remember/)
    expect(out.stdout).toMatch(/plan_updated — the WHOLE plan — a full replace/)
  })

  it('prints one type, or JSON, and refuses an unknown type with the known list', () => {
    const one = runEventTypes('phase_status_changed')
    expect(one.stdout.split('\n')[0]).toMatch(/^phase_status_changed — /)
    expect(one.stdout).not.toContain('task_status_changed')

    expect(JSON.parse(runEventTypes(undefined, { json: true }).stdout)).toEqual(EVENT_TYPE_REFERENCE)
    expect(JSON.parse(runEventTypes('note_added', { json: true }).stdout)).toEqual({
      note_added: EVENT_TYPE_REFERENCE.note_added,
    })

    const bad = runEventTypes('plan_update')
    expect(bad.exitCode).toBe(1)
    const shape = JSON.parse(bad.stderr)
    expect(shape.code).toBe('unknown_event')
    expect(shape.errors[0]).toContain('plan_updated')
  })

  it('every example it prints appends cleanly through `event append`', () => {
    const root = initedRepo()
    runNew(root, 'proj', { bind: true, goal: 'g' }, PLAIN, PLAIN)
    const printed = payloadsIn(runEventTypes().stdout)
    const agentTypes = EVENT_TYPES.filter((t) => EVENT_TYPE_REFERENCE[t].writer === 'agent')
    expect(printed).toHaveLength(agentTypes.length)
    printed.forEach(({ json }, i) => {
      const res = runAppend(root, { type: agentTypes[i]!, payload: json, session: 's1', source: 'codex', actor: 'agent' })
      expect(res.exitCode, `${agentTypes[i]}: ${res.stderr}`).toBe(0)
    })
  })
})

describe('any --source, readable by older engines (r1-fixes 1.3)', () => {
  it('accepts an unlisted agent name and records it as `cli`, keeping the name in the payload', () => {
    const root = initedRepo()
    runNew(root, 'proj', { bind: true, goal: 'g' }, PLAIN, PLAIN)
    const res = runAppend(root, {
      type: 'session_started',
      payload: '{"tool":"cursor"}',
      session: 'cur-1',
      source: 'cursor',
      actor: 'agent',
    })
    expect(res.exitCode).toBe(0)
    const line = readFileSync(join(root, '.sofar', 'initiatives', 'proj', 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((e) => e.session === 'cur-1')
    expect(line.source).toBe('cli')
    expect(line.payload.tool).toBe('cursor')
    // The mixed-version policy: nothing this engine writes carries a source a
    // 0.32.0 reader would reject as a corrupt envelope.
    expect(SOURCES_KNOWN_TO_0_32).toContain(line.source)
    expect(validateEnvelope(line).ok).toBe(true)
  })

  it('a listed source is still recorded as itself', () => {
    const root = initedRepo()
    runNew(root, 'proj', { bind: true, goal: 'g' }, PLAIN, PLAIN)
    runAppend(root, { type: 'note_added', payload: '{"text":"hi"}', session: 'c', source: 'codex', actor: 'agent' })
    const last = readFileSync(join(root, '.sofar', 'initiatives', 'proj', 'events.jsonl'), 'utf8').trim().split('\n').pop()!
    expect(JSON.parse(last).source).toBe('codex')
  })

  it('the actor is still validated', () => {
    const root = initedRepo()
    runNew(root, 'proj', { bind: true, goal: 'g' }, PLAIN, PLAIN)
    const res = runAppend(root, { type: 'note_added', payload: '{"text":"x"}', session: 'c', source: 'x', actor: 'robot' })
    expect(res.exitCode).toBe(1)
  })
})

describe('the AGENTS.md block teaches a project initiative with a plan (r1-fixes 1.3)', () => {
  it('names --goal, one initiative per project or roadmap, the plan, phase status and the reference', () => {
    expect(AGENTS_PROTOCOL_BLOCK).toContain('sofar new <slug> --goal "<one line>"')
    expect(AGENTS_PROTOCOL_BLOCK).toContain('One initiative per project or roadmap')
    expect(AGENTS_PROTOCOL_BLOCK).toContain('--type plan_updated')
    expect(AGENTS_PROTOCOL_BLOCK).toContain('FULL replace')
    expect(AGENTS_PROTOCOL_BLOCK).toContain('--type phase_status_changed')
    expect(AGENTS_PROTOCOL_BLOCK).toContain('`sofar event types`')
    // No tool is privileged in the example any more.
    expect(AGENTS_PROTOCOL_BLOCK).not.toContain('--source opencode')
  })

  it('every payload the block shows validates against the schema', () => {
    const shown = payloadsIn(AGENTS_PROTOCOL_BLOCK)
    const typed = shown.filter((p) => p.type !== null)
    expect(typed.map((p) => p.type)).toEqual(
      expect.arrayContaining(['session_started', 'plan_updated', 'task_status_changed', 'phase_status_changed', 'decision_logged', 'note_added', 'session_ended']),
    )
    for (const { type, json } of typed) {
      expect(validatePayload(type as KnownEventType, firstOption(JSON.parse(json))), type!).toEqual({ ok: true })
    }
  })

  it('following the block end to end yields a project initiative with a goal, a plan and a write-back', () => {
    const root = initedRepo()
    expect(runNew(root, 'boopada', { bind: true, goal: 'Travel planner app' }, PLAIN, PLAIN).exitCode).toBe(0)
    const append = (type: string, payload: unknown): void => {
      const res = runAppend(root, {
        slug: 'boopada',
        type,
        payload: JSON.stringify(payload),
        session: 'cursor-s1',
        source: 'cursor',
        actor: 'agent',
      })
      expect(res.exitCode, `${type}: ${res.stderr}`).toBe(0)
    }
    append('session_started', { tool: 'cursor' })
    append('session_started', { tool: 'cursor' }) // re-run: harmless
    append('plan_updated', {
      plan: {
        goal: 'Travel planner app',
        phases: [
          { name: 'Phase 1 — Traveller profile', status: 'active', tasks: [{ id: '1.1', title: 'Profile API', status: 'pending' }] },
          { name: 'Phase 2 — Itineraries', status: 'pending', tasks: [{ id: '2.1', title: 'Itinerary model', status: 'pending' }] },
        ],
      },
    })
    append('task_status_changed', { id: '1.1', status: 'done' })
    append('phase_status_changed', { phase: 'Phase 1 — Traveller profile', status: 'done' })
    append('session_ended', { summary: 'profile shipped', next_action: 'Start 2.1' })

    const { state, warnings } = foldLog(join(root, '.sofar', 'initiatives', 'boopada', 'events.jsonl'))
    expect(warnings).toEqual([])
    expect(state.goal).toBe('Travel planner app')
    expect(state.phases.map((p) => [p.name, p.status])).toEqual([
      ['Phase 1 — Traveller profile', 'done'],
      ['Phase 2 — Itineraries', 'pending'],
    ])
    expect(state.sessions.map((s) => [s.id, s.tool, s.summary])).toEqual([['cursor-s1', 'cursor', 'profile shipped']])
  })
})
