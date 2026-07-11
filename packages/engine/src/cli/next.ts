import { listInitiatives, type InitiativeListing } from '../core/listing'
import { currentBranch } from '../mcp/context'
import { renderNextActions } from '../projections/templates/next'
import { clip } from '../projections/templates/shared'
import { ok, type CmdResult } from './shared'
import { createStyle, sanitizeProse, stdoutCaps, symbolsFor, type Caps } from './ui'

/**
 * `sofar next` (next-command 1.3, SPEC §CLI) — every initiative's next
 * action, one line each, most recently active first; an entry whose record
 * moved since its last write-back carries the ⚠ may-be-stale suffix. Where
 * `sofar list` answers "what work exists", next answers "what would each
 * piece of work do next". Same tolerance as list: derivation warnings go
 * to stderr without failing the command.
 *
 * Rendering (cli-ui 2.6) is capability-gated like list (2.3): the styled
 * path keeps next's one-line-per-initiative identity — bold slug, dim
 * branch tag, warn-colored stale suffix, accent pointer on the
 * current-branch entry — while piped/NO_COLOR output keeps the
 * pre-styling plain bytes. Entry set and order stay the derivation's.
 */
export function runNext(rootDir: string, caps: Caps = stdoutCaps()): CmdResult {
  const listing = listInitiatives(rootDir)
  const stdout = caps.color
    ? renderStyledNext(rootDir, listing, caps)
    : renderNextActions(listing)
  return ok(stdout, listing.warnings.map((w) => `warning: ${w}`).join('\n'))
}

function renderStyledNext(
  rootDir: string,
  listing: InitiativeListing,
  caps: Caps,
): string {
  const s = createStyle(true)
  const sym = symbolsFor(caps.unicode)
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
    // clip at an unreachable budget = whitespace collapse (the plain
    // path's rule), then the styled-layout sanitize law for record prose.
    const action =
      entry.next_action != null
        ? sanitizeProse(clip(entry.next_action, Number.MAX_SAFE_INTEGER))
        : undefined
    const stale =
      entry.drift_events > 0
        ? ` ${s.warn(
            `${sym.warn} may be stale (${entry.drift_events} event${entry.drift_events === 1 ? '' : 's'} since write-back)`,
          )}`
        : ''
    lines.push(
      `${gutter}${s.bold(sanitizeProse(entry.slug))} ${s.dim(`[${branches}]`)} ${s.dim('—')} ${
        action ?? s.dim('(no next action recorded)')
      }${stale}`,
    )
  }
  return `${lines.join('\n')}\n`
}
