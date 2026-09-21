import type { InitiativeListEntry, InitiativeListing } from '../../core/listing'
import { isClosedInitiativeStatus } from '@sofar/schema'
import { provenanceSummary } from './copies'
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
  const closed = isClosedInitiativeStatus(entry.status)
  // A closed record's branch tag would read `[unbound]`, which says the wrong
  // thing: it is not waiting to be bound, it is finished. The status replaces
  // the tag rather than joining it (initiative-lifecycle 4.2).
  const tag = closed
    ? entry.status
    : entry.branches.length > 0
      ? entry.branches.join(', ')
      : 'unbound'
  const parts = [
    `${entry.slug} [${tag}]`,
    `${entry.tasks_done}/${entry.tasks_total} tasks (${pct(entry.tasks_done, entry.tasks_total)})`,
  ]
  // Only on a union listing, and only when another copy adds events: the
  // figure above then folds every branch, and this says what it is made of.
  if (entry.elsewhere !== undefined) parts.push(provenanceSummary(entry.elsewhere))
  if (entry.active_phase !== null && !closed) parts.push(`active: ${entry.active_phase}`)
  // What this record took over, named on the live side too: the successor is
  // where a reader lands, and the predecessors are where its history is.
  if (entry.supersedes.length > 0) parts.push(`supersedes: ${entry.supersedes.join(', ')}`)
  // A closed record has no next action; its reason is what a reader wants —
  // and for a superseded one, where the work went.
  if (closed) {
    if (entry.successor !== null) parts.push(`continues in: ${entry.successor}`)
    if (entry.status_note !== null) parts.push(`why: ${entry.status_note}`)
  } else if (entry.next_action !== null) {
    parts.push(`next: ${entry.next_action}`)
  }
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
