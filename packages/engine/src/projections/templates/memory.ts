import type { InitiativeState } from '../../core/fold'
import { GENERATED_HEADER, doc, nativeOriginMark } from './shared'

/**
 * memory.md template — facts this initiative promoted toward repo memory,
 * each with the `M<n>` handle repo.md cites it by (repo-memory-capture D1).
 *
 * Generated, unlike its DESTINATION: .sofar/repo.md is hand-written and sofar
 * never writes it (SPEC §Record layout). This file is the staging list — what
 * was promoted — and doctor reports which entries repo.md does not yet name.
 * Written only when something has been promoted, so initiatives that never
 * promote anything carry no empty file (the sessions-dir precedent).
 */
export function renderMemory(state: InitiativeState): string {
  const lines: string[] = [GENERATED_HEADER, '']
  lines.push(`# Promoted to repo memory: ${state.slug || '(unnamed initiative)'}`, '')
  lines.push(
    `Cite these in .sofar/repo.md by qualified handle — \`${state.slug || '<slug>'} M<n>\` —`,
    'which is how `sofar doctor` sees that a promoted fact reached repo memory.',
    '',
  )

  state.memories.forEach((memory, index) => {
    // A retired fact stays listed (history is append-only) but struck, with
    // its successor named, so a reader never carries it into repo.md.
    const body = memory.superseded_by !== undefined ? `~~${memory.text}~~ — superseded by ${memory.superseded_by}` : memory.text
    const replaces = memory.supersedes !== undefined ? ` (supersedes ${memory.supersedes})` : ''
    lines.push(`- **M${index + 1}** (${memory.ts})${replaces} — ${nativeOriginMark(memory.origin)}${body}`)
  })

  return doc(lines)
}
