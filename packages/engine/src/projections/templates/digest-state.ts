import type { InitiativeState, SessionActivity, SessionState } from '../../core/fold'
import { LANE_RECENT_SESSIONS } from '../../core/lane'

/**
 * The state renderStatus can reach, and nothing more (rust-core 4.4): what the
 * session-start digest cache stores so a hit renders without folding. At team
 * scale the full state is ~14 MB, and all but a few sessions' text is
 * unreachable from the digest.
 *
 * The cut, reader by reader (status.ts and core/fold.ts):
 * - `files_touched` is read only by renderFullStatus, so it is dropped.
 * - `summary`: lastWithSummary renders the newest session that has one; every
 *   other reader asks only whether a summary exists. The rest become `''`,
 *   which keeps `summary !== undefined` true.
 * - `activity`: rendered only for the last unwritten session, the lane's
 *   recent sessions, and open sessions (openSessionFiles reads their files).
 *   Every other reader asks only whether activity exists, so the rest keep
 *   an empty placeholder.
 * - `next_action`: overlappingWritebacks (called with no reference) picks the
 *   winner among the wrapped sessions by `ended` alone, then compares text only
 *   with the sessions whose [started, ended] overlaps the winner's. The winner
 *   and those keep their text; every other one becomes `''`, which keeps
 *   `next_action !== undefined` true.
 * Every other field is kept as is.
 *
 * renderStatus(digestState(s), o) === renderStatus(s, o) is a CONTRACT, pinned
 * by test/digest-state.test.ts over this repo's real logs and synthetic
 * records under an options matrix. A template change that reads more of the
 * state must widen the cut here, or that suite goes red.
 */

const EMPTY_ACTIVITY: SessionActivity = { files: [], commands: 0, task_changes: [] }

/** Indices of the sessions whose activity a reader can render. */
function activityKept(sessions: readonly SessionState[]): Set<number> {
  const keep = new Set<number>()
  // Open sessions: openSessionFiles reads their files for the conflict lines.
  sessions.forEach((s, i) => {
    if (s.ended === undefined && s.activity !== undefined) keep.add(i)
  })
  // lastUnwrittenWithActivity: newest first, stopping at a written-back one.
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i]!
    if (s.summary !== undefined) break
    if (s.activity !== undefined) {
      keep.add(i)
      break
    }
  }
  // The lane block: the newest LANE_RECENT_SESSIONS with activity.
  let lane = 0
  for (let i = sessions.length - 1; i >= 0 && lane < LANE_RECENT_SESSIONS; i--) {
    if (sessions[i]!.activity !== undefined) {
      keep.add(i)
      lane += 1
    }
  }
  return keep
}

/** Indices whose next_action text overlappingWritebacks can read. */
function nextActionKept(sessions: readonly SessionState[]): Set<number> {
  const wrapped: number[] = []
  sessions.forEach((s, i) => {
    if (s.ended !== undefined && s.next_action !== undefined) wrapped.push(i)
  })
  const keep = new Set<number>()
  if (wrapped.length === 0) return keep
  // The winner, exactly as overlappingWritebacks picks it: max ended, the
  // later array position winning a tie.
  let ref = wrapped[0]!
  for (const i of wrapped) if (sessions[i]!.ended! >= sessions[ref]!.ended!) ref = i
  const r = sessions[ref]!
  keep.add(ref)
  for (const i of wrapped) {
    const s = sessions[i]!
    if (s.started <= r.ended! && s.ended! >= r.started) keep.add(i)
  }
  return keep
}

export function digestState(state: InitiativeState): InitiativeState {
  const sessions = state.sessions
  let newestSummary = -1
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i]!.summary !== undefined) {
      newestSummary = i
      break
    }
  }
  const keepActivity = activityKept(sessions)
  const keepNext = nextActionKept(sessions)
  return {
    ...state,
    files_touched: [],
    sessions: sessions.map((s, i) => {
      const cut: SessionState = { ...s }
      if (s.summary !== undefined && i !== newestSummary) cut.summary = ''
      if (s.activity !== undefined && !keepActivity.has(i)) cut.activity = EMPTY_ACTIVITY
      if (s.next_action !== undefined && !keepNext.has(i)) cut.next_action = ''
      return cut
    }),
  }
}
