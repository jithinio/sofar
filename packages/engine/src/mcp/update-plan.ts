import type { ToolOkResult, UpdatePlanArgs } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * sofar_update_plan — appends plan_updated with the full plan structure
 * (full replace, SPEC §MCP tools). The plan already satisfied the
 * PlanStructure validator during input validation.
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 *
 * PHASE NOTES SURVIVE THE REPLACE (phase-lifecycle 6.1, D8, D9). The plan
 * shape has no slot for a note, and the fold's plan_updated rebuilds every
 * phase without one — so a caller who restated every phase and task still
 * lost the summaries under each heading, with nothing said. The fold stays as
 * it is (changing it would re-mean every historic plan_updated); the tool,
 * which alone sees both plans, restores each note through an ordinary
 * phase_status_changed when the phase keeps its exact name AND its status.
 * A note is the reason for the CURRENT status, so a status change drops it,
 * and so does a rename or a removal — each named in `warnings`.
 */
export function updatePlan(ctx: ToolContext, args: UpdatePlanArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const before = ctx.foldState(slug).phases.filter((p) => p.note !== undefined)
  const event = ctx.appendAndProject(slug, 'plan_updated', { plan: args.plan })

  const warnings: string[] = []
  for (const old of before) {
    const next = args.plan.phases.find((p) => p.name === old.name)
    if (next === undefined) {
      warnings.push(`phase "${old.name}" is not in the new plan (renamed or removed), so its note was dropped: "${clip(old.note!)}". Restate it with sofar_update_phase if it still applies`)
      continue
    }
    const status = next.status ?? 'pending'
    if (status !== old.status) {
      warnings.push(`phase "${old.name}" moved ${old.status} → ${status}, so its note (the reason for ${old.status}) was dropped: "${clip(old.note!)}"`)
      continue
    }
    ctx.appendAndProject(slug, 'phase_status_changed', { phase: old.name, status, note: old.note })
  }
  return warnings.length > 0 ? { ok: true, event_id: event.id, warnings } : { ok: true, event_id: event.id }
}

const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)
