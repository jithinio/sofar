import type { DecisionState, InitiativeState, PhaseState } from '../../core/fold'
import { doc } from './shared'

/**
 * The review evidence packet (commit-attribution 4.2).
 *
 * What a reviewer is given decides what a review is worth. Handed only the
 * record, a reviewer re-reads the initiative's own prose and agrees with it —
 * the same session's claims, restated. So the packet's job is to supply the two
 * things the record cannot check about itself: the DIFF the work actually
 * produced, and the CONSTRAINTS it was supposed to honour.
 *
 * The constraint half is the part with no substitute. A dedicated code-review
 * tool finds bugs far better than anything here ever will, but it cannot know
 * that D25 capped concentration at 40%, or that hand-writing plan.md was tried
 * and rejected. Only sofar holds those, which is exactly why the review
 * delegates bug-hunting (4.3, D3) and keeps conformance for itself.
 *
 * The delegation is stated HOST-AGNOSTICALLY (D12). sofar runs under any agent
 * — the AGENTS.md dialect exists for exactly that (BD31) — so naming a Claude
 * Code slash command as though every host had it would render an instruction
 * most readers cannot follow. Named skills are offered as a shortcut where they
 * exist; the work itself is spelled out so the packet stands alone.
 *
 * This module renders TEXT ONLY and reaches no further than the folded state
 * plus a caller-supplied commit range — no model call, no analysis, no
 * judgement (SPEC §Architectural invariants).
 */

/** Scope of a single review: one phase, or the whole initiative at close. */
export type ReviewScope = 'phase' | 'final'

export interface ReviewPacketInput {
  /** Which phase is under review; omitted for the close-time final pass. */
  phase?: PhaseState
  scope: ReviewScope
  /**
   * Commits in watermark..HEAD attributed to this initiative, newest first.
   * Empty is a legitimate and important answer — see the note it renders.
   */
  commits: string[]
  /** The sha the previous review ended at; null when this is the first. */
  watermark: string | null
  /** Findings from earlier phase reviews that were never resolved (D10). */
  openFindings?: readonly string[]
}

/**
 * Decisions in force for this review.
 *
 * Standing constraints (those carrying a `rule`) are rendered VERBATIM and
 * never clipped — the render contract they carry everywhere else in sofar
 * (drift-hardening D1). Clipping a constraint in the one document whose job is
 * to check conformance against it would defeat the packet entirely.
 */
function constraintLines(decisions: readonly DecisionState[]): string[] {
  const standing = decisions
    .map((decision, i) => ({ decision, handle: `D${i + 1}` }))
    .filter((entry) => entry.decision.rule !== undefined)
  if (standing.length === 0) return ['- (none)']
  return standing.map((entry) => `- [${entry.handle}] ${entry.decision.rule!}`)
}

/**
 * What was tried and rejected. Re-entering a rejected approach is the single
 * most expensive drift there is — the work looks like progress and is not —
 * and it is invisible to any reviewer working from the diff alone.
 */
function rejectedLines(decisions: readonly DecisionState[]): string[] {
  if (decisions.length === 0) return ['- (none)']
  return decisions.map((decision, i) => `- [D${i + 1}] ${decision.over}`)
}

function taskLines(phase: PhaseState | undefined, state: InitiativeState): string[] {
  const phases = phase === undefined ? state.phases : [phase]
  const lines: string[] = []
  for (const p of phases) {
    for (const task of p.tasks) {
      if (task.status !== 'done') continue
      const files = state.task_files[task.id]
      const where = files === undefined || files.length === 0 ? '' : `  (files: ${files.join(', ')})`
      lines.push(`- [${task.id}] ${task.title}${where}`)
    }
  }
  return lines.length === 0 ? ['- (none claimed done)'] : lines
}

/**
 * The questions. Deliberately different per scope, because that difference is
 * the entire justification for paying for a second pass at close (D10): a final
 * review that asks the phase questions again is a rubber stamp, and re-treading
 * ground trains people to skim.
 */
function questions(scope: ReviewScope): string[] {
  if (scope === 'phase') {
    return [
      '1. CODE QUALITY. If your host has a dedicated code-review capability, use',
      '   it on the diff above and report what survives — in Claude Code that is',
      '   `/code-review` then `/simplify`; other hosts have their own. If it has',
      '   none, do it directly: correctness bugs, unhandled edge cases, error',
      '   paths, resource leaks, and anything a simpler construction would do',
      '   better. Name the file and line for each.',
      '2. CONFORMANCE (no substitute — only this record holds it): does the work',
      '   above honour every standing constraint listed? Quote the constraint and',
      '   the code when it does not.',
      '3. Did it re-enter any rejected approach? That drift looks like progress',
      '   and is not, and it is invisible from the diff alone.',
      '4. Does each task marked done actually do what its title claims?',
      '5. Acceptance criteria: does it meet the repo\'s stated definition of done',
      '   (in this repo, docs/SPEC.md §Acceptance criteria)?',
    ]
  }
  return [
    '1. GOAL CONFORMANCE: does the finished initiative achieve the goal stated',
    '   at the top of this packet? This question has no other home — a phase',
    '   review sees one slice and structurally cannot ask it.',
    '2. CROSS-PHASE DRIFT: did a later phase violate a decision taken in an',
    '   earlier one? Check the standing constraints against the WHOLE range.',
    '3. INTEGRATION: every phase passed on its own. Do they compose?',
    '4. OPEN FINDINGS: what did the phase reviews flag that was never resolved?',
    '',
    'Do NOT re-audit per-phase correctness (D10). The phase reviews already did',
    'that, and repeating them is how a close review becomes a rubber stamp.',
  ]
}

/** Render the packet a reviewing session works from. */
export function renderReviewPacket(state: InitiativeState, input: ReviewPacketInput): string {
  const { phase, scope, commits, watermark } = input
  const title =
    scope === 'final'
      ? `# Final review — ${state.slug}`
      : `# Phase review — ${state.slug} / ${phase?.name ?? '(unnamed phase)'}`

  const range =
    watermark === null
      ? 'from the start of the record — no prior review'
      : `${watermark.slice(0, 12)}..HEAD`

  const diffHint =
    commits.length === 0
      ? [
          '(no attributed commits in range)',
          '',
          'This is a finding in itself, not an empty section. Either the work',
          'landed without the trailer — so attribution is silently off, and',
          '`sofar doctor` will say which — or the phase was completed with no',
          'code change at all. Establish which BEFORE reviewing anything else:',
          'a review of a diff you cannot see is worth nothing.',
        ]
      : [
          `${commits.length} commit(s), newest first:`,
          ...commits.map((sha) => `  ${sha.slice(0, 12)}`),
          '',
          'Read the diff with:',
          // The shas are listed EXPLICITLY rather than as `oldest..newest`. A
          // two-dot range means "reachable from newest but not oldest", which
          // silently EXCLUDES the oldest commit — losing the first commit of
          // every phase from the review. Parent notation (`oldest~1..`) fixes
          // that but breaks on a root commit. An explicit list is always right.
          `  git show ${commits.map((sha) => sha.slice(0, 12)).join(' ')}`,
        ]

  const openFindings = input.openFindings ?? []

  return doc([
    title,
    '',
    `Goal: ${state.goal}`,
    '',
    `## Range under review (${range})`,
    ...diffHint,
    '',
    '## Tasks claimed done',
    ...taskLines(phase, state),
    '',
    '## Standing constraints — the work must obey every one, verbatim',
    ...constraintLines(state.decisions),
    '',
    '## Rejected approaches — re-entering one is drift',
    ...rejectedLines(state.decisions),
    ...(state.guard_violations.length > 0
      ? [
          '',
          '## Guarded rules this record already crossed',
          ...state.guard_violations.map((v) => `- [D${v.decision}] ${v.guard} — ${v.subject}`),
        ]
      : []),
    ...(openFindings.length > 0
      ? ['', '## Findings still open from earlier reviews', ...openFindings.map((f) => `- ${f}`)]
      : []),
    '',
    '## What to do',
    ...questions(scope),
    '',
    'Record the verdict with `sofar_review` (or `sofar event append --type',
    'review_recorded` if your host has no MCP). A review that can only',
    'say "looks good" is a rubber stamp — if nothing is wrong, say so plainly,',
    'but the verdict must be able to be "no".',
  ])
}
