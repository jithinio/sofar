import type { InitiativeState } from '../../core/fold'
import { GENERATED_HEADER, doc, phaseFraction, progressText, taskProgress } from './shared'

/**
 * plan.md template (task 3.6, extends the BD14 v0 seam in place): goal,
 * overall progress %, and the full phase tree with statuses and tasks.
 */
export function renderPlan(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Plan: ${state.slug || '(unnamed initiative)'}`, '')
  lines.push(`Goal: ${state.goal || '(none recorded)'}`, '')

  lines.push(`Progress: ${progressText(taskProgress(state.phases))}`, '')

  if (state.phases.length === 0) {
    lines.push('(no plan recorded yet — call sofar_update_plan)', '')
  }
  for (const phase of state.phases) {
    lines.push(`## ${phase.name} [${phase.status}] — ${phaseFraction(taskProgress([phase]))} done`, '')
    for (const task of phase.tasks) {
      // A dropped task is resolved but was never built, so it gets neither
      // the done checkmark nor an empty box that would read as still queued.
      const box = task.status === 'done' ? 'x' : task.status === 'dropped' ? '-' : ' '
      const suffix =
        task.status === 'active' || task.status === 'blocked' || task.status === 'dropped'
          ? ` (${task.status})`
          : ''
      lines.push(`- [${box}] ${task.id} ${task.title}${suffix}`)
    }
    lines.push('')
  }

  if (state.current.active_phase !== null) lines.push(`Active phase: ${state.current.active_phase}`)
  if (state.current.next_action !== null) lines.push(`Next action: ${state.current.next_action}`)
  if (state.current.blocked_on !== undefined) lines.push(`Blocked on: ${state.current.blocked_on}`)

  return doc(lines)
}
