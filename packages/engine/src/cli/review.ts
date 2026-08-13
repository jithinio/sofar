import { join } from 'node:path'
import type { Command } from 'commander'
import { bySlug, readAttribution } from '../core/attribution'
import { readGitState } from '../core/git'
import { openFindings, reviewWatermark, type PhaseState } from '../core/fold'
import { renderReviewPacket, type ReviewScope } from '../projections/templates/review'
import { createToolContext, ToolError } from '../mcp/context'
import { emit, ok, fail, type CmdResult } from './shared'

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

/**
 * Ceiling on the watermark..HEAD walk. Every walk is bounded (D6), and this one
 * cannot be unbounded just because a range narrows it — a watermark from long
 * ago is exactly the case where the range is huge. `git log --max-count` keeps
 * the NEWEST n, so hitting the cap drops the OLDEST commits of the phase, which
 * is the loss templates/review.ts refuses to accept from a two-dot range. Hence
 * the cap is generous AND its bite is reported rather than swallowed.
 */
export const REVIEW_MAX_COMMITS = 500

export function runReview(opts: ReviewCmdOptions): CmdResult {
  const ctx = createToolContext(opts.root)
  let slug: string
  try {
    slug = ctx.resolveInitiative(opts.slug)
  } catch (err) {
    if (err instanceof ToolError) {
      return fail(`sofar review: ${err.message} (usage: sofar review [slug])`)
    }
    throw err
  }

  // Through the context, never foldLog directly: a missing or unreadable log is
  // a typed io_error here, and a raw fs throw escapes both this catch and
  // commander's action to print a stack trace at the user.
  let state
  try {
    state = ctx.foldState(slug)
  } catch (err) {
    if (err instanceof ToolError) return fail(`sofar review: ${err.message}`)
    throw err
  }
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
  const maxCount = watermark === null ? FIRST_REVIEW_WINDOW : REVIEW_MAX_COMMITS
  const attributed = readAttribution(
    opts.root,
    watermark === null ? { maxCount } : { range: `${watermark}..HEAD`, maxCount },
  )
  // NULL IS NOT EMPTY, and conflating them is a false accusation. Null means
  // the walk failed — no git, or a range git cannot resolve, which is the
  // ORDINARY state after history is rewritten: a rebase, an amend or a
  // squash-merged PR leaves the recorded watermark unreachable. Rendered as an
  // empty range, the packet tells the reviewer attribution is silently off and
  // sends them to audit a bug that does not exist, while the real cause — a
  // watermark that no longer names a commit — is never mentioned.
  const commits = attributed === null ? [] : (bySlug(attributed).get(slug) ?? [])

  return ok(
    renderReviewPacket(state, {
      scope,
      commits,
      watermark,
      head: readHead(opts.root),
      ...(attributed === null ? { unreadable: true } : {}),
      ...(attributed !== null && attributed.length >= maxCount ? { truncated: maxCount } : {}),
      ...(phase !== undefined ? { phase } : {}),
      ...(scope === 'final' ? { openFindings: openFindings(state) } : {}),
    }),
  )
}

/**
 * The sha a review that reads through HEAD should record as its watermark.
 *
 * The packet demands a watermark and the only shas it could otherwise show are
 * 12-char abbreviations of ATTRIBUTED commits — so every available answer
 * either under-advances the mark (leaving another record's commits inside the
 * next range) or is a prefix that can go ambiguous as history grows, and an
 * ambiguous prefix makes the next range error out, which lands right back in
 * the null-is-not-empty case above.
 */
function readHead(rootDir: string): string | null {
  const git = readGitState(rootDir)
  return git?.headFull ?? null
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
      // emit(), not a hand-rolled copy: it normalises the trailing newline on
      // stderr, and the copy here did not — an error left the shell prompt
      // mid-line.
      emit(
        runReview({
          root: rootOf(opts),
          ...(slug !== undefined ? { slug } : {}),
          ...(opts.final !== undefined ? { final: opts.final } : {}),
          ...(opts.phase !== undefined ? { phase: opts.phase } : {}),
        }),
      )
    })
}
