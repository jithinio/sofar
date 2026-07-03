import type { EndSessionArgs, ToolOkResult } from '@harness/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * harness_end_session — appends session_ended (the write-back). The
 * session_id from args wins over the active session (BD15); if it names the
 * active session, that session's initiative is used (the SPEC signature has
 * no initiative arg) and the active session is cleared after the append.
 */
export function endSession(ctx: ToolContext, args: EndSessionArgs): ToolOkResult {
  const active = ctx.session.get()
  const endsActive = active !== null && active.id === args.session_id
  const slug = endsActive ? active.initiative : ctx.resolveInitiative(undefined)

  const event = ctx.appendAndProject(slug, 'session_ended', {
    session_id: args.session_id,
    summary: args.summary,
    next_action: args.next_action,
  })
  if (endsActive) ctx.session.set(null)
  return { ok: true, event_id: event.id }
}
