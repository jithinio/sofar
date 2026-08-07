/**
 * Event payload schemas + validation — the swappable part (SPEC §Event
 * types, BD6). This directory is the ONLY home for payload shapes; the
 * envelope (src/core/envelope.ts) is stable and lives outside it.
 */

/**
 * `blocked` and `dropped` are NOT synonyms (task-drop-state D1). `blocked`
 * means "wants to happen, cannot yet" — it stays outstanding and keeps
 * nagging. `dropped` is terminal: decided not to happen. Both `done` and
 * `dropped` are RESOLVED — nothing remains — but only `done` means
 * delivered, so drops are counted and rendered as their own third term
 * rather than folded into either the numerator or the denominator.
 */
export const TASK_STATUSES = ['pending', 'active', 'done', 'blocked', 'dropped'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const PHASE_STATUSES = ['pending', 'active', 'done', 'blocked', 'dropped'] as const
export type PhaseStatus = (typeof PHASE_STATUSES)[number]

/**
 * Initiative-level status. The same two terminal words as tasks and phases,
 * for the same reason (task-drop-state D1): `done` = finished, `dropped` =
 * abandoned, and neither is a near-synonym of the other. `blocked` is
 * deliberately absent — a blocked initiative is still active work, which is
 * what its blocked TASKS already say; adding it here would invent a third
 * reading of the same fact.
 *
 * `active` is the default for every log that carries no status event, so an
 * initiative written before this existed folds exactly as it always did.
 */
export const INITIATIVE_STATUSES = ['active', 'done', 'dropped'] as const
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number]

/** Terminal statuses: no work remains, whether or not anything was built. */
export const RESOLVED_TASK_STATUSES: readonly TaskStatus[] = ['done', 'dropped']

export function isResolvedTaskStatus(s: string): boolean {
  return (RESOLVED_TASK_STATUSES as readonly string[]).includes(s)
}

/**
 * Terminal initiative statuses. "Closed" is the initiative-level word for what
 * tasks call "resolved" — it matches the command that gets there (`sofar
 * close`), so the vocabulary the user types is the vocabulary the code uses.
 */
export const CLOSED_INITIATIVE_STATUSES: readonly InitiativeStatus[] = ['done', 'dropped']

export function isClosedInitiativeStatus(s: string): boolean {
  return (CLOSED_INITIATIVE_STATUSES as readonly string[]).includes(s)
}

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
/**
 * The initiative's own status changed. `note` is the reason, and it is
 * REQUIRED for `dropped` (task-drop-state D3): a whole initiative abandoned
 * with nothing said reads as forgotten rather than decided, and unlike a
 * dropped task there is no surviving sibling work to infer the reason from.
 *
 * Reopening is just another event with status `active` — history stays
 * append-only, so a closed initiative is never a dead end in the log.
 */
export interface InitiativeStatusChangedPayload { status: InitiativeStatus; note?: string }
export interface PlanUpdatedPayload { plan: PlanStructure }
export interface PhaseStatusChangedPayload { phase: string; status: PhaseStatus }
export interface TaskAddedPayload { phase: string; id: string; title: string; status?: TaskStatus }
export interface TaskStatusChangedPayload { id: string; status: TaskStatus; note?: string }
/**
 * `rule` (drift-hardening D1): optional standing-constraint clause — one short
 * imperative every future session must obey. Its presence is what makes a
 * decision a standing constraint; there is no separate flag. Render contract:
 * verbatim on every surface, never clipped, never aged out — the C-abl
 * ablation showed decisions are the load-bearing resume field, and clipped
 * normative text is how dead ends recur.
 */
export interface DecisionLoggedPayload { chose: string; over: string; because: string; rule?: string }
export interface SessionStartedPayload { tool: string; model?: string }
export interface SessionEndedPayload { session_id?: string; summary: string; next_action: string }
/**
 * Mechanical session close (SessionEnd hook fallback). Deliberately has no
 * summary/next_action: those belong to session_ended (the write-back) and a
 * mechanical close must never clobber them during fold.
 */
export interface SessionClosedPayload { reason: string }
export interface FileTouchedPayload { path: string; op: string }
export interface CommandRunPayload { cmd: string }
export interface NoteAddedPayload { text: string }
/**
 * A fact its author declares repo memory — operational knowledge that is not a
 * decision (a release command, a failure mode) and so can never be observed as
 * repo-general from citation behaviour, because nothing derives a fact that was
 * never written down (repo-memory-capture D1).
 */
export interface MemoryPromotedPayload { text: string }
export interface CorrectionPayload { ref: string; reason?: string }

export interface KnownEventPayloads {
  initiative_created: InitiativeCreatedPayload
  initiative_status_changed: InitiativeStatusChangedPayload
  plan_updated: PlanUpdatedPayload
  phase_status_changed: PhaseStatusChangedPayload
  task_added: TaskAddedPayload
  task_status_changed: TaskStatusChangedPayload
  decision_logged: DecisionLoggedPayload
  session_started: SessionStartedPayload
  session_ended: SessionEndedPayload
  session_closed: SessionClosedPayload
  file_touched: FileTouchedPayload
  command_run: CommandRunPayload
  note_added: NoteAddedPayload
  memory_promoted: MemoryPromotedPayload
  correction: CorrectionPayload
}

export type KnownEventType = keyof KnownEventPayloads

export const EVENT_TYPES = [
  'initiative_created',
  'initiative_status_changed',
  'plan_updated',
  'phase_status_changed',
  'task_added',
  'task_status_changed',
  'decision_logged',
  'session_started',
  'session_ended',
  'session_closed',
  'file_touched',
  'command_run',
  'note_added',
  'memory_promoted',
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
/** Optional, but non-empty when present — an empty rule would render an empty constraint. */
function optNonEmptyStr(v: unknown): boolean {
  return v === undefined || str(v)
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
function initiativeStatus(v: unknown): v is InitiativeStatus {
  return typeof v === 'string' && (INITIATIVE_STATUSES as readonly string[]).includes(v)
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

/** One status this build did not recognise, rewritten so the plan survives. */
export interface CoercedStatus {
  /** Human path into the plan, e.g. `phases[0].tasks[1]`. */
  path: string
  /** Task id, or phase name for a phase-level coercion. */
  subject: string
  /** The unrecognised value as written. */
  status: string
}

/**
 * Forward compatibility for plan_updated (task-drop-state D2).
 *
 * plan_updated is a FULL REPLACE, so rejecting one for a single unreadable
 * task status throws away the entire plan — a log written by a NEWER engine
 * would silently revert this reader's goal, done statuses, and every task and
 * phase added in that same event. That cliff is what made `dropped` expensive
 * to add; retiring it here means the NEXT status added is cheap.
 *
 * Statuses this build does not know are rewritten IN PLACE to `pending` and
 * reported. `pending` is the conservative target: an unreadable status counts
 * as outstanding, so a stale reader over-reports remaining work rather than
 * quietly claiming something was resolved. Callers are expected to warn — the
 * fix for a coercion is always to upgrade, never to edit the log.
 */
export function coerceUnknownPlanStatuses(payload: unknown): CoercedStatus[] {
  const coerced: CoercedStatus[] = []
  if (!isObj(payload) || !isObj(payload.plan) || !Array.isArray(payload.plan.phases)) return coerced

  payload.plan.phases.forEach((phase, pi) => {
    if (!isObj(phase)) return
    if (phase.status !== undefined && !phaseStatus(phase.status)) {
      coerced.push({
        path: `phases[${pi}]`,
        subject: str(phase.name) ? phase.name : `#${pi}`,
        status: String(phase.status),
      })
      phase.status = 'pending'
    }
    if (!Array.isArray(phase.tasks)) return
    phase.tasks.forEach((task, ti) => {
      if (!isObj(task) || optTaskStatus(task.status)) return
      coerced.push({
        path: `phases[${pi}].tasks[${ti}]`,
        subject: str(task.id) ? task.id : `#${ti}`,
        status: String(task.status),
      })
      task.status = 'pending'
    })
  })
  return coerced
}

const validators: Record<KnownEventType, (p: Obj, errors: string[]) => void> = {
  initiative_created(p, e) {
    if (!str(p.slug)) e.push('slug: must be a non-empty string')
    if (!str(p.goal)) e.push('goal: must be a non-empty string')
  },
  initiative_status_changed(p, e) {
    if (!initiativeStatus(p.status)) e.push(`status: must be one of ${INITIATIVE_STATUSES.join('|')}`)
    if (!optStr(p.note)) e.push('note: must be a string')
    // task-drop-state D3: a drop with no stated reason reads as forgotten.
    if (p.status === 'dropped' && !str(p.note)) {
      e.push('note: required when status is "dropped" — say why it was abandoned')
    }
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
    if (!optNonEmptyStr(p.rule)) e.push('rule: must be a non-empty string when present')
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
  session_closed(p, e) {
    if (!str(p.reason)) e.push('reason: must be a non-empty string')
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
  memory_promoted(p, e) {
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
