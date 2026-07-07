import type { InitiativeState } from '../../core/fold'
import { GENERATED_HEADER, doc, pct, taskProgress } from './shared'

/**
 * plan.md template (task 3.6, extends the BD14 v0 seam in place): goal,
 * overall progress %, and the full phase tree with statuses and tasks.
 */
export function renderPlan(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Plan: ${state.slug || '(unnamed initiative)'}`, '')
  lines.push(`Goal: ${state.goal || '(none recorded)'}`, '')

  const [done, total] = taskProgress(state.phases)
  lines.push(`Progress: ${done}/${total} tasks done (${pct(done, total)})`, '')

  if (state.phases.length === 0) {
    lines.push('(no plan recorded yet — call sofar_update_plan)', '')
  }
  for (const phase of state.phases) {
    const [phaseDone, phaseTotal] = taskProgress([phase])
    lines.push(`## ${phase.name} [${phase.status}] — ${phaseDone}/${phaseTotal} done`, '')
    for (const task of phase.tasks) {
      const box = task.status === 'done' ? 'x' : ' '
      const suffix = task.status === 'active' || task.status === 'blocked' ? ` (${task.status})` : ''
      lines.push(`- [${box}] ${task.id} ${task.title}${suffix}`)
    }
    lines.push('')
  }

  if (state.current.active_phase !== null) lines.push(`Active phase: ${state.current.active_phase}`)
  if (state.current.next_action !== null) lines.push(`Next action: ${state.current.next_action}`)
  if (state.current.blocked_on !== undefined) lines.push(`Blocked on: ${state.current.blocked_on}`)

  return doc(lines)
}
