import { ulid } from 'ulid'
import type { StartSessionArgs } from '@sofar/schema/tool-inputs'
import { homeInitiative, ToolError, toSource, type ToolContext } from './context'

/**
 * sofar_start_session — adopt-by-id (task 7.1, BD43, replacing BD20's
 * newest-open heuristic, which cross-adopted parallel sessions on one
 * initiative). The SessionStart hook registers Claude Code's session_id in
 * the log AND injects it into the context block ("Session: <id> — …"); the
 * agent passes that id back here as `session_id`:
 *
 *  - session_id names an OPEN session (session_started, not ended/closed) →
 *    adopt exactly it: no duplicate append, set the active box, return it.
 *  - session_id names an ENDED session → typed invalid_input ("session
 *    already ended") — a finished identity is never resumed silently.
 *  - session_id is unknown → append session_started WITH that id as
 *    envelope.session (registers it — MCP-only setups have no hook to do it).
 *  - session_id omitted → mint a fresh ulid and register it. NEVER adopts:
 *    another agent's open session is not ours to take.
 *
 * Either way the session becomes the server process's active session
 * (BD15): subsequent appends carry its id in envelope.session and its tool
 * mapped to envelope.source.
 */
export function startSession(ctx: ToolContext, args: StartSessionArgs): { session_id: string } {
  let slug = ctx.resolveInitiative(args.initiative)

  // Home beats branch when no initiative is named (record-integrity 1.4, D1).
  // Lazy registration (D2) means the PostToolUse hook usually registers a
  // session BEFORE the agent gets here; resolving by branch alone then
  // registered the same id a SECOND time in another log whenever the binding
  // had moved in between — the dominant tear shape in this repo's own record
  // (11 of 14 double-registrations were hook-then-claude-code across two
  // initiatives). An explicit `initiative` still re-homes deliberately.
  if (args.initiative === undefined && args.session_id !== undefined) {
    const home = homeInitiative(ctx.sofarDir, args.session_id, slug)
    if (home !== null) slug = home
  }

  if (args.session_id !== undefined) {
    const existing = ctx.foldState(slug).sessions.find((s) => s.id === args.session_id)
    if (existing !== undefined) {
      if (existing.ended !== undefined) {
        throw new ToolError(
          'invalid_input',
          `session "${args.session_id}" already ended — omit session_id to start a fresh session`,
        )
      }
      ctx.session.set({ id: existing.id, tool: args.tool, initiative: slug })
      return { session_id: existing.id } // adopted — already registered, no append
    }
  }

  const sessionId = args.session_id ?? ulid()
  const payload: Record<string, unknown> = { tool: args.tool }
  if (args.model !== undefined) payload.model = args.model

  ctx.appendAndProject(slug, 'session_started', payload, {
    session: sessionId,
    source: toSource(args.tool),
  })
  ctx.session.set({ id: sessionId, tool: args.tool, initiative: slug })
  return { session_id: sessionId }
}
