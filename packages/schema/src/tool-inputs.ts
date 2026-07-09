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
  TASK_STATUSES,
  PHASE_STATUSES,
  validatePayload,
  type PlanStructure,
  type TaskStatus,
} from './events'

// ---------------------------------------------------------------------------
// Typed tool errors — the single home for the error-code union.
// ---------------------------------------------------------------------------

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
  'sofar_log_decision',
  'sofar_update_plan',
  'sofar_add_note',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name)
}

/**
 * get_state output detail (progressive disclosure, token-optimization).
 * "digest" (default) = summary-dense orientation projection with rationale
 * surfaced (~1k tok); "full" = the complete folded InitiativeState,
 * re-injectable in full (architecture Open-Q#5 compaction-proofing).
 */
export const GET_STATE_VIEWS = ['digest', 'full'] as const
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
}
export interface UpdateTaskArgs {
  initiative?: string
  task_id: string
  status: TaskStatus
  note?: string
}
export interface LogDecisionArgs {
  initiative?: string
  chose: string
  over: string
  because: string
}
export interface UpdatePlanArgs {
  initiative?: string
  plan: PlanStructure
}
export interface AddNoteArgs {
  initiative?: string
  text: string
}

export interface ToolArgs {
  sofar_get_state: GetStateArgs
  sofar_start_session: StartSessionArgs
  sofar_end_session: EndSessionArgs
  sofar_update_task: UpdateTaskArgs
  sofar_log_decision: LogDecisionArgs
  sofar_update_plan: UpdatePlanArgs
  sofar_add_note: AddNoteArgs
}

/** Result shape for the write tools (SPEC "→ ok"); event_id aids testing/audit. */
export interface ToolOkResult {
  ok: true
  event_id: string
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

const initiativeProp = {
  type: 'string',
  minLength: 1,
  description:
    'Initiative slug. Omit to resolve from the current git branch via .sofar/bindings.json.',
}

const planTaskSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    status: { enum: [...TASK_STATUSES] },
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
  description: 'Full plan structure — replaces the existing plan entirely.',
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
        description:
          'Output detail: "digest" (default) = summary-dense orientation with rationale; "full" = the complete folded InitiativeState.',
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
        description: 'Agent tool starting the session, e.g. "claude-code", "opencode", "codex".',
      },
      model: { type: 'string', description: 'Model identifier, if known.' },
      session_id: {
        type: 'string',
        minLength: 1,
        description:
          'Session id from the injected context line "Session: <id> — …". Pass it to adopt exactly that session; omit to mint a fresh id.',
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
    },
    required: ['session_id', 'summary', 'next_action'],
    additionalProperties: false,
  },
  sofar_update_task: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      task_id: { type: 'string', minLength: 1 },
      status: { enum: [...TASK_STATUSES] },
      note: { type: 'string', description: 'Optional context, e.g. why the task is blocked.' },
    },
    required: ['task_id', 'status'],
    additionalProperties: false,
  },
  sofar_log_decision: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      chose: { type: 'string', minLength: 1, description: 'What was chosen.' },
      over: { type: 'string', minLength: 1, description: 'What was rejected.' },
      because: { type: 'string', minLength: 1, description: 'Why.' },
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
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'sofar_get_state',
    description:
      'Orient on an initiative from the event log — call this first. Default returns a summary-dense digest (goal, active/next task, next action, recent decisions with rationale). Pass view:"full" for the complete folded InitiativeState.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_get_state,
  },
  {
    name: 'sofar_start_session',
    description:
      'Start a work session on an initiative. Returns {session_id}; subsequent events in this server process are attributed to it.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_start_session,
  },
  {
    name: 'sofar_end_session',
    description:
      'End a session with a summary and the single next action — the write-back that lets the next session resume without context.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_end_session,
  },
  {
    name: 'sofar_update_task',
    description: 'Set a task status (pending|active|done|blocked), with an optional note.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_task,
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
      'Replace the full plan structure (goal + phases with tasks). This is a full replace, not a merge.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_plan,
  },
  {
    name: 'sofar_add_note',
    description: 'Append a free-form note to the initiative record.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_add_note,
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
function optSlug(v: unknown): boolean {
  return v === undefined || str(v)
}

const toolValidators: Record<ToolName, (a: Obj, e: string[]) => void> = {
  sofar_get_state(a, e) {
    if (!optSlug(a.initiative)) e.push('initiative: must be a non-empty string')
    if (a.view !== undefined && !(GET_STATE_VIEWS as readonly string[]).includes(a.view as string)) {
      e.push(`view: must be one of ${GET_STATE_VIEWS.join('|')}`)
    }
  },
  sofar_start_session(a, e) {
    if (!optSlug(a.initiative)) e.push('initiative: must be a non-empty string')
    if (!str(a.tool)) e.push('tool: must be a non-empty string')
    if (!optStr(a.model)) e.push('model: must be a string')
    if (!optSlug(a.session_id)) e.push('session_id: must be a non-empty string')
  },
  sofar_end_session(a, e) {
    if (!str(a.session_id)) e.push('session_id: must be a non-empty string')
    if (!str(a.summary)) e.push('summary: must be a non-empty string')
    if (!str(a.next_action)) e.push('next_action: must be a non-empty string')
  },
  sofar_update_task(a, e) {
    if (!optSlug(a.initiative)) e.push('initiative: must be a non-empty string')
    if (!str(a.task_id)) e.push('task_id: must be a non-empty string')
    if (typeof a.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(a.status)) {
      e.push(`status: must be one of ${TASK_STATUSES.join('|')}`)
    }
    if (!optStr(a.note)) e.push('note: must be a string')
  },
  sofar_log_decision(a, e) {
    if (!optSlug(a.initiative)) e.push('initiative: must be a non-empty string')
    if (!str(a.chose)) e.push('chose: must be a non-empty string')
    if (!str(a.over)) e.push('over: must be a non-empty string')
    if (!str(a.because)) e.push('because: must be a non-empty string')
  },
  sofar_update_plan(a, e) {
    if (!optSlug(a.initiative)) e.push('initiative: must be a non-empty string')
    // The plan must satisfy the existing PlanStructure validator — reuse the
    // plan_updated payload validator so tool input and event payload can
    // never drift apart.
    const check = validatePayload('plan_updated', { plan: a.plan })
    if (!check.ok) e.push(...check.errors)
  },
  sofar_add_note(a, e) {
    if (!optSlug(a.initiative)) e.push('initiative: must be a non-empty string')
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
