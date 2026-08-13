import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Command } from 'commander'
import { TRAILER_KEY } from '../core/attribution'
import { currentBranch } from '../core/git'
import { homeInitiative } from '../mcp/context'
import { readBindingsFile } from '../core/bindings'

/**
 * `sofar commit-trailer <msgfile>` — the prepare-commit-msg worker (D5).
 *
 * Stamps `Sofar-Initiative: <slug>` onto a commit message so the commit →
 * initiative binding lives in git rather than in the record (D4). That is what
 * lets a later session ask which of ITS commits reached origin, without sofar
 * ever logging a git command — record-hygiene D1 exempts git precisely because
 * logging it makes the record un-settleable.
 *
 * Resolution is session-first and session-ONLY. CLAUDE_CODE_SESSION_ID is
 * inherited by git hooks (verified), and homeInitiative maps it to the log that
 * actually registered it. The branch binding is passed only as `preferred`,
 * where it can seed and break ties but can never invent an answer: a session
 * registered nowhere resolves to null and nothing is written. That is D5's
 * standing rule — a wrong attribution is worse than a missing one, and in this
 * repo the branch binding IS wrong (main is bound to drift-certification while
 * other initiatives are worked on it).
 *
 * Never fails a commit. Every failure path is a silent success: no session, no
 * record, an unreadable message file, a slug that is already there. A hook that
 * can block `git commit` is worse than no attribution at all.
 */

export type TrailerOutcome =
  | 'added'
  | 'already-present'
  | 'no-session'
  | 'unresolved'
  | 'unreadable'

export interface TrailerResult {
  outcome: TrailerOutcome
  /** The slug written, when one was. */
  slug?: string
}

/**
 * Append the trailer to a commit message, unless it is already attributed.
 *
 * Idempotent by design: prepare-commit-msg fires again on `git commit --amend`,
 * and a message accumulating one trailer per amend would turn a single commit
 * into a fake multi-initiative squash.
 */
export function applyTrailer(message: string, slug: string): string | null {
  if (hasTrailer(message, slug)) return null

  // Strip the comment block git appends (everything from the scissors line, or
  // trailing `#` lines) so the trailer lands in the message body, not below the
  // cut where git would discard it.
  const lines = message.split('\n')
  let end = lines.length
  while (end > 0) {
    const line = lines[end - 1]!
    if (line.trim().length === 0 || line.startsWith('#')) end--
    else break
  }
  const body = lines.slice(0, end)
  const tail = lines.slice(end)

  // A trailer block must be separated from the body by a blank line, or git
  // reads it as ordinary prose and `%(trailers)` returns nothing.
  if (body.length > 0 && body[body.length - 1]!.trim().length > 0) body.push('')
  body.push(`${TRAILER_KEY}: ${slug}`)
  return [...body, ...tail].join('\n')
}

/** Is this message already attributed to this slug? */
function hasTrailer(message: string, slug: string): boolean {
  const wanted = `${TRAILER_KEY}: ${slug}`.toLowerCase()
  return message
    .split('\n')
    .some((line) => !line.startsWith('#') && line.trim().toLowerCase() === wanted)
}

/**
 * Resolve this session's initiative, or null. Exported so tests can assert the
 * no-guess contract without constructing a git hook invocation.
 */
export function resolveForCommit(
  rootDir: string,
  sessionId: string | undefined,
): string | null {
  if (sessionId === undefined || sessionId.length === 0) return null
  const sofarDir = join(rootDir, '.sofar')
  let preferred: string | null = null
  try {
    const branch = currentBranch(rootDir)
    if (branch !== null) {
      const bound = readBindingsFile(join(sofarDir, 'bindings.json'))[branch]
      preferred = typeof bound === 'string' ? bound : null
    }
  } catch {
    preferred = null // a missing binding is not an error; it only forfeits the tie-break
  }
  try {
    return homeInitiative(sofarDir, sessionId, preferred)
  } catch {
    return null
  }
}

export function runCommitTrailer(rootDir: string, msgPath: string): TrailerResult {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  if (sessionId === undefined || sessionId.length === 0) return { outcome: 'no-session' }

  const slug = resolveForCommit(rootDir, sessionId)
  if (slug === null) return { outcome: 'unresolved' }

  let message: string
  try {
    message = readFileSync(msgPath, 'utf8')
  } catch {
    return { outcome: 'unreadable' }
  }

  const next = applyTrailer(message, slug)
  if (next === null) return { outcome: 'already-present', slug }
  try {
    writeFileSync(msgPath, next, 'utf8')
  } catch {
    return { outcome: 'unreadable' }
  }
  return { outcome: 'added', slug }
}

export function registerCommitTrailerCommand(
  program: Command,
  rootOf: (opts: { root?: string }) => string,
): void {
  program
    .command('commit-trailer <msgfile>')
    .description(
      'prepare-commit-msg worker: stamp Sofar-Initiative onto a commit message from the session that made it (D5). Silent no-op outside a session; never fails a commit',
    )
    .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
    .action((msgfile: string, opts: { root?: string }) => {
      // Exit 0 on every path, always: this runs inside `git commit`.
      try {
        runCommitTrailer(rootOf(opts), msgfile)
      } catch {
        // swallowed by contract
      }
      process.exitCode = 0
    })
}
