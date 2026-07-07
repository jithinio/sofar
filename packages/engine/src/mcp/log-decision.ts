import type { LogDecisionArgs, ToolOkResult } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/** sofar_log_decision — appends decision_logged {chose, over, because}. */
export function logDecision(ctx: ToolContext, args: LogDecisionArgs): ToolOkResult {
  const slug = ctx.resolveInitiative(args.initiative)
  const event = ctx.appendAndProject(slug, 'decision_logged', {
    chose: args.chose,
    over: args.over,
    because: args.because,
  })
  return { ok: true, event_id: event.id }
}
