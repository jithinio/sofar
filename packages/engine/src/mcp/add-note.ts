import type { AddNoteArgs, ToolOkResult, WarnedOkResult } from '@sofar/schema/tool-inputs'
import { filingWarnings } from '../core/filing-judge'
import type { JudgeOptions } from '../core/judge'
import type { ToolContext } from './context'
import { judgeOptionsFor } from './log-decision'

/**
 * sofar_add_note — appends note_added {text}.
 * Resolution pins to the active session's initiative (task 12.1, BD58).
 */
export function addNote(ctx: ToolContext, args: AddNoteArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const event = ctx.appendAndProject(slug, 'note_added', { text: args.text })
  return { ok: true, event_id: event.id }
}

/**
 * What the MCP server runs: addNote, then the filing judge (typed-judge 3.3,
 * A4) over the text. Bare unless a line renders (typed-judge D7).
 */
export async function addNoteJudged(ctx: ToolContext, args: AddNoteArgs, judgeOpts?: JudgeOptions): Promise<WarnedOkResult> {
  const result = addNote(ctx, args)
  const lines = await filingWarnings([{ kind: 'note', label: 'This note', text: args.text }], judgeOpts ?? judgeOptionsFor(ctx))
  return lines.length === 0 ? result : { ...result, warnings: lines }
}
