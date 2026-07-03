import type { InitiativeState } from '../../core/fold'
import { GENERATED_HEADER, doc } from './shared'

/**
 * plan.md template — v0 (BD14): minimal but truthful rendering of the folded
 * plan. Phase 3 (task 3.6) extends this (progress %, status block, sessions).
 */
export function renderPlan(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Plan: ${state.slug || '(unnamed initiative)'}`, '')
  lines.push(`Goal: ${state.goal || '(none recorded)'}`, '')

  if (state.phases.length === 0) {
    lines.push('(no plan recorded yet — call harness_update_plan)', '')
  }
  for (const phase of state.phases) {
    lines.push(`## ${phase.name} [${phase.status}]`, '')
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
