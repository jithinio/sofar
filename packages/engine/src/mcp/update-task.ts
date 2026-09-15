import type { UpdateTaskArgs, UpdateTaskResult } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * sofar_update_task — maps args {task_id, status, note?} onto the
 * task_status_changed payload {id, status, note?} (BD18: tool surface says
 * task_id per SPEC §MCP tools; the Phase 1 payload schema says id).
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 *
 * The response is the bare {ok, event_id} on every status (r1-fixes 2.1,
 * D10). Until then `active` echoed every standing constraint back
 * (drift-hardening 4.1, point-of-use resurfacing); round 1 measured that
 * echo as pure repetition — the same [D<n>] lines the session was injected
 * with at SessionStart, ~600 chars per activation — while the point-of-use
 * GUARD (§Hooks) remained the half that actually enforces. The reminder
 * lives in the digest and the read-back; the guard warns at the crossing.
 */
export function updateTask(ctx: ToolContext, args: UpdateTaskArgs): UpdateTaskResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const payload: Record<string, unknown> = { id: args.task_id, status: args.status }
  if (args.note !== undefined) payload.note = args.note
  const event = ctx.appendAndProject(slug, 'task_status_changed', payload)
  return { ok: true, event_id: event.id }
}
