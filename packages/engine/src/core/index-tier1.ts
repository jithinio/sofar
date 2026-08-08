import { parseGuard, type GuardDomain } from '@sofar/schema'
import type { DecisionLoggedPayload, FileTouchedPayload } from '@sofar/schema'
import { GRAPH_RESULT_CAP } from './adjacency'
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

const TIER1_FILE = 'graph.json'
const TIER1_META = 'meta-graph.json'

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

interface SlugState {
  /** decision_logged events applied so far — the `D<n>` base. */
  decisions: number
  guards: GuardedDecision[]
  /** path → session id → [most recent ts, touch count]. */
  files: Record<string, Record<string, [string, number]>>
}

interface Tier1Disk {
  version: number
  initiatives: Record<string, SlugState>
}

export interface Tier1Index {
  guards: GuardedDecision[]
  /** path → session id → { initiatives, ts, touches } — the cross-initiative join. */
  files: Map<string, Map<string, { initiatives: Set<string>; ts: string; touches: number }>>
}

function isTier1Disk(v: unknown): v is Tier1Disk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

const empty = (): SlugState => ({ decisions: 0, guards: [], files: {} })

function clone(state: SlugState): SlugState {
  const files: Record<string, Record<string, [string, number]>> = {}
  for (const [path, sessions] of Object.entries(state.files)) {
    const copy: Record<string, [string, number]> = {}
    for (const [session, [ts, n]] of Object.entries(sessions)) copy[session] = [ts, n]
    files[path] = copy
  }
  return { decisions: state.decisions, guards: state.guards.map((g) => ({ ...g })), files }
}

/**
 * Apply one event, mirroring the fold and the graph's own emission rule.
 *
 * `cli` is not a session identity (BD44) and anchors no `touched` edge, so a
 * cli-sourced file_touched contributes nothing here either — otherwise the
 * index would report a toucher whyFile does not.
 */
function apply(state: SlugState, event: IndexedEvent, slug: string): void {
  switch (event.type) {
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      // Counted BEFORE the guard test: `D<n>` is a position among all
      // decisions, and skipping the unguarded ones would renumber the record.
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
      return
    }
    case 'file_touched': {
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
      return
    }
    default:
      return
  }
}

/** Bring Tier 1 up to date and return the repo-wide keyed views. */
export function refreshTier1(sofarDir: string): Tier1Index {
  const prior = readIndexFile<Tier1Disk>(sofarDir, TIER1_FILE, isTier1Disk)
  const { states, changed } = passOverRecord<SlugState>(
    sofarDir,
    TIER1_META,
    prior === null ? null : prior.initiatives,
    { empty, clone, apply },
  )

  const next: Tier1Disk = { version: INDEX_SCHEMA_VERSION, initiatives: states }
  if (changed) writeIndexFile(sofarDir, TIER1_FILE, next)
  return repoWide(next)
}

/** Read Tier 1 without refreshing. Null when there is nothing usable on disk. */
export function readTier1(sofarDir: string): Tier1Index | null {
  const disk = readIndexFile<Tier1Disk>(sofarDir, TIER1_FILE, isTier1Disk)
  return disk === null ? null : repoWide(disk)
}

/**
 * Union the per-initiative states into the repo-wide view.
 *
 * Per-slug on disk so a rebuild can replace ONE initiative without touching
 * the rest; unioned here because the questions are repo-wide — a path edited
 * under three initiatives is one path with three initiatives against it, which
 * is precisely what a per-initiative fold can never say.
 */
function repoWide(disk: Tier1Disk): Tier1Index {
  const guards: GuardedDecision[] = []
  const files: Tier1Index['files'] = new Map()

  for (const slug of Object.keys(disk.initiatives).sort()) {
    const state = disk.initiatives[slug]!
    guards.push(...state.guards.map((g) => ({ ...g })))
    for (const [path, sessions] of Object.entries(state.files)) {
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

  guards.sort((a, b) => (a.initiative === b.initiative ? a.ordinal - b.ordinal : a.initiative.localeCompare(b.initiative)))
  return { guards, files }
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
  index: Tier1Index,
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
 * Which recorded paths a query denotes — resolveFileNodes' rule, over the index.
 *
 * file_touched records the ABSOLUTE path the agent edited, so one logical file
 * accumulates several identities across checkouts and worktrees. An exact hit
 * wins outright; otherwise every recorded path ending at a `/` boundary with
 * the query matches. Literal, no inference, caller controls specificity.
 */
export function resolvePaths(index: Tier1Index, path: string): string[] {
  const query = path.replace(/^\.\//, '')
  if (index.files.has(query)) return [query]
  const suffix = `/${query}`
  const matches: string[] = []
  for (const recorded of index.files.keys()) {
    if (recorded === query || recorded.endsWith(suffix)) matches.push(recorded)
  }
  return matches.sort()
}

/**
 * Every session that ever touched a path, across ALL initiatives — the DERIVED
 * tier (D2), which may be offered as worth reading and never asserted as a
 * rule.
 *
 * Equivalent to whyFile(graph, path).sessions, down to newest-first ordering,
 * the cap, and reporting overflow as a NUMBER rather than an in-band sentinel.
 */
export function touchersOfPath(index: Tier1Index, path: string): PathTouchers {
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

/**
 * Which OTHER initiatives have touched these paths, with how much weight.
 *
 * The shape 3.3's priming line needs — "files this initiative touches carry
 * work from N other initiatives, named" — computed here rather than in the
 * renderer so the count and the names can never disagree.
 */
export function neighbouringInitiatives(
  index: Tier1Index,
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
