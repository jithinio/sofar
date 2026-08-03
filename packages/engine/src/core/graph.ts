import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  validatePayload,
  type CommandRunPayload,
  type DecisionLoggedPayload,
  type FileTouchedPayload,
  type NoteAddedPayload,
  type PhaseStatus,
  type PlanUpdatedPayload,
  type TaskAddedPayload,
  type TaskStatus,
  type TaskStatusChangedPayload,
} from '@sofar/schema'
import { decodeLines, foldLines, type InitiativeState } from './fold'

/**
 * Record graph (SPEC §Record graph, record-graph 1.2): ONE mechanical,
 * read-side adjacency derivation over every .sofar/initiatives/<slug>/
 * events.jsonl in the repo.
 *
 * It exists because the fold reads ONE log at a time and therefore cannot
 * see the facts that outlive a log: a session that wrote to two initiatives,
 * a file path touched from three, a decision cited from somewhere else.
 * Those are already typed facts in the envelopes — flattening them away is a
 * property of per-initiative folding, not of the record.
 *
 * Zero new event types, zero new capture, retroactive over every existing
 * record, zero model API calls (felt-cost D3: citation extraction is a
 * closed lexical grammar, never inference). Never in the hot path — this
 * reads N logs where a shim can afford one (speed T2); its only consumers
 * are explicit CLI surfaces and doctor.
 */

// ---------------------------------------------------------------------------
// Node vocabulary — three identity families (SPEC §Record graph).
// ---------------------------------------------------------------------------

export type GraphNodeKind =
  | 'initiative'
  | 'phase'
  | 'task'
  | 'session'
  | 'file'
  | 'command'
  | 'decision'
  | 'note'

/** STRUCTURAL — from each initiative's FINAL folded plan. */
export interface InitiativeNode {
  kind: 'initiative'
  id: string
  slug: string
  goal: string
}

export interface PhaseNode {
  kind: 'phase'
  id: string
  initiative: string
  name: string
  status: PhaseStatus
}

export interface TaskNode {
  kind: 'task'
  id: string
  initiative: string
  task_id: string
  title: string
  status: TaskStatus
  /**
   * Minted from a task_status_changed whose id the final plan never held
   * (the FoldResult.orphan_task_events population). Present so every edge
   * endpoint resolves AND the orphan stays visible rather than being
   * silently dropped along with its edge.
   */
  orphan?: true
}

/** JOIN — deliberately NOT slug-scoped: the id means the same in every log. */
export interface SessionNode {
  kind: 'session'
  id: string
  session_id: string
  tool?: string
  model?: string
  started?: string
  ended?: string
}

export interface FileNode {
  kind: 'file'
  id: string
  path: string
}

/** OCCURRENCE — one node per sourcing event, keyed by its ulid. */
export interface CommandNode {
  kind: 'command'
  id: string
  initiative: string
  session: string
  ts: string
  cmd: string
}

export interface DecisionNode {
  kind: 'decision'
  id: string
  initiative: string
  session: string
  ts: string
  /** 1-based position among this initiative's decisions in ulid order — the `D<n>` handle. */
  ordinal: number
  chose: string
  over: string
  because: string
  /** Handle-shaped tokens this decision cites that resolve to no node (never discarded). */
  dangling: string[]
}

export interface NoteNode {
  kind: 'note'
  id: string
  initiative: string
  session: string
  ts: string
  text: string
}

export type GraphNode =
  | InitiativeNode
  | PhaseNode
  | TaskNode
  | SessionNode
  | FileNode
  | CommandNode
  | DecisionNode
  | NoteNode

export const initiativeNodeId = (slug: string): string => `initiative:${slug}`
export const phaseNodeId = (slug: string, name: string): string => `phase:${slug}#${name}`
export const taskNodeId = (slug: string, taskId: string): string => `task:${slug}#${taskId}`
export const sessionNodeId = (sessionId: string): string => `session:${sessionId}`
export const fileNodeId = (path: string): string => `file:${path}`

// ---------------------------------------------------------------------------
// Edge vocabulary.
// ---------------------------------------------------------------------------

export type GraphEdgeKind =
  | 'has_phase'
  | 'has_task'
  | 'touched'
  | 'ran'
  | 'changed'
  | 'decided'
  | 'noted'
  | 'worked'
  | 'cites'

export interface GraphEdge {
  kind: GraphEdgeKind
  from: string
  to: string
  /**
   * envelope.initiative of the sourcing event (the home slug for structural
   * edges) — what makes cross-initiative provenance a filter, not a join.
   */
  initiative: string
  /** Present on occurrence edges: the ulid of the event that produced this edge. */
  event_id?: string
  ts?: string
  attrs?: { op?: string; status?: TaskStatus }
}

export interface RecordGraph {
  nodes: Map<string, GraphNode>
  /** Deterministic order: slug asc, structural then occurrence in ulid order, cites last. */
  edges: GraphEdge[]
  outgoing: Map<string, GraphEdge[]>
  incoming: Map<string, GraphEdge[]>
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Citation grammar (record-graph 1.3) — closed, lexical, literal.
// ---------------------------------------------------------------------------

/** One handle-shaped token found in decision prose, before resolution. */
export interface Citation {
  /** The matched text, verbatim — what a dangling report shows. */
  raw: string
  /** Initiative the handle is scoped to: the qualifier, or the citing decision's own slug. */
  slug: string
  /** `D<n>`, `T<n>`, or `<n>.<n>`. */
  handle: string
  /** True when the slug came from an explicit qualifier rather than the default. */
  qualified: boolean
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract citation handles from decision prose.
 *
 * QUALIFIED `<slug> <handle>` binds to that initiative; UNQUALIFIED
 * `D<n>`/`T<n>` binds to the citing decision's own. A bare `<n>.<n>` is NOT
 * a handle: measured over the live record it matches version strings
 * (`0.1`, `0.7`, `0.8`) and an IP octet (`127.0`) and nothing true. `BD<n>`
 * and `D-<label>` are not in the grammar at all — they name the archived
 * pre-migration prose record and hand-coined labels, which have no nodes
 * here; resolving them would require inference (D3).
 *
 * Only a space or tab may separate qualifier from handle, so a slug ending
 * one field cannot bind to a handle opening the next.
 */
export function extractCitations(
  text: string,
  homeSlug: string,
  knownSlugs: readonly string[],
): Citation[] {
  const citations: Citation[] = []
  if (knownSlugs.length === 0) return citations
  // Longest slug first so `speed-2` wins over `speed`.
  const alternation = [...knownSlugs]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|')
  const re = new RegExp(`(?:\\b(${alternation})[ \\t]+)?\\b(D\\d+|T\\d+|\\d+\\.\\d+)\\b`, 'g')
  for (const match of text.matchAll(re)) {
    const qualifier = match[1]
    const handle = match[2]
    if (handle === undefined) continue
    // A dotted task id without its slug is not a handle.
    if (qualifier === undefined && handle.includes('.')) continue
    citations.push({
      raw: match[0],
      slug: qualifier ?? homeSlug,
      handle,
      qualified: qualifier !== undefined,
    })
  }
  return citations
}

// ---------------------------------------------------------------------------
// buildGraph.
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Live plan structure during the adjacency replay — mirrors the fold's plan handling. */
interface LiveTask {
  id: string
  status: TaskStatus
}

interface PerInitiative {
  slug: string
  state: InitiativeState
  /** Decision node ids in ulid order — index i is the `D<i+1>` handle. */
  decisionIds: string[]
}

export function buildGraph(rootDir: string): RecordGraph {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const warnings: string[] = []
  const initiativesDir = join(rootDir, '.sofar', 'initiatives')
  const empty: RecordGraph = {
    nodes,
    edges,
    outgoing: new Map(),
    incoming: new Map(),
    warnings,
  }
  if (!existsSync(initiativesDir)) return empty // not sofar-initialized

  let slugs: string[]
  try {
    slugs = readdirSync(initiativesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort() // deterministic build order
  } catch (err) {
    warnings.push(`cannot read ${initiativesDir}: ${errMessage(err)}`)
    return empty
  }

  const perInitiative: PerInitiative[] = []

  for (const slug of slugs) {
    const logPath = join(initiativesDir, slug, 'events.jsonl')
    if (!existsSync(logPath)) continue // an initiative that never logged has no adjacency

    let raw: string
    try {
      raw = readFileSync(logPath, 'utf8')
    } catch (err) {
      warnings.push(`${slug}: cannot read events.jsonl — omitted from the graph (${errMessage(err)})`)
      continue
    }

    const lines = raw.split('\n')
    const { state, warnings: foldWarnings } = foldLines(lines)
    warnings.push(...foldWarnings.map((w) => `${slug}: ${w}`))
    const { parsed, voided } = decodeLines(lines)

    // --- Structural nodes + edges, from the FINAL folded plan.
    const initiativeId = initiativeNodeId(slug)
    nodes.set(initiativeId, { kind: 'initiative', id: initiativeId, slug, goal: state.goal })
    for (const phase of state.phases) {
      const phaseId = phaseNodeId(slug, phase.name)
      nodes.set(phaseId, {
        kind: 'phase',
        id: phaseId,
        initiative: slug,
        name: phase.name,
        status: phase.status,
      })
      edges.push({ kind: 'has_phase', from: initiativeId, to: phaseId, initiative: slug })
      for (const task of phase.tasks) {
        const taskId = taskNodeId(slug, task.id)
        nodes.set(taskId, {
          kind: 'task',
          id: taskId,
          initiative: slug,
          task_id: task.id,
          title: task.title,
          status: task.status,
        })
        edges.push({ kind: 'has_task', from: phaseId, to: taskId, initiative: slug })
      }
    }

    // Session nodes are repo-wide: a session registered here may already have
    // been seen in another log (or may be registered only in another log —
    // the misroute signature, record-integrity 2.1). First registration by
    // `started` wins the metadata; slug order breaks ties deterministically.
    for (const session of state.sessions) {
      const id = sessionNodeId(session.id)
      const existing = nodes.get(id) as SessionNode | undefined
      if (existing !== undefined && existing.started !== undefined) {
        if (existing.started <= session.started) continue
      }
      const node: SessionNode = { kind: 'session', id, session_id: session.id, started: session.started }
      if (session.tool !== undefined) node.tool = session.tool
      if (session.model !== undefined) node.model = session.model
      if (session.ended !== undefined) node.ended = session.ended
      nodes.set(id, node)
    }

    // --- Occurrence walk, in ulid order (the fold's normative order).
    const decisionIds: string[] = []
    const livePhases: { name: string; tasks: LiveTask[] }[] = []

    for (const { event } of parsed) {
      if (voided.has(event.id)) continue
      if (!validatePayload(event.type, event.payload).ok) continue

      // Track plan structure so `worked` can attribute to the tasks that were
      // ACTIVE at this point — the task_files rule (speed T4) generalized.
      switch (event.type) {
        case 'plan_updated': {
          const p = event.payload as unknown as PlanUpdatedPayload
          livePhases.length = 0
          for (const phase of p.plan.phases) {
            livePhases.push({
              name: phase.name,
              tasks: phase.tasks.map((t) => ({ id: t.id, status: t.status ?? 'pending' })),
            })
          }
          break
        }
        case 'task_added': {
          const p = event.payload as unknown as TaskAddedPayload
          if (findLiveTask(livePhases, p.id) === undefined) {
            let phase = livePhases.find((ph) => ph.name === p.phase)
            if (phase === undefined) {
              phase = { name: p.phase, tasks: [] }
              livePhases.push(phase)
            }
            phase.tasks.push({ id: p.id, status: p.status ?? 'pending' })
          }
          break
        }
        case 'task_status_changed': {
          const p = event.payload as unknown as TaskStatusChangedPayload
          const live = findLiveTask(livePhases, p.id)
          if (live !== undefined) live.status = p.status
          break
        }
      }

      const sessionId = event.session === 'cli' ? undefined : sessionNodeId(event.session)
      // `cli` is not a session identity (BD44) and gets no node; a session id
      // seen only on non-lifecycle events is still a real session living in
      // another log, so mint a bare node rather than dropping its edges.
      if (sessionId !== undefined && !nodes.has(sessionId)) {
        nodes.set(sessionId, { kind: 'session', id: sessionId, session_id: event.session })
      }

      switch (event.type) {
        case 'file_touched': {
          const p = event.payload as unknown as FileTouchedPayload
          const fileId = fileNodeId(p.path)
          // Minted for ANY source including cli — task_files and freshness
          // both count cli events, and this derivation subsumes task_files.
          if (!nodes.has(fileId)) nodes.set(fileId, { kind: 'file', id: fileId, path: p.path })
          if (sessionId !== undefined) {
            edges.push({
              kind: 'touched',
              from: sessionId,
              to: fileId,
              initiative: event.initiative,
              event_id: event.id,
              ts: event.ts,
              attrs: { op: p.op },
            })
          }
          for (const phase of livePhases) {
            for (const task of phase.tasks) {
              if (task.status !== 'active') continue
              edges.push({
                kind: 'worked',
                from: taskNodeId(slug, task.id),
                to: fileId,
                initiative: event.initiative,
                event_id: event.id,
                ts: event.ts,
              })
            }
          }
          break
        }
        case 'command_run': {
          const p = event.payload as unknown as CommandRunPayload
          const id = `command:${event.id}`
          nodes.set(id, {
            kind: 'command',
            id,
            initiative: event.initiative,
            session: event.session,
            ts: event.ts,
            cmd: p.cmd,
          })
          if (sessionId !== undefined) {
            edges.push({
              kind: 'ran',
              from: sessionId,
              to: id,
              initiative: event.initiative,
              event_id: event.id,
              ts: event.ts,
            })
          }
          break
        }
        case 'task_status_changed': {
          const p = event.payload as unknown as TaskStatusChangedPayload
          const target = taskNodeId(slug, p.id)
          // The plan never held this id → orphan node, so the edge still
          // resolves and activity's task_changes stays reproducible (4.2).
          if (!nodes.has(target)) {
            nodes.set(target, {
              kind: 'task',
              id: target,
              initiative: slug,
              task_id: p.id,
              title: '',
              status: p.status,
              orphan: true,
            })
          }
          if (sessionId !== undefined) {
            edges.push({
              kind: 'changed',
              from: sessionId,
              to: target,
              initiative: event.initiative,
              event_id: event.id,
              ts: event.ts,
              attrs: { status: p.status },
            })
          }
          break
        }
        case 'decision_logged': {
          const p = event.payload as unknown as DecisionLoggedPayload
          const id = `decision:${event.id}`
          decisionIds.push(id)
          nodes.set(id, {
            kind: 'decision',
            id,
            initiative: event.initiative,
            session: event.session,
            ts: event.ts,
            ordinal: decisionIds.length,
            chose: p.chose,
            over: p.over,
            because: p.because,
            dangling: [],
          })
          if (sessionId !== undefined) {
            edges.push({
              kind: 'decided',
              from: sessionId,
              to: id,
              initiative: event.initiative,
              event_id: event.id,
              ts: event.ts,
            })
          }
          break
        }
        case 'note_added': {
          const p = event.payload as unknown as NoteAddedPayload
          const id = `note:${event.id}`
          nodes.set(id, {
            kind: 'note',
            id,
            initiative: event.initiative,
            session: event.session,
            ts: event.ts,
            text: p.text,
          })
          if (sessionId !== undefined) {
            edges.push({
              kind: 'noted',
              from: sessionId,
              to: id,
              initiative: event.initiative,
              event_id: event.id,
              ts: event.ts,
            })
          }
          break
        }
      }
    }

    perInitiative.push({ slug, state, decisionIds })
  }

  // --- `cites`: a second pass, because a citation may name any initiative.
  const knownSlugs = perInitiative.map((p) => p.slug)
  const decisionsBySlug = new Map(perInitiative.map((p) => [p.slug, p.decisionIds]))
  const tasksBySlug = new Map(
    perInitiative.map((p) => [p.slug, new Set(p.state.phases.flatMap((ph) => ph.tasks.map((t) => t.id)))]),
  )
  const citeEdges: GraphEdge[] = []

  for (const { slug, decisionIds } of perInitiative) {
    for (const decisionId of decisionIds) {
      const node = nodes.get(decisionId) as DecisionNode | undefined
      if (node === undefined) continue
      const text = `${node.chose}\n${node.over}\n${node.because}`
      for (const citation of extractCitations(text, slug, knownSlugs)) {
        const target = resolveCitation(citation, decisionId, decisionsBySlug, tasksBySlug)
        if (target === undefined) {
          if (!node.dangling.includes(citation.raw)) node.dangling.push(citation.raw)
          continue
        }
        if (target === decisionId) continue // self-label, not a citation
        citeEdges.push({ kind: 'cites', from: decisionId, to: target, initiative: slug })
      }
    }
  }
  // Ordered by citing decision ulid — deterministic across the whole repo.
  citeEdges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1))
  edges.push(...citeEdges)

  const outgoing = new Map<string, GraphEdge[]>()
  const incoming = new Map<string, GraphEdge[]>()
  for (const edge of edges) {
    const out = outgoing.get(edge.from)
    if (out === undefined) outgoing.set(edge.from, [edge])
    else out.push(edge)
    const inc = incoming.get(edge.to)
    if (inc === undefined) incoming.set(edge.to, [edge])
    else inc.push(edge)
  }

  return { nodes, edges, outgoing, incoming, warnings }
}

function findLiveTask(
  phases: { name: string; tasks: LiveTask[] }[],
  id: string,
): LiveTask | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((t) => t.id === id)
    if (task !== undefined) return task
  }
  return undefined
}

/**
 * Resolve one citation to a node id, or undefined (dangling). Literal only:
 * `D<n>` is the nth decision of that initiative in ulid order, `T<n>` /
 * `<n>.<n>` is the task with that EXACT id in its final plan, and a decision
 * target must sort BEFORE the citing decision — nothing cites the future.
 */
function resolveCitation(
  citation: Citation,
  citingDecisionId: string,
  decisionsBySlug: ReadonlyMap<string, readonly string[]>,
  tasksBySlug: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  if (/^D\d+$/.test(citation.handle)) {
    const ordinal = Number(citation.handle.slice(1))
    const ids = decisionsBySlug.get(citation.slug)
    if (ids === undefined || ordinal < 1 || ordinal > ids.length) return undefined
    const target = ids[ordinal - 1]
    if (target === undefined || target > citingDecisionId) return undefined
    return target
  }
  const tasks = tasksBySlug.get(citation.slug)
  if (tasks === undefined || !tasks.has(citation.handle)) return undefined
  return taskNodeId(citation.slug, citation.handle)
}
