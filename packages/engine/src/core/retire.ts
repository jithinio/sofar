import { isResolvedTaskStatus } from '@sofar/schema'
import type { InitiativeState } from './fold'

/**
 * Decision retirement (r1-fixes 3.2, D25) — which decisions have left the
 * digest, derived from the record alone.
 *
 * A record pays for every decision it ever logged, twice: the rule verbatim
 * in Standing constraints and the `over` in the rejected ledger. 2.2 stopped
 * paying for the same bytes twice; nothing until now removed a byte a LATER
 * decision had already declared stale. Two facts the author records do that:
 * `supersedes: "D<n>"` (this replaces that — the fold marks the target
 * `superseded_by`, core/fold.ts) and `until: "<task id>"` (in force until
 * that task resolves). Both resolve from replayed events — a fold at any time
 * yields the same state, which is the ruling's condition for building this at
 * all: a constraint that could vanish between two folds with no event
 * explaining it would be the record silently dropping law.
 *
 * Standing rules never age out: `until` is rejected on a rule by payload
 * validation, and a rule is retired only by a superseder that carries a rule
 * (the fold leaves any other reference inert). Ordinals never renumber — a
 * retired D7 is still D7 in every citation, decisions.md and `sofar find`.
 *
 * `SOFAR_RETIRE=off` is the ablation switch round 3 prices this lever with:
 * read at RENDER time only (the digest, the lessons line), never by the fold,
 * so the folded state and every fold-parity golden are the same bytes on
 * both arms.
 */

/** Env switch: `SOFAR_RETIRE=off` (also `0`, `false`) renders every decision as if none were retired. */
export const RETIRE_ENV = 'SOFAR_RETIRE'

export function retireEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[RETIRE_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/**
 * 1-based ordinals of the decisions no longer in force: superseded by a later
 * decision, or scoped by `until` to a task that has resolved (done or
 * dropped). A task the plan never names never resolves, so its decisions
 * stay. Pure function of the folded state.
 */
export function retiredOrdinals(state: InitiativeState): Set<number> {
  const resolved = new Set<string>()
  for (const phase of state.phases) {
    for (const task of phase.tasks) if (isResolvedTaskStatus(task.status)) resolved.add(task.id)
  }
  const out = new Set<number>()
  state.decisions.forEach((d, i) => {
    if (d.superseded_by !== undefined || (d.until !== undefined && resolved.has(d.until))) out.add(i + 1)
  })
  return out
}
