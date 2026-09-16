import type { LogDecisionArgs, ToolOkResult } from '@sofar/schema/tool-inputs'
import { silentReversal } from '../core/reversal'
import { ToolError, type ToolContext } from './context'

/**
 * sofar_log_decision — appends decision_logged {chose, over, because, rule?,
 * guard?, supersedes?, until?}. Resolution pins to the active session's initiative (task 12.1,
 * BD58). A malformed guard (or one without a rule) fails payload validation
 * inside appendAndProject and appends nothing — the typed error is the whole
 * feedback loop, since a guard nobody can compile would otherwise sit in the
 * log reading as enforcement.
 */
export function logDecision(ctx: ToolContext, args: LogDecisionArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  // A silent reversal of a standing decision is refused before the append (r1-fixes 4.1.2, D31).
  const refusal = silentReversal(ctx.foldState(slug), args)
  if (refusal !== null) throw new ToolError('invalid_input', refusal.message, refusal.errors)
  const event = ctx.appendAndProject(slug, 'decision_logged', {
    chose: args.chose,
    over: args.over,
    because: args.because,
    // Absent stays absent (drift-hardening D1) — never an empty key.
    ...(args.rule !== undefined ? { rule: args.rule } : {}),
    ...(args.guard !== undefined ? { guard: args.guard } : {}),
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
  })
  return { ok: true, event_id: event.id }
}
