import type { ToolOkResult, UpdateTaskArgs } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * sofar_update_task — maps args {task_id, status, note?} onto the
 * task_status_changed payload {id, status, note?} (BD18: tool surface says
 * task_id per SPEC §MCP tools; the Phase 1 payload schema says id).
 */
export function updateTask(ctx: ToolContext, args: UpdateTaskArgs): ToolOkResult {
  const slug = ctx.resolveInitiative(args.initiative)
  const payload: Record<string, unknown> = { id: args.task_id, status: args.status }
  if (args.note !== undefined) payload.note = args.note

  const event = ctx.appendAndProject(slug, 'task_status_changed', payload)
  return { ok: true, event_id: event.id }
}
