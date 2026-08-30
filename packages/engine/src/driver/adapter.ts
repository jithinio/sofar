import type { RunPolicy } from '@sofar/schema'
import type { InitiativeState, SessionState } from '../core/fold'
import type { NudgeDetail } from './nudge'
import type { PermissionSurface } from './permissions'

/**
 * The adapter contract (session-driver 1.3, D2/D3): how `sofar drive` reaches
 * a headless agent. Three calls — launch, usage, wait — and nothing else,
 * because the record is the queue and the driver holds no state: everything
 * an adapter cannot answer, the fold answers.
 *
 * What an adapter IS: a process wrapper. It starts the operator's OWN agent
 * (D1: under the operator's auth, never sofar's), reads what that agent's
 * transport happens to show — a session id in a stream, token usage in a
 * result line — and reports the exit. What it is NOT: a judge of record
 * state. Whether a session wrote back is a fact about events.jsonl, and an
 * adapter claiming it would be asserting record state it never checked — the
 * same shape as the conflict line that asserted liveness it never tested
 * (3c909f0). `wroteBack` below asks the fold instead (D3).
 *
 * Two of the three calls are OPTIONAL in effect, and the capabilities say
 * which: `usage()` may never return a number (fx reports none), and a session
 * may have no way to be nudged. The threshold policy needs both; the task
 * policy needs neither, which is why it is the default — it runs on every
 * adapter identically.
 */

/** What an adapter can do, declared up front so the driver picks a policy it can run. */
export interface AdapterCapabilities {
  /**
   * `usage()` can return numbers. Without it the threshold policy is
   * unavailable and handoff reason `threshold` never occurs on this adapter —
   * only task_done / stall / needs_user.
   */
  usage: boolean
  /**
   * The adapter can tell a RUNNING session to finish the current task, write
   * back and end its turn — the threshold nudge. Claude Code delivers it as
   * hook additionalContext; an agent with no such channel cannot be packed.
   */
  nudge: boolean
  /** `launch()` honours a `model` hint (per-task routing, 3.2). */
  model: boolean
  /** `launch()` honours an `effort` hint. */
  effort: boolean
  /**
   * The agent can express PER-TOOL permission rules, so a surface's `allow`
   * and `deny` reach it (2.4). False for an agent whose permission vocabulary
   * is a mode and nothing finer — codex speaks a sandbox enum and an approval
   * policy — and the driver then says so before the run, because a recorded
   * allow-list that had no effect is the overstatement D8 forbids.
   */
  permission_rules: boolean
  /**
   * The transport reports cost, so `--cost-cap` can fire. False leaves the cap
   * inert, which on an unattended run is worse than having no cap at all — so
   * the driver states it rather than letting the operator find out from a bill
   * (D9).
   */
  cost: boolean
}

/**
 * What this adapter cannot honour about `options`, as lines for the run's
 * progress stream (D9). Empty when nothing is inert. Stated BEFORE the first
 * launch: an operator who set a flag that cannot work should learn it from the
 * driver, not from an unattended run that never stopped.
 */
export function inertOptions(
  caps: AdapterCapabilities,
  options: { surface?: PermissionSurface; costCapUsd?: number },
): string[] {
  const lines: string[] = []
  const rules = (options.surface?.allow.length ?? 0) + (options.surface?.deny?.length ?? 0)
  if (!caps.permission_rules && rules > 0) {
    lines.push(
      `this adapter has no per-tool permission rules, so the ${rules} allow/deny rule(s) this run records do NOT reach it — only the mode does`,
    )
  }
  if (!caps.cost && options.costCapUsd !== undefined) {
    lines.push('this adapter reports no cost, so --cost-cap can never fire on this run')
  }
  return lines
}

/** One launch: everything the driver knows that the session should start with. */
export interface LaunchRequest {
  /** Absolute path the session works in — its own worktree under the driver (2.2). */
  cwd: string
  /**
   * The record the session serves. The agent's own hooks and MCP tools find
   * the record from `cwd`; the slug is passed so the adapter can pin the
   * session to it explicitly (bindings move, and a driven session must never
   * write into whatever record the branch happens to name).
   */
  initiative: string
  /** The opening prompt — the driver renders it from the record digest and the task. */
  prompt: string
  /** The task this session is for, when the policy names one; absent leaves it to the record's next action. */
  task?: { id: string; title: string }
  /** Routing hints from the task (3.2); an adapter whose capabilities say no ignores them. */
  model?: string
  effort?: string
  /**
   * The permission surface this session runs under (2.4, D8), stated
   * generically because every headless agent has one and none of them spell
   * it the same way. The ADAPTER renders it into its own config — a settings
   * file for Claude Code — and proves it landed before the spawn. Absent
   * leaves the child to whatever the operator's own configuration says, which
   * is what a run that pinned nothing records.
   */
  surface?: PermissionSurface
  /** Extra environment for the child — the driver's isolation (private TMPDIR, port block). */
  env?: Record<string, string>
}

/** Token accounting as the agent's transport reports it. */
export interface Usage {
  /**
   * Context tokens the session holds right now — for Claude Code, the latest
   * turn's input + cache_read + cache_creation. This is the number the
   * threshold policy compares against `threshold_pct` of the model's window.
   */
  context_tokens: number
  /** Cumulative output tokens, when reported. */
  output_tokens?: number
  /** Cost in USD, when the agent reports it (Claude Code's result line does). */
  cost_usd?: number
}

/** How the agent process ended. */
export interface SessionExit {
  /** Process exit code; null when a signal ended it. */
  code: number | null
  signal?: string
  /**
   * The record session id the adapter saw the agent register, when its
   * transport shows one (Claude Code prints it in its init message). Absent
   * means the transport was silent and the driver resolves the session by
   * diffing the fold — see `resolveLaunchedSession`.
   */
  session_id?: string
  /** The last usage the adapter saw, when it saw any. */
  usage?: Usage
}

/** A launched session: the handle the driver watches until it ends. */
export interface AgentSession {
  /** Latest usage seen; undefined until the transport shows one, or forever on an adapter without `capabilities.usage`. */
  usage(): Usage | undefined
  /**
   * Deliver the threshold nudge, with what the driver saw when it decided to
   * (2.3). Present only on adapters with `capabilities.nudge`.
   */
  nudge?(detail?: NudgeDetail): void
  /** End the session now — cost cap, max sessions, operator interrupt. */
  kill(signal?: NodeJS.Signals): void
  /** Resolves when the process has ended. Never rejects: a crash is an exit with a code. */
  wait(): Promise<SessionExit>
}

export interface Adapter {
  /** Stable name, recorded in `run_started.adapter` and matched against `session_started.tool`. */
  readonly name: string
  readonly capabilities: AdapterCapabilities
  launch(request: LaunchRequest): AgentSession
}

/**
 * Why `policy` cannot run on an adapter with these capabilities, or null when
 * it can. The task policy runs everywhere; the threshold policy needs usage
 * to measure and a nudge to act on the measurement — one without the other is
 * a gauge with no lever, or a lever with no gauge.
 */
export function policyUnavailable(caps: AdapterCapabilities, policy: RunPolicy): string | null {
  if (policy === 'task') return null
  const missing: string[] = []
  if (!caps.usage) missing.push('does not report usage')
  if (!caps.nudge) missing.push('cannot nudge a running session')
  if (missing.length === 0) return null
  return `threshold policy needs an adapter that reports usage and can nudge; this one ${missing.join(' and ')}`
}

/**
 * wrote_back, from the record (D3): the session is registered in this log and
 * carries a write-back. A session_closed alone is an end without a write-back;
 * a session the log never registered wrote back nowhere the driver can see.
 */
export function wroteBack(state: InitiativeState, sessionId: string): boolean {
  const session = state.sessions.find((s) => s.id === sessionId)
  return session !== undefined && session.summary !== undefined
}

export type LaunchedSession =
  | { kind: 'found'; session: SessionState }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: string[] }

/**
 * Which record session a launch became. The adapter's word is taken when the
 * transport showed an id AND the record registered it; otherwise the
 * candidates are the sessions registered at or after the launch, by an agent
 * of the adapter's name, that the caller had not already seen. One candidate
 * is the answer. Several is parallel work the driver did not start, and it
 * must not guess — a wrong guess would file the handoff on someone else's
 * session — so the ambiguity is returned as such and the driver treats it as
 * a stall.
 *
 * `known` — the session ids the caller folded BEFORE launching — is what makes
 * that sound. Timestamps are the weaker half of the filter: `started` has
 * millisecond resolution, so a run whose sessions land inside the same
 * millisecond has every earlier session tie with the launch and read as
 * ambiguity that never happened. The set difference is exact, and the
 * timestamp stays as the check that catches a `known` set from an older fold.
 */
export function resolveLaunchedSession(
  state: InitiativeState,
  exit: SessionExit,
  launchedAt: string,
  tool: string,
  known: ReadonlySet<string> = new Set(),
): LaunchedSession {
  if (exit.session_id !== undefined) {
    const named = state.sessions.find((s) => s.id === exit.session_id)
    if (named !== undefined) return { kind: 'found', session: named }
  }
  const candidates = state.sessions.filter(
    (s) => s.tool === tool && s.started >= launchedAt && !known.has(s.id),
  )
  if (candidates.length === 1) return { kind: 'found', session: candidates[0]! }
  if (candidates.length === 0) return { kind: 'none' }
  return { kind: 'ambiguous', candidates: candidates.map((s) => s.id) }
}
