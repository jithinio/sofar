import type { GetStateArgs } from '@sofar/schema/tool-inputs'
import type { InitiativeState } from '../core/fold'
import { listAcrossCopies } from '../core/listing'
import { renderInitiativeList } from '../projections/templates/list'
import { renderStatus } from '../projections/templates/status'
import type { ToolContext } from './context'

/**
 * sofar_get_state — read-only orientation (progressive disclosure).
 *
 * Default view "digest" returns the summary-dense status projection (goal,
 * active/next task, next action, recent decisions WITH rationale) as text —
 * the compaction-proof orient (~1k tok), keeping the rationale "muscle"
 * first-class. view:"full" returns the complete folded InitiativeState,
 * re-injectable in full (architecture Open-Q#5). view:"initiatives"
 * (initiative-list 3.1) returns the budgeted portfolio listing and skips
 * initiative resolution entirely — it must work from an unbound branch,
 * which is exactly when a session reaches for it. It folds every copy of
 * the record, like `sofar list` (branch-visibility 3.1): remote-tracking
 * refs stay out (D1's conservative default) and there is no single-copy
 * switch — the one-copy view is the misreport the union exists to replace.
 * No view appends.
 */
export function getState(ctx: ToolContext, args: GetStateArgs): InitiativeState | string {
  if (args.view === 'initiatives') return renderInitiativeList(listAcrossCopies(ctx.rootDir))
  const slug = ctx.resolveInitiative(args.initiative)
  const state = ctx.foldState(slug)
  if (args.view === 'full') return state
  return renderStatus(state)
}
