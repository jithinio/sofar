import type { ToolOkResult, UpdatePlanArgs } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * sofar_update_plan — appends plan_updated with the full plan structure
 * (full replace, SPEC §MCP tools). The plan already satisfied the
 * PlanStructure validator during input validation.
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 */
export function updatePlan(ctx: ToolContext, args: UpdatePlanArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const event = ctx.appendAndProject(slug, 'plan_updated', { plan: args.plan })
  return { ok: true, event_id: event.id }
}
