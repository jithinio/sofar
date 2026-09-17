import type { LogDecisionArgs, LogDecisionResult } from '@sofar/schema/tool-inputs'
import { silentReversal } from '../core/reversal'
import { ruleFidelityWarning } from '../core/rule-fidelity'
import { ToolError, type ToolContext } from './context'

/**
 * sofar_log_decision — appends decision_logged {chose, over, because, rule?,
 * quote?, guard?, supersedes?, until?}. Resolution pins to the active session's initiative (task 12.1,
 * BD58). A malformed guard (or one without a rule) fails payload validation
 * inside appendAndProject and appends nothing — the typed error is the whole
 * feedback loop, since a guard nobody can compile would otherwise sit in the
 * log reading as enforcement.
 */
export function logDecision(ctx: ToolContext, args: LogDecisionArgs): LogDecisionResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)
  // A silent reversal of a standing decision is refused before the append (r1-fixes 4.1.2, D31).
  const refusal = silentReversal(state, args)
  if (refusal !== null) throw new ToolError('invalid_input', refusal.message, refusal.errors)
  const ordinal = state.decisions.length + 1
  const event = ctx.appendAndProject(slug, 'decision_logged', {
    chose: args.chose,
    over: args.over,
    because: args.because,
    // Absent stays absent (drift-hardening D1) — never an empty key.
    ...(args.rule !== undefined ? { rule: args.rule } : {}),
    ...(args.quote !== undefined ? { quote: args.quote } : {}),
    ...(args.guard !== undefined ? { guard: args.guard } : {}),
    ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    ...(args.until !== undefined ? { until: args.until } : {}),
  })
  // What the rule adds to the operator's words (memory-lead 1.2, D2) — after
  // the append, so a warning never reads as a refusal.
  const warning = args.rule !== undefined ? ruleFidelityWarning(ordinal, args.rule, args.quote) : null
  return { ok: true, event_id: event.id, ...(warning !== null ? { warnings: [warning] } : {}) }
}
