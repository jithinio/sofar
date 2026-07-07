import type { InitiativeState, SessionState } from '../../core/fold'
import { GENERATED_HEADER, describeActivity, doc } from './shared'

/**
 * sessions/<session-id>.md template (task 3.6, BD3): per-session detail —
 * the status block stays summary-dense, this file carries the full
 * write-back for one session. Since task 7.2 (BD44) it also carries the
 * derived activity (files, commands, task changes), which becomes the
 * resume point when a session never wrote back.
 */
export function renderSession(state: InitiativeState, session: SessionState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Session ${session.id}`, '')
  lines.push(`- Initiative: ${state.slug || '(unnamed initiative)'}`)
  lines.push(`- Tool: ${session.tool}`)
  if (session.model !== undefined) lines.push(`- Model: ${session.model}`)
  lines.push(`- Started: ${session.started}`)
  const closed = session.closed_reason !== undefined ? ` (closed: ${session.closed_reason})` : ''
  lines.push(`- Ended: ${session.ended !== undefined ? `${session.ended}${closed}` : '(in progress)'}`)
  lines.push('')
  lines.push('## Summary', '')
  if (session.summary !== undefined) {
    lines.push(session.summary)
  } else if (session.activity !== undefined) {
    const fate = session.ended !== undefined ? 'ended without write-back' : 'no write-back yet'
    lines.push(`(none recorded — ${fate}; derived resume point below)`)
  } else {
    lines.push('(none recorded — session did not write back)')
  }
  lines.push('')
  lines.push('## Next action', '')
  lines.push(session.next_action ?? '(none recorded)')
  if (session.activity !== undefined) {
    const activity = session.activity
    lines.push('')
    lines.push('## Activity (derived from mechanical events)', '')
    lines.push(`- Derived: ${describeActivity(activity)}`)
    if (activity.files.length > 0) {
      lines.push(`- Files:`)
      for (const file of activity.files) lines.push(`  - ${file}`)
    }
    lines.push(`- Commands run: ${activity.commands}`)
    if (activity.task_changes.length > 0) {
      lines.push(`- Task changes:`)
      for (const change of activity.task_changes) lines.push(`  - ${change}`)
    }
  }
  return doc(lines)
}
