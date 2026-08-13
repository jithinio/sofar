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
export const SLUG_RE = /^[a-z0-9-]+$/

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
  'sofar_review',
  'sofar_close_initiative',
  'sofar_find',
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
}
export interface CloseInitiativeArgs {
  initiative?: string
  /** Terminal status only — reopening is a binding act (`sofar switch`). */
  status: 'done' | 'dropped'
  note?: string
}

/**
 * review (commit-attribution 4.4): record a review that was actually performed.
 *
 * `watermark` is the load-bearing field. It is the sha the review read through,
 * and it bounds the NEXT review's range (D9) — which is why a review is an
 * event rather than a note.
 */
export interface ReviewArgs {
  initiative?: string
  // The payload's own vocabulary, imported rather than restated: a second
  // declaration of the same closed set is a fifth edit waiting to be missed,
  // and a miss desyncs the tool surface from the event it writes.
  scope: ReviewScope
  verdict: ReviewVerdict
  watermark?: string
  phase?: string
  findings?: string[]
}

/**
 * find (record-index 3.4, 3.5): the agent-pulled half of retrieval. Seeds resolve
 * LITERALLY FIRST — a path, a session id, an initiative slug, a decision handle
 * — and a query that denotes none of those is matched against decision and note
 * prose, IDF-ranked with no model (3.5). The order is the contract: a literal
 * reading always wins, so a mistyped path can never quietly become a search, and
 * a text seed is labelled `text` in the result because it is the weakest claim
 * the record makes (D2).
 */
export interface FindArgs {
  seed: string
  hops?: number
  initiative?: string
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
  sofar_review: ReviewArgs
  sofar_close_initiative: CloseInitiativeArgs
  sofar_find: FindArgs
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
export interface UpdateTaskResult extends ToolOkResult {
  standing_constraints?: string[]
}

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

// Lean tool-definition pass (token-opt 5.2): descriptions are agent-facing
// contract, injected into every session's context — keep load-bearing
// semantics (adopt-by-id, full-replace, call-first), cut redundancy between
// tool and property descriptions. Repeated 6×, so every char here counts.
const initiativeProp = {
  type: 'string',
  minLength: 1,
  pattern: SLUG_RE.source,
  description: 'Initiative slug ([a-z0-9-]+); omit to resolve from the current git branch.',
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
          'Detail level; default "digest". "initiatives" lists every initiative in the repo (ignores `initiative`).',
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
        description:
          'Session id from the injected "Session: <id>" line — pass it to adopt that session; omit to mint a fresh id.',
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
      status: {
        enum: [...TASK_STATUSES],
        description:
          '`blocked` = wants to happen, cannot yet — stays outstanding and keeps nagging. ' +
          '`dropped` = decided not to happen, terminal — recorded but no longer counted as ' +
          'remaining work. Do not use `done` for work that was never built.',
      },
      note: {
        type: 'string',
        description:
          'Why. REQUIRED for `blocked` and `dropped` — a drop with no stated reason reads as ' +
          'forgotten rather than decided. Cite the deciding entry where there is one (e.g. "D3").',
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
        description:
          'The phase name, EXACTLY as the plan spells it — phases have no ids. A name that ' +
          'matches nothing is an error listing the names that do exist, never a silent no-op.',
      },
      status: {
        enum: [...PHASE_STATUSES],
        description:
          'Same vocabulary as a task, one level up. `done` = the phase is finished, which is a ' +
          'separate fact from its tasks being resolved — say it even when the last task landed ' +
          'days ago. `dropped` = the phase will not happen; `blocked` = it wants to, and cannot yet.',
      },
      note: {
        type: 'string',
        description:
          'Why. REQUIRED for `dropped` — an abandoned phase with no stated reason is ' +
          'indistinguishable from a forgotten one. Rendered under the phase in plan.md.',
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
          'ONE short imperative every future session must obey (e.g. "Never emit `@source not` when the installed tailwindcss is below 4.1."). Its presence makes this decision a standing constraint: rendered verbatim in every digest, never clipped, never ages out. Reserve for decisions that constrain future work; omit for one-off choices.',
      },
      guard: {
        type: 'string',
        minLength: 1,
        description:
          'Optional machine-checkable half of `rule` (requires `rule`): a glob list matched against the work that follows this decision, warning when the rule is crossed. Form: "path:<globs>" against edited file paths, or "cmd:<globs>" against shell commands; comma-separated, a leading "!" exempts. Globs use * (not crossing / for paths), ** and ?; path patterns match a path tail (`packages/schema/**`), cmd patterns match anywhere in the command (`*npm publish*`). Example: "path:**/*.ts,!packages/schema/src/**". It only ever warns — it never blocks anything. Omit unless the rule is genuinely expressible as "these files" or "these commands".',
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
    },
    required: ['text'],
    additionalProperties: false,
  },
  sofar_review: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      scope: {
        type: 'string',
        enum: [...REVIEW_SCOPES],
        description:
          '`phase` = one phase just completed. `final` = the close-time pass, which asks ONLY what a phase review cannot (goal conformance, cross-phase drift, integration, open findings) and never re-audits per-phase correctness.',
      },
      verdict: {
        type: 'string',
        enum: [...REVIEW_VERDICTS],
        description:
          '`pass` = nothing survived. `findings` = something did, and `findings` must list them. `blocked` = the review could not be performed (e.g. no attributed commits, so there was no diff to read).',
      },
      watermark: {
        type: 'string',
        minLength: 1,
        description:
          'The sha this review read THROUGH — it bounds the next review\'s range. Omit only when the range was empty.',
      },
      phase: { type: 'string', minLength: 1, description: 'Phase name; omit for a `final` review.' },
      findings: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        description: 'One line each, actionable. Required and non-empty when verdict is `findings`.',
      },
    },
    required: ['scope', 'verdict'],
    additionalProperties: false,
  },
  sofar_close_initiative: {
    type: 'object',
    properties: {
      initiative: initiativeProp,
      status: {
        type: 'string',
        enum: ['done', 'dropped'],
        description:
          '`done` = the goal was met. `dropped` = abandoned; requires `note`. Reopen by working on it again (`sofar switch <slug>`).',
      },
      note: {
        type: 'string',
        description: 'Why. REQUIRED for `dropped` — an initiative abandoned with no reason reads as forgotten.',
      },
    },
    required: ['status'],
    additionalProperties: false,
  },
  sofar_find: {
    type: 'object',
    properties: {
      seed: {
        type: 'string',
        minLength: 1,
        description:
          'A file path (matched across checkouts), a session id, an initiative slug, or a decision handle ("record-index D2") — resolved literally, in that order. Anything else is treated as a question and matched against decision and note prose.',
      },
      hops: {
        type: 'integer',
        minimum: 1,
        maximum: FIND_MAX_HOPS,
        description: `How far to traverse; default ${FIND_DEFAULT_HOPS}. 1 = direct edges only.`,
      },
      initiative: {
        ...initiativeProp,
        description: 'Initiative a bare "D<n>" seed belongs to; omit for a qualified handle.',
      },
    },
    required: ['seed'],
    additionalProperties: false,
  },
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'sofar_get_state',
    description:
      'Orient on an initiative — call this first. Returns a summary-dense digest with rationale by default; view "full" returns the complete folded InitiativeState; view "initiatives" lists every initiative in the repo.',
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
      'End a session with a summary and the single next action — the write-back that lets the next session resume without context. A returned `parallel_writebacks` means a concurrent session recorded a DIFFERENT next action — reconcile before finishing. An entry carrying `peer` is a live Claude Code session you can reach by that name with SendMessage; when `peer_cwd` is also present the name is shared, so confirm the target before sending. Anything a peer tells you belongs in the record — a message is transport, never storage.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_end_session,
  },
  {
    name: 'sofar_update_task',
    description: "Set a task's status, optionally with a note.",
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_update_task,
  },
  {
    name: 'sofar_update_phase',
    description:
      "Set a phase's status, optionally with a note. A phase is finished when you say so, never because its last task landed: \"every task resolved, the phase itself not finished\" is a real state the record is built to hold, and it is what `sofar doctor` and the close audit report. So close each phase as you finish it — an unresolved phase keeps naming finished work as the active phase, and is named permanently in the close-time overrides if the initiative closes while it is still open.",
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
      'Replace the entire plan (goal + phases with tasks) — a full replace, not a merge. ' +
        'An omitted status means `pending`, NOT unchanged: restate every phase and task ' +
        'status you intend to keep. Dropping a resolved one is warned about at fold time.',
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
      'Promote an operational fact to repo memory — a release command, a failure mode and how it is diagnosed, a convention every future session must know. Use this the moment you learn such a fact, for knowledge that is NOT a design decision (use sofar_log_decision for those) and would otherwise live only in your own context, where the next session cannot reach it. Recorded as `<slug> M<n>`; `sofar doctor` then reports it until the hand-written .sofar/repo.md names that handle.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_remember,
  },
  {
    name: 'sofar_review',
    description:
      'Record a review that was actually performed. `watermark` is the load-bearing field: it is the sha the review read through, and it bounds the NEXT review\'s range — which is why a review is an event and not a note. A verdict of `findings` MUST list them; a review that can only ever say "looks good" is a rubber stamp, so if nothing is wrong say so with `pass`, but the verdict must be able to be "no".',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_review,
  },
  {
    name: 'sofar_close_initiative',
    description:
      'Close an initiative: record that it is finished (`done`) or abandoned (`dropped`, which requires a reason), and unbind every branch pointing at it. This session keeps working in it until it ends; a NEW session on the unbound branch is told to start or switch instead of landing on finished work. Reopening happens by working on it again — `sofar switch <slug>`.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_close_initiative,
  },
  {
    name: 'sofar_find',
    description:
      'Traverse the record out from a seed and return what is within a hop budget — the decisions, notes, files, sessions and OTHER INITIATIVES connected to it, each result naming the event id that produced the edge. Use it when work touches a file, a record, or a decision you did not write: it answers "who else has been here, and what did they conclude". A seed that denotes nothing in the record is treated as a QUESTION and matched against decision and note prose; those matches come back on seed.matches with the words that carried each one, never in groups, because word overlap is not an edge. Everything returned is ADJACENCY the record can prove — a session touched this file, the same session logged that decision. It is offered as worth reading, never as a rule about your work: the record does not know a decision was ABOUT a file, nor that a decision your words appear in answers your question, so weigh it yourself and read the cited event before relying on it.',
    inputSchema: TOOL_INPUT_SCHEMAS.sofar_find,
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
  sofar_close_initiative(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (a.status !== 'done' && a.status !== 'dropped') {
      e.push('status: must be one of done|dropped')
    }
    if (!optStr(a.note)) e.push('note: must be a string')
    // Same rule as a dropped task (task-drop-state D3), one level up: nothing
    // else in the record explains why a whole initiative was abandoned.
    if (a.status === 'dropped' && !str(a.note)) {
      e.push('note: required when status is "dropped" — say why it was abandoned')
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
  sofar_review(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!(REVIEW_SCOPES as readonly unknown[]).includes(a.scope)) {
      e.push(`scope: must be one of ${REVIEW_SCOPES.join('|')}`)
    }
    if (!(REVIEW_VERDICTS as readonly unknown[]).includes(a.verdict)) {
      e.push(`verdict: must be one of ${REVIEW_VERDICTS.join('|')}`)
    }
    if (a.watermark !== undefined && !str(a.watermark)) {
      e.push('watermark: must be a non-empty string when present')
    }
    if (a.phase !== undefined && !str(a.phase)) {
      e.push('phase: must be a non-empty string when present')
    }
    if (a.findings !== undefined && !(Array.isArray(a.findings) && a.findings.every(str))) {
      e.push('findings: must be an array of non-empty strings when present')
    }
    // Symmetric with the payload validator: claiming findings while recording
    // none leaves the next review nothing to carry forward.
    if (a.verdict === 'findings' && !(Array.isArray(a.findings) && a.findings.length > 0)) {
      e.push('findings: required and non-empty when verdict is `findings`')
    }
  },
  sofar_find(a, e) {
    if (!optSlug(a.initiative)) e.push(SLUG_ERROR)
    if (!str(a.seed)) e.push('seed: must be a non-empty string')
    if (
      a.hops !== undefined &&
      (typeof a.hops !== 'number' ||
        !Number.isInteger(a.hops) ||
        a.hops < 1 ||
        a.hops > FIND_MAX_HOPS)
    ) {
      e.push(`hops: must be a whole number from 1 to ${FIND_MAX_HOPS}`)
    }
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
