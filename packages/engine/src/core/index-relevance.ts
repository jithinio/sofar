import type { JudgementRecordedPayload } from '@sofar/schema'
import { passOverRecord } from './index-pass'
import { INDEX_SCHEMA_VERSION, readIndexFile, writeIndexFile } from './index-store'
import type { IndexedEvent } from './index-tail'

/**
 * Stored relevance, keyed for lookup (typed-judge 5.1, the D10 contract).
 *
 * A relevance judgement is made at write time (the write-back pass,
 * core/relevance-judge.ts) or server-side, and read where no judge may run:
 * the SessionStart digest (5.3) and memory-lead B1's read-time surfacing,
 * both on hooks (typed-judge D1). This tier is what they read: one row per
 * (about, subject), the latest judgement winning, from judgement_recorded
 * events with question `relevance`. Derived and disposable like every tier
 * (record-index D1).
 *
 * Two laws from D10 live in the reader, not the tier:
 *
 * - RETIRED STAYS RETIRED. The reader never returns a superseded or
 *   until-retired decision, whatever its stored p. It does not re-derive
 *   retirement: that is the fold's supersession logic, and copying it into a
 *   reducer is the drift the index's faithful-not-better law forbids. So the
 *   caller passes the retired handles, from the fold it already holds
 *   (SessionStart) or from its own structure (B1). The parameter is required.
 * - RANK AND ADD, NEVER REMOVE. `rankByRelevance` keeps every deterministic
 *   candidate (guard, derived scope, lexical link) and only orders it, and
 *   adds a candidate the judge found only at p >= RELEVANCE_CARRY. The drop
 *   at p <= relevance_drop can therefore touch only what the judge would have
 *   added.
 */

/**
 * A candidate the judge alone found is added at or above this: THRESHOLDS.
 * relevance_carry (typed-judge 1.2, jev-1.13.0). Restated rather than imported,
 * because hooks read this module and must never reach core/judge.ts (D1's
 * import pin). A test pins the two equal.
 */
export const RELEVANCE_CARRY = 0.8

const RELEVANCE_FILE = 'relevance.json'
const RELEVANCE_META = 'meta-relevance.json'

/** One stored answer, as the tier keeps it. */
export interface RelevanceRow {
  /** Qualified handle, event id or task id: bare `D<n>` is qualified with the writing initiative. */
  subject: string
  /** P(relevant). */
  p: number
  model: string
  /** The judgement_recorded event id: later ids win. */
  id: string
}

interface SlugRelevanceState {
  /** about → subject → row. */
  rows: Record<string, Record<string, RelevanceRow>>
}

interface RelevanceDisk {
  version: number
  initiatives: Record<string, SlugRelevanceState>
}

function isRelevanceDisk(v: unknown): v is RelevanceDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return r.version === INDEX_SCHEMA_VERSION && typeof r.initiatives === 'object' && r.initiatives !== null
}

/** A bare `D12` names the envelope's own initiative (the citation grammar); qualify it so rows are comparable repo-wide. */
export function qualifySubject(subject: string, slug: string): string {
  return /^D\d+$/.test(subject) ? `${slug} ${subject}` : subject
}

function apply(state: SlugRelevanceState, event: IndexedEvent, slug: string): void {
  if (event.type !== 'judgement_recorded') return
  const p = event.payload as unknown as JudgementRecordedPayload
  if (p.question !== 'relevance' || typeof p.about !== 'string' || p.answer?.type !== 'noul') return
  if (typeof p.subject !== 'string' || typeof p.model !== 'string') return
  const subject = qualifySubject(p.subject, slug)
  const rows = state.rows[p.about] ?? {}
  const prior = rows[subject]
  if (prior === undefined || event.id > prior.id) rows[subject] = { subject, p: p.answer.noul, model: p.model, id: event.id }
  state.rows[p.about] = rows
}

const empty = (): SlugRelevanceState => ({ rows: {} })
const clone = (s: SlugRelevanceState): SlugRelevanceState => ({
  rows: Object.fromEntries(Object.entries(s.rows).map(([about, rows]) => [about, { ...rows }])),
})

/** Per-initiative rows: a `task:` row is about a task of the initiative that wrote it. */
export type RelevanceIndex = Record<string, SlugRelevanceState>

/** Bring the tier up to date. Cost is O(events since its own cursor). */
export function refreshRelevance(sofarDir: string): RelevanceIndex {
  const prior = readIndexFile<RelevanceDisk>(sofarDir, RELEVANCE_FILE, isRelevanceDisk)
  const { states, changed } = passOverRecord<SlugRelevanceState>(sofarDir, RELEVANCE_META, prior === null ? null : prior.initiatives, {
    empty,
    clone,
    apply,
  })
  if (changed) writeIndexFile(sofarDir, RELEVANCE_FILE, { version: INDEX_SCHEMA_VERSION, initiatives: states })
  return states
}

/** Read the tier without refreshing; null when nothing usable is on disk. */
export function readRelevance(sofarDir: string): RelevanceIndex | null {
  const disk = readIndexFile<RelevanceDisk>(sofarDir, RELEVANCE_FILE, isRelevanceDisk)
  return disk === null ? null : disk.initiatives
}

/**
 * The stored rows about `about`, strongest first, never a retired subject.
 * `task:` rows belong to one initiative, so `initiative` names it; `file:` rows
 * are repo-wide and every initiative's count. `retired` holds qualified
 * handles (`<slug> D<n>`) and is required: see the header.
 */
export function relevance(
  index: RelevanceIndex,
  query: { about: string; initiative?: string; retired: ReadonlySet<string> },
): RelevanceRow[] {
  const slugs = query.about.startsWith('task:') ? (query.initiative !== undefined ? [query.initiative] : []) : Object.keys(index)
  const best = new Map<string, RelevanceRow>()
  for (const slug of slugs) {
    for (const row of Object.values(index[slug]?.rows[query.about] ?? {})) {
      if (query.retired.has(row.subject)) continue
      const prior = best.get(row.subject)
      if (prior === undefined || row.id > prior.id) best.set(row.subject, row)
    }
  }
  return [...best.values()].sort((a, b) => b.p - a.p || (a.subject < b.subject ? -1 : 1))
}

/**
 * Rank and add (D10). Every deterministic candidate stays, ordered by its
 * stored p, with no row counting as undecided (0.5) and ties keeping the
 * deterministic order. A row naming something that is not a candidate is
 * added only at p >= RELEVANCE_CARRY. Nothing is removed.
 */
export function rankByRelevance(candidates: readonly string[], rows: readonly RelevanceRow[]): string[] {
  const p = new Map(rows.map((r) => [r.subject, r.p]))
  const known = new Set(candidates)
  const added = rows.filter((r) => !known.has(r.subject) && r.p >= RELEVANCE_CARRY).map((r) => r.subject)
  const all = [...candidates, ...added]
  const position = new Map(all.map((s, i) => [s, i]))
  return all.sort((a, b) => (p.get(b) ?? 0.5) - (p.get(a) ?? 0.5) || position.get(a)! - position.get(b)!)
}
