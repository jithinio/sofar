import {
  freshnessTotal,
  openSessionFileConflicts,
  overlappingWritebacks,
  staleActivePhases,
  type InitiativeState,
  type SessionState,
} from '../../core/fold'
import {
  clip,
  clipBlockDetect,
  clipDetect,
  describeActivity,
  describeFreshness,
  pct,
  taskProgress,
} from './shared'

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
const DECISION_LINE_BUDGET = 280
const MAX_DECISIONS = 5
// Rejected-approaches ledger (D-ledger, Phase-3 validated): breadth of "what
// NOT to re-propose" that the last-5 recent window drops — over-only, heavily
// clipped, so it stays compact even as decisions accumulate.
const REJECTED_OVER_LINE_BUDGET = 90
const REJECTED_LEDGER_BUDGET = 2_800
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
  lines.push(`Goal: ${state.goal || '(none recorded)'}`)

  const [done, total] = taskProgress(state.phases)
  lines.push(`Progress: ${done}/${total} tasks done (${pct(done, total)}) across ${state.phases.length} phase(s)`)
  lines.push('')

  const stalePhases = staleActivePhases(state)
  const staleNames = new Set(stalePhases.map((p) => p.name))

  if (state.phases.length > 0) {
    lines.push('Phases:')
    for (const phase of state.phases) {
      const [phaseDone, phaseTotal] = taskProgress([phase])
      lines.push(`- ${phase.name} ${phaseMark(phase, staleNames)} ${phaseDone}/${phaseTotal}`)
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
}

export function renderStatus(state: InitiativeState, options?: StatusOptions): string {
  const lines: string[] = []
  lines.push(`# Sofar status: ${state.slug || '(unnamed initiative)'}`, '')

  // Session identity (task 7.1, BD43) — near the top, before everything else:
  // this is the id the agent must hand back to sofar_start_session.
  const sessionId = options?.sessionId?.trim() ?? ''
  if (sessionId.length > 0) {
    lines.push(
      `Session: ${clip(sessionId, SESSION_ID_BUDGET)} — when calling sofar_start_session, pass this as session_id.`,
      '',
    )
  }

  lines.push(`Goal: ${state.goal ? clip(state.goal, GOAL_BUDGET) : '(none recorded)'}`, '')

  // Progress + active phase.
  const [done, total] = taskProgress(state.phases)
  lines.push(`Progress: ${done}/${total} tasks done (${pct(done, total)}) across ${state.phases.length} phase(s)`)

  const active = state.phases.find((p) => p.name === state.current.active_phase)
  if (active !== undefined) {
    const [phaseDone, phaseTotal] = taskProgress([active])
    lines.push(`Active phase: ${clip(active.name, PHASE_LINE_BUDGET)} — ${phaseDone}/${phaseTotal} tasks done`)
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
    }
    if (next !== undefined) {
      lines.push(`Next task: ${clip(`${next.id} ${next.title}`, TASK_LINE_BUDGET)}`)
    }
  } else {
    lines.push('Active phase: (none)')
  }

  if (state.current.next_action !== null) {
    lines.push(`Next action: ${clip(state.current.next_action, NEXT_ACTION_BUDGET)}`)
  }

  // Parallel write-backs (task 12.4, BD58 family): the next_action above is
  // last-writer-wins — when concurrent sessions wrapped with DIFFERENT next
  // actions, the losers are parallel threads the resuming agent must see,
  // directly under the scalar that swallowed them.
  const parallel = overlappingWritebacks(state)
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
  if (drift > 0 && state.freshness.last_writeback_ts !== null) {
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

  if (state.current.blocked_on !== undefined) {
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
  lines.push('')

  // Repo memory (task 6.5, BD40): hand-written repo-scoped notes, surfaced
  // after the goal/current sections with their own budget.
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
  if (state.phases.length > 0) {
    const open = state.phases.filter((p) => p.status !== 'done')
    const donePhases = state.phases.filter((p) => p.status === 'done')
    // Stale-phase marker (staleness-detection 2.2): stale phases are never
    // 'done', so every one of them lives in the itemized open list.
    const staleNames = new Set(staleActivePhases(state).map((p) => p.name))
    lines.push('Phases:')
    for (const phase of open.slice(0, MAX_PHASE_LINES)) {
      const [phaseDone, phaseTotal] = taskProgress([phase])
      lines.push(`- ${clip(phase.name, PHASE_LINE_BUDGET)} ${phaseMark(phase, staleNames)} ${phaseDone}/${phaseTotal}`)
    }
    if (open.length > MAX_PHASE_LINES) {
      lines.push(`- …and ${open.length - MAX_PHASE_LINES} more phases (see plan.md)`)
    }
    if (donePhases.length > 0) {
      const [doneDone, doneTotal] = taskProgress(donePhases)
      const names = donePhases.map((p) => p.name.split(' — ')[0]!).join(', ')
      lines.push(clip(`- done: ${names} (${doneDone}/${doneTotal} tasks)`, DONE_PHASES_LINE_BUDGET))
    }
    lines.push('')
  }

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

  // Derived resume fallback (task 7.2, BD44): a newer session that worked
  // but never wrote back still leaves a usable resume point.
  const unwritten = lastUnwrittenWithActivity(state.sessions)
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

  // Recent decisions, one line each, newest last.
  if (state.decisions.length > 0) {
    const recent = state.decisions.slice(-MAX_DECISIONS)
    const skipped = state.decisions.length - recent.length
    lines.push(`Recent decisions${skipped > 0 ? ` (last ${recent.length} of ${state.decisions.length})` : ''}:`)
    for (const d of recent) {
      lines.push(`- ${clip(`${d.ts.slice(0, 10)} chose ${d.chose} over ${d.over} — ${d.because}`, DECISION_LINE_BUDGET)}`)
    }
    lines.push('')
  }

  // Rejected-approaches ledger (D-ledger, Phase-3 validated): the `over` clause
  // of every decision with a real alternative — the breadth of "what NOT to
  // re-propose" that the last-5 window (and its 280-char clip) drop. Over-only;
  // the `because` lives in decisions.md / get_state view:"full". This closes the
  // M4 (dead-end recurrence) gap the resume ablation found in the bare digest.
  const rejected = state.decisions.filter((d) => hasRealAlternative(d.over))
  if (rejected.length > 0) {
    lines.push(`Rejected approaches — do NOT re-propose (${rejected.length}):`)
    let used = 0
    let shown = 0
    for (const d of rejected) {
      const line = `- ${clip(d.over, REJECTED_OVER_LINE_BUDGET)}`
      if (used + line.length + 1 > REJECTED_LEDGER_BUDGET) break
      lines.push(line)
      used += line.length + 1
      shown++
    }
    if (shown < rejected.length) {
      lines.push(`- …and ${rejected.length - shown} more (see decisions.md)`)
    }
    lines.push('')
  }

  lines.push('(generated by sofar — full detail in plan.md, decisions.md, sessions/)')
  return enforceStatusLimit(lines.join('\n').replace(/\n+$/, '') + '\n')
}
