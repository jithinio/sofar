import type { ReviewArgs, ToolOkResult } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * sofar_review — appends review_recorded (commit-attribution 4.4).
 *
 * Deliberately DECOUPLED from closing (4.5). If passing a review were what let
 * a session go home, the reviewing agent would have an incentive to pass and
 * would find nothing. So this records a verdict and does not gate anything;
 * close reads the verdicts separately and reports what is open.
 *
 * The tool records; it never judges. sofar performs no analysis and makes no
 * model call (SPEC §Architectural invariants) — the reviewing SESSION does the
 * work, from the packet renderReviewPacket hands it, and this is where the
 * conclusion lands so the next review can start where this one stopped.
 */
export function review(ctx: ToolContext, args: ReviewArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const event = ctx.appendAndProject(slug, 'review_recorded', {
    scope: args.scope,
    verdict: args.verdict,
    ...(args.watermark !== undefined ? { watermark: args.watermark } : {}),
    ...(args.phase !== undefined ? { phase: args.phase } : {}),
    ...(args.findings !== undefined ? { findings: args.findings } : {}),
  })
  return { ok: true, event_id: event.id }
}
