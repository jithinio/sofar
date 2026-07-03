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
  type SessionEndedPayload,
  type SessionStartedPayload,
  type TaskAddedPayload,
  type TaskStatus,
  type TaskStatusChangedPayload,
} from '../schema/events'

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

export interface SessionState {
  id: string
  tool: string
  started: string
  ended?: string
  summary?: string
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
  }

  deriveCurrent(state, blockNotes)
  return { state, warnings }
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
      state.sessions.push({ id: event.session, tool: p.tool, started: event.ts })
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
      state.current.next_action = p.next_action
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
