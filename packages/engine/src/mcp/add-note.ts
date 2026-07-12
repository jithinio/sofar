import type { AddNoteArgs, ToolOkResult } from '@sofar/schema/tool-inputs'
import type { ToolContext } from './context'

/**
 * sofar_add_note — appends note_added {text}.
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 */
export function addNote(ctx: ToolContext, args: AddNoteArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const event = ctx.appendAndProject(slug, 'note_added', { text: args.text })
  return { ok: true, event_id: event.id }
}
