import type { EndSessionArgs, ToolOkResult } from '@sofar/schema/tool-inputs'
import { overlappingWritebacks, type ParallelWriteback } from '../core/fold'
import { homeInitiative, type ToolContext } from './context'

/**
 * The write-back result (writeback-collisions 1.2). `parallel_writebacks` is
 * OMITTED when there is no collision, never `[]`: the field's presence is the
 * signal, and the no-collision case — every session, almost always — stays
 * byte-identical to what this tool returned before, so nothing about the
 * common path shifts. Shape follows the close_initiative precedent, where a
 * write tool already returns more than `{ok, event_id}`.
 */
export interface EndSessionResult extends ToolOkResult {
  /** Overlapping sessions whose next_action differs from the one just written. */
  parallel_writebacks?: ParallelWriteback[]
}

/**
 * Where a write-back for a NON-active session belongs (record-integrity 4.5).
 *
 * Same order the hooks have used since 1.2 (resolveBound in cli/event.ts): the
 * session's own home wins, the branch binding is only the fallback. The branch
 * is passed as the preferred candidate, so the common case — branch and
 * registration agree — settles without scanning the other initiatives.
 *
 * An unbound branch is a miss rather than an error here, exactly as in
 * resolveBound: a session that registered somewhere still resolves through its
 * home. Only when neither answers does the typed unknown_initiative error from
 * resolveInitiative surface.
 */
function resolveWriteBackHome(ctx: ToolContext, sessionId: string): string {
  let branchSlug: string | null = null
  try {
    branchSlug = ctx.resolveInitiative(undefined)
  } catch {
    branchSlug = null // unbound/detached — a home may still answer
  }
  const home = homeInitiative(ctx.sofarDir, sessionId, branchSlug)
  // Route through the explicit path so a home whose directory vanished
  // mid-session still errors typed rather than appending into nothing.
  if (home !== null) return ctx.resolveInitiative(home)
  if (branchSlug !== null) return branchSlug
  return ctx.resolveInitiative(undefined) // re-raise the typed error
}

/**
 * sofar_end_session — appends session_ended (the write-back). The
 * session_id from args wins over the active session (BD15); if it names the
 * active session, that session's initiative is used (the SPEC signature has
 * no initiative arg).
 *
 * The pin SURVIVES the write-back (record-integrity 4.5). Clearing it was the
 * last place in the codebase still assuming a write-back ends the session, and
 * that assumption has already been disproved twice: 0.13.0 taught
 * start_session to adopt an ENDED session, and the parallel-wrap window
 * explicitly handles a session that writes back and keeps working. A pin is a
 * routing key, and a session's home does not stop being its home the moment it
 * summarises.
 *
 * Clearing it misrouted live. Every later write — a second write-back, a
 * decision, a task update — fell through to resolveInitiative(undefined) and
 * followed the BRANCH. A parallel session running `sofar new` rebinds the
 * branch mid-flight, so a write-back landed in a sibling's brand-new
 * initiative while this session's own record showed no wrap-up at all. That is
 * the misroute this whole initiative exists to close, reintroduced through the
 * one path that had opted out of the pin.
 */
export function endSession(ctx: ToolContext, args: EndSessionArgs): EndSessionResult {
  const active = ctx.session.get()
  const endsActive = active !== null && active.id === args.session_id
  const slug = endsActive ? active.initiative : resolveWriteBackHome(ctx, args.session_id)

  const event = ctx.appendAndProject(slug, 'session_ended', {
    session_id: args.session_id,
    summary: args.summary,
    next_action: args.next_action,
  })

  // Tell the WRITER, at write time (writeback-collisions 1.2). The same
  // collision already reaches the next SessionStart, but that is a fresh
  // agent with no context, inheriting two next actions and no way to tell
  // how they relate. Here the caller is still alive and still holds the
  // reasoning behind its own next_action, so it can reconcile — append a
  // note, or write back again with a next action that covers both.
  //
  // Costs one extra fold, on a path that runs once per session and already
  // folds to regenerate projections. A collision reported after the append
  // is the only honest ordering: the log is truth, and until this event is
  // in it there is nothing to compare against.
  const parallel = overlappingWritebacks(ctx.foldState(slug), args.session_id)
  if (parallel.length === 0) return { ok: true, event_id: event.id }
  return { ok: true, event_id: event.id, parallel_writebacks: parallel }
}
