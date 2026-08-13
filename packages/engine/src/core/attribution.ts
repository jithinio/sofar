import { execFileSync } from 'node:child_process'

/**
 * Commit → initiative attribution, read from git commit trailers (D4).
 *
 * Deliberately NOT in core/git.ts. That file guarantees "reads FILES, no
 * subprocess" so hook shims can call it freely inside their 100ms budget
 * (speed T2), and trailers cannot be answered that way — they live in commit
 * objects, which are packed and zlib-compressed. Putting a spawn behind that
 * file's name would silently void the guarantee every caller relies on.
 *
 * Cost, measured on this repo at 454 commits (20 iterations, median): a bare
 * `git rev-parse HEAD` is 8.35ms, so spawn alone dominates. A 20-commit
 * trailer walk is 10.35ms, last-100 is 15.55ms, and a full walk is 21.21ms
 * with a 45.25ms tail. Against ~33ms of shim headroom (record-integrity D13
 * measured 63-67ms already spent) the full walk's tail alone would blow it.
 *
 * Hence D6: never call this unconditionally on the hot hook path, and always
 * bound the walk. Spawn cost is fixed, but an unbounded walk is O(history) and
 * grows without limit. Callers gate on a ref having actually moved — which
 * core/git.ts answers for free from files.
 *
 * Best-effort by contract, like gitUserEmail: no git, no repo, a malformed
 * trailer → null or an empty list, never a throw. Attribution is a signal, and
 * a missing signal must never break a caller.
 */

/** The trailer key carrying the slug. Written by the prepare-commit-msg hook (D5). */
export const TRAILER_KEY = 'Sofar-Initiative'

/**
 * Default ceiling when the caller gives no range. Generous enough to cover a
 * session's recent history, small enough to stay near the spawn floor. Prefer
 * passing an explicit `range` — `origin/<branch>..HEAD` is both cheaper and
 * exactly the question the staleness signal asks.
 */
export const DEFAULT_MAX_COUNT = 200

export interface CommitAttribution {
  /** Full 40-char sha. */
  sha: string
  /**
   * Slugs claimed by this commit's trailers. EMPTY means unattributed, which
   * is a first-class answer (1.3): a commit made outside a session has no
   * owner, and saying so is the point — never guess one.
   *
   * More than one is legitimate, not a corruption: a squash merge can carry
   * several initiatives' trailers, and that is informative.
   */
  initiatives: string[]
}

export interface AttributionQuery {
  /** Rev range, e.g. `origin/main..HEAD`. Strongly preferred over maxCount. */
  range?: string
  /** Hard ceiling on commits walked. Defaults to DEFAULT_MAX_COUNT. */
  maxCount?: number
}

/** Slug shape, mirroring the tool-input pattern — anything else is not ours. */
const SLUG = /^[a-z0-9-]+$/
const FULL_SHA = /^[0-9a-f]{40}$/

// Record/unit separators rather than newlines: a trailer value can legally be
// folded across lines, so a line-oriented parse would tear one commit into two.
const RS = '\x1e'
const US = '\x1f'

/**
 * Read trailer attribution for a bounded set of commits, newest first.
 * Returns null when git is unavailable or the walk fails — never throws.
 */
export function readAttribution(
  rootDir: string,
  query: AttributionQuery = {},
): CommitAttribution[] | null {
  const maxCount = query.maxCount ?? DEFAULT_MAX_COUNT
  if (!Number.isInteger(maxCount) || maxCount <= 0) return null

  const args = [
    'log',
    '--no-color',
    `--max-count=${maxCount}`,
    `--format=${RS}%H${US}%(trailers:key=${TRAILER_KEY},valueonly,separator=%x2C)`,
  ]
  // A range is a rev, never a flag — reject anything that could read as one.
  if (query.range !== undefined) {
    if (query.range.length === 0 || query.range.startsWith('-')) return null
    args.push(query.range)
  }

  let out: string
  try {
    out = execFileSync('git', args, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    return null
  }
  return parseAttribution(out)
}

/**
 * Parse `git log` output in this module's format. Exported for tests, which
 * must be able to exercise malformed input without constructing a repo for
 * every case.
 */
export function parseAttribution(out: string): CommitAttribution[] {
  const commits: CommitAttribution[] = []
  for (const record of out.split(RS)) {
    if (record.length === 0) continue
    const sep = record.indexOf(US)
    if (sep === -1) continue
    const sha = record.slice(0, sep).trim()
    if (!FULL_SHA.test(sha)) continue
    commits.push({ sha, initiatives: parseSlugs(record.slice(sep + 1)) })
  }
  return commits
}

/**
 * Split a trailer value into valid slugs. Anything not slug-shaped is dropped
 * rather than surfaced: the trailer is free text a human can mistype, and an
 * invented initiative name is exactly the wrong attribution D5's rule forbids.
 * Duplicates collapse — one commit claiming a slug twice still claims it once.
 */
function parseSlugs(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const slug = part.trim()
    if (slug.length > 0 && SLUG.test(slug)) seen.add(slug)
  }
  return [...seen]
}

/**
 * Group a walk by initiative: slug → shas, newest first. A commit carrying two
 * slugs appears under both, which is the honest reading of a squash.
 */
export function bySlug(commits: CommitAttribution[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const commit of commits) {
    for (const slug of commit.initiatives) {
      const shas = out.get(slug)
      if (shas === undefined) out.set(slug, [commit.sha])
      else shas.push(commit.sha)
    }
  }
  return out
}

/** Commits carrying no attribution at all — doctor's 2.4 surface. */
export function unattributed(commits: CommitAttribution[]): string[] {
  return commits.filter((c) => c.initiatives.length === 0).map((c) => c.sha)
}
