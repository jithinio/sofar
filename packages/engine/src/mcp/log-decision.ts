import type { LogDecisionArgs, LogDecisionResult } from '@sofar/schema/tool-inputs'
import { resolveJudgeProvider } from '../client/judge'
import { decisionJudgeWarnings, type DecisionDraft } from '../core/decision-judge'
import { filingWarnings } from '../core/filing-judge'
import type { InitiativeState } from '../core/fold'
import { foreignDecisions } from '../core/index-tier1'
import type { JudgeOptions } from '../core/judge'
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
  return logDecisionLogged(ctx, args).result
}

/**
 * What the MCP server runs: logDecision, then the write-time judges over the
 * state the decision was logged against: re-proposal and contradiction
 * (typed-judge 3.1), then filing (3.3). They run AFTER the append, so their
 * lines can only add to `warnings` and never undo the write. The provider is
 * resolved per call (`judge.provider`, link, login); tests pass `judgeOpts`
 * instead.
 */
export async function logDecisionJudged(
  ctx: ToolContext,
  args: LogDecisionArgs,
  judgeOpts?: JudgeOptions,
): Promise<LogDecisionResult> {
  const { result, before, draft } = logDecisionLogged(ctx, args)
  const opts = judgeOpts ?? judgeOptionsFor(ctx)
  const [decided, filed] = await Promise.all([
    decisionJudgeWarnings(before, [draft], opts),
    filingWarnings([{ kind: 'decision', label: `D${draft.ordinal}`, text: { chose: args.chose, over: args.over, because: args.because } }], opts),
  ])
  const judged = [...decided, ...filed]
  if (judged.length === 0) return result
  return { ...result, warnings: [...(result.warnings ?? []), ...judged] }
}

/** The configured provider for this repo, or deterministic only. Never throws. */
export function judgeOptionsFor(ctx: ToolContext): JudgeOptions {
  const { provider } = resolveJudgeProvider(ctx.rootDir)
  return provider !== undefined ? { provider } : {}
}

function logDecisionLogged(
  ctx: ToolContext,
  args: LogDecisionArgs,
): { result: LogDecisionResult; before: InitiativeState; draft: DecisionDraft } {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const state = ctx.foldState(slug)
  // A silent reversal of a standing decision — in any record (memory-lead
  // 2.2, D8) — is refused before the append (r1-fixes 4.1.2, D31).
  const refusal = silentReversal(state, args, foreignDecisions(ctx.sofarDir, slug))
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
  return {
    result: { ok: true, event_id: event.id, ...(warning !== null ? { warnings: [warning] } : {}) },
    before: state,
    draft: {
      ordinal,
      chose: args.chose,
      over: args.over,
      because: args.because,
      ...(args.rule !== undefined ? { rule: args.rule } : {}),
      ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
    },
  }
}
