import type { RecordCopy, RecordProvenance } from '../../core/record-copies'
import { progressText } from './shared'

/**
 * Where a record's events live (branch-visibility D1): the lines `sofar
 * status` and `sofar list` add when other copies of the record hold events
 * this checkout lacks. Never rendered otherwise, so a record with no such
 * copy prints byte-identically to before.
 *
 * The union number is the headline and these lines say what it is made of:
 * what this checkout alone holds, and which branches carry the rest. Work done
 * on a branch has not reached this one, and an abandoned branch must not read
 * as landed work.
 */

/** How many contributing copies a one-line summary names before "+N more". */
const SUMMARY_NAMES = 2

function tildify(path: string, home: string | undefined): string {
  if (home === undefined || home.length === 0) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function copyName(copy: RecordCopy): string {
  return copy.ref ?? 'detached'
}

/** `r1-fixes (worktree ~/IO/sofar-r1-fixes)`, `peer-messaging (branch)`, `origin/x (remote)`. */
export function copyLabel(copy: RecordCopy, home?: string): string {
  if (copy.kind === 'worktree') return `${copyName(copy)} (worktree ${tildify(copy.path ?? '?', home)})`
  return `${copyName(copy)} (${copy.kind})`
}

/** `here (main): 0/18 tasks done`, or `here (main): not on this checkout`. */
export function hereText(p: RecordProvenance): string {
  const where = `here (${p.branch ?? 'this checkout'})`
  if (!p.exists) return `${where}: not on this checkout`
  return `${where}: ${progressText({ ...p, remaining: p.total - p.done - p.dropped })}`
}

/** The `sofar status` block: a heading, this checkout's own figure, then one line per copy. */
export function renderProvenanceBlock(p: RecordProvenance, home?: string): string[] {
  const lines = [
    `Across branches: progress above folds every copy of this record (sofar status --here: this checkout alone)`,
    `  ${hereText(p)} — ${p.unseen} event(s) not on this checkout`,
  ]
  for (const c of p.copies) lines.push(`  ${copyLabel(c.copy, home)}: +${c.unseen}`)
  return lines
}

/** The `sofar list` part: `across branches: here 0/18 tasks done, +1875 on r1-fixes, agents-parity, +2 more`. */
export function provenanceSummary(p: RecordProvenance): string {
  const here = p.exists ? `here ${p.done}/${p.total} tasks done` : 'not on this checkout'
  const named = p.copies.slice(0, SUMMARY_NAMES).map((c) => copyName(c.copy))
  const more = p.copies.length > SUMMARY_NAMES ? `, +${p.copies.length - SUMMARY_NAMES} more` : ''
  return `across branches: ${here}, +${p.unseen} event(s) on ${named.join(', ')}${more}`
}
