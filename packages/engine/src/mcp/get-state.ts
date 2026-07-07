import type { GetStateArgs } from '@sofar/schema/tool-inputs'
import type { InitiativeState } from '../core/fold'
import type { ToolContext } from './context'

/** sofar_get_state — read-only: resolve initiative, fold, return the state. */
export function getState(ctx: ToolContext, args: GetStateArgs): InitiativeState {
  const slug = ctx.resolveInitiative(args.initiative)
  return ctx.foldState(slug)
}
