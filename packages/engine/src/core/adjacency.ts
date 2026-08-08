import type {
  CommandRunPayload,
  DecisionLoggedPayload,
  FileTouchedPayload,
  NoteAddedPayload,
  TaskStatus,
  TaskStatusChangedPayload,
} from '@sofar/schema'
import type { EventEnvelope } from './envelope'

/**
 * Adjacency vocabulary and the ONE emission rule (record-graph 4.1/4.2).
 *
 * This module sits BELOW both fold.ts and graph.ts, and that placement is the
 * whole point of the consolidation. Before it, the same question — "which
 * tasks were active when this file was touched, and what did this session
 * do" — was answered by three separate reducers: the fold's `recordTaskFiles`
 * (speed T4), the fold's `recordActivity` (BD44), and the graph's own event
 * walk. They agreed by care, not by construction.
 *
 * Now one function turns an event into edges, and each derived view is a pure
 * function of that edge list:
 *   fold.ts   — emits edges during its EXISTING state replay (the live plan it
 *               already tracks IS the active-task set) and derives task_files
 *               and per-session activity from them.
 *   graph.ts  — unions the per-log edge lists into the repo-wide graph.
 *
 * The layering is load-bearing, not stylistic. fold.ts runs on the hot path
 * (SessionStart, PostToolUse, Stop — 100ms end-to-end, speed T2) while
 * buildGraph reads EVERY log in the repo; fold must never import graph
 * (SPEC §Record graph, pinned by test/graph-hotpath.test.ts). A shared module
 * below both gives one rule without the hot path ever paying an N-log read.
 * Measured on this record: per-log edge emission ≈0.02ms against a 0.9ms fold
 * of the largest log, where buildGraph over the whole repo is ~16ms.
 *
 * Edge ids are SLUG-QUALIFIED for structural endpoints (`task:<slug>#<id>`)
 * because task ids are not repo-unique — `1.1` exists in most initiatives. The
 * slug comes from the caller (foldLog derives it from the record layout), so a
 * per-log edge list is directly unionable into the repo-wide graph with no
 * rewriting.
 */

// ---------------------------------------------------------------------------
// Node ids.
// ---------------------------------------------------------------------------

export const initiativeNodeId = (slug: string): string => `initiative:${slug}`
export const phaseNodeId = (slug: string, name: string): string => `phase:${slug}#${name}`
export const taskNodeId = (slug: string, taskId: string): string => `task:${slug}#${taskId}`
export const sessionNodeId = (sessionId: string): string => `session:${sessionId}`
export const fileNodeId = (path: string): string => `file:${path}`

/** The task id inside a `task:<slug>#<id>` node id (the part after the first #). */
export function taskIdOf(nodeId: string): string {
  const hash = nodeId.indexOf('#')
  return hash === -1 ? nodeId.replace(/^task:/, '') : nodeId.slice(hash + 1)
}

/** The path inside a `file:<path>` node id. */
export function pathOfNodeId(nodeId: string): string {
  return nodeId.startsWith('file:') ? nodeId.slice('file:'.length) : nodeId
}

// ---------------------------------------------------------------------------
// Edges.
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

/**
 * Every edge ONE event contributes, in a fixed order.
 *
 * `activeTasks` is the set of task ids ACTIVE at this point in the replay —
 * the caller's live plan, never re-derived here. That is the speed T4 rule
 * generalized: a file_touched attributes to EVERY task active at that moment,
 * because envelope events carry sessions, not tasks, and task activity
 * windows are what the record actually knows.
 *
 * Session-anchored edges form only for a real session id: `cli` is not a
 * session identity (BD44) and anchors nothing. A cli-sourced file_touched
 * still emits its `worked` edges — task_files and freshness both count cli
 * events, so the derivation that replaces them must too.
 *
 * The caller has already skipped voided events, unknown types and invalid
 * payloads (the fold's replay guard); this function assumes that contract.
 */
export function edgesForEvent(
  event: EventEnvelope,
  slug: string,
  activeTasks: readonly string[],
): GraphEdge[] {
  const edges: GraphEdge[] = []
  const session = event.session === 'cli' ? undefined : sessionNodeId(event.session)
  const stamp = { initiative: event.initiative, event_id: event.id, ts: event.ts }

  switch (event.type) {
    case 'file_touched': {
      const p = event.payload as unknown as FileTouchedPayload
      const file = fileNodeId(p.path)
      if (session !== undefined) {
        edges.push({ kind: 'touched', from: session, to: file, ...stamp, attrs: { op: p.op } })
      }
      for (const taskId of activeTasks) {
        edges.push({ kind: 'worked', from: taskNodeId(slug, taskId), to: file, ...stamp })
      }
      break
    }
    case 'command_run': {
      if (session !== undefined) {
        edges.push({ kind: 'ran', from: session, to: `command:${event.id}`, ...stamp })
      }
      break
    }
    case 'task_status_changed': {
      if (session !== undefined) {
        const p = event.payload as unknown as TaskStatusChangedPayload
        edges.push({
          kind: 'changed',
          from: session,
          to: taskNodeId(slug, p.id),
          ...stamp,
          attrs: { status: p.status },
        })
      }
      break
    }
    case 'decision_logged': {
      if (session !== undefined) {
        edges.push({ kind: 'decided', from: session, to: `decision:${event.id}`, ...stamp })
      }
      break
    }
    case 'note_added': {
      if (session !== undefined) {
        edges.push({ kind: 'noted', from: session, to: `note:${event.id}`, ...stamp })
      }
      break
    }
  }
  return edges
}

/** Payload accessors kept beside the emission rule so both readers agree. */
export const commandTextOf = (event: EventEnvelope): string =>
  (event.payload as unknown as CommandRunPayload).cmd
export const noteTextOf = (event: EventEnvelope): string =>
  (event.payload as unknown as NoteAddedPayload).text
export const decisionOf = (event: EventEnvelope): DecisionLoggedPayload =>
  event.payload as unknown as DecisionLoggedPayload

// ---------------------------------------------------------------------------
// Derived views — pure functions of an edge list.
// ---------------------------------------------------------------------------

/**
 * Per-task file cap (speed T4): task_files lists hold the most recent touches
 * only — render surfaces show fewer still, so the fold stays bounded without
 * a sentinel.
 */
export const TASK_FILES_CAP = 20

/** List cap for derived activity arrays (BD44) — overflow becomes a "+N more" sentinel. */
export const ACTIVITY_LIST_CAP = 20

/**
 * Per-list cap on structural QUERY results (record-graph 2.x), re-exported by
 * core/graph.ts where readers look for it. It lives down here beside the other
 * two caps because the index answers the same questions the graph does
 * (record-index 3.1) and must cap them identically — and core/graph.ts is
 * import-locked away from the hot path, so a hot-path module cannot reach a
 * constant that lives there.
 *
 * Overflow past it is reported as a NUMERIC count, never as a "+N more"
 * element inside a typed list: the in-band sentinel in activity.files above is
 * why openSessionFileConflicts has to defend with `startsWith('+')`.
 */
export const GRAPH_RESULT_CAP = 20

/**
 * File-locality hints (speed T4) as a function of the `worked` edges: task id
 * → paths touched while that task was active, deduped MOST-RECENT-FIRST (a
 * re-touch moves the path to the front), capped at TASK_FILES_CAP.
 *
 * Derived only from record events, so an identical record yields identical
 * task_files — byte-stability safe by construction, which is what the
 * SessionStart injection pin depends on.
 */
export function taskFilesFromEdges(edges: readonly GraphEdge[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const edge of edges) {
    if (edge.kind !== 'worked') continue
    const taskId = taskIdOf(edge.from)
    const path = pathOfNodeId(edge.to)
    const files = out[taskId] ?? []
    const existing = files.indexOf(path)
    if (existing !== -1) files.splice(existing, 1)
    files.unshift(path)
    if (files.length > TASK_FILES_CAP) files.pop()
    out[taskId] = files
  }
  return out
}

/**
 * Derived per-session activity (task 7.2, BD44): the resume fallback for
 * sessions that never wrote back. Aggregated from the mechanical edges —
 * `touched` (deduped, FIRST-touch order, unlike task_files), `ran`, `changed`
 * — in edge order, which is replay order.
 *
 * Capped lists carry a "+N more" sentinel, kept for byte-compatibility with
 * every existing render (this is why graph QUERY results report a numeric
 * `omitted` instead: the sentinel is why openSessionFileConflicts has to
 * defend with `startsWith('+')`).
 */
export interface SessionActivity {
  /** Deduped file_touched paths in first-touch order (capped + sentinel). */
  files: string[]
  /** Count of command_run events. */
  commands: number
  /** task_status_changed as "<id> → <status>" in log order (capped + sentinel). */
  task_changes: string[]
}

interface ActivityAcc {
  files: string[]
  seen: Set<string>
  filesOverflow: number
  commands: number
  taskChanges: string[]
  taskChangesOverflow: number
}

/**
 * Activity per session id, in edge order. The caller decides ATTACHMENT: the
 * fold attaches to sessions registered in THAT log only (the no-stub rule,
 * BD21/BD44), a per-log fact the repo-wide graph deliberately does not carry
 * — session identity there is repo-wide, which is the whole cross-initiative
 * join.
 */
export function activityFromEdges(edges: readonly GraphEdge[]): Map<string, SessionActivity> {
  const acc = new Map<string, ActivityAcc>()
  const of = (sessionNode: string): ActivityAcc => {
    const id = sessionNode.slice('session:'.length)
    let a = acc.get(id)
    if (a === undefined) {
      a = { files: [], seen: new Set(), filesOverflow: 0, commands: 0, taskChanges: [], taskChangesOverflow: 0 }
      acc.set(id, a)
    }
    return a
  }

  for (const edge of edges) {
    switch (edge.kind) {
      case 'touched': {
        const a = of(edge.from)
        const path = pathOfNodeId(edge.to)
        if (a.seen.has(path)) break // dedupe — first touch wins the slot
        a.seen.add(path)
        if (a.files.length < ACTIVITY_LIST_CAP) a.files.push(path)
        else a.filesOverflow += 1
        break
      }
      case 'ran': {
        of(edge.from).commands += 1
        break
      }
      case 'changed': {
        const a = of(edge.from)
        if (a.taskChanges.length < ACTIVITY_LIST_CAP) {
          a.taskChanges.push(`${taskIdOf(edge.to)} → ${edge.attrs?.status ?? ''}`)
        } else a.taskChangesOverflow += 1
        break
      }
    }
  }

  const out = new Map<string, SessionActivity>()
  for (const [id, a] of acc) {
    out.set(id, {
      files: a.filesOverflow > 0 ? [...a.files, `+${a.filesOverflow} more`] : a.files,
      commands: a.commands,
      task_changes:
        a.taskChangesOverflow > 0 ? [...a.taskChanges, `+${a.taskChangesOverflow} more`] : a.taskChanges,
    })
  }
  return out
}
