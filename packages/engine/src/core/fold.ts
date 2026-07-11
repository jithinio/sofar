import { readFileSync } from 'node:fs'
import { validateEnvelope, type EventEnvelope } from './envelope'
import {
  isKnownEventType,
  validatePayload,
  type CorrectionPayload,
  type DecisionLoggedPayload,
  type FileTouchedPayload,
  type InitiativeCreatedPayload,
  type NoteAddedPayload,
  type PhaseStatus,
  type PhaseStatusChangedPayload,
  type PlanUpdatedPayload,
  type SessionClosedPayload,
  type SessionEndedPayload,
  type SessionStartedPayload,
  type TaskAddedPayload,
  type TaskStatus,
  type TaskStatusChangedPayload,
} from '@sofar/schema'

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

/** One un-absorbed note: appended after the last write-back (notes-in-digest 1.2). */
export interface NoteEntry {
  ts: string
  text: string
}

/**
 * Fold-time freshness (staleness-detection 1.1): how much MECHANICAL record
 * activity landed after the last write-back (session_ended). Derived purely
 * from event order in the log — zero new event types, any source incl. cli.
 * The counts are the drift signal behind "next action may be stale": every
 * counted event postdates the next_action the last write-back recorded.
 *
 * `notes` (notes-in-digest 1.2) carries the CONTENT for the one drift kind
 * that has prose: the counters say THAT the record moved, the notes say WHAT
 * changed. Same selection window as the counters by construction — living in
 * this struct means the session_ended reset clears both together, so signal
 * and content can never disagree. When nothing ever wrote back the window is
 * the whole log: every note is un-absorbed. Log order, uncapped here
 * (notes are hand-written, low-frequency); render surfaces cap and clip.
 */
export interface FreshnessState {
  /** Events appended after the last session_ended, by kind. */
  events_since_writeback: {
    /** file_touched */
    files: number
    /** command_run */
    commands: number
    /** task_status_changed */
    tasks: number
    /** note_added */
    notes: number
    /** decision_logged */
    decisions: number
  }
  /** Notes in the window, {ts, text} in log order — notes.length === counts.notes. */
  notes: NoteEntry[]
  /** ts of the last session_ended, or null when nothing ever wrote back. */
  last_writeback_ts: string | null
}

/** Total drift since the last write-back — the "N events" of the staleness line. */
export function freshnessTotal(freshness: FreshnessState): number {
  const c = freshness.events_since_writeback
  return c.files + c.commands + c.tasks + c.notes + c.decisions
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
  freshness: FreshnessState
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
    freshness: emptyFreshness(),
    cursor: null,
  }
}

function emptyFreshness(): FreshnessState {
  return {
    events_since_writeback: { files: 0, commands: 0, tasks: 0, notes: 0, decisions: 0 },
    notes: [],
    last_writeback_ts: null,
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
    recordFreshness(state, event)
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

// ---------------------------------------------------------------------------
// Fold-time freshness (staleness-detection 1.1).
// ---------------------------------------------------------------------------

/**
 * Count mechanical drift after the last write-back. Runs on payload-valid,
 * unvoided events only (same guard as applyEvent/recordActivity), on ANY
 * session/source including "cli" — a cli-appended task change stales the
 * next_action exactly as an agent edit does. session_ended is the ONLY
 * reset: it is the write-back that mints a new next_action; a mechanical
 * session_closed carries no summary and resets nothing.
 */
function recordFreshness(state: InitiativeState, event: EventEnvelope): void {
  const counts = state.freshness.events_since_writeback
  switch (event.type) {
    case 'session_ended':
      state.freshness = { ...emptyFreshness(), last_writeback_ts: event.ts }
      break
    case 'file_touched':
      counts.files += 1
      break
    case 'command_run':
      counts.commands += 1
      break
    case 'task_status_changed':
      counts.tasks += 1
      break
    case 'note_added':
      counts.notes += 1
      state.freshness.notes.push({
        ts: event.ts,
        text: (event.payload as unknown as NoteAddedPayload).text,
      })
      break
    case 'decision_logged':
      counts.decisions += 1
      break
  }
}

// ---------------------------------------------------------------------------
// Cross-session derivations (Phase 11, D-P11) — read-only over folded state.
// ---------------------------------------------------------------------------

export interface FileConflict {
  /** A file path touched by more than one still-open session. */
  path: string
  /** The open sessions (started, no write-back) that touched it. */
  sessions: string[]
}

/** A phase whose tasks are all done but that was never marked done (D-P11). */
export interface StalePhase {
  name: string
  /** The lagging status the phase is stuck on — never 'done'. */
  status: PhaseStatus
  /** How many tasks are done (== the phase's task total). */
  tasks_done: number
}

/**
 * Stale-active-phase detection (staleness-detection 1.2): every task in the
 * phase is done but the phase itself was never marked done — the missing
 * phase_status_changed keeps it presenting as live work. Extracted from
 * doctor's inline D-P11 check so ONE detector feeds both surfaces (doctor
 * WARN + status renders). Empty phases are never stale (nothing was
 * completed); order follows the plan's phase order — deterministic.
 */
export function staleActivePhases(state: InitiativeState): StalePhase[] {
  const stale: StalePhase[] = []
  for (const phase of state.phases) {
    if (phase.status === 'done' || phase.tasks.length === 0) continue
    if (phase.tasks.every((t) => t.status === 'done')) {
      stale.push({ name: phase.name, status: phase.status, tasks_done: phase.tasks.length })
    }
  }
  return stale
}

/**
 * Live concurrent-edit hazards: files touched by ≥2 sessions that are still
 * OPEN (session_started with no session_ended/session_closed). Ended sessions
 * are treated as wrapped, so this fires only in the genuine live-overlap
 * window — the "another agent is in this file right now" signal. Deterministic
 * (sorted by path); the "+N more" activity sentinel is not a real file and is
 * skipped.
 */
export function openSessionFileConflicts(state: InitiativeState): FileConflict[] {
  const byFile = new Map<string, string[]>()
  for (const session of state.sessions) {
    if (session.ended !== undefined || session.activity === undefined) continue
    for (const file of session.activity.files) {
      if (file.startsWith('+')) continue // the "+N more" overflow sentinel
      const owners = byFile.get(file) ?? []
      owners.push(session.id)
      byFile.set(file, owners)
    }
  }
  const conflicts: FileConflict[] = []
  for (const [path, sessions] of byFile) {
    if (sessions.length >= 2) conflicts.push({ path, sessions })
  }
  conflicts.sort((a, b) => a.path.localeCompare(b.path))
  return conflicts
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
