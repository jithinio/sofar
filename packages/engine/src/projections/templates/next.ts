import type { InitiativeListing } from '../../core/listing'
import { EMPTY_LISTING } from './list'
import { clip, doc } from './shared'

/**
 * Next-actions render (next-command 1.3, SPEC §CLI `sofar next`). The
 * portfolio's answer to "what would each initiative do next": one line per
 * initiative — slug, bound branch(es) or "unbound", the next action the
 * last write-back recorded — in the listing's recency order. An entry whose
 * record moved since that write-back (drift_events > 0) carries the
 * ⚠ may-be-stale suffix: a next action that predates record movement
 * misleads exactly the reader this surface exists for. Terminal surface:
 * uncapped entry count, whitespace-collapsed lines (the sofar-list
 * precedent).
 */
export function renderNextActions(listing: InitiativeListing): string {
  const lines: string[] = [`# Sofar next actions (${listing.entries.length})`, '']
  if (listing.entries.length === 0) {
    lines.push(EMPTY_LISTING)
  } else {
    for (const entry of listing.entries) {
      const branch = entry.branches.length > 0 ? entry.branches.join(', ') : 'unbound'
      const action = entry.next_action ?? '(no next action recorded)'
      const stale =
        entry.drift_events > 0
          ? ` ⚠ may be stale (${entry.drift_events} event${entry.drift_events === 1 ? '' : 's'} since write-back)`
          : ''
      // clip() with an unreachable budget = whitespace collapse only.
      lines.push(clip(`- ${entry.slug} [${branch}] — ${action}${stale}`, Number.MAX_SAFE_INTEGER))
    }
  }
  return doc(lines)
}
