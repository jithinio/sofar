import { join } from 'node:path'
import { foldLog, openSessionFiles, type FileConflict, type InitiativeState } from './fold'
import { initiativeSlugs } from './listing'
import { isWarm } from './warmth'

/**
 * Concurrent-edit hazards ACROSS initiatives (cross-initiative-conflicts 2.1).
 *
 * openSessionFileConflicts answers the question inside one record, which is
 * the boundary the hook and `sofar doctor` both inherited. The filesystem does
 * not honour that boundary: two agents editing one file clobber each other
 * whether or not they serve the same initiative, and until now neither was
 * told — the hook folds a single slug, and doctor loops slugs but detects
 * per-slug.
 *
 * The cost of answering it properly is the whole design problem. Folding every
 * log on every prompt is O(total history) on a path with a 100ms end-to-end
 * budget (speed T2): measured at +15.8ms on a 30-initiative record, passing
 * today and rotting forever. So the hot path passes a `window` and folds only
 * logs that GREW inside it, which reduces the cost to O(concurrent activity)
 * — bounded by how many agents are actually working, not by how much has ever
 * been recorded.
 *
 * The gate is not an approximation of the answer. The hazard is concurrent
 * EDITING, and an agent that is editing is appending continuously (every tool
 * call lands a file_touched). A log that has not grown inside the window
 * cannot hold a session that is editing right now. The residue — a session
 * open but silent for longer than the window — cannot clobber anyone while it
 * is silent, and the moment it resumes it appends, which makes ITS next prompt
 * see the conflict from the side that is about to cause the damage.
 *
 * Omitting `window` disables the gate entirely, which is how `sofar doctor`
 * calls it: an audit is not on the critical path, so the exhaustive answer
 * always exists. The gate narrows what is computed per keystroke, never what
 * is knowable.
 */

/** One open session's hold on a file, with the initiative it serves. */
export interface CrossHolder {
  session: string
  initiative: string
}

/** A file held open by sessions spanning two or more initiatives. */
export interface CrossFileConflict {
  path: string
  holders: CrossHolder[]
  /** Distinct initiatives among the holders — >1 is what this adds over FileConflict. */
  initiatives: string[]
}

export interface CrossConflictOptions {
  /**
   * Only fold logs that grew within this many ms of `now`. Omit to fold every
   * initiative — correct but O(total history), so only off the hook path.
   */
  window?: number
  now?: number
  /** Count this session as open despite `ended`, as openSessionFileConflicts does. */
  alsoLiveSessionId?: string
}

/** Which initiatives are worth folding for a live-conflict question. */
export function warmInitiatives(sofarDir: string, opts: CrossConflictOptions = {}): string[] {
  const slugs = initiativeSlugs(sofarDir)
  if (opts.window === undefined) return slugs
  const now = opts.now ?? Date.now()
  return slugs.filter((slug) =>
    isWarm(join(sofarDir, 'initiatives', slug, 'events.jsonl'), now, opts.window!),
  )
}

/**
 * Files under concurrent edit by open sessions, unioned across initiatives.
 *
 * Returns ONLY conflicts that span initiatives — the same-initiative case is
 * already covered by openSessionFileConflicts, and reporting it twice would
 * double every existing warning.
 */
export function crossInitiativeFileConflicts(
  sofarDir: string,
  opts: CrossConflictOptions = {},
): CrossFileConflict[] {
  const entries: { slug: string; state: InitiativeState }[] = []
  for (const slug of warmInitiatives(sofarDir, opts)) {
    try {
      entries.push({ slug, state: foldLog(join(sofarDir, 'initiatives', slug, 'events.jsonl')).state })
    } catch {
      continue // an unreadable log degrades to silence, never to a throw
    }
  }
  return crossConflictsFromStates(entries, opts.alsoLiveSessionId)
}

/**
 * The same union over states that are ALREADY folded.
 *
 * `sofar doctor` folds every initiative for its other axes before it asks this
 * question, so making it re-read the logs would double the most expensive part
 * of the command to recompute something it is holding. The disk entry point
 * above exists for callers that have no states yet; both end here, so the
 * gated and ungated answers can never disagree about what a conflict IS.
 */
export function crossConflictsFromStates(
  entries: readonly { slug: string; state: InitiativeState }[],
  alsoLiveSessionId?: string,
): CrossFileConflict[] {
  const byFile = new Map<string, CrossHolder[]>()
  for (const { slug, state } of entries) {
    for (const { session, file } of openSessionFiles(state, alsoLiveSessionId)) {
      const holders = byFile.get(file) ?? []
      holders.push({ session, initiative: slug })
      byFile.set(file, holders)
    }
  }

  const conflicts: CrossFileConflict[] = []
  for (const [path, holders] of byFile) {
    const initiatives = [...new Set(holders.map((h) => h.initiative))].sort()
    if (initiatives.length < 2) continue
    holders.sort((a, b) =>
      a.initiative === b.initiative
        ? a.session.localeCompare(b.session)
        : a.initiative.localeCompare(b.initiative),
    )
    conflicts.push({ path, holders, initiatives })
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path))
  return conflicts
}

/** The cross-initiative conflicts a given session is party to. */
export function crossConflictsForSession(
  sofarDir: string,
  sessionId: string,
  opts: CrossConflictOptions = {},
): CrossFileConflict[] {
  return crossInitiativeFileConflicts(sofarDir, { ...opts, alsoLiveSessionId: sessionId }).filter(
    (c) => c.holders.some((h) => h.session === sessionId),
  )
}

/** Re-exported for callers that mix both scopes on one surface. */
export type { FileConflict }
