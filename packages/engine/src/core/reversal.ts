import type { DecisionState, InitiativeState } from './fold'
import { lexicalCounts } from './lexicon'
import { retiredOrdinals } from './retire'

/**
 * Reversal check (r1-fixes 4.1.2, L08, D31) — a decision that inverts a
 * standing one is refused at append time, with no model.
 *
 * Round 1: a Cursor session logged "hard delete over soft delete" three
 * minutes after the previous session logged "soft delete over hard delete",
 * and the standing decision's tests failed from then on. Nothing in the
 * append path looked back.
 *
 * The comparison is over DISTINGUISHING terms: chose minus over, and over
 * minus chose. The word both sides share — `delete` — says what the decision
 * is about, not which way it went, so it never counts. N reverses P when N's
 * chose lands on P's over AND N's over lands on P's chose, each measured as
 * overlap over the smaller set: a one-word `over` ("hard delete") against a
 * four-word `chose` is still the exact inverse.
 *
 * Only label-sized clauses are compared. A chose or over longer than
 * REVERSAL_MAX_TERMS terms is prose — a contract, not a choice between two
 * named options — and shared domain vocabulary there would read as inversion.
 */

/** A clause with more terms than this is prose and is never compared. */
export const REVERSAL_MAX_TERMS = 24
/**
 * Overlap over the smaller distinguishing set, required in BOTH directions, as
 * a fraction [numerator, denominator] so the boundary is exact. Calibrated on
 * round 1's cursor-sofar/r2 reversal: "Hard delete for itinerary items" over
 * "Soft delete + undo", against the standing "App-wide soft delete via
 * deleted_at + deletion_log …" over "Hard deletes or per-entity undo", shares
 * `hard` with 3 distinguishing terms on the smaller side — exactly 1/3. The
 * 1/2 first contracted in D31 missed the very case L08 cites.
 */
export const REVERSAL_MIN_SHARE: readonly [number, number] = [1, 3]

export interface Reversal {
  /** 1-based `D<n>` ordinal of the standing decision the new one inverts. */
  ordinal: number
  decision: DecisionState
}

export interface DecisionDraft {
  chose: string
  over: string
  because: string
  supersedes?: string
}

const terms = (text: string): Set<string> => new Set(Object.keys(lexicalCounts(text)))

function minus(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a].filter((t) => !b.has(t)))
}

/** |a∩b| ÷ min(|a|,|b|) ≥ REVERSAL_MIN_SHARE, in integers. */
function lands(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false
  let common = 0
  for (const t of a) if (b.has(t)) common++
  const [num, den] = REVERSAL_MIN_SHARE
  return common > 0 && common * den >= num * Math.min(a.size, b.size)
}

/** Distinguishing terms of a decision, or null when either clause is prose-sized. Shared with core/decision-judge.ts. */
export function sides(chose: string, over: string): { chose: Set<string>; over: Set<string> } | null {
  const c = terms(chose)
  const o = terms(over)
  if (c.size > REVERSAL_MAX_TERMS || o.size > REVERSAL_MAX_TERMS) return null
  return { chose: minus(c, o), over: minus(o, c) }
}

/** Every standing decision in this record that `draft` inverts, oldest first. */
export function reversedDecisions(state: InitiativeState, draft: DecisionDraft): Reversal[] {
  const next = sides(draft.chose, draft.over)
  if (next === null || next.chose.size === 0 || next.over.size === 0) return []
  const retired = retiredOrdinals(state)
  const out: Reversal[] = []
  state.decisions.forEach((decision, i) => {
    if (retired.has(i + 1)) return
    const prior = sides(decision.chose, decision.over)
    if (prior === null) return
    if (lands(next.chose, prior.over) && lands(next.over, prior.chose)) {
      out.push({ ordinal: i + 1, decision })
    }
  })
  return out
}

/** Why a draft is refused: the typed error's message and one line per reversed decision. */
export interface ReversalRefusal {
  message: string
  errors: string[]
}

/**
 * The refusal for a draft that reverses a standing decision without saying
 * so, or null when it may be logged. A reversal is said by `supersedes:
 * "D<n>"` (it replaces D<n>) or by citing `D<n>` in `because` (a narrower
 * exception while D<n> still stands). The writers throw it as invalid_input
 * before appending — core stays free of the MCP error type.
 */
export function silentReversal(state: InitiativeState, draft: DecisionDraft): ReversalRefusal | null {
  const unsaid = reversedDecisions(state, draft).filter(
    ({ ordinal }) => draft.supersedes !== `D${ordinal}` && !new RegExp(`\\bD${ordinal}\\b`).test(draft.because),
  )
  if (unsaid.length === 0) return null
  const handles = unsaid.map(({ ordinal }) => `D${ordinal}`)
  const first = handles[0]!
  const rule = unsaid.some(({ decision }) => decision.rule !== undefined)
  return {
    message:
      `this decision reverses standing ${handles.join(', ')} — nothing was logged. Follow ${handles.length > 1 ? 'them' : first}; ` +
      `if the operator changed it, log this again with "supersedes":"${first}"${rule ? ' and a "rule" (a rule is replaced only by a rule)' : ''}; ` +
      `for a narrower exception while ${first} still stands, cite ${first} in "because".`,
    errors: unsaid.map(
      ({ ordinal, decision }) =>
        `D${ordinal} (${decision.ts.slice(0, 10)}): chose "${clip(decision.chose)}" over "${clip(decision.over)}"`,
    ),
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}
