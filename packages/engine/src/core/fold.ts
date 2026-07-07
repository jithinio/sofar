import { readFileSync } from 'node:fs'
import { validateEnvelope, type EventEnvelope } from './envelope'
import {
  isKnownEventType,
  validatePayload,
  type CorrectionPayload,
  type DecisionLoggedPayload,
  type FileTouchedPayload,
  type InitiativeCreatedPayload,
  type PhaseStatus,
  type PhaseStatusChangedPayload,
  type PlanUpdatedPayload,
  type SessionClosedPayload,
  type SessionEndedPayload,
  type SessionStartedPayload,
  type TaskAddedPayload,
  type TaskStatus,
  type TaskStatusChangedPayload,
} from '@harness/schema'

/**
 * Fold/replay: events.jsonl → InitiativeState (SPEC §State).
 *
 * Tolerance rules (CLAUDE.md): corrupt or unknown lines are skipped with a
 * warning, never fatal, never rewritten. A torn final line is just a corrupt
 * line. The fold is deterministic — the same log always produces a
 * deep-equal state and identical warnings.
 *
 * Corrections (BD8): a `correction` event voids the event its `ref` points
 * at — the target is skipped during replay. Replacement content, if any, is
 * appended as a fresh event by the corrector.
 */

export interface TaskState {
  id: string
  title: string
  status: TaskStatus
}

export interface PhaseState {
  name: string
  status: PhaseStatus
  tasks: TaskState[]
}

export interface DecisionState {
  id: string
  ts: string
  chose: string
  over: string
  because: string
}

/** List cap for derived activity arrays (BD44) — overflow becomes a "+N more" sentinel. */
export const ACTIVITY_LIST_CAP = 20

/**
 * Derived per-session activity (task 7.2, BD44): the resume fallback for
 * sessions that never wrote back. Aggregated from mechanical events
 * attributed by envelope.session — file_touched, command_run,
 * task_status_changed. Events on session "cli" are never aggregated (cli is
 * not a session). Deterministic: log order in, capped lists out.
 */
export interface SessionActivity {
  /** Deduped file_touched paths in first-touch order (capped + sentinel). */
  files: string[]
  /** Count of command_run events. */
  commands: number
  /** task_status_changed as "<id> → <status>" in log order (capped + sentinel). */
  task_changes: string[]
}

export interface SessionState {
  id: string
  tool: string
  model?: string
  started: string
  ended?: string
  summary?: string
  next_action?: string
  /** Reason from the session_closed that set `ended` (BD21/BD44), if any. */
  closed_reason?: string
  /** Present only when ≥1 mechanical event is attributed to this session (BD44). */
  activity?: SessionActivity
}

export interface InitiativeState {
  slug: string
  goal: string
  phases: PhaseState[]
  decisions: DecisionState[]
  sessions: SessionState[]
  files_touched: string[]
  current: {
    active_phase: string | null
    next_action: string | null
    blocked_on?: string
  }
  cursor: string | null
}

export interface FoldResult {
  state: InitiativeState
  warnings: string[]
}

export function emptyState(): InitiativeState {
  return {
    slug: '',
    goal: '',
    phases: [],
    decisions: [],
    sessions: [],
    files_touched: [],
    current: { active_phase: null, next_action: null },
    cursor: null,
  }
}

interface ParsedLine {
  lineNo: number
  event: EventEnvelope
}

/** Fold a log file. The file must exist; foldLines is the pure core. */
export function foldLog(logPath: string): FoldResult {
  return foldLines(readFileSync(logPath, 'utf8').split('\n'))
}

export function foldLines(lines: readonly string[]): FoldResult {
  const warnings: string[] = []
  const parsed: ParsedLine[] = []

  // Pass 1 — decode lines tolerantly, collect corrected (voided) event ids.
  lines.forEach((raw, index) => {
    const lineNo = index + 1
    const line = raw.trim()
    if (line.length === 0) return // blank/trailing lines are not corruption

    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      warnings.push(`line ${lineNo}: unparseable JSON — skipped (torn or corrupt line)`)
      return
    }

    const check = validateEnvelope(decoded)
    if (!check.ok) {
      const detail = check.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
      warnings.push(`line ${lineNo}: invalid envelope (${detail}) — skipped`)
      return
    }

    parsed.push({ lineNo, event: check.event })
  })

  const voided = new Set<string>()
  for (const { event } of parsed) {
    if (event.type !== 'correction') continue
    if (validatePayload('correction', event.payload).ok) {
      voided.add((event.payload as unknown as CorrectionPayload).ref)
    }
  }

  // Pass 2 — replay in log order.
  const state = emptyState()
  const blockNotes = new Map<string, string>() // task id → note from its blocking event
  const activity = new Map<string, ActivityAcc>() // envelope.session → derived activity (BD44)

  for (const { lineNo, event } of parsed) {
    // Cursor tracks the last envelope-valid event: sync (export/import)
    // moves events by envelope, regardless of payload validity.
    state.cursor = event.id

    if (voided.has(event.id)) continue

    if (!isKnownEventType(event.type)) {
      warnings.push(`line ${lineNo}: unknown event type "${event.type}" — skipped`)
      continue
    }

    const payloadCheck = validatePayload(event.type, event.payload)
    if (!payloadCheck.ok) {
      warnings.push(`line ${lineNo}: invalid ${event.type} payload (${payloadCheck.errors.join('; ')}) — skipped`)
      continue
    }

    applyEvent(state, event, blockNotes, warnings, lineNo)
    recordActivity(activity, event)
  }

  attachActivity(state, activity)
  deriveCurrent(state, blockNotes)
  return { state, warnings }
}

// ---------------------------------------------------------------------------
// Derived per-session activity (task 7.2, BD44).
// ---------------------------------------------------------------------------

interface ActivityAcc {
  files: string[]
  fileSet: Set<string>
  filesOverflow: number
  commands: number
  taskChanges: string[]
  taskChangesOverflow: number
}

/**
 * Aggregate mechanical events by envelope.session. Runs on payload-valid,
 * unvoided events only (called after applyEvent), so corrections void
 * activity the same way they void state. Session "cli" is excluded — cli is
 * not a session and its events belong to no resume point.
 */
function recordActivity(acc: Map<string, ActivityAcc>, event: EventEnvelope): void {
  if (event.session === 'cli') return
  if (event.type !== 'file_touched' && event.type !== 'command_run' && event.type !== 'task_status_changed') {
    return
  }
  let a = acc.get(event.session)
  if (a === undefined) {
    a = { files: [], fileSet: new Set(), filesOverflow: 0, commands: 0, taskChanges: [], taskChangesOverflow: 0 }
    acc.set(event.session, a)
  }
  switch (event.type) {
    case 'file_touched': {
      const p = event.payload as unknown as FileTouchedPayload
      if (a.fileSet.has(p.path)) break // dedupe — first touch wins the slot
      a.fileSet.add(p.path)
      if (a.files.length < ACTIVITY_LIST_CAP) a.files.push(p.path)
      else a.filesOverflow += 1
      break
    }
    case 'command_run': {
      a.commands += 1
      break
    }
    case 'task_status_changed': {
      const p = event.payload as unknown as TaskStatusChangedPayload
      if (a.taskChanges.length < ACTIVITY_LIST_CAP) a.taskChanges.push(`${p.id} → ${p.status}`)
      else a.taskChangesOverflow += 1
      break
    }
  }
}

/**
 * Attach accumulated activity to REGISTERED sessions only — events carrying
 * a session id with no session_started stay unattached (same no-stub rule as
 * session_closed, BD21). Capped lists carry a "+N more" sentinel so the
 * fold stays deterministic and bounded.
 */
function attachActivity(state: InitiativeState, acc: Map<string, ActivityAcc>): void {
  for (const session of state.sessions) {
    const a = acc.get(session.id)
    if (a === undefined) continue
    session.activity = {
      files: a.filesOverflow > 0 ? [...a.files, `+${a.filesOverflow} more`] : a.files,
      commands: a.commands,
      task_changes:
        a.taskChangesOverflow > 0 ? [...a.taskChanges, `+${a.taskChangesOverflow} more`] : a.taskChanges,
    }
  }
}

function findTask(state: InitiativeState, id: string): TaskState | undefined {
  for (const phase of state.phases) {
    const task = phase.tasks.find((t) => t.id === id)
    if (task) return task
  }
  return undefined
}

function findOrCreatePhase(
  state: InitiativeState,
  name: string,
  warnings: string[],
  lineNo: number,
): PhaseState {
  let phase = state.phases.find((p) => p.name === name)
  if (!phase) {
    warnings.push(`line ${lineNo}: phase "${name}" not in plan — created implicitly`)
    phase = { name, status: 'pending', tasks: [] }
    state.phases.push(phase)
  }
  return phase
}

function applyEvent(
  state: InitiativeState,
  event: EventEnvelope,
  blockNotes: Map<string, string>,
  warnings: string[],
  lineNo: number,
): void {
  switch (event.type) {
    case 'initiative_created': {
      const p = event.payload as unknown as InitiativeCreatedPayload
      state.slug = p.slug
      state.goal = p.goal
      break
    }
    case 'plan_updated': {
      const p = event.payload as unknown as PlanUpdatedPayload
      if (p.plan.goal !== undefined) state.goal = p.plan.goal
      state.phases = p.plan.phases.map((phase) => ({
        name: phase.name,
        status: phase.status ?? 'pending',
        tasks: phase.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status ?? 'pending',
        })),
      }))
      break
    }
    case 'phase_status_changed': {
      const p = event.payload as unknown as PhaseStatusChangedPayload
      const phase = findOrCreatePhase(state, p.phase, warnings, lineNo)
      phase.status = p.status
      break
    }
    case 'task_added': {
      const p = event.payload as unknown as TaskAddedPayload
      if (findTask(state, p.id)) {
        warnings.push(`line ${lineNo}: task "${p.id}" already exists — task_added skipped`)
        break
      }
      const phase = findOrCreatePhase(state, p.phase, warnings, lineNo)
      phase.tasks.push({ id: p.id, title: p.title, status: p.status ?? 'pending' })
      break
    }
    case 'task_status_changed': {
      const p = event.payload as unknown as TaskStatusChangedPayload
      const task = findTask(state, p.id)
      if (!task) {
        warnings.push(`line ${lineNo}: task "${p.id}" not found — task_status_changed skipped`)
        break
      }
      task.status = p.status
      if (p.status === 'blocked' && p.note) {
        blockNotes.set(p.id, p.note)
      } else if (p.status !== 'blocked') {
        blockNotes.delete(p.id)
      }
      break
    }
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      state.decisions.push({
        id: event.id,
        ts: event.ts,
        chose: p.chose,
        over: p.over,
        because: p.because,
      })
      break
    }
    case 'session_started': {
      const p = event.payload as unknown as SessionStartedPayload
      if (state.sessions.some((s) => s.id === event.session)) {
        warnings.push(`line ${lineNo}: session "${event.session}" already started — skipped`)
        break
      }
      const session: SessionState = { id: event.session, tool: p.tool, started: event.ts }
      if (p.model !== undefined) session.model = p.model
      state.sessions.push(session)
      break
    }
    case 'session_ended': {
      const p = event.payload as unknown as SessionEndedPayload
      const sid = p.session_id ?? event.session
      let session = state.sessions.find((s) => s.id === sid)
      if (!session) {
        warnings.push(`line ${lineNo}: session "${sid}" ended without session_started — stub created`)
        session = { id: sid, tool: 'unknown', started: event.ts }
        state.sessions.push(session)
      }
      session.ended = event.ts
      session.summary = p.summary
      session.next_action = p.next_action
      state.current.next_action = p.next_action
      break
    }
    case 'session_closed': {
      // Mechanical close (SessionEnd hook fallback): sets ended only (plus
      // the close reason for the 7.2 derived resume line, BD44). Never
      // touches summary/next_action — those belong to session_ended (the
      // write-back), and never creates stub sessions (a close marker for an
      // unregistered session carries no information).
      const p = event.payload as unknown as SessionClosedPayload
      const session = state.sessions.find((s) => s.id === event.session)
      if (!session) {
        warnings.push(
          `line ${lineNo}: session "${event.session}" closed without session_started — skipped`,
        )
        break
      }
      if (session.ended === undefined) {
        session.ended = event.ts
        session.closed_reason = p.reason
      }
      break
    }
    case 'file_touched': {
      const p = event.payload as unknown as FileTouchedPayload
      if (!state.files_touched.includes(p.path)) state.files_touched.push(p.path)
      break
    }
    case 'command_run':
    case 'note_added':
    case 'correction':
      // Log-only for state purposes: commands and notes live in the record
      // (projections may surface them); corrections were applied in pass 1.
      break
  }
}

function deriveCurrent(state: InitiativeState, blockNotes: Map<string, string>): void {
  const active = state.phases.find((p) => p.status === 'active')
  state.current.active_phase = active ? active.name : null

  const blocked: string[] = []
  for (const phase of state.phases) {
    if (phase.status === 'blocked') blocked.push(`phase ${phase.name}`)
    for (const task of phase.tasks) {
      if (task.status === 'blocked') {
        const note = blockNotes.get(task.id)
        blocked.push(note ? `task ${task.id}: ${note}` : `task ${task.id} (${task.title})`)
      }
    }
  }
  if (blocked.length > 0) {
    state.current.blocked_on = blocked.join('; ')
  }
}
