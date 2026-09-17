import { isClosedInitiativeStatus } from '@sofar/schema'
import {
  freshnessTotal,
  latestRun,
  openSessionFileConflicts,
  overlappingWritebacks,
  staleActivePhases,
  type InitiativeState,
  type SessionState,
  type TaskState,
} from '../../core/fold'
import type { GitState } from '../../core/git'
import type { NeighbourRecord } from '../../core/index-tier1'
import { LANE_RECENT_SESSIONS, QUICK_LANE } from '../../core/lane'
import { retireEnabled, retiredOrdinals } from '../../core/retire'
import {
  clip,
  clipBlockDetect,
  clipDetect,
  describeActivity,
  describeFreshness,
  describeRun,
  phaseFraction,
  progressText,
  standingConstraintLines,
  taskProgress, testOutcomeLine } from './shared'

/**
 * Status projection — the SessionStart context block (task 3.6, BD3):
 * summary-dense orientation for a fresh session. Injected as context by
 * `sofar event session-start`, so it carries a HARD ≤10,000-char
 * guarantee: every free-text section is budget-clipped, list sections are
 * count-capped, and enforceStatusLimit is the final belt-and-braces guard.
 * Detail lives in plan.md / decisions.md / sessions/<id>.md.
 */

export const STATUS_CHAR_LIMIT = 10_000

export const STATUS_TRUNCATION_MARKER = '…truncated — run sofar status for full detail'

/** Repo memory (.sofar/repo.md) gets its OWN budget (task 6.5, BD40). */
export const REPO_MEMORY_CHAR_BUDGET = 1_500

export const REPO_MEMORY_TRUNCATION_MARKER =
  '…truncated — read .sofar/repo.md for the rest'

// Per-section budgets (chars). Worst-case sum stays well under the limit;
// the final guard covers pathological futures, not expected inputs.
const SESSION_ID_BUDGET = 120 // session ids are external input — never trust their size
const GOAL_BUDGET = 600
const TASK_LINE_BUDGET = 200
const NEXT_ACTION_BUDGET = 500
const BLOCKED_BUDGET = 500
const PHASE_LINE_BUDGET = 100
const MAX_PHASE_LINES = 12
// Collapsed done-phases line (task 6.2, token-opt): bounded even when many
// phases are done or names lack the "Phase N — title" convention.
const DONE_PHASES_LINE_BUDGET = 220
const SESSION_SUMMARY_BUDGET = 1_200
const DERIVED_SESSION_BUDGET = 600
// Decision index (r1-fixes 2.2, D11): the recent window clips `chose` and
// `over` separately so the rejected alternative survives a long `chose`;
// `because` is on demand (decisions.md). A decision whose rule renders in
// Standing constraints gets the short chose budget — the rule is its content.
const DECISION_CHOSE_BUDGET = 120
const DECISION_RULED_CHOSE_BUDGET = 60
const MAX_DECISIONS = 5
// Rejected-approaches ledger (D-ledger, Phase-3 validated; scoped by D11 to
// decisions OLDER than the recent window): breadth of "what NOT to re-propose"
// that the window drops — over-only, heavily clipped, so it stays compact even
// as decisions accumulate, and never a byte the window already paid for.
const REJECTED_OVER_LINE_BUDGET = 90
const REJECTED_LEDGER_BUDGET = 2_800
// What the ledger leaves under the hard cap for the fixed lines after it: its
// own overflow pointer, `Next ids`, the read-back line and the footer (~330
// chars at their longest). The variable tail (adjacency, session, git,
// notices — D12) is measured, not estimated, so the protocol tail always
// renders when everything above the ledger fits.
const PROTOCOL_TAIL_RESERVE = 400
// Standing-constraints ledger (drift-hardening 2.1): rules render VERBATIM —
// budget pressure drops whole entries with a pointer, never clips inside a
// rule. Section renders near the top, so the enforceStatusLimit tail cut can
// never take it before the clippable sections below.
const STANDING_LEDGER_BUDGET = 2_000
// Concurrent-edit surfacing (task 11.4, D-P11) — rendered only when open
// sessions share files, so it costs nothing in the common single-session case.
const CONFLICT_LINE_BUDGET = 200
const MAX_CONFLICT_LINES = 8
// Staleness line (staleness-detection 2.1) — rendered only when mechanical
// events postdate the last write-back, so a fresh record pays nothing.
// Counts are numeric and the breakdown has ≤5 fixed kinds; the budget is
// belt-and-braces, not an expected cut.
const STALENESS_LINE_BUDGET = 200
// Parallel write-backs (task 12.4): concurrent sessions' next-actions that
// lost the single-scalar race — rendered only when overlapping write-backs
// disagree, so the common single-session case pays nothing.
const PARALLEL_LINE_BUDGET = 260
const MAX_PARALLEL_LINES = 3
// Notes since write-back (notes-in-digest 2.1): the drift CONTENT beside the
// staleness line's drift signal — corrections recorded after the write-back
// would otherwise die invisible in the log. Newest-last window mirroring
// recent decisions; a record with no un-absorbed notes pays nothing.
const NOTE_LINE_BUDGET = 200
const MAX_NOTES = 5
// File-locality hint (speed T4): where the active task's work actually
// lives, from the fold's task_files derivation — one budgeted line, absent
// when no file_touched ever landed while the task was active.
const TASK_FILES_LINE_BUDGET = 300
const MAX_TASK_FILES = 8
// Adjacent records (record-index 3.3): other initiatives that have worked this
// one's files, from the Tier 1 index — absent when the caller could not read it
// or nothing overlaps, so a single-initiative repo renders exactly as before.
const NEIGHBOUR_LINE_BUDGET = 200
const MAX_NEIGHBOURS = 3
// Driver line (session-driver 1.2): which run drove the recent sessions, its
// handoffs by reason, and whether it is still going — rendered only when a
// driver has ever run this initiative, so a hand-run record pays nothing.
const DRIVEN_LINE_BUDGET = 300

/** `1 decision` / `8 decisions` — the staleness line's convention, reused. */
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Hard cap: anything over the limit is cut to fit, marker included. */
export function enforceStatusLimit(text: string): string {
  if (text.length <= STATUS_CHAR_LIMIT) return text
  const marker = `\n${STATUS_TRUNCATION_MARKER}\n`
  return text.slice(0, STATUS_CHAR_LIMIT - marker.length) + marker
}

function lastWithSummary(sessions: readonly SessionState[]): SessionState | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    if (sessions[i]!.summary !== undefined) return sessions[i]
  }
  return undefined
}

/**
 * Derived resume fallback (task 7.2, BD44): newest → oldest, the first
 * session that did mechanical work but never wrote a summary — UNLESS a
 * written-back session is newer (summary-first: the real write-back already
 * carries the resume point). Sessions with neither summary nor activity
 * (e.g. the session that just started and triggered this render) are
 * skipped, not blockers.
 */
function lastUnwrittenWithActivity(sessions: readonly SessionState[]): SessionState | undefined {
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i]!
    if (session.summary !== undefined) return undefined
    if (session.activity !== undefined) return session
  }
  return undefined
}

/** Cap on the sibling-count line so a crowded record cannot bloat the block. */
export const UNWRITTEN_SIBLING_CAP = 5

/**
 * EVERY session that did mechanical work and never wrote back
 * (record-integrity 4.3), newest first.
 *
 * lastUnwrittenWithActivity answers a different question — "what is the best
 * derived resume point" — and deliberately stops at the newest written-back
 * session. That is right for resuming and wrong for accounting: with parallel
 * sessions, one write-back hid every other session's unwritten work from the
 * block entirely. This scans the whole list so the count is honest.
 */
export function unwrittenSessions(sessions: readonly SessionState[]): SessionState[] {
  return sessions
    .filter((s) => s.summary === undefined && s.activity !== undefined)
    .reverse()
}

/**
 * A decision recorded a real rejected alternative — vs the placeholder
 * "(no alternative recorded)" logged when nothing was weighed.
 */
function hasRealAlternative(over: string | undefined): boolean {
  if (over === undefined) return false
  const t = over.trim()
  return t.length > 0 && !/^\(\s*(no alternative|none)/i.test(t)
}

/**
 * Full status render for `sofar status` (task 4.3) — same orientation
 * data as renderStatus but UNCAPPED with a per-task phase tree: the 10k cap
 * is a SessionStart context budget (BD3), not a terminal constraint.
 */
export function renderFullStatus(state: InitiativeState): string {
  const lines: string[] = []
  lines.push(`# ${state.slug || '(unnamed initiative)'}`, '')
  // A closed record says so before anything else (initiative-lifecycle 4.2):
  // when, and why. Omitted entirely while active, so every open record renders
  // byte-identically to how it always has.
  if (isClosedInitiativeStatus(state.status)) {
    const when = state.status_ts === null ? '' : ` ${state.status_ts}`
    const why = state.status_note === null ? '' : ` — ${state.status_note}`
    // A superseded record's first fact is WHERE it continues
    // (initiative-supersession 3.1); the word alone would send the reader to
    // the log to find out.
    const where = state.successor === null ? '' : ` by ${state.successor}`
    lines.push(`Status: ${state.status}${where}${when}${why}`)
    // What the close-time audit found and the closer went ahead over
    // (commit-attribution 5.2). Uncapped here like every other terminal
    // surface, and never omitted: rendering it forever IS the mechanism, since
    // nothing refused the close.
    if (state.status_overrides.length > 0) {
      lines.push(`Closed over ${state.status_overrides.length} finding(s):`)
      for (const finding of state.status_overrides) lines.push(`  - ${finding}`)
    }
  }
  lines.push(`Goal: ${state.goal || '(none recorded)'}`)

  // Standing constraints (drift-hardening 2.1) — terminal surface, uncapped.
  // In force only (r1-fixes 3.2, D25), switch-aware like the digest.
  const standing = standingConstraintLines(state.decisions, undefined, retireEnabled())
  if (standing.length > 0) {
    lines.push('')
    lines.push(...standing)
  }

  lines.push(
    `Progress: ${progressText(taskProgress(state.phases))} across ${state.phases.length} phase(s)`,
  )
  lines.push('')

  const stalePhases = staleActivePhases(state)
  const staleNames = new Set(stalePhases.map((p) => p.name))

  if (state.phases.length > 0) {
    lines.push('Phases:')
    for (const phase of state.phases) {
      lines.push(
        `- ${phase.name} ${phaseMark(phase, staleNames)} ${phaseFraction(taskProgress([phase]))}`,
      )
      for (const task of phase.tasks) {
        lines.push(`  - ${TASK_MARKS[task.status] ?? '[ ]'} ${task.id} ${task.title}`)
      }
    }
    lines.push('')
  }

  lines.push(`Next action: ${state.current.next_action ?? '(none recorded)'}`)

  // Parallel write-backs (task 12.4) — terminal surface, uncapped: every
  // overlapping session's swallowed next_action with its full identity.
  const parallel = overlappingWritebacks(state)
  if (parallel.length > 0) {
    lines.push(`⚠ Parallel write-backs (${parallel.length}):`)
    for (const w of parallel) {
      lines.push(`- ${w.session_id} (${w.tool}, ended ${w.ended}): ${w.next_action}`)
    }
  }

  if (state.current.blocked_on !== undefined) {
    lines.push(`Blocked on: ${state.current.blocked_on}`)
  }

  const last = lastWithSummary(state.sessions)

  // Staleness section (staleness-detection 2.3) — the terminal surface gets
  // the full mechanical picture, uncapped: drift breakdown since the last
  // write-back, every stale phase, and a pointer when the capped surfaces
  // (SessionStart block / get_state digest) clip the last summary. Rendered
  // only when at least one signal fires.
  const drift = freshnessTotal(state.freshness)
  const staleness: string[] = []
  if (drift > 0 && state.freshness.last_writeback_ts !== null) {
    staleness.push(
      `- next action may be stale: ${drift} event${drift === 1 ? '' : 's'} since the last write-back (${state.freshness.last_writeback_ts}) — ${describeFreshness(state.freshness.events_since_writeback)}`,
    )
  }
  for (const sp of stalePhases) {
    staleness.push(
      `- phase "${sp.name}": all ${sp.tasks_done} tasks done but still ${sp.status} — emit phase_status_changed to mark it done`,
    )
  }
  if (last?.summary !== undefined && clipDetect(last.summary, SESSION_SUMMARY_BUDGET).clipped) {
    staleness.push(
      `- last write-back summary exceeds the SessionStart budget (${SESSION_SUMMARY_BUDGET} chars) and is clipped there — full text in sessions/${last.id}.md`,
    )
  }
  if (staleness.length > 0) {
    lines.push('')
    lines.push('⚠ Staleness:')
    lines.push(...staleness)
  }

  // Notes since write-back (notes-in-digest 2.2) — the terminal surface gets
  // every selected note UNCAPPED (no count cap, no length clip): the 10k cap
  // is a SessionStart context budget, not a terminal constraint. Entries stay
  // one line each (whitespace collapsed) so the list shape holds.
  if (state.freshness.notes.length > 0) {
    lines.push('')
    const label = state.freshness.last_writeback_ts !== null ? 'Notes since write-back' : 'Notes'
    lines.push(`${label} (${state.freshness.notes.length}):`)
    for (const n of state.freshness.notes) {
      lines.push(`- ${n.ts} ${n.text.replace(/\s+/g, ' ').trim()}`)
    }
  }

  const conflicts = openSessionFileConflicts(state)
  if (conflicts.length > 0) {
    lines.push('')
    lines.push(`⚠ Concurrent edits — files touched by multiple open sessions (${conflicts.length}):`)
    for (const c of conflicts) lines.push(`- ${c.path} (sessions ${c.sessions.join(', ')})`)
  }

  if (last !== undefined) {
    lines.push('')
    lines.push(`Last session (${last.tool}, ended ${last.ended ?? '?'}):`)
    lines.push(`  ${last.summary!}`)
  }

  if (state.runs.length > 0) {
    lines.push('')
    lines.push(`Driven (${plural(state.runs.length, 'run')}):`)
    for (const run of state.runs) {
      lines.push(`- ${describeRun(run)}`)
      // The surface in FULL, and only here (session-driver 2.4, D8). The
      // digest's Driven line is budgeted and this is the question nobody asks
      // until months later — what were those unattended sessions allowed to
      // do? — so it belongs on the surface that answers questions, not the one
      // that fits in a header. Rules are listed whole: a truncated allow-list
      // is worse than none, because it reads as complete.
      if (run.surface !== undefined) {
        const s = run.surface
        const pinned = [
          s.model !== undefined ? `model ${s.model}` : undefined,
          s.effort !== undefined ? `effort ${s.effort}` : undefined,
        ].filter((p): p is string => p !== undefined)
        lines.push(`  permissions: ${s.permission_mode}${pinned.length > 0 ? `, ${pinned.join(', ')}` : ''}`)
        for (const rule of s.allow) lines.push(`    allow ${rule}`)
        for (const rule of s.deny ?? []) lines.push(`    deny ${rule}`)
      }
      for (const h of run.handoffs) {
        const task = h.task !== undefined ? `, task ${h.task}` : ''
        const tokens = h.tokens !== undefined ? `, ${h.tokens} tokens` : ''
        const detail = h.detail !== undefined ? ` (${h.detail})` : ''
        lines.push(`  - ${h.ts} session ${h.session_id} — ${h.reason}${task}${tokens}${detail}`)
      }
    }
  }

  if (state.files_touched.length > 0) {
    lines.push('')
    lines.push(`Files touched (${state.files_touched.length}):`)
    for (const file of state.files_touched) lines.push(`- ${file}`)
  }

  return lines.join('\n').replace(/\n+$/, '') + '\n'
}

/** Task status → tree marker: done, active, blocked, pending. */
const TASK_MARKS: Record<string, string> = {
  done: '[x]',
  active: '[~]',
  blocked: '[!]',
  pending: '[ ]',
  dropped: '[-]',
}

/**
 * Phase-line status bracket, staleness-aware (staleness-detection 2.2): a
 * stale phase (1.2 detector — all tasks done, phase not done) carries the
 * nudge inside its bracket. Constant-bounded suffix, so phase lines stay
 * budget-safe wherever names are clipped.
 */
function phaseMark(phase: { name: string; status: string }, staleNames: ReadonlySet<string>): string {
  return staleNames.has(phase.name)
    ? `[${phase.status} — all tasks done; mark phase done?]`
    : `[${phase.status}]`
}

export interface StatusOptions {
  /**
   * Contents of .sofar/repo.md (hand-written repo-scoped memory, SPEC
   * §Record layout). The caller decides whether it is worth surfacing
   * (missing/empty/stub → omit); the template owns budget + placement.
   */
  repoMemory?: string
  /**
   * The hook-registered session id (task 7.1, BD43): surfaced near the top
   * so the agent can pass it to sofar_start_session as `session_id` and
   * adopt exactly its own session — the delivery mechanism that replaced
   * BD20's newest-open adoption heuristic.
   */
  sessionId?: string
  /**
   * Derived git state (record-integrity 4.1) — read from refs by the caller,
   * never stored in the record. Rendered as one line so a session can see
   * whether the work in front of it has been pushed without a human saying
   * so. Omitted entirely when the caller could not read git.
   */
  git?: GitState
  /**
   * Other records that have worked this one's files (record-index 3.3),
   * densest first, uncapped — the template owns the cap and the wording.
   *
   * Derived by the caller from the Tier 1 index, which renderStatus cannot
   * reach: it is handed a folded state, and this is the one fact in the block
   * that no single log contains. Omitted when the index is unreadable or
   * nothing overlaps, so a repo with one initiative renders byte-identically
   * to before this existed.
   */
  neighbours?: readonly NeighbourRecord[]
  /**
   * Per-session notices the SessionStart hook used to compose as a preface
   * (r1-fixes 2.3, D12): recent work elsewhere, the closed banner, the
   * cold-resume advisory, the shipping notice — each already budgeted by
   * its builder. Rendered in the volatile tail, after the session and git
   * lines and before the read-back, so a block that led with them shares
   * no cached prefix with the previous session's. Blank entries are dropped.
   */
  notices?: readonly string[]
  /**
   * Render as the quick-work lane (r1-fixes 2.6, D14): the same template
   * minus every section that presumes a plan or a write-back — no phases,
   * progress, next action, staleness, blocked line, derived-resume or
   * unwritten-session warnings, no read-back — plus three lines saying how
   * the lane works and a recent-quick-work list in place of the last-session
   * block. Decisions render as always: they are the "why" the lane recalls.
   */
  lane?: boolean
  /**
   * Derived activity lines (r1-fixes 2.5, D24): the active task's latest test
   * outcome. Default on; the CALLER passes false under SOFAR_ACTIVITY=off —
   * the switch is read by the hook, never here (templates read no env).
   */
  activity?: boolean
}

/** How the lane works — static, so it sits in the cached head (D12). */
const LANE_HOW_LINES = [
  'This branch is bound to no initiative, so the hooks capture edits and commands here — no sofar new, no plan, no write-back.',
  '- Made a decision? sofar_start_session (id below) then sofar_log_decision — one line of why. That is the only ask.',
  '- Project-sized work needs its own record: sofar new <slug> --goal "<one line>" (or sofar switch <slug>) — this session follows the branch there.',
]

/**
 * The adopt-by-id line (task 7.1, BD43), or null for a missing/blank id.
 * Exported because the unbound notice carries the same line (r1-fixes 1.1):
 * a session that has no record YET is exactly the one about to register,
 * and one wording is what keeps the two surfaces from teaching different ids.
 */
/**
 * `tests: pass — npm test` for the active task (D24). A D19 verification that
 * is at least as new is the stronger fact — the driver ran the task's OWN
 * acceptance command on a fingerprinted tree — and takes the line instead.
 */
function taskTestsLine(state: InitiativeState, task: TaskState): string | null {
  const test = state.task_tests?.[task.id]
  const v = task.verification
  if (v !== undefined && (test === undefined || v.ts >= test.ts)) {
    return `tests: verified ${v.result} — ${v.command}`
  }
  if (test === undefined) return null
  return `tests: ${testOutcomeLine(test)}`
}

export function sessionIdLine(sessionId: string | null | undefined): string | null {
  const id = sessionId?.trim() ?? ''
  if (id.length === 0) return null
  return `Session: ${clip(id, SESSION_ID_BUDGET)} — adopted on Claude Code; else pass to sofar_start_session.`
}

export function renderStatus(state: InitiativeState, options?: StatusOptions): string {
  // Layout is ordered by VOLATILITY (r1-fixes 2.3, D12): prompt caching
  // matches prefixes, so bytes that never change between sessions of the same
  // record come first and bytes that change every session come last. Before
  // D12 the per-session `Session:` line was line 3 and every consecutive pair
  // of sessions shared 0.8% of the block — the title. Three segments:
  //   1. static head — title, goal, standing constraints, repo memory, phases;
  //   2. record state — progress, tasks, next action, drift, last session,
  //      driver, decisions, next ids;
  //   3. volatile tail — adjacency, session id, git, hook notices;
  // then the read-back and footer, last as before.
  const lines: string[] = []
  const lane = options?.lane === true
  lines.push(lane ? `# Sofar: quick-work lane (${state.slug || QUICK_LANE})` : `# Sofar status: ${state.slug || '(unnamed initiative)'}`, '')

  lines.push(`Goal: ${state.goal ? clip(state.goal, GOAL_BUDGET) : '(none recorded)'}`, '')
  if (lane) lines.push(...LANE_HOW_LINES, '')

  // Standing constraints (drift-hardening 2.1): the normative frame, directly
  // under the goal — what every session must obey before it reads any detail.
  // Absent when no decision carries a rule, so old records render unchanged.
  // Retirement (r1-fixes 3.2, D25): a rule a later rule replaced, and below
  // a decision superseded or scoped to a task that resolved, leave the block
  // — derived from the record, never a clock. `SOFAR_RETIRE=off` renders
  // everything as before: the ablation arm round 3 prices this lever with.
  const retire = retireEnabled()
  const retired = retire ? retiredOrdinals(state) : new Set<number>()
  const standing = standingConstraintLines(state.decisions, STANDING_LEDGER_BUDGET, retire)
  if (standing.length > 0) {
    lines.push(...standing, '')
  }

  // Repo memory (task 6.5, BD40): hand-written repo-scoped notes with their
  // own budget. In the static head since D12 — it changes when a human edits
  // the file, which is rarer than any state-derived section below.
  const repoMemory = options?.repoMemory?.trim() ?? ''
  if (repoMemory.length > 0) {
    lines.push('Repo memory (.sofar/repo.md):')
    lines.push(clipBlockDetect(repoMemory, REPO_MEMORY_CHAR_BUDGET, REPO_MEMORY_TRUNCATION_MARKER).text)
    lines.push('')
  }

  // Compact phase tree (statuses + per-phase progress), count-capped. Done
  // phases collapse into one trailing line (task 6.2, token-opt): their
  // per-phase detail carries little resume value (plan.md keeps it), the
  // saving grows as an initiative ages, and the freed slots let more open
  // phases fit under the cap. Names keep only their leading "Phase N"
  // segment (text before " — "); names without that convention pass whole.
  const stalePhases = staleActivePhases(state)
  const staleNames = new Set(stalePhases.map((p) => p.name))
  if (!lane && state.phases.length > 0) {
    // A dropped phase is resolved, not open — leaving it in the itemized
    // list is the exact false "queued work" signal this initiative exists
    // to kill, and it would burn a capped slot to do it.
    const open = state.phases.filter((p) => p.status !== 'done' && p.status !== 'dropped')
    const donePhases = state.phases.filter((p) => p.status === 'done')
    const droppedPhases = state.phases.filter((p) => p.status === 'dropped')
    // Stale-phase marker (staleness-detection 2.2): stale phases are never
    // 'done', so every one of them lives in the itemized open list.
    lines.push('Phases:')
    for (const phase of open.slice(0, MAX_PHASE_LINES)) {
      lines.push(
        `- ${clip(phase.name, PHASE_LINE_BUDGET)} ${phaseMark(phase, staleNames)} ${phaseFraction(taskProgress([phase]))}`,
      )
    }
    if (open.length > MAX_PHASE_LINES) {
      lines.push(`- …and ${open.length - MAX_PHASE_LINES} more phases (see plan.md)`)
    }
    if (donePhases.length > 0) {
      const p = taskProgress(donePhases)
      const names = donePhases.map((ph) => ph.name.split(' — ')[0]!).join(', ')
      lines.push(clip(`- done: ${names} (${p.done}/${p.total} tasks)`, DONE_PHASES_LINE_BUDGET))
    }
    if (droppedPhases.length > 0) {
      const p = taskProgress(droppedPhases)
      const names = droppedPhases.map((ph) => ph.name.split(' — ')[0]!).join(', ')
      lines.push(clip(`- dropped: ${names} (${p.total} tasks)`, DONE_PHASES_LINE_BUDGET))
    }
    lines.push('')
  }

  // Progress + active phase. The lane has neither (D14): its sections start
  // at the concurrent-edit warning, the one plan-free hazard below.
  if (!lane) lines.push(
    `Progress: ${progressText(taskProgress(state.phases))} across ${state.phases.length} phase(s)`,
  )

  const active = lane ? undefined : state.phases.find((p) => p.name === state.current.active_phase)
  if (active !== undefined) {
    lines.push(
      `Active phase: ${clip(active.name, PHASE_LINE_BUDGET)} — ${phaseFraction(taskProgress([active]))} tasks done`,
    )
    const current = active.tasks.find((t) => t.status === 'active')
    const next = active.tasks.find((t) => t.status === 'pending')
    if (current !== undefined) {
      lines.push(`Current task: ${clip(`${current.id} ${current.title}`, TASK_LINE_BUDGET)}`)
      // File-locality hint (speed T4): the active task's most recent files,
      // newest first — silently absent when the record has no data.
      const files = state.task_files[current.id]
      if (files !== undefined && files.length > 0) {
        lines.push(`  ${clip(`files: ${files.slice(0, MAX_TASK_FILES).join(', ')}`, TASK_FILES_LINE_BUDGET - 2)}`)
      }
      // The task's latest test outcome (r1-fixes 2.5, D24) — what the record
      // already knows, so the agent need not narrate it. One budgeted line,
      // silently absent when no outcome was ever reported.
      if (options?.activity !== false) {
        const tests = taskTestsLine(state, current)
        if (tests !== null) lines.push(`  ${clip(tests, TASK_FILES_LINE_BUDGET - 2)}`)
      }
    }
    if (next !== undefined) {
      lines.push(`Next task: ${clip(`${next.id} ${next.title}`, TASK_LINE_BUDGET)}`)
    }
  } else if (!lane) {
    lines.push('Active phase: (none)')
  }

  if (!lane && state.current.next_action !== null) {
    lines.push(`Next action: ${clip(state.current.next_action, NEXT_ACTION_BUDGET)}`)
  }

  // Parallel write-backs (task 12.4, BD58 family): the next_action above is
  // last-writer-wins — when concurrent sessions wrapped with DIFFERENT next
  // actions, the losers are parallel threads the resuming agent must see,
  // directly under the scalar that swallowed them.
  const parallel = lane ? [] : overlappingWritebacks(state)
  if (parallel.length > 0) {
    lines.push(
      `⚠ Parallel write-backs — ${parallel.length} overlapping session(s) also recorded a next action:`,
    )
    for (const w of parallel.slice(0, MAX_PARALLEL_LINES)) {
      lines.push(`- ${clip(`${w.tool}, ended ${w.ended.slice(0, 10)}: ${w.next_action}`, PARALLEL_LINE_BUDGET)}`)
    }
    if (parallel.length > MAX_PARALLEL_LINES) {
      lines.push(`- …and ${parallel.length - MAX_PARALLEL_LINES} more (run sofar status)`)
    }
  }

  // Staleness heads-up (staleness-detection 2.1): mechanical events landed
  // AFTER the write-back that minted the next_action — the resuming agent
  // should distrust it in proportion. Rendered only when drift exists and
  // something ever wrote back (no write-back → no next_action to stale).
  const drift = freshnessTotal(state.freshness)
  if (!lane && drift > 0 && state.freshness.last_writeback_ts !== null) {
    lines.push(
      clip(
        `⚠ next action may be stale: ${drift} event${drift === 1 ? '' : 's'} since write-back (${describeFreshness(state.freshness.events_since_writeback)})`,
        STALENESS_LINE_BUDGET,
      ),
    )
  }

  // Notes since write-back (notes-in-digest 2.1): the content behind the
  // staleness line's note count — rendered directly under it so drift-signal
  // and drift-content read together. Also renders when nothing ever wrote
  // back (the window is the whole log; every note is un-absorbed), where the
  // header drops the write-back phrasing.
  const notes = state.freshness.notes
  if (notes.length > 0) {
    const recent = notes.slice(-MAX_NOTES)
    const skipped = notes.length - recent.length
    const label = state.freshness.last_writeback_ts !== null ? 'Notes since write-back' : 'Notes'
    lines.push(`${label}${skipped > 0 ? ` (last ${recent.length} of ${notes.length})` : ''}:`)
    for (const n of recent) {
      lines.push(`- ${clip(`${n.ts.slice(0, 10)} ${n.text}`, NOTE_LINE_BUDGET)}`)
    }
  }

  if (!lane && state.current.blocked_on !== undefined) {
    lines.push(`Blocked on: ${clip(state.current.blocked_on, BLOCKED_BUDGET)}`)
  }

  // Concurrent-edit heads-up (task 11.4, BD-P11): if another OPEN session is
  // already in these files, the orienting agent should know BEFORE it edits.
  const conflicts = openSessionFileConflicts(state)
  if (conflicts.length > 0) {
    lines.push(`⚠ Concurrent edits — ${conflicts.length} file(s) touched by multiple open sessions:`)
    for (const c of conflicts.slice(0, MAX_CONFLICT_LINES)) {
      lines.push(`- ${clip(`${c.path} (sessions ${c.sessions.join(', ')})`, CONFLICT_LINE_BUDGET)}`)
    }
    if (conflicts.length > MAX_CONFLICT_LINES) {
      lines.push(`- …and ${conflicts.length - MAX_CONFLICT_LINES} more (run sofar doctor)`)
    }
  }
  // The lane renders nothing above this point past the how-lines' own blank
  // unless a conflict fired, so the separator would double up (D14).
  if (!lane || conflicts.length > 0) lines.push('')

  // Last written-back session. When the budget cuts the summary (1.3
  // detection), the pointer to the full text rides INSIDE the budget
  // (staleness-detection 2.4) — the reader learns the render is partial and
  // where the rest lives, at no extra cap cost.
  const last = lastWithSummary(state.sessions)
  if (last !== undefined) {
    lines.push(`Last session (${last.tool}, ended ${last.ended ?? '?'}):`)
    const summary = clipDetect(last.summary!, SESSION_SUMMARY_BUDGET)
    if (summary.clipped) {
      const pointer = ` (clipped — full text in sessions/${clip(last.id, SESSION_ID_BUDGET)}.md)`
      lines.push(`  ${clip(last.summary!, Math.max(0, SESSION_SUMMARY_BUDGET - pointer.length))}${pointer}`)
    } else {
      lines.push(`  ${summary.text}`)
    }
    lines.push('')
  }

  // Driver line (session-driver 1.2): a resuming driver reads this before the
  // next action — still running means pick the run up, stopped says why not.
  const run = latestRun(state)
  if (run !== undefined) {
    lines.push(clip(`Driven: ${describeRun(run)}`, DRIVEN_LINE_BUDGET))
    lines.push('')
  }

  // Derived resume fallback (task 7.2, BD44): a newer session that worked
  // but never wrote back still leaves a usable resume point.
  // The lane's sessions never write back by design (D14), so the derived
  // resume line and the unwritten-sibling warning — both of which say a
  // write-back is missing — would fire on every one of them. In their place:
  // a count and the last few sessions' mechanical activity, newest first,
  // which is what "what was done here lately" honestly reduces to.
  if (lane && state.sessions.length > 0) {
    const worked = state.sessions.filter((s) => s.activity !== undefined).reverse()
    const since = state.sessions[0]?.started.slice(0, 10)
    lines.push(
      `Recent quick work (${plural(state.sessions.length, 'session')}, ${plural(state.decisions.length, 'decision')}` +
        `${since !== undefined ? ` since ${since}` : ''}${worked.length > LANE_RECENT_SESSIONS ? `; last ${LANE_RECENT_SESSIONS}` : ''}):`,
    )
    for (const s of worked.slice(0, LANE_RECENT_SESSIONS)) {
      lines.push(`- ${clip(`${s.started.slice(0, 10)} ${s.tool} — ${describeActivity(s.activity!)}`, DERIVED_SESSION_BUDGET)}`)
    }
    lines.push('')
  }
  const unwritten = lane ? undefined : lastUnwrittenWithActivity(state.sessions)
  if (unwritten !== undefined) {
    const fate = unwritten.ended !== undefined ? 'ended without write-back' : 'open, no write-back yet'
    const closed = unwritten.closed_reason !== undefined ? `, closed: ${unwritten.closed_reason}` : ''
    lines.push(
      clip(
        `Last session (${unwritten.tool}${closed}) ${fate} — derived: ${describeActivity(unwritten.activity!)}`,
        DERIVED_SESSION_BUDGET,
      ),
    )
    lines.push(`  (details in sessions/${clip(unwritten.id, SESSION_ID_BUDGET)}.md)`)
    lines.push('')
  }

  // Every OTHER unwritten session (record-integrity 4.3): the derived line
  // above names one, and with parallel sessions the rest used to vanish —
  // a single write-back was enough to hide them all. One budgeted line.
  const allUnwritten = lane ? [] : unwrittenSessions(state.sessions)
  const others = allUnwritten.filter((s) => s.id !== unwritten?.id)
  if (others.length > 0) {
    const named = others.slice(0, UNWRITTEN_SIBLING_CAP).map((s) => clip(s.id, SESSION_ID_BUDGET))
    const more = others.length > named.length ? `, +${others.length - named.length} more` : ''
    lines.push(
      clip(
        `⚠ ${others.length} other session(s) did work without writing back: ${named.join(', ')}${more}`,
        DERIVED_SESSION_BUDGET,
      ),
    )
    lines.push('')
  }

  // The volatile tail is built BEFORE the decision index so the ledger's cap
  // reserve can count its real length (D12): the tail renders after the
  // ledger, and the ledger is the section that yields.
  const tail: string[] = []

  // Adjacent records (record-index 3.3) — the priming line, first in the
  // tail: it is the only entry that is not about THIS record — the sections
  // above report what has happened to your work, this one reports where else
  // your work has company — and it moves whenever ANOTHER record works.
  //
  // A COUNT, never a capability blurb. An offer ("you can search the record")
  // is ignored, because nothing in it says there is anything to find; a number
  // and three names create the intent to look, which is the whole mechanism
  // this layer is for. Nothing here tells the agent what to do about it.
  //
  // D2 is in the wording, not just the doc: this is DERIVED relevance, so the
  // header says adjacency and the closing clause says offered-not-binding. The
  // record knows these initiatives worked the same files; it does not know
  // their decisions are ABOUT those files, and the line must not imply it.
  const neighbours = options?.neighbours ?? []
  if (neighbours.length > 0) {
    const named = neighbours.slice(0, MAX_NEIGHBOURS)
    // The header carries the READABLE total, not just the initiative count.
    // Ranking is by shared files — the direct edge, and the honest answer to
    // who is on your ground — which can put a record holding one decision at
    // the top. Leading with the decision total means the intent to look is
    // already created by the time the reader gets there.
    const decisions = neighbours.reduce((sum, n) => sum + n.decisions, 0)
    tail.push(
      `Adjacent records — ${plural(decisions, 'decision')} across ` +
        `${plural(neighbours.length, 'other initiative')} that have worked this one's files, densest first:`,
    )
    for (const n of named) {
      tail.push(
        `- ${clip(`${n.initiative} — ${plural(n.paths, 'shared file')}, ${plural(n.decisions, 'decision')}`, NEIGHBOUR_LINE_BUDGET)}`,
      )
    }
    const rest = neighbours.length - named.length
    tail.push(
      `${rest > 0 ? `…and ${rest} more. ` : ''}Adjacency, not aboutness — offered as worth reading, never as a rule.`,
    )
    tail.push('')
  }

  // Session identity (task 7.1, BD43): the id a host without adoption hands
  // back to sofar_start_session — Claude Code's MCP server adopts it from
  // CLAUDE_CODE_SESSION_ID (memory-lead 1.1, D3), so the line names both.
  // Per-session by definition, so it sits in the tail.
  const idLine = sessionIdLine(options?.sessionId)
  if (idLine !== null) tail.push(idLine)

  // Git state (record-integrity 4.1): one derived line, never an event. The
  // sha moves with every commit, so it sits beside the session line.
  const git = options?.git
  if (git !== undefined) {
    const sync =
      git.upstream === null
        ? 'no origin ref — never pushed'
        : git.synced
          ? `in sync with origin/${git.branch}`
          : `differs from origin/${git.branch} (${git.upstream}) — unpushed work`
    tail.push(`Git: ${clip(`${git.branch} @ ${git.head} — ${sync}`, GOAL_BUDGET)}`)
  }
  if (idLine !== null || git !== undefined) tail.push('')

  // Hook notices (D12): recent work elsewhere, closed banner, cold-resume
  // advisory, shipping — the caller's per-session lines, once a preface and
  // now the last content before the read-back. Each is already budgeted by
  // its builder; they are rendered as given, blank-line separated.
  const notices = (options?.notices ?? []).filter((n) => n.trim().length > 0)
  for (const notice of notices) tail.push(notice, '')

  // Decision index (r1-fixes 2.2, D11) — index-first, handle-first. Two
  // blocks that never repeat a byte of each other: the recent window carries
  // `[D<n>] <date> <chose> — over <over>` with the fields clipped SEPARATELY,
  // so `over` (the C3 half — what not to re-propose) survives however long
  // `chose` runs; the older decisions carry `over` only, as the rejected
  // ledger always did. `because` lives in decisions.md, named in the header:
  // on every real record the old 280-char concatenation clipped inside
  // `chose`, so the rationale it promised was already absent while the same
  // `over` text was paid twice (once here, once in the ledger). A decision
  // whose rule rendered in Standing constraints above is marked `(rule above)`
  // and gets the short chose budget — the rule IS its operative content, and
  // the index stops restating it (constraints vs rules).
  if (state.decisions.length > 0) {
    // In-force decisions keep their ordinals (D25: ids never renumber); the
    // window is the last 5 of THEM, so a superseded decision does not spend
    // a window slot restating what its successor already says. The header
    // is byte-identical to before when nothing is retired.
    const inForce = state.decisions
      .map((d, i) => ({ d, ordinal: i + 1 }))
      .filter((x) => !retired.has(x.ordinal))
    const recent = inForce.slice(-MAX_DECISIONS)
    const olderCount = inForce.length - recent.length
    const shownRules = new Set(
      standing.map((line) => /^- \[D(\d+)\]/.exec(line)?.[1]).filter((n): n is string => n !== undefined),
    )
    const count = olderCount > 0 ? `last ${recent.length} of ${inForce.length}` : `${inForce.length}`
    const window = retired.size > 0 ? `${count} in force, ${retired.size} retired` : count
    lines.push(`Recent decisions (${window}; full text in decisions.md):`)
    for (const { d, ordinal } of recent) {
      const ruled = d.rule !== undefined && shownRules.has(String(ordinal))
      const chose = clip(d.chose, ruled ? DECISION_RULED_CHOSE_BUDGET : DECISION_CHOSE_BUDGET)
      const over = hasRealAlternative(d.over) ? ` — over ${clip(d.over, REJECTED_OVER_LINE_BUDGET)}` : ''
      const marks = [...(ruled ? ['rule above'] : []), ...(retire && d.supersedes !== undefined ? [`supersedes ${d.supersedes}`] : [])]
      const mark = marks.length > 0 ? ` (${marks.join('; ')})` : ''
      lines.push(`- [D${ordinal}] ${d.ts.slice(0, 10)}${mark} ${chose}${over}`)
    }

    // Older rejected approaches (D-ledger, Phase-3 validated; scoped by D11):
    // the `over` of every decision OUTSIDE the recent window that recorded a
    // real alternative — the breadth of "what NOT to re-propose" the window
    // drops. A record of ≤5 decisions has nothing older and renders no ledger.
    const rejected = inForce
      .slice(0, olderCount)
      .map(({ d, ordinal }) => ({ ordinal, over: d.over }))
      .filter((d) => hasRealAlternative(d.over))
    if (rejected.length > 0) {
      lines.push(`Earlier rejected approaches — do NOT re-propose (${rejected.length} older):`)
      // The ledger is the last budgeted section before the tail (Next ids,
      // adjacency, session, git, notices, read-back, footer), so it is the
      // one that yields to the hard cap: it takes the smaller of its own
      // budget and what the cap leaves once the tail is reserved. Before
      // D11 a heavy record (24 verbatim rules, 28 older decisions) rendered
      // at exactly 10,000 chars and enforceStatusLimit cut the tail — the
      // two lines the session is meant to read last. Pure function of the
      // inputs: byte-stable.
      const ledgerBudget = Math.min(
        REJECTED_LEDGER_BUDGET,
        STATUS_CHAR_LIMIT - lines.join('\n').length - tail.join('\n').length - PROTOCOL_TAIL_RESERVE,
      )
      let used = 0
      let shown = 0
      for (const d of rejected) {
        const line = `- [D${d.ordinal}] ${clip(d.over, REJECTED_OVER_LINE_BUDGET)}`
        if (used + line.length + 1 > ledgerBudget) break
        lines.push(line)
        used += line.length + 1
        shown++
      }
      if (shown < rejected.length) {
        lines.push(`- …and ${rejected.length - shown} more (see decisions.md)`)
      }
    }
    lines.push('')
  }

  // Next handles (r1-fixes 2.1, D10): what the decision or memory this
  // session is about to log will be called, so it can be cited in the same
  // turn — no fold, no get_state, no `sofar find` to learn it. Digest-only,
  // like the read-back line below, and only once the record has any: a fresh
  // record's D1/M1 needs no line.
  if (state.decisions.length > 0 || state.memories.length > 0) {
    lines.push(`Next ids: D${state.decisions.length + 1} (decision), M${state.memories.length + 1} (memory)`, '')
  }

  lines.push(...tail)

  // Read-back protocol (drift-hardening 3.1): the LAST content line — the
  // final thing read before the session starts acting is the instruction to
  // prove it parsed the record. A misread restated out loud is drift caught
  // at zero cost; aviation read-back, applied to resume. Digest-only (agent
  // protocol, not terminal furniture) and rendered only when the record has
  // something to restate, so empty records stay byte-identical.
  if (!lane && (state.current.next_action !== null || standing.length > 0)) {
    lines.push(
      'Read-back: before acting, restate goal, next action, and standing constraints in one sentence each — if your restatement disagrees with this block, trust the block and say so.',
      '',
    )
  }

  lines.push('(generated by sofar — full detail in plan.md, decisions.md, sessions/)')
  return enforceStatusLimit(lines.join('\n').replace(/\n+$/, '') + '\n')
}
