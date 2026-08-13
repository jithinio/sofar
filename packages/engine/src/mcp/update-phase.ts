import type { UpdatePhaseArgs, UpdatePhaseResult } from '@sofar/schema/tool-inputs'
import { ToolError, type ToolContext } from './context'

/** Known phase names, budgeted — the dead end doubles as orientation (initiative-list 2.2). */
const MAX_LISTED = 8

/**
 * sofar_update_phase — the phase-level sibling of sofar_update_task, mapping
 * args {phase, status, note?} onto the phase_status_changed payload of the
 * same shape. Resolution pins to the active session's initiative like every
 * other write tool (BD58), so a peer's branch switch on this shared checkout
 * cannot misroute the write.
 *
 * Phase status is written, never derived (D2). The fold could compute "all
 * tasks resolved" for itself; what it cannot compute is whether the person
 * doing the work considers the phase finished, and that difference is exactly
 * what doctor's stale-phase axis and the close audit's phases_unresolved
 * finding exist to report.
 *
 * Two behaviours the fold cannot provide, which is why they live here:
 *
 * 1. UNKNOWN PHASE IS AN ERROR. Phases are addressed by free-text name, and
 *    applyEvent's findOrCreatePhase CREATES one on a miss — the right call for
 *    a fold, which must never lose a logged fact, and the wrong one for a tool,
 *    where a typo would silently mint a phantom phase that then renders in the
 *    plan forever. This repo's own record carries one: harness-build's "Phase
 *    13 - Sync contract", created implicitly at line 204. Validating BEFORE the
 *    append is the only place that distinction can be drawn.
 *
 * 2. IDEMPOTENT. Already at this status appends nothing and returns a null
 *    event_id (the close_initiative precedent), so re-issuing is safe and the
 *    log keeps only transitions that happened. A note-only change on an
 *    unchanged status IS a transition worth recording, so it still appends.
 */
export function updatePhase(ctx: ToolContext, args: UpdatePhaseArgs): UpdatePhaseResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)

  const phase = state.phases.find((p) => p.name === args.phase)
  if (phase === undefined) {
    const names = state.phases.map((p) => `"${p.name}"`)
    const listed = names.slice(0, MAX_LISTED).join(', ')
    const more = names.length > MAX_LISTED ? `, …+${names.length - MAX_LISTED} more` : ''
    throw new ToolError(
      'invalid_input',
      names.length === 0
        ? `initiative "${slug}" has no phases yet — record a plan with sofar_update_plan first`
        : `phase "${args.phase}" not in the plan for "${slug}" — names must match exactly; this plan has ${listed}${more}`,
    )
  }

  const note = args.note !== undefined && args.note.length > 0 ? args.note : undefined
  const unchanged = phase.status === args.status && note === phase.note
  const progress = {
    tasks_done: phase.tasks.filter((t) => t.status === 'done').length,
    tasks_total: phase.tasks.length,
  }
  if (unchanged) return { ok: true, event_id: null, ...progress }

  const payload: Record<string, unknown> = { phase: args.phase, status: args.status }
  if (note !== undefined) payload.note = note

  const event = ctx.appendAndProject(slug, 'phase_status_changed', payload)
  return { ok: true, event_id: event.id, ...progress }
}
