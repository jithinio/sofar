import type { DecisionState, InitiativeState, SessionActivity, SessionState } from '../../core/fold'
import { LANE_RECENT_SESSIONS } from '../../core/lane'
import { retiredOrdinals } from '../../core/retire'
import { hasRealAlternative, MAX_DECISIONS, UNWRITTEN_SIBLING_CAP } from './status'

/**
 * The state renderStatus can reach, and nothing more (rust-core 4.4; the
 * tighter cut is D-b, DIGEST_CACHE_VERSION 2): what the session-start digest
 * cache stores so a hit renders without folding. Every session and decision
 * stays an entry (the lane counts both, the scans read their order); each keeps
 * only the fields a reader can reach, decided from the FULL state.
 *
 * Sessions, reader by reader (status.ts and core/fold.ts):
 * - lastWithSummary: the newest session with a summary keeps its summary,
 *   tool, ended and id.
 * - overlappingWritebacks (no reference): the winner and the sessions that
 *   overlap it keep next_action, tool, started and ended. Every other
 *   next_action is dropped: it only made a session a candidate, and removing
 *   non-winning candidates changes neither the winner nor who overlaps it.
 * - openSessionFiles, lastUnwrittenWithActivity, the lane: `activityKept`
 *   sessions keep their activity, id, tool, started, ended and closed_reason.
 * - unwrittenSessions counts every summary-less session with activity, so
 *   those keep an activity placeholder; the newest UNWRITTEN_SIBLING_CAP + 1
 *   keep their ids. The lane asks whether more than LANE_RECENT_SESSIONS
 *   worked, so the newest LANE_RECENT_SESSIONS + 1 with activity keep one.
 * - An older write-back's summary matters only beside activity (it keeps a
 *   session out of the unwritten count), so the two go together: `''` and a
 *   placeholder when its activity is still counted, both dropped otherwise.
 * - The lane's `since` reads sessions[0].started.
 * Everything else becomes `''` (id, tool, started), 0 (unwritten) or absent.
 *
 * Decisions: rule, quote, supersedes, until and superseded_by are kept (the
 * standing rules and retirement). ts and chose are kept for the recent window
 * and over for the window and the rejected ledger's head, under SOFAR_RETIRE
 * on AND off (read at render time). Every other `over` keeps only whether it
 * is a real alternative. id, because, guard and check are never rendered.
 *
 * renderStatus(digestState(s), o) === renderStatus(s, o) is a CONTRACT, pinned
 * by test/digest-state.test.ts over this repo's real logs, team-shaped records
 * and the options matrix, with a text-reachability check (dropped text
 * replaced by sentinels renders the same). A template change that reads more
 * of the state must widen the cut here, or that suite goes red.
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

/**
 * How many older rejected approaches can render at most: the ledger's room is
 * at most REJECTED_LEDGER_BUDGET (450) less its header and OVERFLOW_RESERVE,
 * and every line is at least `- [D1] x` plus its newline (9), so no more than
 * 45 show, plus the one whose length breaks the loop. 48 bounds that without
 * repeating the budget arithmetic.
 */
const REJECTED_TEXT_KEPT = 48

/** Placeholder for an `over` no reader shows: only its realness is read. */
const REAL_OVER = '-'

/** Indices whose ts/chose (window) and over (window + ledger head) can render. */
function decisionTextKept(state: InitiativeState): { window: Set<number>; over: Set<number> } {
  const window = new Set<number>()
  const over = new Set<number>()
  for (const retire of [true, false]) {
    const retired = retire ? retiredOrdinals(state) : new Set<number>()
    const inForce = state.decisions.map((_, i) => i).filter((i) => !retired.has(i + 1))
    const recent = inForce.slice(-MAX_DECISIONS)
    for (const i of recent) {
      window.add(i)
      over.add(i)
    }
    const older = inForce.slice(0, inForce.length - recent.length).filter((i) => hasRealAlternative(state.decisions[i]!.over))
    for (const i of older.slice(0, REJECTED_TEXT_KEPT)) over.add(i)
  }
  return { window, over }
}

function cutDecision(d: DecisionState, i: number, kept: { window: Set<number>; over: Set<number> }): DecisionState {
  const cut: DecisionState = {
    id: '',
    ts: kept.window.has(i) ? d.ts : '',
    chose: kept.window.has(i) ? d.chose : '',
    over: kept.over.has(i) ? d.over : hasRealAlternative(d.over) ? REAL_OVER : '',
    because: '',
  }
  if (d.rule !== undefined) cut.rule = d.rule
  if (d.quote !== undefined) cut.quote = d.quote
  if (d.supersedes !== undefined) cut.supersedes = d.supersedes
  if (d.until !== undefined) cut.until = d.until
  if (d.superseded_by !== undefined) cut.superseded_by = d.superseded_by
  return cut
}

/** The newest `n` indices matching `test`. */
function newest(sessions: readonly SessionState[], n: number, test: (s: SessionState) => boolean): Set<number> {
  const out = new Set<number>()
  for (let i = sessions.length - 1; i >= 0 && out.size < n; i--) if (test(sessions[i]!)) out.add(i)
  return out
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
  const laneCount = newest(sessions, LANE_RECENT_SESSIONS + 1, (s) => s.activity !== undefined)
  const unwrittenIds = newest(sessions, UNWRITTEN_SIBLING_CAP + 1, (s) => s.summary === undefined && s.activity !== undefined)
  const decisions = decisionTextKept(state)
  return {
    ...state,
    files_touched: [],
    sessions: sessions.map((s, i) => {
      const last = i === newestSummary
      const next = keepNext.has(i)
      const act = keepActivity.has(i)
      const counted = s.activity !== undefined && (s.summary === undefined || act || laneCount.has(i))
      const cut: SessionState = {
        id: last || act || unwrittenIds.has(i) ? s.id : '',
        tool: last || next || act ? s.tool : '',
        started: i === 0 || next || act ? s.started : '',
        unwritten: 0,
      }
      if (s.ended !== undefined && (last || next || act)) cut.ended = s.ended
      if (s.summary !== undefined && (last || counted)) cut.summary = last ? s.summary : ''
      if (s.next_action !== undefined && next) cut.next_action = s.next_action
      if (s.closed_reason !== undefined && act) cut.closed_reason = s.closed_reason
      if (counted) cut.activity = act ? s.activity : EMPTY_ACTIVITY
      return cut
    }),
    decisions: state.decisions.map((d, i) => cutDecision(d, i, decisions)),
  }
}
