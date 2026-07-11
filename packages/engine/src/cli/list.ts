import { listInitiatives } from '../core/listing'
import { renderFullInitiativeList } from '../projections/templates/list'
import { ok, type CmdResult } from './shared'

/**
 * `sofar list` (initiative-list 2.1, SPEC §CLI) — one line per initiative:
 * slug, bound branch, progress, active phase, next action; most recently
 * active first. The portfolio complement to `sofar status`'s single-
 * initiative tree: status answers "where does THIS work stand", list
 * answers "what work exists". Derivation warnings (corrupt bindings, an
 * unreadable log) go to stderr without failing the command — an
 * un-initialized or damaged record still renders what it can.
 */
export function runList(rootDir: string): CmdResult {
  const listing = listInitiatives(rootDir)
  return ok(
    renderFullInitiativeList(listing),
    listing.warnings.map((w) => `warning: ${w}`).join('\n'),
  )
}
