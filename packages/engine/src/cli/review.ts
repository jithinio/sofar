import { join } from 'node:path'
import type { Command } from 'commander'
import { bySlug, readAttribution } from '../core/attribution'
import { foldLog, openFindings, reviewWatermark, type PhaseState } from '../core/fold'
import { renderReviewPacket, type ReviewScope } from '../projections/templates/review'
import { createToolContext, ToolError } from '../mcp/context'
import { ok, fail, type CmdResult } from './shared'

/**
 * `sofar review [slug]` — print the evidence packet a reviewing session works
 * from (commit-attribution 4.2/4.3/4.6).
 *
 * The READ half of the review loop; `sofar_review` is the write half. Split
 * deliberately: rendering is cheap and repeatable, recording a verdict is an
 * append, and a session must be able to re-read the packet without producing
 * another event every time it looks.
 *
 * The range is watermark..HEAD (D9), filtered to this initiative's
 * trailer-attributed commits — never derived from task or phase timestamps,
 * which is the time-window guess record-integrity D6 rejected.
 */

export interface ReviewCmdOptions {
  root: string
  slug?: string
  final?: boolean
  phase?: string
}

/** How many commits to consider when no watermark bounds the range. */
const FIRST_REVIEW_WINDOW = 200

export function runReview(opts: ReviewCmdOptions): CmdResult {
  const sofarDir = join(opts.root, '.sofar')
  let slug: string
  try {
    slug = createToolContext(opts.root).resolveInitiative(opts.slug)
  } catch (err) {
    if (err instanceof ToolError) {
      return fail(`sofar review: ${err.message} (usage: sofar review [slug])`)
    }
    throw err
  }

  const { state } = foldLog(join(sofarDir, 'initiatives', slug, 'events.jsonl'))
  const scope: ReviewScope = opts.final === true ? 'final' : 'phase'

  let phase: PhaseState | undefined
  if (scope === 'phase') {
    const wanted = opts.phase ?? state.current.active_phase
    phase = state.phases.find((p) => p.name === wanted)
    if (phase === undefined) {
      return fail(
        wanted == null
          ? 'sofar review: no active phase to review — name one with --phase, or use --final.'
          : `sofar review: no phase named "${wanted}".`,
      )
    }
  }

  const watermark = reviewWatermark(state)
  // A watermark bounds the walk exactly; without one this is the first review,
  // so fall back to a bounded window rather than all of history (D6).
  const attributed = readAttribution(
    opts.root,
    watermark === null ? { maxCount: FIRST_REVIEW_WINDOW } : { range: `${watermark}..HEAD` },
  )
  const commits = attributed === null ? [] : (bySlug(attributed).get(slug) ?? [])

  return ok(
    renderReviewPacket(state, {
      scope,
      commits,
      watermark,
      ...(phase !== undefined ? { phase } : {}),
      ...(scope === 'final' ? { openFindings: openFindings(state) } : {}),
    }),
  )
}

export function registerReviewCommand(
  program: Command,
  rootOf: (opts: { root?: string }) => string,
): void {
  program
    .command('review [slug]')
    .description(
      'print the review evidence packet — the diff range, tasks claimed done, standing constraints and rejected approaches a reviewing session checks the work against. Reviews fire at phase boundaries for initiatives of 3+ phases (D9); --final is the close-time pass, which asks only what a phase review cannot (D10)',
    )
    .option('--final', 'the close-time pass: goal conformance, cross-phase drift, integration, open findings')
    .option('--phase <name>', 'review a specific phase instead of the active one')
    .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
    .action((slug: string | undefined, opts: { final?: boolean; phase?: string; root?: string }) => {
      const result = runReview({
        root: rootOf(opts),
        ...(slug !== undefined ? { slug } : {}),
        ...(opts.final !== undefined ? { final: opts.final } : {}),
        ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
      })
      if (result.stdout.length > 0) process.stdout.write(result.stdout)
      if (result.stderr.length > 0) process.stderr.write(result.stderr)
      process.exitCode = result.exitCode
    })
}
