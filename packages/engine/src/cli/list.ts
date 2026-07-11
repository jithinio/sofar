import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { emptyState, foldLog, type InitiativeState } from '../core/fold'
import {
  listInitiatives,
  type InitiativeListEntry,
  type InitiativeListing,
} from '../core/listing'
import { currentBranch } from '../mcp/context'
import { renderFullInitiativeList } from '../projections/templates/list'
import { ok, type CmdResult } from './shared'
import {
  columnsOf,
  createStyle,
  padEndVisible,
  renderInitiative,
  stdoutCaps,
  symbolsFor,
  visibleWidth,
  type Caps,
  type Style,
} from './ui'

/**
 * `sofar list` (initiative-list 2.1, SPEC §CLI) — one line per initiative:
 * slug, bound branch, progress, active phase, next action; most recently
 * active first. The portfolio complement to `sofar status`'s single-
 * initiative tree: status answers "where does THIS work stand", list
 * answers "what work exists". Derivation warnings (corrupt bindings, an
 * unreadable log) go to stderr without failing the command — an
 * un-initialized or damaged record still renders what it can.
 *
 * Rendering (cli-ui 2.3) is capability-gated: `caps.color` picks the
 * portfolio-zoom layout grammar (one compact block per initiative, branch
 * tags right-aligned, the current-branch initiative marked with the
 * pointer) — the styled layout is inherently color-coded (D1), so
 * piped/NO_COLOR output keeps the pre-styling plain bytes. Which
 * initiatives appear and their order stay the derivation's — the styled
 * path only changes presentation.
 */

/** Block gutter: pointer + space marks the current-branch initiative. */
const GUTTER = 2

export function runList(
  rootDir: string,
  caps: Caps = stdoutCaps(),
  columns: number = columnsOf(process.stdout),
): CmdResult {
  const listing = listInitiatives(rootDir)
  const stdout = caps.color
    ? renderStyledList(rootDir, listing, caps, columns)
    : renderFullInitiativeList(listing)
  return ok(stdout, listing.warnings.map((w) => `warning: ${w}`).join('\n'))
}

/** Styled listing: header, then one portfolio-zoom block per initiative. */
function renderStyledList(
  rootDir: string,
  listing: InitiativeListing,
  caps: Caps,
  columns: number,
): string {
  const s = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const lines: string[] = [
    `${s.bold('Sofar initiatives')} ${s.dim(`(${listing.entries.length})`)}`,
    '',
  ]
  if (listing.entries.length === 0) {
    lines.push(s.dim('(no initiatives — create one with `sofar new <slug>`)'))
  }
  const branch = currentBranch(rootDir)
  const inner = Math.max(0, columns - GUTTER)
  for (const entry of listing.entries) {
    const block = renderInitiative(stateOf(rootDir, entry), {
      zoom: 'portfolio',
      style: s,
      symbols: sym,
      columns: inner,
    })
    const current = branch !== null && entry.branches.includes(branch)
    const marker = current ? `${s.accent(sym.pointer)} ` : '  '
    lines.push(marker + decorateHead(block[0]!, entry, inner, s))
    for (const line of block.slice(1)) lines.push(`  ${line}`)
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

/**
 * The portfolio block renders from InitiativeState (blocked_on/freshness
 * are not in the listing entry), so the styled path folds the log again.
 * Fold problems already surfaced as listing warnings — here they just thin
 * the block to the entry's empty-state shape, and the directory name stays
 * the listed identity either way.
 */
function stateOf(rootDir: string, entry: InitiativeListEntry): InitiativeState {
  const logPath = join(rootDir, '.sofar', 'initiatives', entry.slug, 'events.jsonl')
  let state = emptyState()
  if (existsSync(logPath)) {
    try {
      state = foldLog(logPath).state
    } catch {
      // warned by listInitiatives — render the entry without detail
    }
  }
  state.slug = entry.slug
  return state
}

/**
 * Branch tag ([main] / [unbound]) right-aligned to the column edge on
 * visible width; dropped when the head leaves it no room — it is
 * decoration, the plain render stays the branch surface of record.
 */
function decorateHead(head: string, entry: InitiativeListEntry, inner: number, s: Style): string {
  const tag = `[${entry.branches.length > 0 ? entry.branches.join(', ') : 'unbound'}]`
  if (visibleWidth(head) + 2 + tag.length > inner) return head
  return padEndVisible(head, inner - tag.length) + s.dim(tag)
}
