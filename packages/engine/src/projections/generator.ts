import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InitiativeState } from '../core/fold'
import { renderPlan } from './templates/plan'
import { renderDecisions } from './templates/decisions'
import { renderSession } from './templates/session'

/**
 * Projection generator — regenerates the derived markdown files from a
 * folded InitiativeState (BD5: events are truth, md files are projections).
 *
 * Called on every append (BD14 seam, SPEC §MCP tools). Full templates since
 * Phase 3 (task 3.6): plan.md (goal, progress, phase tree), decisions.md,
 * and sessions/<session-id>.md per known session. The status block is not a
 * file — `harness event session-start` renders it straight to stdout.
 */

/** Session ids come from outside (Claude Code) — never let one shape a path. */
function sessionFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`
}

export function regenerateProjections(initiativeDir: string, state: InitiativeState): void {
  mkdirSync(initiativeDir, { recursive: true })
  writeFileSync(join(initiativeDir, 'plan.md'), renderPlan(state), 'utf8')
  writeFileSync(join(initiativeDir, 'decisions.md'), renderDecisions(state), 'utf8')

  if (state.sessions.length > 0) {
    const sessionsDir = join(initiativeDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    for (const session of state.sessions) {
      writeFileSync(join(sessionsDir, sessionFileName(session.id)), renderSession(state, session), 'utf8')
    }
  }
}
