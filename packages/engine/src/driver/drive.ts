import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import {
  isClosedInitiativeStatus,
  isResolvedTaskStatus,
  type HandoffReason,
  type RunPolicy,
  type RunStopReason,
  type TaskRoute,
} from '@sofar/schema'
import type { InitiativeState, PhaseState } from '../core/fold'
import { latestRun } from '../core/fold'
import { createToolContext, ToolError } from '../mcp/context'
import type { NudgeDetail } from './nudge'
import { describeSurface, sameSurface, type PermissionSurface } from './permissions'
import {
  inertOptions,
  policyUnavailable,
  resolveLaunchedSession,
  wroteBack,
  type Adapter,
  type AgentSession,
  type SessionExit,
} from './adapter'
import { previewRoutes, resolveRoute, RouteError, type RoutingOptions } from './routing'

/**
 * `sofar drive <initiative>` (session-driver 2.2, D2): the loop, and nothing
 * but the loop. Fold the record → pick the next task → launch a session
 * through the adapter → wait → read what changed → append the handoff. Repeat
 * until a stop rule fires. The driver holds no state of its own: `run`,
 * `handoffs` and `stalls` below are read back out of the fold on the next
 * turn, and a driver that dies mid-run leaves a run with no stop, which the
 * next one resumes (--resume) rather than reconstructs.
 *
 * Everything the driver decides, it decides from the RECORD (D3):
 *
 * - which session a launch became — `resolveLaunchedSession`, never the
 *   adapter's say-so, and never a guess when several are candidates;
 * - whether that session wrote back — `wroteBack` over the fold;
 * - why the driver moved on — `handoffReason` below (D5): `needs_user` is the
 *   named task sitting in `blocked`, `task_done` is a write-back plus a task
 *   that reached done/dropped, everything else is a stall. No prose is
 *   matched and no exit code is trusted: the reason is a fact about
 *   events.jsonl or it is not recorded.
 *
 * What it deliberately does NOT do (D6): create worktrees or switch branches.
 * Sessions in a run are sequential and cumulative — session N+1 continues
 * session N's tree — so one directory serves the whole run. It is the repo
 * root unless `cwd` names another, and either way the driver refuses to start
 * until that directory's log for the initiative IS the log it is driving.
 */

/** Consecutive stalls that stop a run; `--max-stalls` overrides it. */
export const DEFAULT_MAX_STALLS = 2

/**
 * How often the threshold policy reads the gauge. Usage only moves when the
 * agent's transport emits a turn, so polling faster buys nothing; polling
 * slower risks nudging a session that has already filled its window.
 */
export const NUDGE_POLL_MS = 2_000

/** How long a signalled session gets to exit on its own before SIGKILL. */
export const KILL_GRACE_MS = 10_000
/** How long the driver waits for an exit after SIGKILL before it stops waiting at all. */
export const REAP_GRACE_MS = 5_000

/**
 * Wait for a session, bounded (the hang guard). Without `timeoutMs` this is
 * `session.wait()` and nothing else — the default, deliberately: a task's
 * honest duration is the operator's to know, and a driver that guessed one
 * would kill sessions that were working.
 *
 * With it, a session that has not ended by the deadline is signalled, SIGKILLed
 * after a grace, and finally given up on — the driver synthesises an exit
 * rather than waiting forever on a `wait()` that a wedged grandchild may never
 * settle. That last step is the whole point: an unattended run must have no
 * state it can sit in indefinitely.
 *
 * Only the WAIT is bounded. The handoff reason is still read from the fold
 * (D5): a session killed on the clock may well have finished its task and
 * written back before its process wedged, and an exit is not a reason.
 */
export interface WaitBounds {
  /** Kill the session when it has not ended in this long; absent waits forever. */
  timeoutMs?: number
  /** SIGTERM → SIGKILL grace (default KILL_GRACE_MS). */
  killGraceMs?: number
  /** SIGKILL → stop waiting grace (default REAP_GRACE_MS). */
  reapGraceMs?: number
  onEscalate?: (line: string) => void
}

export async function awaitSession(session: AgentSession, bounds: WaitBounds = {}): Promise<SessionExit> {
  const { timeoutMs } = bounds
  if (timeoutMs === undefined) return session.wait()
  const escalate = bounds.onEscalate ?? ((): void => {})
  const exit = session.wait()
  const after = (ms: number): Promise<'timeout'> =>
    new Promise((resolve) => setTimeout(() => resolve('timeout'), ms).unref())

  if ((await Promise.race([exit, after(timeoutMs)])) !== 'timeout') return exit
  escalate(`  no exit after ${Math.round(timeoutMs / 1000)}s — signalling the session`)
  session.kill('SIGTERM')
  if ((await Promise.race([exit, after(bounds.killGraceMs ?? KILL_GRACE_MS)])) !== 'timeout') return exit
  escalate('  still running — SIGKILL')
  session.kill('SIGKILL')
  if ((await Promise.race([exit, after(bounds.reapGraceMs ?? REAP_GRACE_MS)])) !== 'timeout') return exit
  escalate('  no exit after SIGKILL — the driver stops waiting and reads the record instead')
  return { code: null, signal: 'SIGKILL' }
}

/**
 * Watch a running session's context and nudge it ONCE when it crosses the
 * threshold. Returns the stop function and a `nudged()` the loop reads
 * afterwards, because the handoff reason has to say which lever moved.
 *
 * Once only, deliberately: the file is created and stays, so the PostToolUse
 * hook re-injects the instruction on every subsequent tool call anyway — a
 * second write would change nothing but the timestamp. The timer is unref'd,
 * so a driver waiting on nothing else can still exit.
 */
export function watchThreshold(
  session: AgentSession,
  thresholdPct: number,
  contextWindow: number,
  onNudge?: (detail: NudgeDetail) => void,
): { stop: () => void; nudged: () => boolean } {
  let fired = false
  const read = (): void => {
    if (fired) return
    const tokens = session.usage()?.context_tokens
    if (tokens === undefined) return
    const pct = (tokens / contextWindow) * 100
    if (pct < thresholdPct) return
    fired = true
    const detail: NudgeDetail = { pct, tokens }
    session.nudge?.(detail)
    onNudge?.(detail)
  }
  // Read once before waiting: a session that reports a full window from its
  // first turn — a resumed one, or one whose prompt is already enormous —
  // should be told at once, not one poll later.
  read()
  const timer = setInterval(read, NUDGE_POLL_MS)
  timer.unref()
  return { stop: () => clearInterval(timer), nudged: () => fired }
}

export interface DriveTask {
  /** Phase the task belongs to — reported, never recorded (the task id is the key). */
  phase: string
  id: string
  title: string
  /** Where the plan says this task wants to run (3.2); resolved by `resolveRoute`. */
  route?: TaskRoute
}

export interface DriveOptions {
  /** The run's default adapter, recorded in `run_started.adapter`. */
  adapter: Adapter
  /**
   * Adapters a task's `route.agent` may name (3.2), by name. The CLI builds
   * this from the one list of agent names it owns; the loop never learns a
   * name, it only looks one up. A route naming anything absent here refuses
   * the run rather than falling back to `adapter` (D10).
   */
  agents?: ReadonlyMap<string, Adapter>
  policy?: RunPolicy
  /** Percentage of `contextWindow` at which a running session is nudged; REQUIRED for `threshold`. */
  thresholdPct?: number
  /** Tokens the session's context window holds — the denominator; REQUIRED for `threshold`. */
  contextWindow?: number
  /** Stop before launching session N+1 when N have been launched in this run. */
  maxSessions?: number
  /** Stop after this many CONSECUTIVE stalls (default DEFAULT_MAX_STALLS). */
  maxStalls?: number
  /**
   * Kill a session that has not ended within this many milliseconds (the hang
   * guard). Absent means wait forever, which is the right default for an agent
   * doing real work and the wrong one for an agent that has wedged — so an
   * unattended run should state it. A per-DRIVER knob like `maxStalls`, not a
   * run property: it bounds one launch rather than describing the run, so it
   * is not recorded and a resumed run takes the resuming driver's.
   */
  sessionTimeoutMs?: number
  /** Stop before the next launch once the run's reported cost reaches this. */
  costCapUsd?: number
  /** Directory every session is launched in; default the repo root (D6). */
  cwd?: string
  /**
   * Routing hints for the whole run. A `surface` carrying its own model/effort
   * wins over these — on a resumed run those are the values the run recorded,
   * and one run must not be half one model. Both outrank a task's own `route`
   * (3.2, D10): what the run states, the task cannot take back.
   */
  model?: string
  effort?: string
  /**
   * The permission surface every session in this run is launched under (2.4,
   * D8). Recorded once in `run_started`; a resumed run keeps its OWN, the way
   * it already keeps its threshold and window. Absent leaves every session to
   * the operator's ambient configuration, and the run records that by
   * recording nothing.
   */
  surface?: PermissionSurface
  /** Adopt the latest run when it has no stop, instead of refusing. */
  resume?: boolean
  /** Progress lines in order, as they happen — the CLI prints them to stderr. */
  onProgress?: (line: string) => void
}

export interface DriveHandoff {
  session_id: string
  reason: HandoffReason
  task: string
  tokens?: number
}

export interface DriveOutcome {
  run: string
  initiative: string
  policy: RunPolicy
  /** Where sessions were launched — the record of what this run actually drove. */
  cwd: string
  /** Handoffs THIS driver appended; a resumed run's earlier ones stay in the fold. */
  handoffs: DriveHandoff[]
  /**
   * Launches that resolved to no session, or to several (D3). They are counted
   * as stalls and as sessions, but no handoff is filed: a handoff names a
   * session, and naming the wrong one files a run's history on someone else's
   * work.
   */
  unresolved: number
  /** Cost the adapter reported, summed over the launches this driver made. */
  cost_usd: number
  stop: { reason: RunStopReason; note?: string }
}

/**
 * The next task to run: within a phase, the one already `active` if there is
 * one, else the first `pending`. Phases are tried active-first and then in
 * plan order, so a run continues past a phase boundary rather than stopping
 * at one — `done`, `blocked` and `dropped` phases are skipped entirely.
 *
 * `blocked` tasks are skipped for the same reason the loop stops on one it
 * caused: a blocked task is waiting on the operator, and relaunching a session
 * onto it would burn a session re-discovering that.
 */
export function nextTask(state: InitiativeState): DriveTask | undefined {
  return queuedTasks(state)[0]
}

/**
 * Every task this run could still reach, in the order it would reach them —
 * `nextTask` is the head of this list, by construction rather than by a second
 * traversal that could disagree with it. The routing preview walks the whole
 * queue (3.2), because a run refuses to start on a route it cannot honour and
 * the task carrying it may be five sessions away.
 */
export function queuedTasks(state: InitiativeState): DriveTask[] {
  const queued: DriveTask[] = []
  for (const phase of orderedPhases(state)) {
    if (phase.status !== 'pending' && phase.status !== 'active') continue
    // Active before pending WITHIN the phase, so the head of this list is the
    // task the loop would take next even when an earlier sibling is pending.
    for (const status of ['active', 'pending'] as const) {
      for (const task of phase.tasks) {
        if (task.status !== status) continue
        queued.push({
          phase: phase.name,
          id: task.id,
          title: task.title,
          ...(task.route !== undefined ? { route: task.route } : {}),
        })
      }
    }
  }
  return queued
}

function orderedPhases(state: InitiativeState): PhaseState[] {
  const active = state.phases.find((p) => p.name === state.current.active_phase)
  if (active === undefined) return [...state.phases]
  return [active, ...state.phases.filter((p) => p !== active)]
}

/** Task id → status, the before/after snapshot a handoff reason is read from. */
function taskStatuses(state: InitiativeState): Map<string, string> {
  const statuses = new Map<string, string>()
  for (const phase of state.phases) for (const task of phase.tasks) statuses.set(task.id, task.status)
  return statuses
}

/**
 * Why the driver moved on (D5), read from the fold alone.
 *
 * `needs_user` first: the named task is `blocked`, which is the record's
 * existing word for "wants to happen, cannot yet" and already requires a
 * note, so the operator's question is recorded where the next reader looks.
 * The prompt tells the session to use it, so this stop is TRIGGERED by the
 * agent rather than inferred about it.
 *
 * `task_done` needs BOTH halves of a finished handoff: a write-back (or the
 * next session resumes from a next_action that predates this one's work) and
 * some task actually resolved. A session that closed a task and skipped its
 * write-back left the queue where it was, so it counts as a stall.
 */
export function handoffReason(
  before: Map<string, string>,
  after: InitiativeState,
  taskId: string,
  sessionId: string,
  nudged = false,
): HandoffReason {
  const statuses = taskStatuses(after)
  if (statuses.get(taskId) === 'blocked') return 'needs_user'
  if (!wroteBack(after, sessionId)) return 'stall'
  for (const [id, status] of statuses) {
    if (isResolvedTaskStatus(status) && !isResolvedTaskStatus(before.get(id) ?? 'pending')) {
      // A nudged session that then wrapped up handed off because the GAUGE
      // said so, whatever else it finished on the way — that is what the
      // threshold policy is, and the reason has to say which lever moved.
      return nudged ? 'threshold' : 'task_done'
    }
  }
  return 'stall'
}

/**
 * The opening prompt: the task, how far to go, and the blocked lever (D5).
 *
 * The policy changes ONE paragraph, and it is the load-bearing one. Print mode
 * ends the session when the turn ends, so a session that stops at its task is
 * the `task` policy by construction; `threshold` only exists if the prompt
 * says to keep taking tasks, and the nudge is what ends it (2.3). Telling a
 * threshold session to stop after one task would make the gauge decorative.
 */
export function renderPrompt(initiative: string, task: DriveTask, policy: RunPolicy = 'task'): string {
  const scope =
    policy === 'threshold'
      ? [
          'Start with THIS task, and when it is finished take the next one from the plan',
          'the same way — done, written back, committed — until sofar tells you the context',
          'is nearly full. That message names a percentage and asks you to finish the',
          'current task and hand off; when it arrives, finish that task and end your turn',
          'without starting another.',
        ]
      : [
          'Do THIS TASK ONLY, to the acceptance criteria the record names. Do not start the',
          'next one: the driver launches a fresh session for it, and running on costs the',
          'context that session needs.',
        ]
  return [
    `Task ${task.id} — ${task.title}`,
    '',
    `You are one session in a driven run of the initiative \`${initiative}\`. The record —`,
    'goal, standing constraints, decisions, next action — is injected at session start;',
    `if you did not receive it, run \`sofar status ${initiative}\` before anything else.`,
    '',
    ...scope,
    '',
    'Finish the way the protocol says: log decisions as you make them, mark the task',
    'done with sofar_update_task, write back with sofar_end_session (summary + the',
    'single next action), then commit code and record together.',
    '',
    'If the task needs a decision only the operator can take, do NOT guess and do not',
    'do the work anyway: mark the task blocked with sofar_update_task (status',
    '"blocked", note = the question), write back, and end your turn. That is the',
    'signal that stops the run and puts your question in front of the operator.',
  ].join('\n')
}

/**
 * Run the loop. Preflight failures throw (nothing was recorded, so nothing has
 * to be unwound); once `run_started` is in the log every ending — including an
 * unexpected one — leaves a `run_stopped` behind it, because a run with no
 * stop is a run the next driver has to ask the operator about.
 */
export async function drive(
  rootDir: string,
  slug: string | undefined,
  options: DriveOptions,
): Promise<DriveOutcome> {
  const ctx = createToolContext(rootDir)
  const initiative = ctx.resolveInitiative(slug)
  const adapter = options.adapter
  const progress = options.onProgress ?? ((): void => {})
  const policy: RunPolicy = options.policy ?? 'task'

  const unavailable = policyUnavailable(adapter.capabilities, policy)
  if (unavailable !== null) throw new ToolError('invalid_input', `sofar drive: ${unavailable}`)
  // Both halves or neither (2.3): the percentage is a percentage OF the
  // window, and a run recording one without the other could not say what
  // number of tokens it actually nudged at.
  let thresholdPct: number | undefined
  let contextWindow: number | undefined
  if (policy === 'threshold') {
    thresholdPct = options.thresholdPct
    contextWindow = options.contextWindow
    if (thresholdPct === undefined || contextWindow === undefined) {
      throw new ToolError(
        'invalid_input',
        'sofar drive: the `threshold` policy needs both --threshold-pct and --context-window — a percentage with no denominator names no number of tokens',
      )
    }
    if (!Number.isInteger(thresholdPct) || thresholdPct < 1 || thresholdPct > 100) {
      throw new ToolError('invalid_input', `sofar drive: --threshold-pct must be 1..100, got ${thresholdPct}`)
    }
    if (!Number.isInteger(contextWindow) || contextWindow < 1) {
      throw new ToolError(
        'invalid_input',
        `sofar drive: --context-window must be a positive whole number of tokens, got ${contextWindow}`,
      )
    }
  }

  // Run-owned, like thresholdPct and contextWindow above: stated by this
  // driver's flags for a fresh run, taken from the record for a resumed one.
  let surface = options.surface

  const cwd = resolve(options.cwd ?? rootDir)
  assertSameRecord(cwd, initiative, ctx.eventsPath(initiative))
  warnOnForeignBinding(cwd, initiative, progress)

  const before0 = ctx.foldState(initiative)
  const last = latestRun(before0)
  const resuming = last !== undefined && last.stopped === undefined
  let priorSessions = 0
  let maxSessions = options.maxSessions
  // Progress lines held until the run is CERTAIN to start. Everything below
  // can still refuse — a route this run cannot reach refuses last (3.2) — and
  // an operator told "run <id> — claude-code, task policy" by a driver that
  // then declined to start would have been told about a run that never was.
  const opening: string[] = []
  if (resuming) {
    if (options.resume !== true) {
      throw new ToolError(
        'invalid_input',
        `sofar drive: run ${last.id} on "${initiative}" has no stop — either a driver is still running it or one died mid-run, and the record cannot tell which. Re-run with --resume to pick it up.`,
      )
    }
    priorSessions = last.handoffs.length
    if (last.max_sessions !== undefined) maxSessions = last.max_sessions
    // The resumed run's own numbers win over this driver's flags: the run is
    // one thing, and half of it nudging at 80% of 200k while the other half
    // nudges at 80% of 1M is two runs wearing one id.
    if (last.policy !== policy) {
      throw new ToolError(
        'invalid_input',
        `sofar drive: run ${last.id} runs the \`${last.policy}\` policy; --resume cannot change it to \`${policy}\``,
      )
    }
    thresholdPct = last.threshold_pct ?? thresholdPct
    contextWindow = last.context_window ?? contextWindow
    // The run's own surface wins, for the reason its threshold does (D8): a
    // run whose first half could run `npm test` and whose second half could
    // not is two runs wearing one id, and the record shows only the first.
    if (last.surface !== undefined && !sameSurface(last.surface, surface)) {
      opening.push(
        `keeping run ${last.id}'s recorded surface (${describeSurface(last.surface)}) over this driver's flags — start a new run to change it`,
      )
    }
    surface = last.surface ?? surface
    opening.push(`resuming run ${last.id} — ${priorSessions} handoff(s) already recorded`)
    // The two budgets the RECORD cannot carry, said before the run rather
    // than discovered from a bill (D9). `threshold_pct`, `context_window`,
    // `max_sessions` and `surface` all survive a resume because `run_started`
    // holds them; what the earlier driver SPENT and how many of its launches
    // resolved to nobody are not events, so neither counter can be seeded
    // from the fold. A cap that quietly starts again from zero is the same
    // silent trap as one that cannot fire at all.
    if (options.costCapUsd !== undefined) {
      opening.push(
        `warning: --cost-cap $${options.costCapUsd.toFixed(2)} counts only THIS driver's launches — what run ${last.id} already spent is not in the record, so the cap starts again from zero`,
      )
    }
    if (maxSessions !== undefined) {
      opening.push(
        `warning: run ${last.id}'s ${maxSessions}-session budget is counted from its ${priorSessions} recorded handoff(s) — launches that resolved to no session file no handoff (D3), so a run that stalled that way has already spent more of the budget than the record can show`,
      )
    }
  }
  const runId = resuming ? last.id : ulid()
  if (!resuming) {
    opening.push(`run ${runId} — ${adapter.name}, ${policy} policy, in ${cwd}`)
    if (surface !== undefined) opening.push(`  permissions: ${describeSurface(surface)}`)
  }

  // Everything a launch needs to know about WHERE a task runs (3.2): the
  // default adapter, the ones a task may name, and what the run has pinned.
  // Built once, from the surface as it now stands — which on a resumed run is
  // the record's, not this driver's flags.
  const routing: RoutingOptions = {
    adapter,
    policy,
    ...(options.agents !== undefined ? { agents: options.agents } : {}),
    ...(surface !== undefined ? { surface } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.costCapUsd !== undefined ? { costCapUsd: options.costCapUsd } : {}),
  }
  // What this adapter cannot honour, said BEFORE the first launch (D9). A
  // resumed run says it too: the flags are this driver's, and an operator who
  // set an inert one should hear it from the driver rather than from a run
  // that never stopped.
  for (const line of inertOptions(adapter.capabilities, {
    ...(surface !== undefined ? { surface } : {}),
    ...(options.costCapUsd !== undefined ? { costCapUsd: options.costCapUsd } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
  })) {
    opening.push(`warning: ${line}`)
  }
  // Every queued task's route, resolved before anything is recorded (3.2,
  // D10). This THROWS on a route the run cannot honour, which is why it runs
  // ahead of the run_started append: a refusal leaves no run behind it.
  const stated = new Set<string>()
  try {
    for (const line of previewRoutes(queuedTasks(before0), routing)) {
      stated.add(line)
      opening.push(`warning: ${line}`)
    }
  } catch (err) {
    // A refusal, wearing the command's name. Inside the loop the same throw
    // stops the run with the same sentence; here nothing has been recorded, so
    // it is a preflight error like a bad --permission-mode.
    if (err instanceof RouteError) throw new ToolError('invalid_input', `sofar drive: ${err.message}`)
    throw err
  }

  if (!resuming) {
    ctx.appendAndProject(
      initiative,
      'run_started',
      {
        run: runId,
        adapter: adapter.name,
        policy,
        ...(thresholdPct !== undefined ? { threshold_pct: thresholdPct } : {}),
        ...(contextWindow !== undefined ? { context_window: contextWindow } : {}),
        ...(maxSessions !== undefined ? { max_sessions: maxSessions } : {}),
        ...(surface !== undefined ? { surface } : {}),
      },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
  }
  for (const line of opening) progress(line)

  const maxStalls = options.maxStalls ?? DEFAULT_MAX_STALLS
  const handoffs: DriveHandoff[] = []
  let unresolved = 0
  let stalls = 0
  let cost = 0
  let stop: { reason: RunStopReason; note?: string } | undefined

  // An operator's ^C ends the RUN, not just the session it lands in: the child
  // is signalled, its handoff is still recorded from whatever the record shows,
  // and the run stops as `interrupted` so the next driver knows a human ended
  // it rather than a rule.
  let interrupted = false
  let signals = 0
  let live: AgentSession | undefined
  const onSignal = (): void => {
    interrupted = true
    signals += 1
    // The first ^C ends the run politely. A second is the operator saying they
    // will not wait, and it escalates to SIGKILL rather than killing the
    // DRIVER: an operator who cannot get out without orphaning the run would
    // leave a run with no stop, which is the one thing the next driver cannot
    // read. SIGKILL unblocks the wait, so the run still gets its stop.
    if (signals === 1) {
      live?.kill()
      progress('interrupted — signalling the session; ^C again to kill it outright')
    } else {
      live?.kill('SIGKILL')
    }
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    for (;;) {
      if (interrupted) {
        stop = { reason: 'interrupted' }
        break
      }
      const state = ctx.foldState(initiative)
      if (isClosedInitiativeStatus(state.status)) {
        stop = { reason: 'closed', note: `initiative is ${state.status}` }
        break
      }
      const task = nextTask(state)
      if (task === undefined) {
        stop = { reason: 'closed', note: 'no task left to run — every task is done, dropped or blocked' }
        break
      }
      const launched = priorSessions + handoffs.length + unresolved
      if (maxSessions !== undefined && launched >= maxSessions) {
        stop = { reason: 'max_sessions', note: `${launched} session(s) launched` }
        break
      }
      if (options.costCapUsd !== undefined && cost >= options.costCapUsd) {
        stop = {
          reason: 'cost_cap',
          note: `$${cost.toFixed(2)} reported, cap $${options.costCapUsd.toFixed(2)}`,
        }
        break
      }

      const beforeStatuses = taskStatuses(state)
      // Who was in the record BEFORE the launch: the exact half of session
      // resolution (below), where a millisecond timestamp is only the coarse one.
      const knownSessions = new Set(state.sessions.map((s) => s.id))
      const launchedAt = new Date().toISOString()
      // Where this task runs (3.2): the run's pins first, the task's route for
      // what the run left open. A route the run cannot reach THROWS, and the
      // catch below stops the run with that sentence rather than launching the
      // task on the default agent (D10). A hint the preview already stated is
      // not restated; one on a task the plan grew mid-run is.
      const route = resolveRoute(task.id, task.route, routing)
      for (const line of route.inert) {
        if (stated.has(line)) continue
        stated.add(line)
        progress(`warning: ${line}`)
      }
      const routed = route.adapter
      progress(
        `session ${launched + 1}: ${task.id} — ${task.title}${routed !== adapter ? ` via ${routed.name}` : ''}`,
      )
      const session = routed.launch({
        cwd,
        initiative,
        prompt: renderPrompt(initiative, task, policy),
        task: { id: task.id, title: task.title },
        ...(route.model !== undefined ? { model: route.model } : {}),
        ...(route.effort !== undefined ? { effort: route.effort } : {}),
        ...(surface !== undefined ? { surface } : {}),
      })
      live = session
      const gauge =
        policy === 'threshold' && thresholdPct !== undefined && contextWindow !== undefined
          ? watchThreshold(session, thresholdPct, contextWindow, (detail) =>
              progress(`  nudged at ${Math.round(detail.pct ?? 0)}% (${detail.tokens} ctx tokens)`),
            )
          : undefined
      let exit
      try {
        exit = await awaitSession(session, {
          ...(options.sessionTimeoutMs !== undefined ? { timeoutMs: options.sessionTimeoutMs } : {}),
          onEscalate: progress,
        })
      } finally {
        gauge?.stop()
      }
      live = undefined
      cost += exit.usage?.cost_usd ?? 0

      const after = ctx.foldState(initiative)
      const resolved = resolveLaunchedSession(after, exit, launchedAt, routed.name, knownSessions)
      if (resolved.kind !== 'found') {
        // No session to name, so no handoff to file (D3). It still counts as a
        // launch and as a stall — the queue did not move and the next one is
        // unlikely to fare better.
        unresolved += 1
        stalls += 1
        const why =
          resolved.kind === 'ambiguous'
            ? `${resolved.candidates.length} sessions registered by ${routed.name} since the launch (${resolved.candidates.join(', ')}) — the driver does not guess which was its own`
            : `no session registered by ${routed.name} since the launch (exit ${exit.code ?? exit.signal ?? 'unknown'})`
        progress(`  unresolved: ${why}`)
        if (interrupted) {
          stop = { reason: 'interrupted', note: why }
          break
        }
        if (stalls >= maxStalls) {
          stop = { reason: 'stall', note: `${stalls} consecutive stalls; last: ${why}` }
          break
        }
        continue
      }

      const sessionId = resolved.session.id
      const reason = handoffReason(beforeStatuses, after, task.id, sessionId, gauge?.nudged() === true)
      const tokens = exit.usage?.context_tokens
      ctx.appendAndProject(
        initiative,
        'handoff',
        {
          run: runId,
          session_id: sessionId,
          reason,
          task: task.id,
          ...(tokens !== undefined ? { tokens } : {}),
        },
        { session: 'cli', source: 'cli', actor: 'human' },
      )
      handoffs.push({ session_id: sessionId, reason, task: task.id, ...(tokens !== undefined ? { tokens } : {}) })
      progress(`  ${reason} — session ${sessionId}${tokens !== undefined ? `, ${tokens} ctx tokens` : ''}`)
      stalls = reason === 'stall' ? stalls + 1 : 0

      if (interrupted) {
        stop = { reason: 'interrupted' }
        break
      }
      if (reason === 'needs_user') {
        stop = { reason: 'needs_user', note: `${task.id} is blocked — read its note` }
        break
      }
      if (stalls >= maxStalls) {
        stop = { reason: 'stall', note: `${stalls} consecutive sessions with no task change` }
        break
      }
    }
  } catch (err) {
    stop = { reason: 'error', note: errorNote(err) }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }

  const ended = stop ?? { reason: 'error' as RunStopReason, note: 'the loop ended without a stop rule' }
  ctx.appendAndProject(
    initiative,
    'run_stopped',
    { run: runId, reason: ended.reason, ...(ended.note !== undefined ? { note: ended.note } : {}) },
    { session: 'cli', source: 'cli', actor: 'human' },
  )
  return {
    run: runId,
    initiative,
    policy,
    cwd,
    handoffs,
    unresolved,
    cost_usd: cost,
    stop: ended,
  }
}

/**
 * What a thrown value says, in a form `run_stopped` can actually carry.
 *
 * `note` is REQUIRED for reason `error` and the validator refuses an empty
 * one, so an Error whose message is blank would cost the run its STOP: the
 * append throws, `drive` throws with it, and the log keeps a `run_started`
 * that nothing closes — the exact outcome the catch around the loop exists
 * to prevent, reached through the catch itself. The fallback names the thrown
 * value's own type, which is the only thing left to say about it.
 */
function errorNote(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.trim().length > 0) return message
  return `the run ended on a thrown ${err instanceof Error ? err.name : typeof err} carrying no message`
}

/**
 * The launch directory must serve the SAME log (D6). The record is committed,
 * so a plain worktree holds a stale COPY of it: a session launched there would
 * write into a second events.jsonl the driver never reads, forking the queue
 * silently. realpath equality catches exactly that, and passes for the repo
 * root and for a worktree whose `.sofar` is a symlink to the real one.
 */
function assertSameRecord(cwd: string, initiative: string, target: string): void {
  const driven = join(cwd, '.sofar', 'initiatives', initiative, 'events.jsonl')
  if (!existsSync(driven)) {
    throw new ToolError(
      'unknown_initiative',
      `sofar drive: ${cwd} has no record for "${initiative}" (${driven} does not exist) — sessions launched there would write nowhere this driver reads`,
    )
  }
  if (realpathSync(driven) !== realpathSync(target)) {
    throw new ToolError(
      'invalid_input',
      `sofar drive: ${cwd} carries a DIFFERENT log for "${initiative}" (${realpathSync(driven)}, not ${realpathSync(target)}) — a session launched there would fork the queue. Point --cwd at the repo root, or symlink the worktree's .sofar at the real record.`,
    )
  }
}

/**
 * The child's SessionStart hook resolves the digest from ITS cwd's branch
 * binding, not from the driver's argument. A launch directory bound elsewhere
 * still writes to the right record — the prompt pins it (D4) — but the session
 * opens on the wrong digest, so say so rather than let it be discovered from
 * the transcript.
 */
function warnOnForeignBinding(cwd: string, initiative: string, progress: (line: string) => void): void {
  let bound: string | null = null
  try {
    bound = createToolContext(cwd).resolveInitiative()
  } catch {
    bound = null
  }
  if (bound === initiative) return
  progress(
    `warning: ${cwd} binds to ${bound ?? 'no initiative'}, not "${initiative}" — driven sessions will be injected with that record's digest and must re-home; the prompt still pins their writes`,
  )
}
