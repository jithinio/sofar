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
    // Rule leads (drift-hardening 2.2): the standing constraint is what a
    // reader must obey; chose/over/because is why it exists.
    const rule = d.rule !== undefined ? `rule: **${d.rule}** — ` : ''
    lines.push(`- ${d.ts} — ${rule}chose **${d.chose}** over ${d.over} because ${d.because}`)
  }

  return doc(lines)
}
