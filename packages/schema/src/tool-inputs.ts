/**
 * MCP tool input contracts (SPEC §MCP tools) — argument types, JSON Schema
 * objects, and runtime validators for the seven sofar tools, plus the
 * typed-error contract tools return on failure.
 *
 * These are validation shapes, so they live here: packages/schema/src/ is
 * the ONLY schema home (CLAUDE.md guard-rail). The JSON Schemas are plain
 * objects and the validators are hand-written — no zod (BD12); the engine's
 * MCP server uses the SDK's low-level API and validates with these.
 */

import {
  INITIATIVE_SLUG_RE,
  TASK_STATUSES,
  PHASE_STATUSES,
  REVIEW_SCOPES,
  REVIEW_VERDICTS,
  validatePayload,
  type PhaseStatus,
  type PlanStructure,
  type ReviewScope,
  type ReviewVerdict,
  type TaskStatus,
} from './events'

// ---------------------------------------------------------------------------
// Typed tool errors — the single home for the error-code union.
// ---------------------------------------------------------------------------

/**
 * The one shape an initiative slug may take, and the ONLY guard between a tool
 * argument and a filesystem path: the engine resolves `initiative` by joining
 * it under .sofar/initiatives/, so a slug carrying `..` walks out of the record
 * and writes the log and every projection into whatever directory it lands in.
 * Lowercase letters, digits, hyphens — no separators, no dots, no traversal.
 * `sofar new` has always enforced this at creation; enforcing it at the tool
 * boundary too is what closes the write path (see engine mcp/context.ts, which
 * asserts containment as well — belt and braces, since this regex is the belt).
 */
export const SLUG_RE = INITIATIVE_SLUG_RE

/** Shared message so every tool rejects a bad slug in the same words. */
export const SLUG_ERROR =
  'initiative: must be a slug of lowercase letters, digits, and hyphens ([a-z0-9-]+)'

export const TOOL_ERROR_CODES = [
  'invalid_input',
  'unknown_initiative',
  'unknown_tool',
  'unknown_event',
  'io_error',
] as const
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]

/** JSON shape carried in content[0].text of an isError tool result. */
export interface ToolErrorShape {
  code: ToolErrorCode
  message: string
  /** Field-level messages for invalid_input failures. */
  errors?: string[]
}

// ---------------------------------------------------------------------------
// Tool names + argument types.
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  'sofar_get_state',
  'sofar_start_session',
  'sofar_end_session',
  'sofar_update_task',
  'sofar_update_phase',
  'sofar_log_decision',
  'sofar_update_plan',
  'sofar_add_note',
  'sofar_remember',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * get_state output detail (progressive disclosure, token-optimization).
 * "digest" (default) = summary-dense orientation projection with rationale
 * surfaced (~1k tok); "full" = the complete folded InitiativeState,
 * re-injectable in full (architecture Open-Q#5 compaction-proofing);
 * "initiatives" (initiative-list 3.1) = one budgeted line per initiative in
 * the repo — the only view that skips initiative resolution, so it works
 * from an unbound branch, which is exactly when a session needs it.
 */
export const GET_STATE_VIEWS = ['digest', 'full', 'initiatives'] as const
export type GetStateView = (typeof GET_STATE_VIEWS)[number]

export interface GetStateArgs {
  initiative?: string
  view?: GetStateView
}
export interface StartSessionArgs {
  initiative?: string
  tool: string
  model?: string
  /**
   * Adopt-by-id (Phase 7, BD43): the session id injected by the SessionStart
   * hook context ("Session: <id> — …"). Provided → adopt exactly that open
   * session (closed id = typed error; unknown id = register it). Omitted →
   * mint a fresh ulid. There is no open-session heuristic.
   */
  session_id?: string
}
export interface EndSessionArgs {
  session_id: string
  summary: string
  next_action: string
  /**
   * Task status changes to file with the write-back (r1-fixes 2.1, D10) —
   * validated as a whole, then appended in order BEFORE session_ended, so
   * the write-back's own fold already counts them. One call instead of one
   * per task at wrap-up.
   */
  tasks?: EndSessionTaskChange[]
}
export interface EndSessionTaskChange {
  task_id: string
  status: TaskStatus
  note?: string
}
export interface UpdateTaskArgs {
  initiative?: string
  task_id: string
  status: TaskStatus
  note?: string
}
/**
 * Phases are addressed by their NAME — plan_updated carries no phase ids, so
 * the name is the only handle that exists (phase-lifecycle 2.2). The engine
 * matches it exactly against the folded plan and errors when nothing matches,
 * which is why there is no id to mint here.
 */
export interface UpdatePhaseArgs {
  initiative?: string
  phase: string
  status: PhaseStatus
  note?: string
}
export interface LogDecisionArgs {
  initiative?: string
  chose: string
  over: string
  because: string
  /** Standing-constraint clause (drift-hardening D1) — see the JSON schema description. */
  rule?: string
  /** Machine-checkable half of `rule` (drift-hardening D3) — see guards.ts. */
  guard?: string
}
export interface UpdatePlanArgs {
  initiative?: string
  plan: PlanStructure
}
export interface AddNoteArgs {
  initiative?: string
  text: string
}
export interface RememberArgs {
  initiative?: string
  text: string
  /** Memory this fact replaces: `M<n>` (in the target initiative) or the qualified `<slug> M<n>`. */
  supersedes?: string
}



/** Hop budget contract, mirrored by the engine's traversal (core/index-reach.ts). */
export const FIND_DEFAULT_HOPS = 2
export const FIND_MAX_HOPS = 3

export interface ToolArgs {
  sofar_get_state: GetStateArgs
  sofar_start_session: StartSessionArgs
  sofar_end_session: EndSessionArgs
  sofar_update_task: UpdateTaskArgs
  sofar_update_phase: UpdatePhaseArgs
  sofar_log_decision: LogDecisionArgs
  sofar_update_plan: UpdatePlanArgs
  sofar_add_note: AddNoteArgs
  sofar_remember: RememberArgs
}

/** Result shape for the write tools (SPEC "→ ok"); event_id aids testing/audit. */
export interface ToolOkResult {
  ok: true
  event_id: string
}

/**
 * update_task result (drift-hardening 4.1): when a task goes `active`, the
 * standing constraints ride along — a reminder at the point of use, where
 * salience is highest, instead of only at session start where it decays.
 */
/** Bare since r1-fixes 2.1 (D10): the standing-constraint echo on `active` is gone. */
export type UpdateTaskResult = ToolOkResult

/**
 * update_phase result (phase-lifecycle 2.3). `event_id` is null when the phase
 * was ALREADY at this status — idempotent, no second event, the same shape
 * close_initiative uses for the same reason: re-issuing must be safe, and a
 * log full of no-op transitions makes the real ones harder to find.
 */
export interface UpdatePhaseResult {
  ok: true
  event_id: string | null
  /** Task counts for the phase, so the caller can see what it just resolved. */
  tasks_done: number
  tasks_total: number
}

// ---------------------------------------------------------------------------
// JSON Schemas — plain objects, declared per MCP Tool.inputSchema.
// ---------------------------------------------------------------------------

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, object>
  required?: string[]
  additionalProperties: false
}

export interface ToolDef {
  name: ToolName
  description: string
  inputSchema: ToolInputSchema
}

// Lean tool-definition pass (token-opt 5.2; cut again by r1-fixes 2.4, D13):
// descriptions are agent-facing contract that hosts without deferred tools
// carry in EVERY turn — keep the load-bearing sentence (adopt-by-id,
// full-replace, when to use which), and let SPEC and `sofar event types` hold
// the documentation. Repeated 7×, so every char here counts.
const initiativeProp = {
  type: 'string',
  minLength: 1,
  pattern: SLUG_RE.source,
  description: "Initiative slug; omit for the current branch's.",
}

/** Routing hints (session-driver 3.2) — what the run leaves open, the task fills. */
const taskRouteSchema = {
  type: 'object',
  properties: {
    agent: {
      type: 'string',
      minLength: 1,
      description: 'Adapter `sofar drive` must launch this task with (e.g. `claude-code`).',
    },
    model: { type: 'string', minLength: 1 },
    effort: { type: 'string', minLength: 1 },
  },
  additionalProperties: false,
}

const planTaskSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    status: { enum: [...TASK_STATUSES] },
    route: {
      ...taskRouteSchema,
      description: 'Routing hints for `sofar drive`; what the run pinned wins.',
    },
  },
  required: ['id', 'title'],
  additionalProperties: false,
}

const planPhaseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    status: { enum: [...PHASE_STATUSES] },
    tasks: { type: 'array', items: planTaskSchema },
  },
  required: ['name', 'tasks'],
  additionalProperties: false,
}

const planSchema = {
  type: 'object',
  properties: {
    goal: { type: 'string', minLength: 1 },
    phases: { type: 'array', items: planPhaseSchema },
  },
  required: ['phases'],
  additionalProperties: false,
}

export const TOOL_INPUT_SCHEMAS: Record<ToolName, ToolInputSchema> = {
  sofar_get_state: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      view: {
        enum: [...GET_STATE_VIEWS],
        description: '"digest" (default), "full" = folded state JSON, "initiatives" = every initiative in the repo.',
      },
    },
    additionalProperties: false,
  },
  sofar_start_session: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      tool: {
        type: 'string',
        minLength: 1,
        description: 'Agent tool name, e.g. "claude-code".',
      },
      model: { type: 'string', description: 'Model identifier, if known.' },
      session_id: {
        type: 'string',
        minLength: 1,
        description: 'The id from the injected "Session: <id>" line — adopts that session; omit to mint one.',
      },
    },
    required: ['tool'],
    additionalProperties: false,
  },
  sofar_end_session: {
    type: 'object',
    properties: {
      session_id: { type: 'string', minLength: 1 },
      summary: { type: 'string', minLength: 1, description: 'What happened this session.' },
      next_action: {
        type: 'string',
        minLength: 1,
        description: 'The single next action for whoever resumes.',
      },
      tasks: {
        type: 'array',
        description:
          'Task status changes to file with this write-back, in order (same rules as sofar_update_task).',
        items: {
          type: 'object',
          properties: {
            task_id: { type: 'string', minLength: 1 },
            status: { enum: [...TASK_STATUSES] },
            note: { type: 'string', description: 'Why; required for blocked/dropped.' },
          },
          required: ['task_id', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['session_id', 'summary', 'next_action'],
    additionalProperties: false,
  },
  sofar_update_task: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      task_id: { type: 'string', minLength: 1 },
      status: {
        enum: [...TASK_STATUSES],
        description:
          '`blocked` = cannot proceed yet, stays outstanding; `dropped` = will not happen, terminal. Never `done` for unbuilt work.',
      },
      note: {
        type: 'string',
        description: 'Why. Required for blocked/dropped; cite the deciding entry (e.g. "D3").',
      },
    },
    required: ['task_id', 'status'],
    additionalProperties: false,
  },
  sofar_update_phase: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      phase: {
        type: 'string',
        minLength: 1,
        description: 'Phase name exactly as the plan spells it; an unknown name errors, listing the real ones.',
      },
      status: {
        enum: [...PHASE_STATUSES],
        description:
          'Task vocabulary, one level up: `done` = finished (say it — resolved tasks do not imply it), `dropped` = will not happen, `blocked` = cannot proceed yet.',
      },
      note: {
        type: 'string',
        description: 'Why. Required for `dropped`; rendered under the phase in plan.md.',
      },
    },
    required: ['phase', 'status'],
    additionalProperties: false,
  },
  sofar_log_decision: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      chose: { type: 'string', minLength: 1 },
      over: { type: 'string', minLength: 1 },
      because: { type: 'string', minLength: 1 },
      rule: {
        type: 'string',
        minLength: 1,
        description:
          'ONE short imperative every future session must obey (e.g. "Never emit `@source not` below tailwindcss 4.1."). Makes this a standing constraint: rendered verbatim in every digest, never clipped or aged out. Omit for one-off choices.',
      },
      guard: {
        type: 'string',
        minLength: 1,
        description:
          'Machine-checkable half of `rule` (requires it): "path:<globs>" matched against edited paths or "cmd:<globs>" against shell commands — comma-separated, leading "!" exempts, * ** ? globs, path patterns match a path tail. Warns when crossed, never blocks. Omit unless the rule is literally "these files" or "these commands".',
      },
    },
    required: ['chose', 'over', 'because'],
    additionalProperties: false,
  },
  sofar_update_plan: {
    type: 'object',
    properties: { initiative: initiativeProp, plan: planSchema },
    required: ['plan'],
    additionalProperties: false,
  },
  sofar_add_note: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      text: { type: 'string', minLength: 1 },
    },
    required: ['text'],
    additionalProperties: false,
  },
  sofar_remember: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      text: { type: 'string', minLength: 1 },
      supersedes: {
        type: 'string',
        pattern: '^(?:[a-z0-9-]+ )?M[1-9][0-9]*$',
        description:
          'The memory this replaces (`M<n>` or `<slug> M<n>`); the old handle is retired, history stays append-only.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'sofar_get_state',
    description:
      'Read an initiative. The default digest is what SessionStart already injected — do not re-read it; use "full" or "initiatives", or name another initiative.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_get_state,
  },
  {
    name: 'sofar_start_session',
    description:
      'Start a work session. Returns {session_id}; subsequent events are attributed to it.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_start_session,
  },
  {
    name: 'sofar_end_session',
    description:
      'Write back: a summary plus the single next action the next session resumes from; `tasks` files task status changes first. A returned `parallel_writebacks` lists concurrent sessions that recorded a DIFFERENT next action — reconcile; an entry with `peer` names a live Claude Code session reachable by SendMessage (with `peer_cwd` the name is shared: confirm first). What a peer tells you goes in the record.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_end_session,
  },
  {
    name: 'sofar_update_task',
    description:
      "Set a task's status, with an optional note. Wrap-up changes can ride sofar_end_session's `tasks` instead.",
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_task,
  },
  {
    name: 'sofar_update_phase',
    description:
      "Set a phase's status. A phase is done only when you say so — its last task landing does not close it — so mark each phase done as you finish it; an open phase with every task resolved is what doctor reports.",
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_phase,
  },
  {
    name: 'sofar_log_decision',
    description:
      'Record a design decision: what was chosen, what it was chosen over, and why.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_log_decision,
  },
  {
    name: 'sofar_update_plan',
    description:
      'Replace the whole plan (goal + phases with tasks) — a full replace, not a merge: an omitted status means `pending`, so restate every status you keep.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_plan,
  },
  {
    name: 'sofar_add_note',
    description: 'Append a free-form note to the initiative record.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_add_note,
  },
  {
    name: 'sofar_remember',
    description:
      'Promote an operational fact to repo memory — a release command, a failure mode and its diagnosis, a convention every session must know. Call it the moment you learn one (design decisions go to sofar_log_decision). Recorded as `<slug> M<n>`; doctor reports it until .sofar/repo.md names that handle.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_remember,
  },
]

// ---------------------------------------------------------------------------
// Runtime validation (same conventions as events.ts).
// ---------------------------------------------------------------------------

export type ToolInputValidation = { ok: true } | { ok: false; errors: string[] }

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
/** Non-empty string with no shape constraint — session ids come from the agent tool. */
function optId(v: unknown): boolean {
  return v === undefined || str(v)
}
function optSlug(v: unknown): boolean {
  return v === undefined || (str(v) && SLUG_RE.test(v))
}

const toolValidators: Record<ToolName, (a: Obj, e: string[]) => void> = {
  sofar_get_state(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (a.view !== undefined && !(GET_STATE_VIEWS as readonly string[]).includes(a.view as string)) {
      e.push(`view: must be one of ${GET_STATE_VIEWS.join('|')}`)
    }
  },
  sofar_start_session(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.tool)) e.push('tool: must be a non-empty string')
    if (!optStr(a.model)) e.push('model: must be a string')
    if (!optId(a.session_id)) e.push('session_id: must be a non-empty string')
  },
  sofar_end_session(a, e) {
    if (!str(a.session_id)) e.push('session_id: must be a non-empty string')
    if (!str(a.summary)) e.push('summary: must be a non-empty string')
    if (!str(a.next_action)) e.push('next_action: must be a non-empty string')
  },
  sofar_update_task(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.task_id)) e.push('task_id: must be a non-empty string')
    if (typeof a.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(a.status)) {
      e.push(`status: must be one of ${TASK_STATUSES.join('|')}`)
    }
    if (!optStr(a.note)) e.push('note: must be a string')
    // A drop is the one status that closes a task without delivering it
    // (task-drop-state D3). Unexplained, it is indistinguishable from work
    // that was quietly forgotten — and unlike a wrong `pending`, nothing
    // downstream will ever nag anyone into supplying the reason later.
    if (a.status === 'dropped' && !str(a.note)) {
      e.push('note: required when status is "dropped" — say why, and cite the deciding entry (e.g. "D3")')
    }
  },
  sofar_update_phase(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.phase)) e.push('phase: must be a non-empty string')
    if (typeof a.status !== 'string' || !(PHASE_STATUSES as readonly string[]).includes(a.status)) {
      e.push(`status: must be one of ${PHASE_STATUSES.join('|')}`)
    }
    if (!optStr(a.note)) e.push('note: must be a string')
    // The task-drop rule (task-drop-state D3) and the initiative-drop rule one
    // level up, applied to the level between them — for the same reason both
    // give: nothing else in the record explains an abandonment.
    if (a.status === 'dropped' && !str(a.note)) {
      e.push('note: required when status is "dropped" — say why the phase will not happen')
    }
  },
  sofar_log_decision(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.chose)) e.push('chose: must be a non-empty string')
    if (!str(a.over)) e.push('over: must be a non-empty string')
    if (!str(a.because)) e.push('because: must be a non-empty string')
  },
  sofar_update_plan(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    // The plan must satisfy the existing PlanStructure validator — reuse the
    // plan_updated payload validator so tool input and event payload can
    // never drift apart.
    const check = validatePayload('plan_updated', { plan: a.plan })
    if (!check.ok) e.push(...check.errors)
  },
  sofar_add_note(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.text)) e.push('text: must be a non-empty string')
  },
  sofar_remember(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.text)) e.push('text: must be a non-empty string')
  },
}

/**
 * Validate MCP tool arguments against the tool's contract. Unknown keys are
 * rejected (the JSON Schemas declare additionalProperties: false; the
 * validator enforces the same so agents get a field-level error, not silent
 * argument loss).
 */
export function validateToolInput(tool: ToolName, args: unknown): ToolInputValidation {
  if (!isObj(args)) {
    return { ok: false, errors: ['arguments: must be a JSON object'] }
  }
  const errors: string[] = []
  const allowed = Object.keys(TOOL_INPUT_SCHEMAS[tool].properties)
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      errors.push(`${key}: unknown argument (allowed: ${allowed.join(', ')})`)
    }
  }
  toolValidators[tool](args, errors)
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}
