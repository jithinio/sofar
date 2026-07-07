import type { InitiativeState, SessionState } from '../../core/fold'
import { clip, describeActivity, pct, taskProgress } from './shared'

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
const SESSION_SUMMARY_BUDGET = 1_200
const DERIVED_SESSION_BUDGET = 600
const DECISION_LINE_BUDGET = 280
const MAX_DECISIONS = 5

/** Hard cap: anything over the limit is cut to fit, marker included. */
export function enforceStatusLimit(text: string): string {
  if (text.length <= STATUS_CHAR_LIMIT) return text
  const marker = `\n${STATUS_TRUNCATION_MARKER}\n`
  return text.slice(0, STATUS_CHAR_LIMIT - marker.length) + marker
}

/**
 * Multi-line budget clip for hand-written blocks: unlike clip() it preserves
 * line structure (repo.md is prose the author formatted); the truncation
 * marker lands INSIDE the budget so the section total never exceeds it.
 */
function clipBlock(text: string, budget: number, marker: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= budget) return trimmed
  const suffix = `\n${marker}`
  return `${trimmed.slice(0, Math.max(0, budget - suffix.length)).trimEnd()}${suffix}`
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

  if (state.phases.length > 0) {
    lines.push('Phases:')
    for (const phase of state.phases) {
      const [phaseDone, phaseTotal] = taskProgress([phase])
      lines.push(`- ${phase.name} [${phase.status}] ${phaseDone}/${phaseTotal}`)
      for (const task of phase.tasks) {
        lines.push(`  - ${TASK_MARKS[task.status] ?? '[ ]'} ${task.id} ${task.title}`)
      }
    }
    lines.push('')
  }

  lines.push(`Next action: ${state.current.next_action ?? '(none recorded)'}`)
  if (state.current.blocked_on !== undefined) {
    lines.push(`Blocked on: ${state.current.blocked_on}`)
  }

  const last = lastWithSummary(state.sessions)
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
  if (state.current.blocked_on !== undefined) {
    lines.push(`Blocked on: ${clip(state.current.blocked_on, BLOCKED_BUDGET)}`)
  }
  lines.push('')

  // Repo memory (task 6.5, BD40): hand-written repo-scoped notes, surfaced
  // after the goal/current sections with their own budget.
  const repoMemory = options?.repoMemory?.trim() ?? ''
  if (repoMemory.length > 0) {
    lines.push('Repo memory (.sofar/repo.md):')
    lines.push(clipBlock(repoMemory, REPO_MEMORY_CHAR_BUDGET, REPO_MEMORY_TRUNCATION_MARKER))
    lines.push('')
  }

  // Compact phase tree (statuses + per-phase progress), count-capped.
  if (state.phases.length > 0) {
    lines.push('Phases:')
    for (const phase of state.phases.slice(0, MAX_PHASE_LINES)) {
      const [phaseDone, phaseTotal] = taskProgress([phase])
      lines.push(`- ${clip(phase.name, PHASE_LINE_BUDGET)} [${phase.status}] ${phaseDone}/${phaseTotal}`)
    }
    if (state.phases.length > MAX_PHASE_LINES) {
      lines.push(`- …and ${state.phases.length - MAX_PHASE_LINES} more phases (see plan.md)`)
    }
    lines.push('')
  }

  // Last written-back session.
  const last = lastWithSummary(state.sessions)
  if (last !== undefined) {
    lines.push(`Last session (${last.tool}, ended ${last.ended ?? '?'}):`)
    lines.push(`  ${clip(last.summary!, SESSION_SUMMARY_BUDGET)}`)
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

  lines.push('(generated by sofar — full detail in plan.md, decisions.md, sessions/)')
  return enforceStatusLimit(lines.join('\n').replace(/\n+$/, '') + '\n')
}
