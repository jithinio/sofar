import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InitiativeState } from '../core/fold'
import { renderPlan } from './templates/plan'
import { renderDecisions } from './templates/decisions'

/**
 * Projection generator — regenerates the derived markdown files from a
 * folded InitiativeState (BD5: events are truth, md files are projections).
 *
 * v0 seam (BD14): every MCP tool append calls this so SPEC §MCP tools
 * ("append event → regenerate projections") holds from Phase 2 on.
 * Phase 3 (task 3.6) extends it with the status block (≤10,000 chars for
 * SessionStart injection) and sessions/<session-id>.md summaries.
 */
export function regenerateProjections(initiativeDir: string, state: InitiativeState): void {
  mkdirSync(initiativeDir, { recursive: true })
  writeFileSync(join(initiativeDir, 'plan.md'), renderPlan(state), 'utf8')
  writeFileSync(join(initiativeDir, 'decisions.md'), renderDecisions(state), 'utf8')
}
