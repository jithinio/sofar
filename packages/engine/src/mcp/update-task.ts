import type { UpdateTaskArgs, UpdateTaskResult } from '@sofar/schema/tool-inputs'
import { standingRules } from '../core/fold'
import type { ToolContext } from './context'

/**
 * sofar_update_task — maps args {task_id, status, note?} onto the
 * task_status_changed payload {id, status, note?} (BD18: tool surface says
 * task_id per SPEC §MCP tools; the Phase 1 payload schema says id).
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 */
export function updateTask(ctx: ToolContext, args: UpdateTaskArgs): UpdateTaskResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const payload: Record<string, unknown> = { id: args.task_id, status: args.status }
  if (args.note !== undefined) payload.note = args.note

  const event = ctx.appendAndProject(slug, 'task_status_changed', payload)

  // Point-of-use resurfacing (drift-hardening 4.1): starting a task is the
  // moment a standing constraint gets obeyed or violated — remind at the
  // decision point, not only at session start where salience has decayed.
  // Uncapped: rules are few and deliberate, and this is a one-off result,
  // not a per-session context budget.
  if (args.status === 'active') {
    const rules = standingRules(ctx.foldState(slug).decisions)
    if (rules.length > 0) {
      return {
        ok: true,
        event_id: event.id,
        standing_constraints: rules.map((r) => `[D${r.ordinal}] ${r.rule}`),
      }
    }
  }
  return { ok: true, event_id: event.id }
}
