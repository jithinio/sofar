import { listInitiatives } from '../core/listing'
import { renderNextActions } from '../projections/templates/next'
import { ok, type CmdResult } from './shared'

/**
 * `sofar next` (next-command 1.3, SPEC §CLI) — every initiative's next
 * action, one line each, most recently active first; an entry whose record
 * moved since its last write-back carries the ⚠ may-be-stale suffix. Where
 * `sofar list` answers "what work exists", next answers "what would each
 * piece of work do next". Same tolerance as list: derivation warnings go
 * to stderr without failing the command.
 */
export function runNext(rootDir: string): CmdResult {
  const listing = listInitiatives(rootDir)
  return ok(
    renderNextActions(listing),
    listing.warnings.map((w) => `warning: ${w}`).join('\n'),
  )
}
