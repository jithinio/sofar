import { listInitiatives, type InitiativeListing } from '../core/listing'
import { currentBranch } from '../mcp/context'
import { renderNextActions } from '../projections/templates/next'
import { clip } from '../projections/templates/shared'
import { ok, type CmdResult } from './shared'
import {
  columnsOf,
  createStyle,
  pieFor,
  sanitizeProse,
  stdoutCaps,
  symbolsFor,
  wrapPlain,
  type Caps,
} from './ui'

/**
 * `sofar next` (next-command 1.3, SPEC §CLI) — every initiative's next
 * action, most recently active first; an entry whose record moved since
 * its last write-back carries the ⚠ may-be-stale suffix. Where `sofar
 * list` answers "what work exists", next answers "what would each piece
 * of work do next". Same tolerance as list: derivation warnings go to
 * stderr without failing the command.
 *
 * Rendering (cli-ui 2.6, rebalanced 4.1/4.2) is capability-gated like
 * list (2.3). The styled entry is a breathing two-part block — header
 * (pointer on the current-branch entry, pie + bold slug + dim branch tag
 * + dim task fraction) over a hanging-indent word-wrapped action, stale
 * warning on its own line, blank line between entries — so a wrapped
 * action never breaks the gutter. Piped/NO_COLOR output keeps the
 * pre-styling plain bytes; entry set and order stay the derivation's.
 */
export function runNext(
  rootDir: string,
  caps: Caps = stdoutCaps(),
  columns: number = columnsOf(process.stdout),
): CmdResult {
  const listing = listInitiatives(rootDir)
  const stdout = caps.color
    ? renderStyledNext(rootDir, listing, caps, columns)
    : renderNextActions(listing)
  return ok(stdout, listing.warnings.map((w) => `warning: ${w}`).join('\n'))
}

/** Hanging indent for the action body under the entry header. */
const INDENT = '    '

function renderStyledNext(
  rootDir: string,
  listing: InitiativeListing,
  caps: Caps,
  columns: number,
): string {
  const s = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  const bodyWidth = Math.max(20, columns - INDENT.length)
  const lines: string[] = [
    `${s.bold('Sofar next actions')} ${s.dim(`(${listing.entries.length})`)}`,
    '',
  ]
  if (listing.entries.length === 0) {
    lines.push(s.dim('(no initiatives — create one with `sofar new <slug>`)'))
  }
  const branch = currentBranch(rootDir)
  for (const entry of listing.entries) {
    const current = branch !== null && entry.branches.includes(branch)
    const gutter = current ? `${s.accent(sym.pointer)} ` : '  '
    const branches =
      entry.branches.length > 0 ? entry.branches.join(', ') : 'unbound'
    const pie = pieFor(entry.tasks_done, entry.tasks_total, sym)
    const pieCell =
      pie === ''
        ? ''
        : `${
            entry.tasks_total > 0 && entry.tasks_done === entry.tasks_total
              ? s.success(pie)
              : entry.tasks_done > 0
                ? s.warn(pie)
                : s.dim(pie)
          } `
    const fraction =
      entry.tasks_total > 0 ? `  ${s.dim(`${entry.tasks_done}/${entry.tasks_total}`)}` : ''
    lines.push(`${gutter}${pieCell}${s.bold(sanitizeProse(entry.slug))} ${s.dim(`[${branches}]`)}${fraction}`)

    if (entry.next_action != null) {
      const action = sanitizeProse(clip(entry.next_action, Number.MAX_SAFE_INTEGER))
      for (const w of wrapPlain(action, bodyWidth)) lines.push(`${INDENT}${w}`)
    } else {
      lines.push(`${INDENT}${s.dim('(no next action recorded)')}`)
    }

    if (entry.drift_events > 0) {
      lines.push(
        `${INDENT}${s.warn(
          `${sym.warn} may be stale (${entry.drift_events} event${entry.drift_events === 1 ? '' : 's'} since write-back)`,
        )}`,
      )
    }
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
