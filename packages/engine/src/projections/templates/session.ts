import type { InitiativeState, SessionState } from '../../core/fold'
import { GENERATED_HEADER, doc } from './shared'

/**
 * sessions/<session-id>.md template (task 3.6, BD3): per-session detail —
 * the status block stays summary-dense, this file carries the full
 * write-back for one session.
 */
export function renderSession(state: InitiativeState, session: SessionState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Session ${session.id}`, '')
  lines.push(`- Initiative: ${state.slug || '(unnamed initiative)'}`)
  lines.push(`- Tool: ${session.tool}`)
  if (session.model !== undefined) lines.push(`- Model: ${session.model}`)
  lines.push(`- Started: ${session.started}`)
  lines.push(`- Ended: ${session.ended ?? '(in progress)'}`)
  lines.push('')
  lines.push('## Summary', '')
  lines.push(session.summary ?? '(none recorded — session did not write back)')
  lines.push('')
  lines.push('## Next action', '')
  lines.push(session.next_action ?? '(none recorded)')
  return doc(lines)
}
