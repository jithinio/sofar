/**
 * Event payload schemas + validation — the swappable part (SPEC §Event types
 * , BD6). This directory is the ONLY home for payload shapes; the
 * envelope (src/core/envelope.ts) is stable and lives outside it.
 */

import { guardSpecErrors } from './guards'

// The guard grammar is part of the decision_logged payload contract, so it
// lives here and is re-exported from the package entry — one definition
// shared by payload validation and by the fold that evaluates it.
export * from './guards'

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
 *
 * `superseded` (initiative-supersession D1) is the third closed word, and the
 * one that carries a pointer: the work did not finish here and was not
 * abandoned — it CONTINUES in `successor`. It is a status rather than a new
 * event type so every reader that already asks "is this closed" (list, next,
 * doctor, the SessionStart banner, the statusline) treats it correctly for
 * free, and only the surfaces that can say WHERE it went need to learn more.
 */
export const INITIATIVE_STATUSES = ['active', 'done', 'dropped', 'superseded'] as const
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number]

/** The slug shape, shared with tool-inputs (which re-exports it as SLUG_RE). */
export const INITIATIVE_SLUG_RE = /^[a-z0-9-]+$/

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
export const CLOSED_INITIATIVE_STATUSES: readonly InitiativeStatus[] = ['done', 'dropped', 'superseded']

export function isClosedInitiativeStatus(s: string): boolean {
  return (CLOSED_INITIATIVE_STATUSES as readonly string[]).includes(s)
}

/**
 * Where a task wants to be run (session-driver 3.2, D10). Hints, not orders:
 * anything the RUN states — the model/effort `run_started.surface` recorded,
 * or the driver's own flags — wins over them, because a run whose second half
 * ran a different model than its record names is two runs wearing one id.
 * What the run leaves open, the task fills.
 *
 * `agent` names an ADAPTER (`claude-code`, `codex`), and it is the one field
 * the driver cannot honour halfway: a run that cannot reach the named agent,
 * or whose policy that agent cannot run, refuses to start rather than falling
 * back to the default one.
 *
 * Nothing else records the route: the plan carries the hint and the launched
 * session's own `session_started` carries the tool and model it actually ran,
 * so a third copy on the handoff would be the one that goes stale (D3).
 */
export interface TaskRoute {
  /** Adapter name the driver must launch this task with. */
  agent?: string
  model?: string
  effort?: string
}

export interface PlanTaskInput {
  id: string
  title: string
  status?: TaskStatus
  route?: TaskRoute
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
 *
 * `overrides` (commit-attribution 5.2) is what the close-time audit found
 * still outstanding, recorded because the close went ahead anyway. It is the
 * whole mechanism: a hard refusal on a solo tool grows a `--force` and the
 * flag becomes the habit, while "closed with 3 tasks outstanding, overridden"
 * rendered in the digest forever is a sentence its author has to live beside.
 * Absent means the audit found nothing — never that it was skipped.
 */
export interface InitiativeStatusChangedPayload {
  status: InitiativeStatus
  note?: string
  overrides?: string[]
  /**
   * The slug this record continues in. REQUIRED for `superseded` and rejected
   * on every other status — a successor on a `done` record is a contradiction
   * the validator refuses rather than one the fold has to interpret. Recorded
   * ONLY here, on the predecessor (initiative-supersession D1): the successor's
   * side is derived at read time, never written on the successor.
   */
  successor?: string
}
export interface PlanUpdatedPayload { plan: PlanStructure }
/**
 * `note` (phase-lifecycle 2.1) is the same field task_status_changed carries,
 * one level up, and required for `dropped` for the same reason: a phase
 * abandoned without a stated reason is indistinguishable from one quietly
 * forgotten, and nothing else in the record explains it.
 */
export interface PhaseStatusChangedPayload { phase: string; status: PhaseStatus; note?: string }
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
export interface DecisionLoggedPayload {
  chose: string
  over: string
  because: string
  rule?: string
  /**
   * `guard` (drift-hardening D3): the mechanical half of the SAME clause —
   * a `path:`/`cmd:` glob list (src/guards.ts) the fold matches against
   * file_touched / command_run events logged after this decision. Valid only
   * alongside `rule`: a guard with no clause has nothing to cite when it
   * fires, and what it produces is a WARNING that never changes an exit code.
   */
  guard?: string
}
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
export interface MemoryPromotedPayload {
  text: string
  /**
   * The QUALIFIED handle `<slug> M<n>` of the memory this one replaces
   * (r1-fixes 1.5, D8). Facts go stale; the record is append-only, so the
   * replacement is a new promotion that names the old one, and readers
   * (memory.md, doctor's repo-memory axis) retire the old handle.
   */
  supersedes?: string
}

/** A qualified memory handle: `<slug> M<n>`. */
export const MEMORY_HANDLE_RE = /^([a-z0-9-]+) M([1-9][0-9]*)$/

/** What a review concluded. `blocked` means it could not be performed at all. */
export const REVIEW_VERDICTS = ['pass', 'findings', 'blocked'] as const
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number]

/** Whether the review covered one phase or the whole initiative at close. */
export const REVIEW_SCOPES = ['phase', 'final'] as const
export type ReviewScope = (typeof REVIEW_SCOPES)[number]

/**
 * A review that was actually performed (commit-attribution 4.4).
 *
 * `watermark` is the load-bearing field, not `verdict`. It is the sha the
 * review read through, and it is what makes the NEXT review's range computable
 * — watermark..HEAD filtered to this initiative's attributed commits (D9).
 * Without it a range could only be derived from task timestamps, which is the
 * time-window guess record-integrity D6 rejected. That is why a review is an
 * EVENT and could never have been a note.
 *
 * `findings` are the ones that survived, one line each. An empty list with
 * verdict `pass` is a legitimate outcome; an empty list with verdict `findings`
 * is not, and validation rejects it — a review that reports findings must say
 * what they were, or it is a rubber stamp wearing the wrong hat.
 */
export interface ReviewRecordedPayload {
  scope: ReviewScope
  verdict: ReviewVerdict
  /** Sha read through; omitted only when the range was empty. */
  watermark?: string
  /** Phase name for a `phase` review; absent for `final`. */
  phase?: string
  findings?: string[]
}
export interface CorrectionPayload { ref: string; reason?: string }

/**
 * Driver events (session-driver 1.2, D2). A RUN is one `sofar drive`
 * invocation over an initiative: it launches agent sessions one after another
 * and the record is its only state — every launch, handoff and stop is an
 * event here, so a driver can be killed and another can pick the run up from
 * the fold alone. The driver is NOT a session and never registers as one: its
 * events carry envelope session "cli" and name the run in the payload, so a
 * run is never mistaken for an unregistered (misrouted) session.
 */

/**
 * How a run decides when a session ends. `task`: one task per session, no
 * context sensing needed — identical on every agent and model, which is why it
 * is the default. `threshold`: pack tasks into a session until the context
 * gauge reaches `threshold_pct`, then hand off at the next task boundary.
 */
export const RUN_POLICIES = ['task', 'threshold'] as const
export type RunPolicy = (typeof RUN_POLICIES)[number]

/**
 * Why a driven session ended and the next one starts. `stall` is a session
 * that ended with no task change; `needs_user` is a write-back whose next
 * action names a decision only the operator can take.
 */
export const HANDOFF_REASONS = ['task_done', 'threshold', 'stall', 'needs_user'] as const
export type HandoffReason = (typeof HANDOFF_REASONS)[number]

/** Why the run itself ended — the stop rules, plus the two ways a run can die. */
export const RUN_STOP_REASONS = [
  'closed',
  'needs_user',
  'stall',
  'cost_cap',
  'max_sessions',
  'interrupted',
  'error',
] as const
export type RunStopReason = (typeof RUN_STOP_REASONS)[number]

export interface RunStartedPayload {
  /** Run id minted by the driver (a ulid) — the key every handoff and the stop cite. */
  run: string
  /** Adapter name, e.g. `claude-code`: which headless agent the run launches. */
  adapter: string
  policy: RunPolicy
  /** Context percentage at which a session is told to finish and hand off; REQUIRED for `threshold`. */
  threshold_pct?: number
  /**
   * Tokens the session's context window holds — the DENOMINATOR
   * `threshold_pct` is a percentage of, and REQUIRED for `threshold` for the
   * same reason the percentage is: 80% of 200k and 80% of 1M are different
   * runs, so a record carrying only the percentage cannot say what the last
   * driver actually nudged at. Sofar never infers it from the model name — a
   * model table it cannot keep true would mis-time every handoff silently —
   * so the operator states it and the record keeps it (session-driver 2.3).
   */
  context_window?: number
  max_sessions?: number
  /**
   * The permission surface every session in the run was launched under
   * (session-driver 2.4, D8) — what the driver PINNED, never what the session
   * could ultimately do: the agent's settings file is one source among the
   * operator's own and allow rules union across them. Absent on a run whose
   * adapter pins nothing. `model`/`effort` are recorded here so a reader can
   * tell a run that pinned them from one that left them to whatever the
   * operator's mutable config said that day.
   */
  surface?: RunSurface
}

/** What `run_started.surface` carries; the driver's own type is engine-side. */
export interface RunSurface {
  permission_mode: string
  allow: string[]
  deny?: string[]
  model?: string
  effort?: string
}
export interface HandoffPayload {
  run: string
  /** The session that just ended — registered here by its own session_started. */
  session_id: string
  reason: HandoffReason
  /** Task the session was working, when the driver knows it. */
  task?: string
  /** Context tokens the session held when it ended, when the adapter could report them. */
  tokens?: number
  /**
   * How the agent process ended, when that is worth knowing (r1-fixes 1.6,
   * D9): the exit code or signal, a spawn error, the last stderr line. Set
   * on stalls and on any unclean exit; never consulted for `reason`, which
   * the driver reads from the fold alone (session-driver D5).
   */
  detail?: string
}
export interface RunStoppedPayload {
  run: string
  reason: RunStopReason
  /** What happened; REQUIRED for `error` — a run that died unexplained is one nobody can resume. */
  note?: string
}
/**
 * An operator asking the driver of `run` to end it from OUTSIDE the driver
 * (in-session-drive D2) — `sofar drive --stop`, for a detached driver no ^C can
 * reach. A request, never a stop: only the driver writes `run_stopped`, after
 * reading the handoff of the session it signalled.
 */
export interface RunStopRequestedPayload {
  run: string
}

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
  review_recorded: ReviewRecordedPayload
  run_started: RunStartedPayload
  handoff: HandoffPayload
  run_stopped: RunStoppedPayload
  run_stop_requested: RunStopRequestedPayload
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
  'review_recorded',
  'run_started',
  'handoff',
  'run_stopped',
  'run_stop_requested',
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

/**
 * A task's routing hint (3.2). Validated strictly, unlike a task STATUS: a
 * status is an enum a newer engine can extend, so an unknown one is coerced
 * rather than allowed to reject the plan (D2), while a route carries no enum
 * at all — an agent name is a free string the DRIVER resolves, and a field of
 * the wrong type here can only come from a broken writer.
 */
function validateRoute(route: unknown, path: string, errors: string[]): void {
  if (route === undefined) return
  if (!isObj(route)) {
    errors.push(`${path}: must be an object`)
    return
  }
  for (const key of ['agent', 'model', 'effort'] as const) {
    if (!optNonEmptyStr(route[key])) errors.push(`${path}.${key}: must be a non-empty string when present`)
  }
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
      validateRoute(task.route, `plan.phases[${pi}].tasks[${ti}].route`, errors)
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
    // initiative-supersession D1: the pointer IS the status. Without it a
    // superseded record points nowhere; with it on any other status the
    // record says two things at once.
    if (p.status === 'superseded') {
      if (!(str(p.successor) && INITIATIVE_SLUG_RE.test(p.successor))) {
        e.push('successor: required when status is "superseded" — the slug the work continues in ([a-z0-9-]+)')
      }
    } else if (p.successor !== undefined) {
      e.push('successor: only allowed when status is "superseded"')
    }
    if (p.overrides !== undefined && !(Array.isArray(p.overrides) && p.overrides.every(str))) {
      e.push('overrides: must be an array of non-empty strings when present')
    }
  },
  plan_updated(p, e) {
    validatePlan(p.plan, e)
  },
  phase_status_changed(p, e) {
    if (!str(p.phase)) e.push('phase: must be a non-empty string')
    if (!phaseStatus(p.status)) e.push(`status: must be one of ${PHASE_STATUSES.join('|')}`)
    if (!optStr(p.note)) e.push('note: must be a string')
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
    if (p.guard !== undefined) {
      // A guard is the mechanical half of a rule (D3), so it cannot stand
      // alone: the violation it raises has to name the clause it enforces.
      if (!str(p.rule)) e.push('guard: requires `rule` — a guard with no clause has nothing to cite')
      e.push(...guardSpecErrors(p.guard))
    }
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
    if (p.supersedes !== undefined && !(str(p.supersedes) && MEMORY_HANDLE_RE.test(p.supersedes as string))) {
      e.push('supersedes: must be a qualified memory handle `<slug> M<n>` when present')
    }
  },
  review_recorded(p, e) {
    if (!(REVIEW_SCOPES as readonly unknown[]).includes(p.scope)) {
      e.push(`scope: must be one of ${REVIEW_SCOPES.join('|')}`)
    }
    if (!(REVIEW_VERDICTS as readonly unknown[]).includes(p.verdict)) {
      e.push(`verdict: must be one of ${REVIEW_VERDICTS.join('|')}`)
    }
    if (p.watermark !== undefined && !str(p.watermark)) {
      e.push('watermark: must be a non-empty string when present')
    }
    if (p.phase !== undefined && !str(p.phase)) {
      e.push('phase: must be a non-empty string when present')
    }
    if (p.findings !== undefined && !(Array.isArray(p.findings) && p.findings.every(str))) {
      e.push('findings: must be an array of non-empty strings when present')
    }
    // A verdict of `findings` with nothing listed is a rubber stamp wearing the
    // wrong hat: it claims something was found while recording nothing anyone
    // can act on, and the next review would have no idea what to carry forward.
    if (p.verdict === 'findings' && !(Array.isArray(p.findings) && p.findings.length > 0)) {
      e.push('findings: required and non-empty when verdict is `findings`')
    }
  },
  run_started(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    if (!str(p.adapter)) e.push('adapter: must be a non-empty string')
    if (!(RUN_POLICIES as readonly unknown[]).includes(p.policy)) {
      e.push(`policy: must be one of ${RUN_POLICIES.join('|')}`)
    }
    if (
      p.threshold_pct !== undefined &&
      !(Number.isInteger(p.threshold_pct) && (p.threshold_pct as number) > 0 && (p.threshold_pct as number) <= 100)
    ) {
      e.push('threshold_pct: must be an integer from 1 to 100 when present')
    }
    if (
      p.context_window !== undefined &&
      !(Number.isInteger(p.context_window) && (p.context_window as number) > 0)
    ) {
      e.push('context_window: must be a positive integer when present')
    }
    // A threshold policy with no threshold cannot be replayed: the next driver
    // to pick the run up would have to guess the number this one ran under.
    // Both halves, for one reason: a percentage with no denominator names no
    // number of tokens at all.
    if (p.policy === 'threshold' && p.threshold_pct === undefined) {
      e.push('threshold_pct: required when policy is `threshold`')
    }
    if (p.policy === 'threshold' && p.context_window === undefined) {
      e.push('context_window: required when policy is `threshold` — the percentage needs its denominator')
    }
    if (p.max_sessions !== undefined && !(Number.isInteger(p.max_sessions) && (p.max_sessions as number) > 0)) {
      e.push('max_sessions: must be a positive integer when present')
    }
    // A surface with no mode and no rules records nothing while claiming to:
    // a reader would take it as "the driver pinned something" and could not
    // say what. Absent means ambient, which is a different and honest fact.
    if (p.surface !== undefined) {
      const s = p.surface as Record<string, unknown>
      if (typeof s !== 'object' || s === null || Array.isArray(p.surface)) {
        e.push('surface: must be an object when present')
      } else {
        if (!str(s.permission_mode)) e.push('surface.permission_mode: must be a non-empty string')
        if (!(Array.isArray(s.allow) && s.allow.every(str))) {
          e.push('surface.allow: must be an array of non-empty strings')
        }
        if (s.deny !== undefined && !(Array.isArray(s.deny) && s.deny.every(str))) {
          e.push('surface.deny: must be an array of non-empty strings when present')
        }
        if (s.model !== undefined && !str(s.model)) e.push('surface.model: must be a non-empty string when present')
        if (s.effort !== undefined && !str(s.effort)) e.push('surface.effort: must be a non-empty string when present')
      }
    }
  },
  handoff(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    if (!str(p.session_id)) e.push('session_id: must be a non-empty string')
    if (!(HANDOFF_REASONS as readonly unknown[]).includes(p.reason)) {
      e.push(`reason: must be one of ${HANDOFF_REASONS.join('|')}`)
    }
    if (p.task !== undefined && !str(p.task)) e.push('task: must be a non-empty string when present')
    if (p.tokens !== undefined && !(Number.isInteger(p.tokens) && (p.tokens as number) >= 0)) {
      e.push('tokens: must be a non-negative integer when present')
    }
    if (p.detail !== undefined && !str(p.detail)) e.push('detail: must be a non-empty string when present')
  },
  run_stopped(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
    if (!(RUN_STOP_REASONS as readonly unknown[]).includes(p.reason)) {
      e.push(`reason: must be one of ${RUN_STOP_REASONS.join('|')}`)
    }
    if (!optStr(p.note)) e.push('note: must be a string')
    // A run that died unexplained is one nobody can resume — the same rule
    // that makes a dropped task or initiative say why.
    if (p.reason === 'error' && !str(p.note)) {
      e.push('note: required when reason is `error` — say what failed')
    }
  },
  run_stop_requested(p, e) {
    if (!str(p.run)) e.push('run: must be a non-empty string')
  },
  correction(p, e) {
    if (!str(p.ref)) e.push('ref: must be a non-empty string (target event id)')
    if (!optStr(p.reason)) e.push('reason: must be a string')
  },
}

/**
 * Who appends an event type — what a CLI-dialect agent writes by hand, and
 * what it must leave alone (r1-fixes 1.3). `command` types have a CLI command
 * that appends them with the bookkeeping done; `hook` and `driver` types are
 * mechanical, and an agent appending one forges a fact it did not observe.
 */
export const EVENT_WRITERS = ['agent', 'command', 'hook', 'driver'] as const
export type EventWriter = (typeof EVENT_WRITERS)[number]

export interface EventTypeReference {
  writer: EventWriter
  /** The command that appends it (`command`), or what to run around it. */
  via?: string
  /** One line: what the event records. */
  summary: string
  /** Field grammar: `name` required, `name?` optional, `a|b` an enum, rules in parens. */
  fields: string
  /** A payload that VALIDATES — the suite pins every one against validatePayload. */
  example: Obj
}

/**
 * The payload reference `sofar event types` prints (r1-fixes 1.3).
 *
 * The AGENTS.md dialect showed payloads for five event types and left the
 * rest to discovery, so MCP-less agents spent tool calls reading source or
 * appending until validation stopped refusing — plan_updated, a nested full
 * replace, most of all. It lives HERE because payload shapes live only in
 * this package (CLAUDE.md guard-rails): a reference kept beside the engine
 * would be a second copy of the schema, free to drift from the validators.
 * Drift is still possible in `fields` prose, so enums interpolate the same
 * constants the validators read, and every `example` is validated by test.
 * Keyed by KnownEventType, so a new event type does not compile without one.
 */
export const EVENT_TYPE_REFERENCE: Record<KnownEventType, EventTypeReference> = {
  initiative_created: {
    writer: 'command',
    via: 'sofar new <slug> --goal "<one line>"',
    summary: 'a new initiative and its goal — one per project or roadmap, not per feature',
    fields: 'slug ([a-z0-9-]+), goal',
    example: { slug: 'my-project', goal: 'Ship the booking flow' },
  },
  initiative_status_changed: {
    writer: 'command',
    via: 'sofar close [slug] [--drop --reason <why> | --superseded-by <slug>]; sofar switch <slug> reopens',
    summary: 'the initiative closed or reopened',
    fields: `status: ${INITIATIVE_STATUSES.join('|')}, note? (required for dropped), successor? (required for superseded, else rejected), overrides?: string[]`,
    example: { status: 'done', note: 'all phases shipped' },
  },
  plan_updated: {
    writer: 'agent',
    summary: 'the WHOLE plan — a full replace: resend every phase and task each time, or the omitted ones vanish',
    fields: `plan: {goal?, phases: [{name, status?: ${PHASE_STATUSES.join('|')}, tasks: [{id, title, status?: ${TASK_STATUSES.join('|')}, route?: {agent?, model?, effort?}}]}]}`,
    example: {
      plan: {
        goal: 'Ship the booking flow',
        phases: [
          {
            name: 'Phase 1 — Data model',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'Schema and migrations', status: 'active' },
              { id: '1.2', title: 'Repository layer', status: 'pending' },
            ],
          },
        ],
      },
    },
  },
  phase_status_changed: {
    writer: 'agent',
    summary: 'one phase changed status (name it exactly as in the plan)',
    fields: `phase, status: ${PHASE_STATUSES.join('|')}, note? (say why when dropped)`,
    example: { phase: 'Phase 1 — Data model', status: 'done' },
  },
  task_added: {
    writer: 'agent',
    summary: 'one task appended to an existing phase, without resending the plan',
    fields: `phase, id, title, status?: ${TASK_STATUSES.join('|')}`,
    example: { phase: 'Phase 1 — Data model', id: '1.3', title: 'Seed data', status: 'pending' },
  },
  task_status_changed: {
    writer: 'agent',
    summary: 'one task changed status',
    fields: `id, status: ${TASK_STATUSES.join('|')}, note? (say why when blocked or dropped)`,
    example: { id: '1.1', status: 'done' },
  },
  decision_logged: {
    writer: 'agent',
    summary: 'a design decision: what was chosen, over what, and why',
    fields: 'chose, over, because, rule? (one imperative every later session must obey), guard? (path:<globs> or cmd:<globs>; only with rule)',
    example: { chose: 'SQLite via better-sqlite3', over: 'Postgres', because: 'single-user local app, zero ops' },
  },
  session_started: {
    writer: 'agent',
    summary: 'register your session id — once; a repeat is a no-op',
    fields: 'tool (your agent name), model?',
    example: { tool: 'codex', model: 'gpt-5.6-sol' },
  },
  session_ended: {
    writer: 'agent',
    summary: 'the write-back the next session reads first — MANDATORY before finishing',
    fields: 'summary, next_action (the single next step)',
    example: { summary: 'Phase 1 done; tests pass', next_action: 'Start 2.1: booking API' },
  },
  session_closed: {
    writer: 'hook',
    summary: 'mechanical close from the SessionEnd hook',
    fields: 'reason',
    example: { reason: 'exit' },
  },
  file_touched: {
    writer: 'hook',
    summary: 'a file edit captured by the PostToolUse hook',
    fields: 'path, op',
    example: { path: 'src/app.ts', op: 'edit' },
  },
  command_run: {
    writer: 'hook',
    summary: 'a shell command captured by the PostToolUse hook',
    fields: 'cmd',
    example: { cmd: 'npm test' },
  },
  note_added: {
    writer: 'agent',
    summary: 'free-form context for later sessions (findings, measurements, caveats)',
    fields: 'text',
    example: { text: 'Hidden tests expect 422 on validation errors, not 400.' },
  },
  memory_promoted: {
    writer: 'command',
    via: 'sofar remember "<fact>" [--supersedes "<slug> M<n>"] [--initiative <slug>]  (or `sofar remember -` with the text on stdin, `sofar remember @<file>`)',
    summary: 'an operational fact for repo memory (a release command, a failure mode) — not a decision',
    fields: 'text, supersedes? (qualified handle `<slug> M<n>` of the fact this one replaces)',
    example: { text: 'Run `bun test` from the repo root; per-package runs miss the setup file.' },
  },
  review_recorded: {
    writer: 'agent',
    via: 'sofar review [slug] prints the packet; append this after performing the review',
    summary: 'a review that was actually performed',
    fields: `scope: ${REVIEW_SCOPES.join('|')}, verdict: ${REVIEW_VERDICTS.join('|')}, watermark? (sha read through), phase?, findings?: string[] (required, non-empty, for findings)`,
    example: { scope: 'phase', verdict: 'pass', phase: 'Phase 1 — Data model', watermark: 'abc1234' },
  },
  run_started: {
    writer: 'driver',
    summary: 'a sofar drive run began',
    fields: `run, adapter, policy: ${RUN_POLICIES.join('|')}, threshold_pct? and context_window? (both required for threshold), max_sessions?, surface?`,
    example: { run: '01J00000000000000000000000', adapter: 'codex', policy: 'task' },
  },
  handoff: {
    writer: 'driver',
    summary: 'a driven session ended and the next one starts',
    fields: `run, session_id, reason: ${HANDOFF_REASONS.join('|')}, task?, tokens?, detail? (how the process ended: exit, spawn error, last stderr line)`,
    example: { run: '01J00000000000000000000000', session_id: 's1', reason: 'task_done', task: '1.1' },
  },
  run_stopped: {
    writer: 'driver',
    summary: 'a sofar drive run ended',
    fields: `run, reason: ${RUN_STOP_REASONS.join('|')}, note? (required for error)`,
    example: { run: '01J00000000000000000000000', reason: 'closed' },
  },
  run_stop_requested: {
    writer: 'command',
    via: 'sofar drive <slug> --stop',
    summary: 'a request for a running drive to stop',
    fields: 'run',
    example: { run: '01J00000000000000000000000' },
  },
  correction: {
    writer: 'agent',
    summary: 'voids one earlier event by id (append the corrected event fresh after it)',
    fields: 'ref (the bad event id), reason?',
    example: { ref: '01J00000000000000000000000', reason: 'wrong task id' },
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
