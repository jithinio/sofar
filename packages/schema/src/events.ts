/**
 * Event payload schemas + validation — the swappable part (SPEC §Event
 * types, BD6). This directory is the ONLY home for payload shapes; the
 * envelope (src/core/envelope.ts) is stable and lives outside it.
 */

export const TASK_STATUSES = ['pending', 'active', 'done', 'blocked'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const PHASE_STATUSES = ['pending', 'active', 'done', 'blocked'] as const
export type PhaseStatus = (typeof PHASE_STATUSES)[number]

export interface PlanTaskInput {
  id: string
  title: string
  status?: TaskStatus
}

export interface PlanPhaseInput {
  name: string
  status?: PhaseStatus
  tasks: PlanTaskInput[]
}

/** Full plan structure carried by plan_updated (full replace, SPEC §MCP tools). */
export interface PlanStructure {
  goal?: string
  phases: PlanPhaseInput[]
}

export interface InitiativeCreatedPayload { slug: string; goal: string }
export interface PlanUpdatedPayload { plan: PlanStructure }
export interface PhaseStatusChangedPayload { phase: string; status: PhaseStatus }
export interface TaskAddedPayload { phase: string; id: string; title: string; status?: TaskStatus }
export interface TaskStatusChangedPayload { id: string; status: TaskStatus; note?: string }
export interface DecisionLoggedPayload { chose: string; over: string; because: string }
export interface SessionStartedPayload { tool: string; model?: string }
export interface SessionEndedPayload { session_id?: string; summary: string; next_action: string }
export interface FileTouchedPayload { path: string; op: string }
export interface CommandRunPayload { cmd: string }
export interface NoteAddedPayload { text: string }
export interface CorrectionPayload { ref: string; reason?: string }

export interface KnownEventPayloads {
  initiative_created: InitiativeCreatedPayload
  plan_updated: PlanUpdatedPayload
  phase_status_changed: PhaseStatusChangedPayload
  task_added: TaskAddedPayload
  task_status_changed: TaskStatusChangedPayload
  decision_logged: DecisionLoggedPayload
  session_started: SessionStartedPayload
  session_ended: SessionEndedPayload
  file_touched: FileTouchedPayload
  command_run: CommandRunPayload
  note_added: NoteAddedPayload
  correction: CorrectionPayload
}

export type KnownEventType = keyof KnownEventPayloads

export const EVENT_TYPES = [
  'initiative_created',
  'plan_updated',
  'phase_status_changed',
  'task_added',
  'task_status_changed',
  'decision_logged',
  'session_started',
  'session_ended',
  'file_touched',
  'command_run',
  'note_added',
  'correction',
] as const satisfies readonly KnownEventType[]

export function isKnownEventType(type: string): type is KnownEventType {
  return (EVENT_TYPES as readonly string[]).includes(type)
}

export type PayloadValidation = { ok: true } | { ok: false; errors: string[] }

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function str(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}
function optStr(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}
function taskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v)
}
function optTaskStatus(v: unknown): boolean {
  return v === undefined || taskStatus(v)
}
function phaseStatus(v: unknown): v is PhaseStatus {
  return typeof v === 'string' && (PHASE_STATUSES as readonly string[]).includes(v)
}

function validatePlan(plan: unknown, errors: string[]): void {
  if (!isObj(plan)) {
    errors.push('plan: must be an object')
    return
  }
  if (plan.goal !== undefined && !str(plan.goal)) errors.push('plan.goal: must be a non-empty string')
  if (!Array.isArray(plan.phases)) {
    errors.push('plan.phases: must be an array')
    return
  }
  plan.phases.forEach((phase, pi) => {
    if (!isObj(phase)) {
      errors.push(`plan.phases[${pi}]: must be an object`)
      return
    }
    if (!str(phase.name)) errors.push(`plan.phases[${pi}].name: must be a non-empty string`)
    if (phase.status !== undefined && !phaseStatus(phase.status)) {
      errors.push(`plan.phases[${pi}].status: must be one of ${PHASE_STATUSES.join('|')}`)
    }
    if (!Array.isArray(phase.tasks)) {
      errors.push(`plan.phases[${pi}].tasks: must be an array`)
      return
    }
    phase.tasks.forEach((task, ti) => {
      if (!isObj(task)) {
        errors.push(`plan.phases[${pi}].tasks[${ti}]: must be an object`)
        return
      }
      if (!str(task.id)) errors.push(`plan.phases[${pi}].tasks[${ti}].id: must be a non-empty string`)
      if (!str(task.title)) errors.push(`plan.phases[${pi}].tasks[${ti}].title: must be a non-empty string`)
      if (!optTaskStatus(task.status)) {
        errors.push(`plan.phases[${pi}].tasks[${ti}].status: must be one of ${TASK_STATUSES.join('|')}`)
      }
    })
  })
}

const validators: Record<KnownEventType, (p: Obj, errors: string[]) => void> = {
  initiative_created(p, e) {
    if (!str(p.slug)) e.push('slug: must be a non-empty string')
    if (!str(p.goal)) e.push('goal: must be a non-empty string')
  },
  plan_updated(p, e) {
    validatePlan(p.plan, e)
  },
  phase_status_changed(p, e) {
    if (!str(p.phase)) e.push('phase: must be a non-empty string')
    if (!phaseStatus(p.status)) e.push(`status: must be one of ${PHASE_STATUSES.join('|')}`)
  },
  task_added(p, e) {
    if (!str(p.phase)) e.push('phase: must be a non-empty string')
    if (!str(p.id)) e.push('id: must be a non-empty string')
    if (!str(p.title)) e.push('title: must be a non-empty string')
    if (!optTaskStatus(p.status)) e.push(`status: must be one of ${TASK_STATUSES.join('|')}`)
  },
  task_status_changed(p, e) {
    if (!str(p.id)) e.push('id: must be a non-empty string')
    if (!taskStatus(p.status)) e.push(`status: must be one of ${TASK_STATUSES.join('|')}`)
    if (!optStr(p.note)) e.push('note: must be a string')
  },
  decision_logged(p, e) {
    if (!str(p.chose)) e.push('chose: must be a non-empty string')
    if (!str(p.over)) e.push('over: must be a non-empty string')
    if (!str(p.because)) e.push('because: must be a non-empty string')
  },
  session_started(p, e) {
    if (!str(p.tool)) e.push('tool: must be a non-empty string')
    if (!optStr(p.model)) e.push('model: must be a string')
  },
  session_ended(p, e) {
    if (!optStr(p.session_id)) e.push('session_id: must be a string')
    if (!str(p.summary)) e.push('summary: must be a non-empty string')
    if (!str(p.next_action)) e.push('next_action: must be a non-empty string')
  },
  file_touched(p, e) {
    if (!str(p.path)) e.push('path: must be a non-empty string')
    if (!str(p.op)) e.push('op: must be a non-empty string')
  },
  command_run(p, e) {
    if (!str(p.cmd)) e.push('cmd: must be a non-empty string')
  },
  note_added(p, e) {
    if (!str(p.text)) e.push('text: must be a non-empty string')
  },
  correction(p, e) {
    if (!str(p.ref)) e.push('ref: must be a non-empty string (target event id)')
    if (!optStr(p.reason)) e.push('reason: must be a string')
  },
}

/**
 * Validate a payload against its event type's schema. Unknown types are
 * rejected here; the fold treats them as skip-with-warning, and the MCP
 * tools treat them as typed errors.
 */
export function validatePayload(type: string, payload: unknown): PayloadValidation {
  if (!isKnownEventType(type)) {
    return { ok: false, errors: [`unknown event type: ${type}`] }
  }
  if (!isObj(payload)) {
    return { ok: false, errors: ['payload: must be a JSON object'] }
  }
  const errors: string[] = []
  validators[type](payload, errors)
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
