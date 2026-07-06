import { ulid } from 'ulid'
import type { StartSessionArgs } from '@harness/schema/tool-inputs'
import { toSource, type ToolContext } from './context'

/**
 * harness_start_session — session identity correlation (BD20): the
 * SessionStart hook registers Claude Code's session_id in the log
 * (`harness event session-start` → session_started with envelope.session =
 * that id). start_session ADOPTS the newest open session (session_started
 * without a close) instead of minting a parallel identity, so end_session
 * closes the hook-registered session and the Stop shim sees the write-back
 * by folding the log. A fresh ulid is minted only when no session is open.
 *
 * Either way the session becomes the server process's active session
 * (BD15): subsequent appends carry its id in envelope.session and its tool
 * mapped to envelope.source.
 */
export function startSession(ctx: ToolContext, args: StartSessionArgs): { session_id: string } {
  const slug = ctx.resolveInitiative(args.initiative)

  const sessions = ctx.foldState(slug).sessions
  for (let i = sessions.length - 1; i >= 0; i--) {
    const candidate = sessions[i]!
    if (candidate.ended === undefined) {
      ctx.session.set({ id: candidate.id, tool: args.tool, initiative: slug })
      return { session_id: candidate.id } // adopted — already registered, no append
    }
  }

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
