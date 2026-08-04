import type { RememberArgs, ToolOkResult } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * sofar_remember — appends memory_promoted {text}.
 *
 * The capture point the record was missing (repo-memory-capture D1): a fact
 * whose repo-wide scope is known when it is learned, which no citation
 * behaviour could ever surface because nothing derives what was never written
 * down. Resolution pins to the active session's initiative (task 12.1, BD58)
 * like every other write — the promotion is repo-scoped in MEANING, but it is
 * still an event, and events live in the log of the initiative that made them.
 */
export function remember(ctx: ToolContext, args: RememberArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const event = ctx.appendAndProject(slug, 'memory_promoted', { text: args.text })
  return { ok: true, event_id: event.id }
}
