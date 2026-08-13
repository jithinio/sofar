import { isClosedInitiativeStatus, type InitiativeStatus } from '@sofar/schema'
import type { CloseInitiativeArgs } from '@sofar/schema/tool-inputs'
import { unbindAll } from '../core/bindings'
import { closeoutFindings } from '../core/closeout'
import { ToolError, type ToolContext } from './context'

export interface CloseInitiativeResult {
  ok: true
  /** null when it was already at this status — idempotent, no second event. */
  event_id: string | null
  /** Branches taken off the record, sorted; [] when none was bound. */
  unbound: string[]
  /**
   * What the close-time audit found still outstanding (5.1), recorded ON the
   * event because the close went ahead anyway (5.2). Returned as well as
   * recorded: the closing agent is the one party who can still act on it, and
   * a finding it never sees is a finding aimed at nobody.
   */
  overrides: string[]
}

/**
 * The two-step close, shared by the MCP tool and `sofar close` so they can
 * never drift on what closing means.
 *
 * Order is load-bearing: append FIRST, unbind second. The log is truth, so a
 * crash between the steps leaves a record correctly marked closed with a
 * stale binding — which `sofar doctor` reports and re-running close repairs.
 * The reverse order would leave branches silently unbound from a record that
 * never closed: invisible, and repetition would not fix it.
 *
 * Idempotent: already at this status appends nothing and still unbinds, so
 * re-running is the repair for a stale binding, never a second event.
 */
export function applyClose(
  ctx: ToolContext,
  slug: string,
  status: InitiativeStatus,
  note?: string,
): { event_id: string | null; unbound: string[]; overrides: string[] } {
  if (!isClosedInitiativeStatus(status)) {
    throw new ToolError('invalid_input', 'status: must be one of done|dropped')
  }
  let eventId: string | null = null
  let overrides: string[] = []
  const state = ctx.foldState(slug)
  if (state.status !== status) {
    // Audited against the state BEFORE the close event, which is the only
    // state in which the question means anything (5.1).
    overrides = closeoutFindings(state, status).map((finding) => finding.text)
    const payload: Record<string, unknown> = { status }
    if (note !== undefined && note.length > 0) payload.note = note
    if (overrides.length > 0) payload.overrides = overrides
    eventId = ctx.appendAndProject(slug, 'initiative_status_changed', payload).id
  }
  return { event_id: eventId, unbound: unbindAll(ctx.bindingsPath, slug), overrides }
}

/**
 * sofar_close_initiative — resolution pins to the ACTIVE session's initiative
 * like every other write tool: an agent closing "the initiative I am working
 * in" must not have that mean "whatever the branch happens to say" mid-session.
 */
export function closeInitiative(
  ctx: ToolContext,
  args: CloseInitiativeArgs,
): CloseInitiativeResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const { event_id, unbound, overrides } = applyClose(ctx, slug, args.status, args.note)
  return { ok: true, event_id, unbound, overrides }
}
