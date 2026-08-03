import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activityFromEdges,
  taskFilesFromEdges,
  ACTIVITY_LIST_CAP,
  TASK_FILES_CAP,
} from '../src/core/adjacency'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { buildGraph } from '../src/core/graph'
import { serializeEvent } from '../src/core/log'

/**
 * Consolidation (record-graph 4.1/4.2): task_files and per-session activity
 * are no longer bespoke reducers inside the fold — they are pure functions of
 * ONE emitted edge list (core/adjacency.ts), which the repo-wide graph then
 * unions instead of re-walking the events itself.
 *
 * These tests pin the RULE rather than either implementation. The golden
 * fixture below states the expected task_files and activity as literals, so a
 * change to the shared emission that happens to be self-consistent still
 * fails here. The parity tests then pin the two structural claims the
 * consolidation rests on: the graph's occurrence edges for a log ARE that
 * log's fold edges, and the derived views survive the repo-wide union.
 *
 * Verified byte-identical against the pre-consolidation implementation over
 * the live record at introduction — the whole graph (3205 nodes, 4300 edges,
 * in order) plus every initiative's task_files, activity, files_touched,
 * freshness, warnings, orphans and unregistered sessions.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

let clock = 0

function ev(
  type: string,
  payload: Record<string, unknown>,
  session = 'sess-1',
  initiative = 'alpha',
): EventEnvelope {
  const event = makeEvent({ initiative, session, source: 'claude-code', actor: 'agent', type, payload })
  clock += 1
  return { ...event, ts: new Date(Date.UTC(2026, 0, 1) + clock * 1000).toISOString() }
}

function repoWith(slug: string, events: readonly EventEnvelope[]): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-cons-'))
  roots.push(root)
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), events.map(serializeEvent).join('\n') + '\n')
  return root
}

/**
 * One log holding every case where the three old reducers disagreed about
 * what counts:
 *   - TWO tasks active at once → one file_touched fans out to both (speed T4)
 *   - a RE-touch moves the path to the front of task_files (most-recent-first)
 *     while activity keeps FIRST-touch order — the two orders that made these
 *     separate reducers in the first place
 *   - a cli-sourced touch counts for task_files, never for activity (BD44)
 *   - a task_status_changed for an id the plan never held still lands in
 *     activity.task_changes (and mints an orphan node in the graph)
 *   - an UNREGISTERED session's events attach to no session (BD21)
 *   - a corrected (voided) event contributes nothing at all
 */
function mixedLog(): EventEnvelope[] {
  const touchedTwice = ev('file_touched', { path: 'src/a.ts', op: 'edit' })
  const voided = ev('file_touched', { path: 'src/voided.ts', op: 'edit' })
  return [
    ev('initiative_created', { slug: 'alpha', goal: 'goal' }),
    ev('plan_updated', {
      plan: {
        phases: [
          {
            name: 'Phase 1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'one' },
              { id: '1.2', title: 'two' },
            ],
          },
        ],
      },
    }),
    ev('session_started', { tool: 'claude-code' }),
    ev('task_status_changed', { id: '1.1', status: 'active' }),
    touchedTwice, // 1.1 only — 1.2 is not active yet
    ev('task_status_changed', { id: '1.2', status: 'active' }),
    ev('file_touched', { path: 'src/b.ts', op: 'edit' }), // both tasks
    ev('command_run', { cmd: 'npm test' }),
    // cli is not a session: counts for task_files, never for activity.
    ev('file_touched', { path: 'src/cli-only.ts', op: 'edit' }, 'cli'),
    // re-touch: front of task_files, but activity keeps its first-touch slot
    ev('file_touched', { path: 'src/a.ts', op: 'edit' }),
    // the plan never held 9.9 — orphan status change, still real activity
    ev('task_status_changed', { id: '9.9', status: 'done' }),
    voided,
    ev('correction', { ref: voided.id, reason: 'wrong path' }),
    // an unregistered session: real events, no session_started in this log
    ev('file_touched', { path: 'src/ghost.ts', op: 'edit' }, 'sess-ghost'),
  ]
}

describe('the one emission rule (4.1/4.2)', () => {
  it('derives task_files exactly: per active task, most-recent-first, cli included', () => {
    const root = repoWith('alpha', mixedLog())
    const { state } = foldLog(join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl'))

    expect(state.task_files).toEqual({
      // a.ts re-touched last → front; cli-only.ts counts; ghost.ts too
      // (session identity is irrelevant to task attribution).
      '1.1': ['src/ghost.ts', 'src/a.ts', 'src/cli-only.ts', 'src/b.ts'],
      // 1.2 became active only after a.ts's first touch.
      '1.2': ['src/ghost.ts', 'src/a.ts', 'src/cli-only.ts', 'src/b.ts'],
    })
    // The voided event is absent from every list.
    expect(JSON.stringify(state.task_files)).not.toContain('voided')
  })

  it('derives activity exactly: first-touch order, no cli, registered sessions only', () => {
    const root = repoWith('alpha', mixedLog())
    const { state } = foldLog(join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl'))

    const registered = state.sessions.find((s) => s.id === 'sess-1')
    expect(registered?.activity).toEqual({
      // FIRST-touch order (a.ts stays first despite the re-touch), no cli path
      files: ['src/a.ts', 'src/b.ts'],
      commands: 1,
      // the orphan id is still a real status change
      task_changes: ['1.1 → active', '1.2 → active', '9.9 → done'],
    })
    // sess-ghost was never registered here: no stub session, no activity.
    expect(state.sessions.map((s) => s.id)).toEqual(['sess-1'])
  })

  it('keeps the caps and their "+N more" sentinel', () => {
    const events: EventEnvelope[] = [
      ev('initiative_created', { slug: 'alpha', goal: 'goal' }),
      ev('plan_updated', {
        plan: { phases: [{ name: 'P', status: 'active', tasks: [{ id: '1.1', title: 'one' }] }] },
      }),
      ev('session_started', { tool: 'claude-code' }),
      ev('task_status_changed', { id: '1.1', status: 'active' }),
    ]
    const extra = 2
    for (let i = 0; i < ACTIVITY_LIST_CAP + extra; i += 1) {
      events.push(ev('file_touched', { path: `src/f${String(i).padStart(2, '0')}.ts`, op: 'edit' }))
    }
    const root = repoWith('alpha', events)
    const { state } = foldLog(join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl'))

    const activity = state.sessions[0]?.activity
    expect(activity?.files).toHaveLength(ACTIVITY_LIST_CAP + 1)
    expect(activity?.files.at(-1)).toBe(`+${extra} more`)
    // task_files caps WITHOUT a sentinel — it drops the oldest instead.
    expect(state.task_files['1.1']).toHaveLength(TASK_FILES_CAP)
    expect(state.task_files['1.1']?.some((f) => f.startsWith('+'))).toBe(false)
  })
})

describe('the graph unions the fold, it does not re-walk (4.1/4.2)', () => {
  const OCCURRENCE = new Set(['touched', 'ran', 'changed', 'decided', 'noted', 'worked'])

  it("a log's occurrence edges in the graph ARE that log's fold edges, in order", () => {
    const root = repoWith('alpha', mixedLog())
    const { edges: foldEdges } = foldLog(join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl'))
    const graphEdges = buildGraph(root).edges.filter((e) => OCCURRENCE.has(e.kind))
    expect(graphEdges).toEqual(foldEdges)
    expect(foldEdges.length).toBeGreaterThan(0) // not vacuous
  })

  it('the derived views survive the repo-wide union — same rule, wider input', () => {
    const root = repoWith('alpha', mixedLog())
    const path = join(root, '.sofar', 'initiatives', 'alpha', 'events.jsonl')
    const { state } = foldLog(path)
    const graph = buildGraph(root)

    // Re-derive from the GRAPH's edges: identical, because it is one rule.
    expect(taskFilesFromEdges(graph.edges)).toEqual(state.task_files)
    const activity = activityFromEdges(graph.edges)
    expect(activity.get('sess-1')).toEqual(state.sessions[0]?.activity)
    // The graph carries the unregistered session's activity that the fold
    // deliberately attaches to nobody — the repo-wide view has no per-log
    // registration to withhold it.
    expect(activity.get('sess-ghost')?.files).toEqual(['src/ghost.ts'])
  })

  it('mints an orphan task node so a `changed` edge to a dropped id still resolves', () => {
    const graph = buildGraph(repoWith('alpha', mixedLog()))
    const orphan = graph.nodes.get('task:alpha#9.9')
    expect(orphan).toMatchObject({ kind: 'task', task_id: '9.9', status: 'done', orphan: true })
    expect(graph.edges.some((e) => e.kind === 'changed' && e.to === 'task:alpha#9.9')).toBe(true)
  })

  it('`worked` counts cli touches while `touched` does not — the asymmetry the old reducers held', () => {
    const graph = buildGraph(repoWith('alpha', mixedLog()))
    const cliFile = 'file:src/cli-only.ts'
    expect(graph.edges.some((e) => e.kind === 'worked' && e.to === cliFile)).toBe(true)
    expect(graph.edges.some((e) => e.kind === 'touched' && e.to === cliFile)).toBe(false)
    // …and the file node exists anyway: it is recoverable from no edge.
    expect(graph.nodes.get(cliFile)).toMatchObject({ kind: 'file', path: 'src/cli-only.ts' })
  })
})
