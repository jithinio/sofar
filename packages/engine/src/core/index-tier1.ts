import { parseGuard, type GuardDomain } from '@sofar/schema'
import type { DecisionLoggedPayload, FileTouchedPayload } from '@sofar/schema'
import { GRAPH_RESULT_CAP, matchRecordedPaths } from './adjacency'
import { passOverRecord } from './index-pass'
import { INDEX_SCHEMA_VERSION, readIndexFile, writeIndexFile } from './index-store'
import { type IndexedEvent } from './index-tail'

/**
 * Tier 1: the record graph, materialized and KEYED for lookup (record-index 3.1).
 *
 * buildGraph already answers everything here, and answers it by reading every
 * log in the repo and re-deriving the whole graph — ~16ms on this record and
 * growing with history, which is why core/graph.ts carries a standing law that
 * it never runs on the hot path. That law protected the shims and, in doing
 * so, kept the record's structure out of reach of exactly the surfaces that
 * needed it: the guard that should fire as a file is edited, the priming line
 * at session start, the search an agent runs mid-task.
 *
 * The way out is not a faster graph build but a different shape. Two questions
 * carry the whole of Phase 3, and both are keyed lookups rather than sweeps:
 *
 *   DECLARED relevance — does any decision ANYWHERE guard this path or command?
 *     Guards are globs, so there is no map to hash; what the index removes is
 *     the sweep. Every guarded decision in the repo is materialized into one
 *     small list (this record: 3 of 195 decisions), and a lookup compiles that
 *     list and matches. Cost is O(guards), not O(history).
 *   DERIVED relevance — who else has touched this path, and from which
 *     initiative? Keyed by path, unioned across initiatives, which is the join
 *     no per-initiative fold can make.
 *
 * D2 governs how the two may SPEAK, and the split is preserved here rather
 * than left to callers: a guard is relevance its author declared and may be
 * asserted; adjacency is relevance we inferred and may only be offered. They
 * are separate functions returning separate types for that reason.
 *
 * FAITHFUL, NOT BETTER, like Tier 0 before it. The guard ordinal is the fold's
 * `D<n>` — its position among that initiative's decisions in replay order,
 * counting the ones the fold counts and skipping the ones it skips — and the
 * toucher aggregation mirrors whyFile's, down to the cap and the `omitted`
 * count. An index that answered a slightly better question would be an index
 * whose answers could not be checked against the logs.
 */

/**
 * TWO FILES ON TWO CURSORS, not one (record-index 3.2).
 *
 * 3.1 kept both halves in one file, which was right until a caller wanted only
 * one of them on a hot path. PostToolUse is that caller: it asks the DECLARED
 * question on every edit, and the answer is three decisions — while the DERIVED
 * half is the whole repo's touch history, 88KB on this record and growing with
 * every file anyone has ever edited. Sharing a file meant parsing and rewriting
 * all of it to read three entries: 1.5ms at 30 initiatives, 9.3ms at 300,
 * 31.8ms at 1000, on a path that fires once per edit. That is O(repo) per edit
 * on an initiative whose whole claim is O(new events).
 *
 * Split, the declared half costs what Tier 0 costs, and the derived half is
 * paid for only when a rule actually fires — rare by construction, and worth
 * its cost exactly then, since what it buys is not repeating a warning.
 *
 * The split is the one D2 already draws. Declared and derived are different
 * kinds of claim with different authority; they turn out to have different
 * sizes and different read frequencies too, which is usually what a real
 * boundary looks like.
 */
const GUARDS_FILE = 'guards.json'
const GUARDS_META = 'meta-guards.json'
const FILES_FILE = 'graph.json'
const FILES_META = 'meta-graph.json'

/** A decision that declared which work it governs (rule + guard). */
export interface GuardedDecision {
  /** Envelope id of the decision_logged event — the citation for any claim. */
  id: string
  initiative: string
  /** 1-based position among this initiative's decisions — the `D<n>` handle. */
  ordinal: number
  ts: string
  /** The imperative every future session must obey, quoted verbatim. */
  rule: string
  /** The machine-checkable half: `path:<globs>` or `cmd:<globs>`. */
  guard: string
  chose: string
}

/** One session's touches of one path, as the graph's `touched` edge records it. */
export interface PathToucher {
  /** session node id, matching the graph's identity for it. */
  id: string
  session_id: string
  /** Initiatives this session touched the path FROM, sorted. */
  initiatives: string[]
  /** ts of its most recent touch. */
  ts: string
  touches: number
}

export interface PathTouchers {
  path: string
  /** False when no event in any log ever touched this path. */
  found: boolean
  /** The recorded paths this query resolved to — several after a repo rename. */
  matched_paths: string[]
  sessions: PathToucher[]
  /** Touchers past the cap, as a count — never an in-band "+N more" element. */
  omitted: number
}

interface SlugGuardState {
  /** decision_logged events applied so far — the `D<n>` base. */
  decisions: number
  guards: GuardedDecision[]
}

interface SlugFileState {
  /** path → session id → [most recent ts, touch count]. */
  files: Record<string, Record<string, [string, number]>>
}

interface TierDisk<S> {
  version: number
  initiatives: Record<string, S>
}

export interface Tier1Index {
  guards: GuardedDecision[]
  /**
   * initiative → how many decisions it holds. Already maintained as the `D<n>`
   * base, and independently the answer to "how much reasoning is in that
   * record" — the number that makes an adjacent record worth opening.
   */
  decisions: Record<string, number>
  /** path → session id → { initiatives, ts, touches } — the cross-initiative join. */
  files: Map<string, Map<string, { initiatives: Set<string>; ts: string; touches: number }>>
}

/** The declared half alone — what a hot path asks for. */
export type GuardIndex = Pick<Tier1Index, 'guards' | 'decisions'>
/** The derived half alone. */
export type FileIndex = Pick<Tier1Index, 'files'>

function isTierDisk<S>(v: unknown): v is TierDisk<S> {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

const emptyGuards = (): SlugGuardState => ({ decisions: 0, guards: [] })

function cloneGuards(state: SlugGuardState): SlugGuardState {
  return { decisions: state.decisions, guards: state.guards.map((g) => ({ ...g })) }
}

const emptyFiles = (): SlugFileState => ({ files: {} })

function cloneFiles(state: SlugFileState): SlugFileState {
  const files: Record<string, Record<string, [string, number]>> = {}
  for (const [path, sessions] of Object.entries(state.files)) {
    const copy: Record<string, [string, number]> = {}
    for (const [session, [ts, n]] of Object.entries(sessions)) copy[session] = [ts, n]
    files[path] = copy
  }
  return { files }
}

/** Apply one event to the declared half, mirroring the fold's own bookkeeping. */
function applyGuard(state: SlugGuardState, event: IndexedEvent, slug: string): void {
  if (event.type !== 'decision_logged') return
  const p = event.payload as unknown as DecisionLoggedPayload
  // Counted BEFORE the guard test: `D<n>` is a position among all decisions,
  // and skipping the unguarded ones would renumber the record.
  state.decisions += 1
  if (typeof p.rule !== 'string' || typeof p.guard !== 'string') return
  state.guards.push({
    id: event.id,
    initiative: slug,
    ordinal: state.decisions,
    ts: event.ts,
    rule: p.rule,
    guard: p.guard,
    chose: p.chose,
  })
}

/**
 * Apply one event to the derived half, mirroring the graph's emission rule.
 *
 * `cli` is not a session identity (BD44) and anchors no `touched` edge, so a
 * cli-sourced file_touched contributes nothing here either — otherwise the
 * index would report a toucher whyFile does not.
 */
function applyFile(state: SlugFileState, event: IndexedEvent): void {
  if (event.type !== 'file_touched') return
  if (event.session === 'cli' || event.session.length === 0) return
  const path = (event.payload as unknown as FileTouchedPayload).path
  const sessions = state.files[path] ?? {}
  const existing = sessions[event.session]
  if (existing === undefined) sessions[event.session] = [event.ts, 1]
  else {
    existing[1] += 1
    if (event.ts > existing[0]) existing[0] = event.ts
  }
  state.files[path] = sessions
}

function refreshHalf<S>(
  sofarDir: string,
  file: string,
  metaFile: string,
  reducer: { empty: () => S; clone: (s: S) => S; apply: (s: S, e: IndexedEvent, slug: string) => void },
): Record<string, S> {
  const prior = readIndexFile<TierDisk<S>>(sofarDir, file, isTierDisk)
  const { states, changed } = passOverRecord<S>(
    sofarDir,
    metaFile,
    prior === null ? null : prior.initiatives,
    reducer,
  )
  if (changed) writeIndexFile(sofarDir, file, { version: INDEX_SCHEMA_VERSION, initiatives: states })
  return states
}

/**
 * Bring the DECLARED half up to date — every guarded decision in the repo.
 *
 * The one call PostToolUse makes on every edit, and the reason the halves have
 * separate cursors: this reads and writes a file sized by the number of guarded
 * decisions (3 of 195 on this record), never by the repo's touch history.
 */
export function refreshGuards(sofarDir: string): GuardIndex {
  return declaredView(refreshHalf(sofarDir, GUARDS_FILE, GUARDS_META, {
    empty: emptyGuards,
    clone: cloneGuards,
    apply: applyGuard,
  }))
}

/** Bring the DERIVED half up to date — who has touched what, across the repo. */
export function refreshFiles(sofarDir: string): FileIndex {
  return { files: unionFiles(refreshHalf(sofarDir, FILES_FILE, FILES_META, {
    empty: emptyFiles,
    clone: cloneFiles,
    apply: (state, event) => applyFile(state, event),
  })) }
}

/** Bring both halves up to date and return the repo-wide keyed views. */
export function refreshTier1(sofarDir: string): Tier1Index {
  return { ...refreshGuards(sofarDir), ...refreshFiles(sofarDir) }
}

/** Read Tier 1 without refreshing. Null when there is nothing usable on disk. */
export function readTier1(sofarDir: string): Tier1Index | null {
  const guards = readIndexFile<TierDisk<SlugGuardState>>(sofarDir, GUARDS_FILE, isTierDisk)
  const files = readIndexFile<TierDisk<SlugFileState>>(sofarDir, FILES_FILE, isTierDisk)
  if (guards === null && files === null) return null
  return {
    ...(guards === null ? { guards: [], decisions: {} } : declaredView(guards.initiatives)),
    files: files === null ? new Map() : unionFiles(files.initiatives),
  }
}

/**
 * Union the per-initiative states into the repo-wide view.
 *
 * Per-slug on disk so a rebuild can replace ONE initiative without touching
 * the rest; unioned here because the questions are repo-wide — a path edited
 * under three initiatives is one path with three initiatives against it, which
 * is precisely what a per-initiative fold can never say.
 */
function declaredView(states: Record<string, SlugGuardState>): GuardIndex {
  const guards: GuardedDecision[] = []
  const decisions: Record<string, number> = {}
  for (const slug of Object.keys(states).sort()) {
    guards.push(...(states[slug]?.guards ?? []).map((g) => ({ ...g })))
    decisions[slug] = states[slug]?.decisions ?? 0
  }
  guards.sort((a, b) => (a.initiative === b.initiative ? a.ordinal - b.ordinal : a.initiative.localeCompare(b.initiative)))
  return { guards, decisions }
}

function unionFiles(states: Record<string, SlugFileState>): Tier1Index['files'] {
  const files: Tier1Index['files'] = new Map()
  for (const slug of Object.keys(states).sort()) {
    for (const [path, sessions] of Object.entries(states[slug]?.files ?? {})) {
      const bySession = files.get(path) ?? new Map()
      for (const [session, [ts, touches]] of Object.entries(sessions)) {
        const existing = bySession.get(session)
        if (existing === undefined) {
          bySession.set(session, { initiatives: new Set([slug]), ts, touches })
        } else {
          existing.initiatives.add(slug)
          existing.touches += touches
          if (ts > existing.ts) existing.ts = ts
        }
      }
      files.set(path, bySession)
    }
  }
  return files
}

/**
 * Every decision whose guard claims this subject — the DECLARED tier (D2).
 *
 * The answer a PostToolUse hook needs while the edit is still the current
 * thought, and the reason Phase 3 builds guards before search: this is pushed
 * by the harness and needs no cooperation from the agent. Un-scoped by
 * construction — a guard in ANY initiative's log is tested, which is what the
 * fold's own guard check structurally cannot do, since it folds one log while
 * the work lands in another.
 *
 * A malformed guard compiles to null and simply never matches, exactly as it
 * does in the fold: a guard that cannot be parsed must not become a guard that
 * fires on everything.
 */
export function guardsForSubject(
  index: GuardIndex,
  domain: GuardDomain,
  subject: string,
): GuardedDecision[] {
  const hits: GuardedDecision[] = []
  for (const decision of index.guards) {
    const compiled = parseGuard(decision.guard)
    if (compiled === null || compiled.domain !== domain) continue
    if (guardHits(compiled.patterns, subject)) hits.push(decision)
  }
  return hits
}

/** guardMatches, inlined over the compiled patterns (exemptions win). */
function guardHits(patterns: { negated: boolean; re: RegExp }[], subject: string): boolean {
  let hit = false
  for (const pattern of patterns) {
    if (!pattern.re.test(subject)) continue
    if (pattern.negated) return false
    hit = true
  }
  return hit
}

/**
 * Which recorded paths a query denotes — matchRecordedPaths (core/adjacency),
 * over the index, with the exact hit taken by hash first since the keys are one.
 */
export function resolvePaths(index: FileIndex, path: string): string[] {
  const query = path.replace(/^\.\//, '')
  if (index.files.has(query)) return [query]
  return matchRecordedPaths(query, index.files.keys())
}

/**
 * When one session last touched a path, as the index recorded it — null if it
 * never has.
 *
 * The fold suppresses a repeat warning with a `seen` set over (rule, session,
 * subject), which it can only keep because it replays the whole log: "a file
 * edited thirty times is one violation of one rule, not thirty warnings"
 * (core/fold.ts). A hook fires once per edit and replays nothing, so it needs
 * the same suppression reconstructed from state — and this is that state, since
 * Tier 1 already keys (path, session) → most recent ts for the derived tier.
 *
 * Comparing that ts against a guard's own ts is what makes the suppression
 * exact rather than merely quiet: a rule logged AFTER my last touch has never
 * been reported against this path, so it still fires on the next edit.
 */
export function lastTouch(index: FileIndex, path: string, session: string): string | null {
  let latest: string | null = null
  for (const recorded of resolvePaths(index, path)) {
    const entry = index.files.get(recorded)?.get(session)
    if (entry === undefined) continue
    if (latest === null || entry.ts > latest) latest = entry.ts
  }
  return latest
}

/**
 * Every session that ever touched a path, across ALL initiatives — the DERIVED
 * tier (D2), which may be offered as worth reading and never asserted as a
 * rule.
 *
 * Equivalent to whyFile(graph, path).sessions, down to newest-first ordering,
 * the cap, and reporting overflow as a NUMBER rather than an in-band sentinel.
 */
export function touchersOfPath(index: FileIndex, path: string): PathTouchers {
  const matched = resolvePaths(index, path)
  const result: PathTouchers = {
    path,
    found: matched.length > 0,
    matched_paths: matched,
    sessions: [],
    omitted: 0,
  }
  if (!result.found) return result

  const merged = new Map<string, { initiatives: Set<string>; ts: string; touches: number }>()
  for (const recorded of matched) {
    for (const [session, entry] of index.files.get(recorded) ?? []) {
      const existing = merged.get(session)
      if (existing === undefined) {
        merged.set(session, { initiatives: new Set(entry.initiatives), ts: entry.ts, touches: entry.touches })
      } else {
        for (const slug of entry.initiatives) existing.initiatives.add(slug)
        existing.touches += entry.touches
        if (entry.ts > existing.ts) existing.ts = entry.ts
      }
    }
  }

  const sessions: PathToucher[] = [...merged.entries()].map(([session, entry]) => ({
    id: `session:${session}`,
    session_id: session,
    initiatives: [...entry.initiatives].sort(),
    ts: entry.ts,
    touches: entry.touches,
  }))
  sessions.sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? 1 : -1) : a.id.localeCompare(b.id)))

  if (sessions.length > GRAPH_RESULT_CAP) result.omitted = sessions.length - GRAPH_RESULT_CAP
  result.sessions = sessions.slice(0, GRAPH_RESULT_CAP)
  return result
}

/** One other record that has worked the same ground as this one. */
export interface NeighbourRecord {
  initiative: string
  /** Paths both records have touched — the DIRECT edge, and the ranking. */
  paths: number
  /** Decisions that record holds — how much reasoning opening it would buy. */
  decisions: number
}

/**
 * The records that have worked this one's files, densest first (record-index
 * 3.3) — the whole derivation behind the priming line, in one pass.
 *
 * Two numbers, because one of them alone says nothing worth acting on. Shared
 * paths is the DIRECT edge and the honest ranking: a record that has been in
 * eight of your files is in your way, and one that shares a single hub file is
 * not. Decision count is what makes the pointer worth following — "another
 * record touched this" is a fact about files, while "and it recorded 31
 * decisions doing so" is the reason to open it.
 *
 * Deliberately NOT the two-hop decision join (decision <- session -> file) that
 * whyFile exposes. Measured on this record, that join reports 41 decisions from
 * 14 records for record-index, and the ranking it produces is dominated by hub
 * files every initiative has edited — cli/event.ts alone makes the whole repo
 * adjacent to everything. Counting shared PATHS instead keeps the weight on
 * ground genuinely held in common, and the decision count stays a property of
 * the record rather than a claim about its contents.
 *
 * Everything here is DERIVED relevance under D2: it may be offered as worth
 * reading and never asserted. Nothing in the record says these decisions are
 * ABOUT your files — only that the work happened in the same places.
 */
export function refreshNeighbours(sofarDir: string, slug: string): NeighbourRecord[] {
  const declared = refreshGuards(sofarDir)
  const states = refreshHalf(sofarDir, FILES_FILE, FILES_META, {
    empty: emptyFiles,
    clone: cloneFiles,
    apply: (state: SlugFileState, event: IndexedEvent) => applyFile(state, event),
  })

  const mine = states[slug]
  if (mine === undefined) return []
  const myPaths = new Set(Object.keys(mine.files))
  if (myPaths.size === 0) return []

  const found: NeighbourRecord[] = []
  for (const [initiative, state] of Object.entries(states)) {
    if (initiative === slug) continue
    let paths = 0
    for (const path of Object.keys(state.files)) if (myPaths.has(path)) paths += 1
    if (paths > 0) found.push({ initiative, paths, decisions: declared.decisions[initiative] ?? 0 })
  }
  return rankNeighbours(found)
}

/**
 * The same answer over the unioned view — the reference implementation.
 *
 * refreshNeighbours must never disagree with this, and a test holds the two
 * against each other. It exists separately because the union is what costs:
 * building the repo-wide Map of Maps allocates two objects per path, which at
 * 1000 initiatives is 100,000 allocations to answer one question about one
 * initiative. Intersecting per-slug path sets asks the same question without
 * ever materializing the join.
 */
export function neighbourRecords(
  index: GuardIndex & FileIndex,
  slug: string,
): NeighbourRecord[] {
  const shared = new Map<string, number>()
  for (const sessions of index.files.values()) {
    let mine = false
    const others = new Set<string>()
    for (const entry of sessions.values()) {
      for (const initiative of entry.initiatives) {
        if (initiative === slug) mine = true
        else others.add(initiative)
      }
    }
    if (!mine) continue
    for (const initiative of others) shared.set(initiative, (shared.get(initiative) ?? 0) + 1)
  }

  return rankNeighbours(
    [...shared.entries()].map(([initiative, paths]) => ({
      initiative,
      paths,
      decisions: index.decisions[initiative] ?? 0,
    })),
  )
}

/** Densest overlap first; decisions break ties, then the name, so it is total. */
function rankNeighbours(found: NeighbourRecord[]): NeighbourRecord[] {
  return found.sort(
    (a, b) => b.paths - a.paths || b.decisions - a.decisions || a.initiative.localeCompare(b.initiative),
  )
}

/**
 * Which OTHER initiatives have touched these paths, with how much weight.
 *
 * The shape 3.3's priming line needs — "files this initiative touches carry
 * work from N other initiatives, named" — computed here rather than in the
 * renderer so the count and the names can never disagree.
 */
export function neighbouringInitiatives(
  index: FileIndex,
  paths: readonly string[],
  exclude: string,
): { initiative: string; paths: number }[] {
  const counts = new Map<string, Set<string>>()
  for (const path of paths) {
    for (const recorded of resolvePaths(index, path)) {
      for (const entry of (index.files.get(recorded) ?? new Map()).values()) {
        for (const slug of entry.initiatives) {
          if (slug === exclude) continue
          const seen = counts.get(slug) ?? new Set<string>()
          seen.add(recorded)
          counts.set(slug, seen)
        }
      }
    }
  }
  return [...counts.entries()]
    .map(([initiative, seen]) => ({ initiative, paths: seen.size }))
    .sort((a, b) => b.paths - a.paths || a.initiative.localeCompare(b.initiative))
}
