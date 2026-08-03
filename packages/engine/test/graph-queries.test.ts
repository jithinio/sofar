import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import {
  buildGraph,
  GRAPH_RESULT_CAP,
  relatedTasks,
  repoGeneral,
  resolveFileNodes,
  taskNodeId,
  whyFile,
} from '../src/core/graph'

/**
 * Record graph queries (record-graph 2.1-2.4, SPEC §Record graph,
 * §Acceptance "Record graph"): cross-initiative provenance, co-touched-file
 * neighbours, observed repo-generality, and the ordering/cap contract.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-gq-'))
  roots.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives'), { recursive: true })
  return root
}

/**
 * Explicit chronology: makeEvent's `ts` is wall-clock at millisecond
 * resolution, so a fixture built in one loop can tie — and the newest-first
 * assertions below would then be decided by the id tiebreak, i.e. by machine
 * speed. Creation order is the intended order; stamp it.
 */
let clock = 0

function ev(
  initiative: string,
  type: string,
  payload: Record<string, unknown>,
  session = 'sess-1',
): EventEnvelope {
  const event = makeEvent({ initiative, session, source: 'claude-code', actor: 'agent', type, payload })
  clock += 1
  return { ...event, ts: new Date(Date.UTC(2026, 0, 1) + clock * 1000).toISOString() }
}

function writeLog(root: string, slug: string, events: readonly EventEnvelope[]): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), events.map(serializeEvent).join('\n') + '\n')
}

function planned(slug: string, taskIds: string[]): EventEnvelope[] {
  return [
    ev(slug, 'initiative_created', { slug, goal: `goal of ${slug}` }),
    ev(slug, 'plan_updated', {
      plan: {
        phases: [
          {
            name: 'Phase 1',
            status: 'active',
            tasks: taskIds.map((id) => ({ id, title: `task ${id}` })),
          },
        ],
      },
    }),
  ]
}

// ---------------------------------------------------------------------------

describe('whyFile (2.1)', () => {
  it('answers across ALL initiatives, newest-first — the fold cannot see past one log', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', ['1.1']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-old'),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }, 's-old'),
      ev('alpha', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 's-old'),
      ev('alpha', 'decision_logged', { chose: 'alpha call', over: 'x', because: 'y' }, 's-old'),
    ])
    writeLog(root, 'beta', [
      ...planned('beta', ['2.1']),
      ev('beta', 'session_started', { tool: 'claude-code' }, 's-new'),
      ev('beta', 'task_status_changed', { id: '2.1', status: 'active' }, 's-new'),
      ev('beta', 'file_touched', { path: 'src/shared.ts', op: 'edit' }, 's-new'),
    ])

    const why = whyFile(buildGraph(root), 'src/shared.ts')
    expect(why.found).toBe(true)
    // Newest first: beta's session was appended later, so it holds the larger ulid ts.
    expect(why.sessions.map((s) => s.session_id)).toEqual(['s-new', 's-old'])
    expect(why.tasks.map((t) => `${t.initiative} ${t.task_id}`)).toEqual(['beta 2.1', 'alpha 1.1'])
    // Two-hop: the decision came from a session that touched this path.
    expect(why.decisions.map((d) => d.chose)).toEqual(['alpha call'])
    expect(why.decisions[0]?.via_session).toBe('s-old')
  })

  it('reports a session that touched the path from more than one initiative', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', ['1.1']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 'shared'),
      ev('alpha', 'file_touched', { path: 'src/a.ts', op: 'edit' }, 'shared'),
    ])
    writeLog(root, 'beta', [
      ...planned('beta', ['2.1']),
      ev('beta', 'file_touched', { path: 'src/a.ts', op: 'edit' }, 'shared'),
    ])

    const why = whyFile(buildGraph(root), 'src/a.ts')
    expect(why.sessions).toHaveLength(1)
    expect(why.sessions[0]?.initiatives).toEqual(['alpha', 'beta'])
    expect(why.sessions[0]?.touches).toBe(2)
  })

  it('returns a not-found result rather than throwing for an untouched path', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', planned('alpha', ['1.1']))
    const why = whyFile(buildGraph(root), 'src/never.ts')
    expect(why).toEqual({
      path: 'src/never.ts',
      found: false,
      matched_paths: [],
      sessions: [],
      tasks: [],
      decisions: [],
      omitted: { sessions: 0, tasks: 0, decisions: 0 },
    })
  })

  it('caps each list at GRAPH_RESULT_CAP and reports the overflow as a count, not an element', () => {
    const root = makeRoot()
    const events = [...planned('alpha', ['1.1'])]
    const extra = 3
    for (let i = 0; i < GRAPH_RESULT_CAP + extra; i += 1) {
      const session = `s-${String(i).padStart(2, '0')}`
      events.push(ev('alpha', 'session_started', { tool: 'claude-code' }, session))
      events.push(ev('alpha', 'file_touched', { path: 'src/hot.ts', op: 'edit' }, session))
    }
    writeLog(root, 'alpha', events)

    const why = whyFile(buildGraph(root), 'src/hot.ts')
    expect(why.sessions).toHaveLength(GRAPH_RESULT_CAP)
    expect(why.omitted.sessions).toBe(extra)
    // No "+N more" string smuggled into the typed list.
    expect(why.sessions.every((s) => !s.session_id.startsWith('+'))).toBe(true)
  })
})

describe('path identity across checkouts (2.1)', () => {
  it('resolves one query to every recorded path that ends with it', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', ['1.1']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      // The same logical file, recorded from three checkouts — the shape the
      // harness->sofar rename and git worktrees leave in a real record.
      ev('alpha', 'file_touched', { path: '/Users/x/IO/harness/src/cli/doctor.ts', op: 'edit' }, 's-a'),
      ev('alpha', 'file_touched', { path: '/Users/x/IO/sofar/src/cli/doctor.ts', op: 'edit' }, 's-a'),
      ev(
        'alpha',
        'file_touched',
        { path: '/Users/x/IO/sofar/.claude/worktrees/wt/src/cli/doctor.ts', op: 'edit' },
        's-a',
      ),
      ev('alpha', 'file_touched', { path: '/Users/x/IO/sofar/src/cli/other.ts', op: 'edit' }, 's-a'),
    ])

    const graph = buildGraph(root)
    const why = whyFile(graph, 'src/cli/doctor.ts')
    expect(why.found).toBe(true)
    expect(why.matched_paths).toEqual([
      '/Users/x/IO/harness/src/cli/doctor.ts',
      '/Users/x/IO/sofar/.claude/worktrees/wt/src/cli/doctor.ts',
      '/Users/x/IO/sofar/src/cli/doctor.ts',
    ])
    expect(why.sessions[0]?.touches).toBe(3)
    // An exact recorded path resolves to itself alone.
    expect(resolveFileNodes(graph, '/Users/x/IO/sofar/src/cli/doctor.ts')).toEqual([
      'file:/Users/x/IO/sofar/src/cli/doctor.ts',
    ])
  })

  it('matches only at a segment boundary — never a bare substring', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', ['1.1']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'src/my-doctor.ts', op: 'edit' }, 's-a'),
    ])
    expect(resolveFileNodes(buildGraph(root), 'doctor.ts')).toEqual([])
  })
})

describe('relatedTasks (2.2)', () => {
  it('ranks co-touched-file neighbours by shared-path count, across initiatives', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', ['1.1']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'src/one.ts', op: 'edit' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'src/two.ts', op: 'edit' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'src/three.ts', op: 'edit' }, 's-a'),
    ])
    // beta shares two paths, gamma shares one, delta shares none.
    writeLog(root, 'beta', [
      ...planned('beta', ['2.1']),
      ev('beta', 'session_started', { tool: 'claude-code' }, 's-b'),
      ev('beta', 'task_status_changed', { id: '2.1', status: 'active' }, 's-b'),
      ev('beta', 'file_touched', { path: 'src/one.ts', op: 'edit' }, 's-b'),
      ev('beta', 'file_touched', { path: 'src/two.ts', op: 'edit' }, 's-b'),
    ])
    writeLog(root, 'gamma', [
      ...planned('gamma', ['3.1']),
      ev('gamma', 'session_started', { tool: 'claude-code' }, 's-c'),
      ev('gamma', 'task_status_changed', { id: '3.1', status: 'active' }, 's-c'),
      ev('gamma', 'file_touched', { path: 'src/three.ts', op: 'edit' }, 's-c'),
    ])
    writeLog(root, 'delta', [
      ...planned('delta', ['4.1']),
      ev('delta', 'session_started', { tool: 'claude-code' }, 's-d'),
      ev('delta', 'task_status_changed', { id: '4.1', status: 'active' }, 's-d'),
      ev('delta', 'file_touched', { path: 'src/elsewhere.ts', op: 'edit' }, 's-d'),
    ])

    const related = relatedTasks(buildGraph(root), taskNodeId('alpha', '1.1'))
    expect(related.found).toBe(true)
    expect(related.neighbours.map((n) => `${n.initiative} ${n.task_id}`)).toEqual([
      'beta 2.1',
      'gamma 3.1',
    ])
    expect(related.neighbours[0]?.shared_count).toBe(2)
    expect(related.neighbours[0]?.shared.sort()).toEqual(['src/one.ts', 'src/two.ts'])
    expect(related.neighbours[1]?.shared).toEqual(['src/three.ts'])
  })

  it('never lists the anchor task as its own neighbour', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', ['1.1', '1.2']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'task_status_changed', { id: '1.1', status: 'active' }, 's-a'),
      ev('alpha', 'task_status_changed', { id: '1.2', status: 'active' }, 's-a'),
      ev('alpha', 'file_touched', { path: 'src/one.ts', op: 'edit' }, 's-a'),
    ])

    const related = relatedTasks(buildGraph(root), taskNodeId('alpha', '1.1'))
    expect(related.neighbours.map((n) => n.task_id)).toEqual(['1.2'])
  })

  it('returns a not-found result for an unknown task', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', planned('alpha', ['1.1']))
    const related = relatedTasks(buildGraph(root), taskNodeId('alpha', '9.9'))
    expect(related).toEqual({ id: taskNodeId('alpha', '9.9'), found: false, neighbours: [], omitted: 0 })
  })
})

describe('repoGeneral (2.3)', () => {
  it('ranks by DISTINCT citing initiatives other than its own, and excludes same-initiative citation', () => {
    const root = makeRoot()
    // alpha D1 is cited from beta and gamma; alpha D2 only from within alpha.
    const alphaEvents = [
      ...planned('alpha', ['1.1']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'decision_logged', { chose: 'the general rule', over: 'x', because: 'y' }, 's-a'),
      ev('alpha', 'decision_logged', { chose: 'a local rule', over: 'x', because: 'y' }, 's-a'),
      ev('alpha', 'decision_logged', { chose: 'cites D2 from home', over: 'x', because: 'y' }, 's-a'),
    ]
    writeLog(root, 'alpha', alphaEvents)
    writeLog(root, 'beta', [
      ...planned('beta', ['2.1']),
      ev('beta', 'session_started', { tool: 'claude-code' }, 's-b'),
      ev('beta', 'decision_logged', { chose: 'follows alpha D1', over: 'x', because: 'y' }, 's-b'),
    ])
    writeLog(root, 'gamma', [
      ...planned('gamma', ['3.1']),
      ev('gamma', 'session_started', { tool: 'claude-code' }, 's-c'),
      ev('gamma', 'decision_logged', { chose: 'also alpha D1', over: 'x', because: 'y' }, 's-c'),
    ])

    const rows = repoGeneral(buildGraph(root))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.initiative).toBe('alpha')
    expect(rows[0]?.ordinal).toBe(1)
    expect(rows[0]?.cited_by).toEqual(['beta', 'gamma'])
    expect(rows[0]?.citations).toBe(2)
  })

  it('is empty when nothing is cited from outside its own initiative', () => {
    const root = makeRoot()
    writeLog(root, 'alpha', [
      ...planned('alpha', ['1.1']),
      ev('alpha', 'session_started', { tool: 'claude-code' }, 's-a'),
      ev('alpha', 'decision_logged', { chose: 'first', over: 'x', because: 'y' }, 's-a'),
      ev('alpha', 'decision_logged', { chose: 'builds on D1', over: 'x', because: 'y' }, 's-a'),
    ])
    expect(repoGeneral(buildGraph(root))).toEqual([])
  })
})
