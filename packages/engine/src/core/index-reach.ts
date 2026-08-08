import type {
  DecisionLoggedPayload,
  FileTouchedPayload,
  NoteAddedPayload,
  PlanUpdatedPayload,
  TaskAddedPayload,
} from '@sofar/schema'
import {
  fileNodeId,
  GRAPH_RESULT_CAP,
  initiativeNodeId,
  matchRecordedPaths,
  sessionNodeId,
} from './adjacency'
import { bindHandle, canonicalSlugs, scanCitations } from './citations'
import { passOverRecord } from './index-pass'
import { INDEX_SCHEMA_VERSION, readIndexFile, writeIndexFile } from './index-store'
import type { IndexedEvent } from './index-tail'

/**
 * The REACH half of Tier 1 (record-index 3.4): what `sofar find` traverses.
 *
 * Layer 3 of D2's ladder. The guard (3.2) is pushed on every edit and the
 * priming line (3.3) once per session; both are cheap because both are narrow.
 * This is the layer the agent PULLS, and pull is where depth belongs — at 300
 * initiatives nothing can be pushed wholesale, so the question an agent
 * actually has ("what else in this repo bears on what I am doing") has to be
 * answerable on demand, in full, with citations.
 *
 * A THIRD file on a THIRD cursor, for the reason 3.2 split the first two: read
 * frequency, not taste. guards.json is read on every edit and holds three
 * decisions; graph.json is read once a rule fires and holds the repo's touch
 * history; reach.json is read only when someone asks a question, and so it can
 * afford to carry what neither of the others can — decision and note prose,
 * citation handles, the event id behind every edge. Nothing on a shim path
 * opens it, and nothing on a shim path imports this module.
 *
 * WHAT IT DOES NOT CARRY, and why:
 *  - Tasks are not nodes. `sofar related <task-id>` already answers task
 *    adjacency from the graph, and the seed vocabulary here is file / session /
 *    decision / initiative. Task ids are kept only as CITATION TARGETS, so a
 *    decision citing `<slug> 3.2` is known to have cited something real.
 *  - Prose is CLIPPED at REACH_PROSE. This index exists to say what is worth
 *    reading, not to become the thing that is read — and a full copy of the
 *    record is a copy that invites being read as truth (D1). Every result names
 *    the event id, and the record is one command away.
 */

const REACH_FILE = 'reach.json'
const REACH_META = 'meta-reach.json'

/**
 * Stored-prose budget. Comfortably above the 96-char render budget, so a line
 * rendered from the index is byte-identical to one rendered from the log, and
 * far below the record itself (decisions here average 945 chars of prose).
 */
export const REACH_PROSE = 300

/** Default hop budget: one hop out and one hop back is the useful question. */
export const REACH_DEFAULT_HOPS = 2
/** Ceiling on the budget — past 3 hops the answer is "the repo", which is not an answer. */
export const REACH_MAX_HOPS = 3

/**
 * Ceiling on nodes VISITED, independent of the per-kind result caps.
 *
 * A hub file (this record: cli/event.ts) is adjacent to most of the repo, so a
 * 3-hop expansion is unbounded in principle. When the ceiling is reached the
 * traversal stops and SAYS SO — a truncated answer that reports itself is
 * usable; a silent one is a lie about coverage.
 */
const VISIT_CAP = 20_000

// ---------------------------------------------------------------------------
// On-disk state — per initiative, exactly like the other halves.
// ---------------------------------------------------------------------------

interface DecisionRow {
  /** Envelope id of the decision_logged event — the node id and the citation. */
  id: string
  ts: string
  session: string
  /** `chose`, clipped to REACH_PROSE. */
  chose: string
  /** Scanned citation handles as [word, handle], BOUND at query time (citations.ts). */
  cites: [string, string][]
}

interface NoteRow {
  id: string
  ts: string
  session: string
  /** Note text, clipped to REACH_PROSE. */
  text: string
}

interface SlugReachState {
  /** decision_logged in replay order — index i is the `D<i+1>` handle. */
  decisions: DecisionRow[]
  notes: NoteRow[]
  /** path → session → [event id of the most recent touch, its ts, touch count]. */
  files: Record<string, Record<string, [string, string, number]>>
  /** Task ids the FINAL plan holds — citation targets only, never nodes. */
  tasks: string[]
}

interface ReachDisk {
  version: number
  initiatives: Record<string, SlugReachState>
}

function isReachDisk(v: unknown): v is ReachDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

const emptyReach = (): SlugReachState => ({ decisions: [], notes: [], files: {}, tasks: [] })

function cloneReach(state: SlugReachState): SlugReachState {
  const files: Record<string, Record<string, [string, string, number]>> = {}
  for (const [path, sessions] of Object.entries(state.files)) {
    const copy: Record<string, [string, string, number]> = {}
    for (const [session, entry] of Object.entries(sessions)) copy[session] = [...entry]
    files[path] = copy
  }
  return {
    decisions: state.decisions.map((d) => ({
      ...d,
      cites: d.cites.map((c) => [...c] as [string, string]),
    })),
    notes: state.notes.map((n) => ({ ...n })),
    files,
    tasks: [...state.tasks],
  }
}

/** Collapse whitespace and hard-cap, ellipsis inside the budget (projections' clip). */
function clipProse(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Apply one event, mirroring the fold and the graph's emission rules.
 *
 * `cli` is not a session identity (BD44) and anchors no session-side edge, so a
 * cli-sourced touch, decision or note contributes a node but no edge — the same
 * asymmetry buildGraph has, kept deliberately, because an indexed answer that
 * differs from the from-logs one is worse than no index.
 *
 * Decision rows are pushed unconditionally: their POSITION is the `D<n>` handle
 * the whole record cites by, so skipping one would renumber every decision
 * after it in that initiative.
 */
function applyReach(state: SlugReachState, event: IndexedEvent): void {
  switch (event.type) {
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      state.decisions.push({
        id: event.id,
        ts: event.ts,
        session: event.session,
        chose: clipProse(p.chose, REACH_PROSE),
        // Scanned over the WHOLE decision, exactly as buildGraph reads it —
        // `because` is where most cross-record citations actually live.
        cites: scanCitations(`${p.chose}\n${p.over}\n${p.because}`).map(
          (s) => [s.word, s.handle] as [string, string],
        ),
      })
      return
    }
    case 'note_added': {
      const p = event.payload as unknown as NoteAddedPayload
      state.notes.push({
        id: event.id,
        ts: event.ts,
        session: event.session,
        text: clipProse(p.text, REACH_PROSE),
      })
      return
    }
    case 'file_touched': {
      if (event.session === 'cli' || event.session.length === 0) return
      const path = (event.payload as unknown as FileTouchedPayload).path
      const sessions = state.files[path] ?? {}
      const existing = sessions[event.session]
      if (existing === undefined) sessions[event.session] = [event.id, event.ts, 1]
      else {
        existing[2] += 1
        // The citation is the MOST RECENT touch — the one a reader would open,
        // and the one that keeps id and ts describing the same event.
        if (event.ts > existing[1]) {
          existing[0] = event.id
          existing[1] = event.ts
        }
      }
      state.files[path] = sessions
      return
    }
    case 'plan_updated': {
      // A full replace (SPEC §MCP tools), so the task-id set is replaced too.
      const p = event.payload as unknown as PlanUpdatedPayload
      state.tasks = p.plan.phases.flatMap((phase) => phase.tasks.map((task) => task.id))
      return
    }
    case 'task_added': {
      const p = event.payload as unknown as TaskAddedPayload
      if (!state.tasks.includes(p.id)) state.tasks.push(p.id)
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// The keyed view.
// ---------------------------------------------------------------------------

export type ReachNodeKind = 'initiative' | 'session' | 'file' | 'decision' | 'note'

export interface ReachNode {
  kind: ReachNodeKind
  id: string
  /** Home initiative. Empty for a file and a session, both of which span records. */
  initiative: string
  /** Path, session id, slug, or clipped prose — what a surface shows. */
  label: string
  ts: string
  /** `D<n>` within its own initiative, for a decision. */
  ordinal?: number
}

export type ReachEdgeKind = 'touched' | 'decided' | 'noted' | 'cites' | 'cited_by'

export interface ReachEdge {
  kind: ReachEdgeKind
  to: string
  /** envelope.initiative of the sourcing event — provenance, not a join. */
  initiative: string
  /**
   * The event that produced this edge, ALWAYS present. For `cites` it is the
   * CITING decision: a citation is prose inside that event, so that event is
   * what a reader opens to check the claim.
   */
  event_id: string
  ts: string
  /** How many touches this edge aggregates (`touched` only). */
  touches?: number
}

export interface ReachIndex {
  nodes: Map<string, ReachNode>
  /** node id → every edge leaving it; symmetric edges are stored on both ends. */
  edges: Map<string, ReachEdge[]>
  /** slug → edges to everything the initiative holds, for an initiative SEED. */
  contents: Map<string, ReachEdge[]>
  /** slug → decision node ids in ordinal order — the `D<n>` lookup. */
  decisions: Map<string, string[]>
  /** Recorded paths, for path resolution. */
  paths: string[]
  /** Session ids the index knows, for seed resolution. */
  sessions: Set<string>
}

/**
 * Union the per-initiative states into the traversable graph.
 *
 * Initiative nodes are minted but carry NO edges in the adjacency map. An
 * initiative is adjacent to everything inside it, so traversing THROUGH one
 * would put every record two hops from every other and the answer would be "the
 * repo". A hub is a destination, not a corridor: an initiative can be a seed
 * (its `contents` are the hop-1 set) and can be reported as reached, but a path
 * never continues through it. Same hazard 3.3 measured on hub FILES, one level
 * up and structural rather than statistical.
 */
export function reachView(states: Record<string, SlugReachState>): ReachIndex {
  const nodes = new Map<string, ReachNode>()
  const edges = new Map<string, ReachEdge[]>()
  const contents = new Map<string, ReachEdge[]>()
  const decisions = new Map<string, string[]>()
  const paths = new Set<string>()
  const sessions = new Set<string>()

  const link = (from: string, edge: ReachEdge): void => {
    const list = edges.get(from)
    if (list === undefined) edges.set(from, [edge])
    else list.push(edge)
  }
  const sessionNode = (id: string): string => {
    const nodeId = sessionNodeId(id)
    if (!nodes.has(nodeId)) {
      nodes.set(nodeId, { kind: 'session', id: nodeId, initiative: '', label: id, ts: '' })
    }
    sessions.add(id)
    return nodeId
  }

  for (const slug of Object.keys(states).sort()) {
    const state = states[slug]!
    const initiativeId = initiativeNodeId(slug)
    nodes.set(initiativeId, {
      kind: 'initiative',
      id: initiativeId,
      initiative: slug,
      label: slug,
      ts: '',
    })
    const held: ReachEdge[] = []
    /** Sessions this initiative's log has seen, each with its newest citing event. */
    const seen = new Map<string, ReachEdge>()
    const note = (edge: ReachEdge): void => {
      const prior = seen.get(edge.to)
      if (prior === undefined || edge.ts > prior.ts) seen.set(edge.to, edge)
    }

    const ordinals: string[] = []
    state.decisions.forEach((row) => {
      const id = `decision:${row.id}`
      nodes.set(id, {
        kind: 'decision',
        id,
        initiative: slug,
        label: row.chose,
        ts: row.ts,
        ordinal: ordinals.length + 1,
      })
      ordinals.push(id)
      const stamp = { initiative: slug, event_id: row.id, ts: row.ts }
      held.push({ kind: 'decided', to: id, ...stamp })
      if (row.session === 'cli' || row.session.length === 0) return
      const from = sessionNode(row.session)
      link(from, { kind: 'decided', to: id, ...stamp })
      link(id, { kind: 'decided', to: from, ...stamp })
      note({ kind: 'decided', to: from, ...stamp })
    })
    decisions.set(slug, ordinals)

    for (const row of state.notes) {
      const id = `note:${row.id}`
      nodes.set(id, { kind: 'note', id, initiative: slug, label: row.text, ts: row.ts })
      const stamp = { initiative: slug, event_id: row.id, ts: row.ts }
      held.push({ kind: 'noted', to: id, ...stamp })
      if (row.session === 'cli' || row.session.length === 0) continue
      const from = sessionNode(row.session)
      link(from, { kind: 'noted', to: id, ...stamp })
      link(id, { kind: 'noted', to: from, ...stamp })
      note({ kind: 'noted', to: from, ...stamp })
    }

    for (const [path, touchers] of Object.entries(state.files)) {
      const fileId = fileNodeId(path)
      paths.add(path)
      if (!nodes.has(fileId)) {
        nodes.set(fileId, { kind: 'file', id: fileId, initiative: '', label: path, ts: '' })
      }
      let newest: ReachEdge | null = null
      let total = 0
      for (const [sessionId, [eventId, ts, touches]] of Object.entries(touchers)) {
        const from = sessionNode(sessionId)
        const stamp = { initiative: slug, event_id: eventId, ts, touches }
        link(from, { kind: 'touched', to: fileId, ...stamp })
        link(fileId, { kind: 'touched', to: from, ...stamp })
        note({ kind: 'touched', to: from, ...stamp })
        total += touches
        if (newest === null || ts > newest.ts) {
          newest = { kind: 'touched', to: fileId, initiative: slug, event_id: eventId, ts, touches }
        }
      }
      if (newest !== null) held.push({ ...newest, touches: total })
    }

    contents.set(slug, [...held, ...seen.values()])
  }

  linkCitations(states, decisions, nodes, link)
  return { nodes, edges, contents, decisions, paths: [...paths].sort(), sessions }
}

/**
 * Resolve every decision's scanned handles into `cites` / `cited_by` edges.
 *
 * A SECOND pass, because a citation may name any initiative — and bound HERE
 * rather than when the event was indexed, because which slugs exist is a
 * repo-wide fact that changes (citations.ts). Resolution is buildGraph's,
 * literally: `D<n>` is the nth decision of that initiative in replay order, and
 * the target must sort BEFORE the citing decision, since nothing cites the
 * future and a decision does not cite itself.
 *
 * A task handle resolves to no edge because tasks are not nodes here. It is
 * still bound, so `sofar doctor`'s dangling report stays the one place that
 * question is answered, and this one never contradicts it.
 */
function linkCitations(
  states: Record<string, SlugReachState>,
  decisions: ReadonlyMap<string, string[]>,
  nodes: ReadonlyMap<string, ReachNode>,
  link: (from: string, edge: ReachEdge) => void,
): void {
  const slugs = Object.keys(states).sort()
  const canonical = canonicalSlugs(slugs)

  for (const slug of slugs) {
    for (const row of states[slug]!.decisions) {
      const fromId = `decision:${row.id}`
      const linked = new Set<string>()
      for (const [word, handle] of row.cites) {
        const citation = bindHandle({ word, gap: ' ', handle }, slug, canonical)
        if (citation === null || !/^D\d+$/.test(citation.handle)) continue
        const targetId = decisions.get(citation.slug)?.[Number(citation.handle.slice(1)) - 1]
        if (targetId === undefined || linked.has(targetId) || !nodes.has(targetId)) continue
        // Node ids carry the `decision:` prefix; the ORDER test is on the
        // event ids beneath them, which are ulids and therefore comparable.
        if (targetId.slice('decision:'.length) >= row.id) continue
        linked.add(targetId)
        const stamp = { initiative: slug, event_id: row.id, ts: row.ts }
        link(fromId, { kind: 'cites', to: targetId, ...stamp })
        link(targetId, { kind: 'cited_by', to: fromId, ...stamp })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Maintenance.
// ---------------------------------------------------------------------------

/**
 * Bring the reach half up to date and return the traversable view.
 *
 * Cost is O(events appended since the last `find`) per initiative, on this
 * half's OWN cursor — asking a question never advances, or is limited by, the
 * cursors the guard and priming halves keep. An absent, stale or unparseable
 * file is a cold rebuild from the logs (D1): slower, and right.
 */
export function refreshReach(sofarDir: string): ReachIndex {
  const prior = readIndexFile<ReachDisk>(sofarDir, REACH_FILE, isReachDisk)
  const { states, changed } = passOverRecord<SlugReachState>(
    sofarDir,
    REACH_META,
    prior === null ? null : prior.initiatives,
    { empty: emptyReach, clone: cloneReach, apply: (state, event) => applyReach(state, event) },
  )
  if (changed) {
    writeIndexFile(sofarDir, REACH_FILE, { version: INDEX_SCHEMA_VERSION, initiatives: states })
  }
  return reachView(states)
}

/** Read the reach half without refreshing. Null when there is nothing usable on disk. */
export function readReach(sofarDir: string): ReachIndex | null {
  const disk = readIndexFile<ReachDisk>(sofarDir, REACH_FILE, isReachDisk)
  return disk === null ? null : reachView(disk.initiatives)
}

// ---------------------------------------------------------------------------
// Seeds.
// ---------------------------------------------------------------------------

export interface ReachSeed {
  /** The query as asked. */
  query: string
  kind: ReachNodeKind | null
  /** Node ids the query denotes — several for a path recorded under several roots. */
  ids: string[]
}

export interface ResolveSeedOptions {
  /** Initiative a bare `D<n>` is scoped to; without it the handle must be qualified. */
  initiative?: string
}

/**
 * Resolve a query string to seed nodes. Literal, ordered, no search.
 *
 * The order IS the disambiguation rule, most explicit first:
 *   1. a node id — `file:…`, `session:…`, `decision:…`, `note:…`, `initiative:…`
 *   2. a known initiative slug
 *   3. a decision handle — `<slug> D<n>` / `<slug>#D<n>`, or `D<n>` with an initiative
 *   4. a known session id
 *   5. a path, resolved across checkouts (matchRecordedPaths)
 *
 * Nothing here guesses. An unresolvable query comes back with kind null and the
 * caller says so, rather than returning the nearest thing it could find —
 * derived relevance is weak enough (D2) without also being approximate.
 */
export function resolveSeed(
  index: ReachIndex,
  query: string,
  options: ResolveSeedOptions = {},
): ReachSeed {
  const miss: ReachSeed = { query, kind: null, ids: [] }
  const trimmed = query.trim()
  if (trimmed === '') return miss

  const node = index.nodes.get(trimmed)
  if (node !== undefined) return { query, kind: node.kind, ids: [node.id] }
  if (/^(session|decision|note|initiative):/.test(trimmed)) return miss // an id, and it is not here
  if (trimmed.startsWith('file:')) return seedPath(index, query, trimmed.slice('file:'.length))

  const initiativeId = initiativeNodeId(trimmed)
  if (index.nodes.has(initiativeId)) return { query, kind: 'initiative', ids: [initiativeId] }

  const handle = /^(?:([A-Za-z0-9-]+)[ \t#]+)?(D\d+)$/.exec(trimmed)
  if (handle !== null) {
    const slug = (handle[1] ?? options.initiative)?.toLowerCase()
    const id = slug === undefined ? undefined : index.decisions.get(slug)?.[Number(handle[2]!.slice(1)) - 1]
    return id === undefined ? miss : { query, kind: 'decision', ids: [id] }
  }

  if (index.sessions.has(trimmed)) return { query, kind: 'session', ids: [sessionNodeId(trimmed)] }
  return seedPath(index, query, trimmed)
}

function seedPath(index: ReachIndex, query: string, path: string): ReachSeed {
  const matched = matchRecordedPaths(path, index.paths)
  return matched.length === 0
    ? { query, kind: null, ids: [] }
    : { query, kind: 'file', ids: matched.map(fileNodeId) }
}

// ---------------------------------------------------------------------------
// Traversal.
// ---------------------------------------------------------------------------

export interface ReachHit {
  kind: ReachNodeKind
  id: string
  /** Home initiative — '' for files and sessions, which span records. */
  initiative: string
  label: string
  /** Distance from the seed, in edges. */
  hops: number
  /**
   * When the thing itself happened — a decision's own date, a note's — falling
   * back to the edge's date for nodes that have none of their own (a file, a
   * session). NOT the edge date: a decision reached because a later one cited
   * it must show when IT was taken, or the row misdates the record.
   */
  ts: string
  /** The edge that reached it, and the EVENT ID that produced that edge. */
  via: { kind: ReachEdgeKind; from: string; event_id: string; initiative: string; ts: string }
  touches?: number
  /**
   * `D<n>` within its own initiative, for a decision. Carried because it is the
   * handle the record itself cites by — a bare ulid names the event but not the
   * thing a reader would go and look up.
   */
  ordinal?: number
  /**
   * The member an INITIATIVE hit was reached through. An initiative is never
   * traversed to (it has no edges); it is reported because something inside it
   * was, and this names that something so the row cites a real relationship
   * rather than an unexplained slug.
   */
  through?: string
}

export interface ReachGroup {
  kind: ReachNodeKind
  hits: ReachHit[]
  /** Hits past the cap, as a count — never an in-band "+N more" element. */
  omitted: number
}

export interface ReachResult {
  seed: ReachSeed
  hops: number
  groups: ReachGroup[]
  /** Nodes traversed to, before the per-kind caps — how much was found. */
  reached: number
  /** True when VISIT_CAP stopped the expansion: the answer is partial and says so. */
  truncated: boolean
}

/** Group order: what a reader should look at first, not alphabetical. */
const GROUP_ORDER: ReachNodeKind[] = ['initiative', 'decision', 'note', 'file', 'session']

/**
 * Breadth-first from the seed, out to `hops` edges.
 *
 * DERIVED relevance in the D2 sense, and the whole of it: every result says
 * only that the record's own events connect it to the seed, and cites the event
 * that does. A surface may OFFER these as worth reading and must never assert
 * that they bear on the work — nothing here knows what a decision was ABOUT.
 *
 * First arrival wins: a node reached at one hop is never re-labelled by a
 * two-hop path, so `via` is always the shortest route found and the citation is
 * the one a reader can check most directly. Ties at equal distance go to the
 * newer edge, matching the newest-first ordering of every other query surface.
 */
export function reachFrom(
  index: ReachIndex,
  seed: ReachSeed,
  hops: number = REACH_DEFAULT_HOPS,
): ReachResult {
  const budget = Math.max(1, Math.min(REACH_MAX_HOPS, Math.trunc(hops) || REACH_DEFAULT_HOPS))
  const result: ReachResult = { seed, hops: budget, groups: [], reached: 0, truncated: false }
  if (seed.ids.length === 0) return result

  const visited = new Map<string, ReachHit>()
  const isSeed = new Set(seed.ids)
  let frontier = [...seed.ids]
  let visits = 0

  outer: for (let hop = 1; hop <= budget && frontier.length > 0; hop += 1) {
    const next: string[] = []
    for (const from of frontier) {
      for (const edge of edgesOut(index, from, hop === 1)) {
        if (isSeed.has(edge.to)) continue
        const node = index.nodes.get(edge.to)
        if (node === undefined) continue
        visits += 1
        if (visits > VISIT_CAP) {
          result.truncated = true
          break outer
        }
        const via = {
          kind: edge.kind,
          from,
          event_id: edge.event_id,
          initiative: edge.initiative,
          ts: edge.ts,
        }
        const existing = visited.get(edge.to)
        if (existing !== undefined) {
          if (existing.hops === hop && edge.ts > existing.via.ts) {
            existing.via = via
            if (node.ts === '') existing.ts = edge.ts
            if (edge.touches !== undefined) existing.touches = edge.touches
          }
          continue
        }
        const hit: ReachHit = {
          kind: node.kind,
          id: node.id,
          initiative: node.initiative,
          label: node.label,
          hops: hop,
          ts: node.ts !== '' ? node.ts : edge.ts,
          via,
        }
        if (edge.touches !== undefined) hit.touches = edge.touches
        if (node.ordinal !== undefined) hit.ordinal = node.ordinal
        visited.set(edge.to, hit)
        next.push(edge.to)
      }
    }
    frontier = next
  }

  const hits = [...visited.values()]
  result.reached = hits.length
  result.groups = group([...hits, ...initiativeHits(index, hits, isSeed)])
  return result
}

/**
 * Edges leaving a node — with the ONE exception that keeps the answer finite.
 *
 * An initiative node has no adjacency (reachView mints none), so a traversal
 * that reaches one stops there. As a SEED it expands to its contents, which
 * asks "what is in this record" rather than "everything two hops from anything
 * in this record".
 */
function edgesOut(index: ReachIndex, node: string, seedExpansion: boolean): readonly ReachEdge[] {
  if (!node.startsWith('initiative:')) return index.edges.get(node) ?? []
  if (!seedExpansion) return []
  return index.contents.get(node.slice('initiative:'.length)) ?? []
}

/**
 * Initiative hits, synthesized from what was reached rather than traversed to.
 *
 * "Which other records are in reach" is the question an agent actually has, and
 * an initiative node carries no edges to answer it with. So it is answered from
 * the members: an initiative is reached at the distance of its nearest member
 * and cites that member's edge — the same citation, one level up, asserting
 * nothing the member had not already established.
 */
function initiativeHits(
  index: ReachIndex,
  hits: readonly ReachHit[],
  isSeed: ReadonlySet<string>,
): ReachHit[] {
  const best = new Map<string, ReachHit>()
  for (const hit of hits) {
    const slug = hit.initiative !== '' ? hit.initiative : hit.via.initiative
    if (slug === '') continue
    const id = initiativeNodeId(slug)
    if (isSeed.has(id) || !index.nodes.has(id)) continue
    const existing = best.get(id)
    if (
      existing === undefined ||
      hit.hops < existing.hops ||
      (hit.hops === existing.hops && hit.ts > existing.ts)
    ) {
      // touches and ordinal belong to the member, not to the record it is in.
      const { touches, ordinal, ...rest } = hit
      best.set(id, {
        ...rest,
        kind: 'initiative',
        id,
        initiative: slug,
        label: slug,
        through: hit.id,
        // An occurrence member IS an event in this initiative's log, so it is
        // its own citation. Keeping the member's reaching edge here instead
        // would cite an event in ANOTHER record — true of the edge, and no
        // evidence at all that this record holds the member.
        via: { ...hit.via, event_id: eventIdOf(hit.id) ?? hit.via.event_id },
      })
    }
  }
  return [...best.values()]
}

/** The event id inside an occurrence node id (`decision:`/`note:`), else null. */
function eventIdOf(nodeId: string): string | null {
  const match = /^(?:decision|note):(.+)$/.exec(nodeId)
  return match === null ? null : match[1]!
}

/** Group by kind, nearest first then newest, capped per kind with a count. */
function group(hits: readonly ReachHit[]): ReachGroup[] {
  const groups: ReachGroup[] = []
  for (const kind of GROUP_ORDER) {
    const of = hits
      .filter((hit) => hit.kind === kind)
      .sort(
        (a, b) =>
          a.hops - b.hops || (a.ts !== b.ts ? (a.ts < b.ts ? 1 : -1) : a.id.localeCompare(b.id)),
      )
    if (of.length === 0) continue
    groups.push({
      kind,
      hits: of.slice(0, GRAPH_RESULT_CAP),
      omitted: Math.max(0, of.length - GRAPH_RESULT_CAP),
    })
  }
  return groups
}

/** Refresh, resolve, traverse — the whole surface, for one query. */
export function findFrom(
  sofarDir: string,
  query: string,
  options: ResolveSeedOptions & { hops?: number } = {},
): ReachResult {
  const index = refreshReach(sofarDir)
  return reachFrom(index, resolveSeed(index, query, options), options.hops ?? REACH_DEFAULT_HOPS)
}
