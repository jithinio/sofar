import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
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
 * file — `sofar event session-start` renders it straight to stdout.
 *
 * Every write is ATOMIC (task 6.3, BD38): temp file in the SAME directory,
 * then rename over the target — atomic on POSIX same-fs — so concurrent
 * readers (serve's /state fold, a SessionStart fold, a human tailing
 * plan.md) never observe a half-written projection.
 */

/** Session ids come from outside (Claude Code) — never let one shape a path. */
function sessionFileName(id: string): string {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.md`
}

/**
 * Atomic replace: write a uniquely-named temp file beside the target, then
 * renameSync over it. The temp name carries pid + random bytes so concurrent
 * regenerations never collide; any failure removes the temp file so no
 * *.tmp ever lingers in the record.
 */
function writeFileAtomic(path: string, content: string): void {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function regenerateProjections(initiativeDir: string, state: InitiativeState): void {
  mkdirSync(initiativeDir, { recursive: true })
  writeFileAtomic(join(initiativeDir, 'plan.md'), renderPlan(state))
  writeFileAtomic(join(initiativeDir, 'decisions.md'), renderDecisions(state))

  if (state.sessions.length > 0) {
    const sessionsDir = join(initiativeDir, 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    for (const session of state.sessions) {
      writeFileAtomic(join(sessionsDir, sessionFileName(session.id)), renderSession(state, session))
    }
  }
}
