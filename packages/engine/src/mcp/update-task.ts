import type { UpdateTaskArgs, UpdateTaskResult } from '@sofar/schema/tool-inputs'
import { evidenceWarnings } from '../core/filing-judge'
import type { JudgeOptions } from '../core/judge'
import type { ToolContext } from './context'
import { judgeOptionsFor } from './log-decision'

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
  return updateTaskFiled(ctx, args).result
}

/**
 * What the MCP server runs: updateTask, then, for `done` only, the evidence
 * judge (typed-judge 3.3, A5) over the task's title and the note. The result
 * stays bare unless a line renders (typed-judge D7, qualifying r1-fixes D10).
 * A task the plan does not hold is not judged: the fold skips that change.
 */
export async function updateTaskJudged(ctx: ToolContext, args: UpdateTaskArgs, judgeOpts?: JudgeOptions): Promise<UpdateTaskResult> {
  const { result, slug } = updateTaskFiled(ctx, args)
  if (args.status !== 'done') return result
  const task = ctx.foldState(slug).phases.flatMap((p) => p.tasks).find((t) => t.id === args.task_id)
  if (task === undefined) return result
  const lines = await evidenceWarnings([{ id: task.id, title: task.title, note: args.note }], judgeOpts ?? judgeOptionsFor(ctx))
  return lines.length === 0 ? result : { ...result, warnings: lines }
}

function updateTaskFiled(ctx: ToolContext, args: UpdateTaskArgs): { result: UpdateTaskResult; slug: string } {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const payload: Record<string, unknown> = { id: args.task_id, status: args.status }
  if (args.note !== undefined) payload.note = args.note
  const event = ctx.appendAndProject(slug, 'task_status_changed', payload)
  return { result: { ok: true, event_id: event.id }, slug }
}
