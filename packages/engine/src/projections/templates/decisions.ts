import type { InitiativeState } from '../../core/fold'
import { retiredOrdinals } from '../../core/retire'
import { quoteClause } from '../../core/rule-fidelity'
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
  // Every decision, retired or not (r1-fixes 3.2, D25): this is the surface
  // the digest points at for the full text, so what left the digest is
  // still here, marked with why. Ordinals never renumber.
  const retired = retiredOrdinals(state)
  state.decisions.forEach((d, i) => {
    const ordinal = i + 1
    const marks: string[] = []
    if (d.superseded_by !== undefined) marks.push(`superseded by D${d.superseded_by}`)
    else if (d.until !== undefined) marks.push(retired.has(ordinal) ? `retired: ${d.until} resolved` : `until ${d.until}`)
    if (d.supersedes !== undefined) marks.push(`supersedes ${d.supersedes}`)
    const mark = marks.length > 0 ? `(${marks.join('; ')}) ` : ''
    // Rule leads (drift-hardening 2.2): the standing constraint is what a
    // reader must obey; chose/over/because is why it exists.
    // The operator's words follow the rule they sourced (memory-lead D2).
    const source = d.rule !== undefined && d.quote !== undefined ? `${quoteClause(d.rule, d.quote)} — ` : ''
    const rule = d.rule !== undefined ? `rule: **${d.rule}** — ${source}` : ''
    lines.push(`- ${d.ts} — ${mark}${rule}chose **${d.chose}** over ${d.over} because ${d.because}`)
  })

  return doc(lines)
}
