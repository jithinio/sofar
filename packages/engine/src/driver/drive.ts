import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import {
  isClosedInitiativeStatus,
  isResolvedTaskStatus,
  type HandoffReason,
  type RunPolicy,
  type RunStopReason,
} from '@sofar/schema'
import type { InitiativeState, PhaseState } from '../core/fold'
import { latestRun } from '../core/fold'
import { createToolContext, ToolError } from '../mcp/context'
import {
  policyUnavailable,
  resolveLaunchedSession,
  wroteBack,
  type Adapter,
  type AgentSession,
} from './adapter'

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

export interface DriveTask {
  /** Phase the task belongs to — reported, never recorded (the task id is the key). */
  phase: string
  id: string
  title: string
}

export interface DriveOptions {
  adapter: Adapter
  policy?: RunPolicy
  /** Stop before launching session N+1 when N have been launched in this run. */
  maxSessions?: number
  /** Stop after this many CONSECUTIVE stalls (default DEFAULT_MAX_STALLS). */
  maxStalls?: number
  /** Stop before the next launch once the run's reported cost reaches this. */
  costCapUsd?: number
  /** Directory every session is launched in; default the repo root (D6). */
  cwd?: string
  /** Routing hints passed to every launch; per-task hints are 3.2. */
  model?: string
  effort?: string
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
  for (const phase of orderedPhases(state)) {
    if (phase.status !== 'pending' && phase.status !== 'active') continue
    const task =
      phase.tasks.find((t) => t.status === 'active') ?? phase.tasks.find((t) => t.status === 'pending')
    if (task !== undefined) return { phase: phase.name, id: task.id, title: task.title }
  }
  return undefined
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
): HandoffReason {
  const statuses = taskStatuses(after)
  if (statuses.get(taskId) === 'blocked') return 'needs_user'
  if (!wroteBack(after, sessionId)) return 'stall'
  for (const [id, status] of statuses) {
    if (isResolvedTaskStatus(status) && !isResolvedTaskStatus(before.get(id) ?? 'pending')) return 'task_done'
  }
  return 'stall'
}

/** The opening prompt: the task, the one-task rule, and the blocked lever (D5). */
export function renderPrompt(initiative: string, task: DriveTask): string {
  return [
    `Task ${task.id} — ${task.title}`,
    '',
    `You are one session in a driven run of the initiative \`${initiative}\`. The record —`,
    'goal, standing constraints, decisions, next action — is injected at session start;',
    `if you did not receive it, run \`sofar status ${initiative}\` before anything else.`,
    '',
    'Do THIS TASK ONLY, to the acceptance criteria the record names. Do not start the',
    'next one: the driver launches a fresh session for it, and running on costs the',
    'context that session needs.',
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
  // The threshold policy is a gauge, a lever AND the hook that reads it; the
  // hook is 2.3. Refused here rather than in the CLI so no path can start a
  // threshold run whose nudges reach nothing.
  if (policy === 'threshold') {
    throw new ToolError(
      'invalid_input',
      'sofar drive: the `threshold` policy needs the PostToolUse nudge hook (session-driver 2.3), which is not wired yet — run the default `task` policy',
    )
  }

  const cwd = resolve(options.cwd ?? rootDir)
  assertSameRecord(cwd, initiative, ctx.eventsPath(initiative))
  warnOnForeignBinding(cwd, initiative, progress)

  const before0 = ctx.foldState(initiative)
  const last = latestRun(before0)
  let runId: string
  let priorSessions = 0
  let maxSessions = options.maxSessions
  if (last !== undefined && last.stopped === undefined) {
    if (options.resume !== true) {
      throw new ToolError(
        'invalid_input',
        `sofar drive: run ${last.id} on "${initiative}" has no stop — either a driver is still running it or one died mid-run, and the record cannot tell which. Re-run with --resume to pick it up.`,
      )
    }
    runId = last.id
    priorSessions = last.handoffs.length
    if (last.max_sessions !== undefined) maxSessions = last.max_sessions
    progress(`resuming run ${runId} — ${priorSessions} handoff(s) already recorded`)
  } else {
    runId = ulid()
    ctx.appendAndProject(
      initiative,
      'run_started',
      {
        run: runId,
        adapter: adapter.name,
        policy,
        ...(maxSessions !== undefined ? { max_sessions: maxSessions } : {}),
      },
      { session: 'cli', source: 'cli', actor: 'human' },
    )
    progress(`run ${runId} — ${adapter.name}, ${policy} policy, in ${cwd}`)
  }

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
  let live: AgentSession | undefined
  const onSignal = (): void => {
    interrupted = true
    live?.kill()
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
      progress(`session ${launched + 1}: ${task.id} — ${task.title}`)
      const session = adapter.launch({
        cwd,
        initiative,
        prompt: renderPrompt(initiative, task),
        task: { id: task.id, title: task.title },
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}),
      })
      live = session
      const exit = await session.wait()
      live = undefined
      cost += exit.usage?.cost_usd ?? 0

      const after = ctx.foldState(initiative)
      const resolved = resolveLaunchedSession(after, exit, launchedAt, adapter.name, knownSessions)
      if (resolved.kind !== 'found') {
        // No session to name, so no handoff to file (D3). It still counts as a
        // launch and as a stall — the queue did not move and the next one is
        // unlikely to fare better.
        unresolved += 1
        stalls += 1
        const why =
          resolved.kind === 'ambiguous'
            ? `${resolved.candidates.length} sessions registered by ${adapter.name} since the launch (${resolved.candidates.join(', ')}) — the driver does not guess which was its own`
            : `no session registered by ${adapter.name} since the launch (exit ${exit.code ?? exit.signal ?? 'unknown'})`
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
      const reason = handoffReason(beforeStatuses, after, task.id, sessionId)
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
    stop = { reason: 'error', note: err instanceof Error ? err.message : String(err) }
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
