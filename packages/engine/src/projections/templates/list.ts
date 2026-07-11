import type { InitiativeListEntry, InitiativeListing } from '../../core/listing'
import { clip, pct } from './shared'

/**
 * Initiative listing renders (initiative-list 2.1/3.1). One line per
 * initiative — slug, bound branch, progress, active phase, next action —
 * most recently active first (the derivation orders; templates only render).
 *
 * Two surfaces, one line shape:
 * - renderInitiativeList — budget-boxed for get_state view:"initiatives"
 *   (count cap + per-line clip), so the context-window cost stays bounded
 *   as initiatives accumulate.
 * - renderFullInitiativeList — `sofar list`, uncapped entry count (the 10k
 *   discipline is a context budget, not a terminal constraint); lines are
 *   still whitespace-collapsed so each initiative stays on one line.
 */

export const MAX_LIST_ENTRIES = 20
const LIST_LINE_BUDGET = 220

export const EMPTY_LISTING = '(no initiatives — create one with `sofar new <slug>`)'

function entryLine(entry: InitiativeListEntry): string {
  const branch = entry.branches.length > 0 ? entry.branches.join(', ') : 'unbound'
  const parts = [
    `${entry.slug} [${branch}]`,
    `${entry.tasks_done}/${entry.tasks_total} tasks (${pct(entry.tasks_done, entry.tasks_total)})`,
  ]
  if (entry.active_phase !== null) parts.push(`active: ${entry.active_phase}`)
  if (entry.next_action !== null) parts.push(`next: ${entry.next_action}`)
  return `- ${parts.join(' — ')}`
}

/** Budgeted listing for the MCP surface (get_state view:"initiatives"). */
export function renderInitiativeList(listing: InitiativeListing): string {
  const lines: string[] = [`# Sofar initiatives (${listing.entries.length})`, '']
  if (listing.entries.length === 0) {
    lines.push(EMPTY_LISTING)
  } else {
    for (const entry of listing.entries.slice(0, MAX_LIST_ENTRIES)) {
      lines.push(clip(entryLine(entry), LIST_LINE_BUDGET))
    }
    if (listing.entries.length > MAX_LIST_ENTRIES) {
      lines.push(`- …and ${listing.entries.length - MAX_LIST_ENTRIES} more (run sofar list)`)
    }
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

/** Uncapped listing for the terminal (`sofar list`). */
export function renderFullInitiativeList(listing: InitiativeListing): string {
  const lines: string[] = [`# Sofar initiatives (${listing.entries.length})`, '']
  if (listing.entries.length === 0) {
    lines.push(EMPTY_LISTING)
  } else {
    for (const entry of listing.entries) {
      // clip() with an unreachable budget = whitespace collapse only.
      lines.push(clip(entryLine(entry), Number.MAX_SAFE_INTEGER))
    }
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}
