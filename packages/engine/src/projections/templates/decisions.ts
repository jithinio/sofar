import type { InitiativeState } from '../../core/fold'
import { GENERATED_HEADER, doc } from './shared'

/**
 * decisions.md template — v0 (BD14): one line per logged decision, in log
 * order. Phase 3 (task 3.6) extends this.
 */
export function renderDecisions(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Decisions: ${state.slug || '(unnamed initiative)'}`, '')

  if (state.decisions.length === 0) {
    lines.push('(no decisions logged yet)')
  }
  for (const d of state.decisions) {
    lines.push(`- ${d.ts} — chose **${d.chose}** over ${d.over} because ${d.because}`)
  }

  return doc(lines)
}
