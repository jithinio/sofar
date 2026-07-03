import { ulid } from 'ulid'
import type { StartSessionArgs } from '@harness/schema/tool-inputs'
import { toSource, type ToolContext } from './context'

/**
 * harness_start_session — appends session_started and makes the new session
 * the server process's active session (BD15): subsequent appends carry its
 * id in envelope.session and its tool mapped to envelope.source.
 */
export function startSession(ctx: ToolContext, args: StartSessionArgs): { session_id: string } {
  const slug = ctx.resolveInitiative(args.initiative)
  const sessionId = ulid()
  const payload: Record<string, unknown> = { tool: args.tool }
  if (args.model !== undefined) payload.model = args.model

  ctx.appendAndProject(slug, 'session_started', payload, {
    session: sessionId,
    source: toSource(args.tool),
  })
  ctx.session.set({ id: sessionId, tool: args.tool, initiative: slug })
  return { session_id: sessionId }
}
