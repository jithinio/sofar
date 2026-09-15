import { ToolError, createToolContext } from '../mcp/context'
import { latestRun } from '../core/fold'
import { describeRun } from '../projections/templates/shared'
import { ClaudeCodeAdapter } from '../driver/claude-code'
import { CodexAdapter } from '../driver/codex'
import { drive, type DriveOptions } from '../driver/drive'
import { buildSurface, SurfaceError } from '../driver/permissions'
import type { Adapter } from '../driver/adapter'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar drive <initiative>` (session-driver 2.2) — the CLI skin on the loop
 * in driver/drive.ts. It builds the adapter, streams progress to STDERR while
 * the run goes (stdout carries the one summary line, so `sofar drive | …`
 * stays parseable), and mirrors the run's own record back through
 * `describeRun` rather than restating it: the log is the truth about what
 * happened, including for the driver that just wrote it.
 *
 * Exit code is 0 for every stop the record can explain — `needs_user` and
 * `stall` are outcomes of a working driver, not failures of the command —
 * and 1 only for `error`, or for a preflight that refused to start a run.
 */

export interface DriveCliOptions {
  policy?: string
  thresholdPct?: string
  contextWindow?: string
  maxSessions?: string
  maxStalls?: string
  costCap?: string
  /** Seconds a single session may run before the driver kills it (the hang guard). */
  sessionTimeout?: string
  cwd?: string
  model?: string
  effort?: string
  resume?: boolean
  /** Which agent to drive: `claude-code` (default) or `codex` (3.1). */
  agent?: string
  /** Binary the adapter spawns (default: the agent's own name). */
  bin?: string
  /** Permission surface for every session in the run (2.4). */
  permissionMode?: string
  allow?: string[]
  deny?: string[]
  /** Drop sofar's default allow-list and use only what --allow states. */
  bareTools?: boolean
  /**
   * Extra argv appended to the agent's own flags — the operator's escape hatch
   * past everything above, and the reason sofar's flag vocabulary falling
   * behind an agent's is an inconvenience rather than a wall. Reaches the
   * agent `--agent` NAMED and no other, for the reason `--bin` does.
   */
  agentArgs?: string[]
  /** Test seam: an adapter to drive with, instead of building the Claude Code one. */
  adapter?: Adapter
}

function positive(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ToolError('invalid_input', `sofar drive: ${name} must be a positive number, got "${raw}"`)
  }
  return value
}

function integer(name: string, raw: string | undefined): number | undefined {
  const value = positive(name, raw)
  if (value !== undefined && !Number.isInteger(value)) {
    throw new ToolError('invalid_input', `sofar drive: ${name} must be a whole number, got "${raw}"`)
  }
  return value
}

/**
 * Every agent this build can launch. Adding one here is the whole cost of a
 * new agent (3.1): the loop takes an `Adapter` and asks it nothing an adapter
 * cannot answer, so the CLI is the only place that knows the names — and
 * per-task routing (3.2) is a lookup in THIS list rather than a second one.
 */
export const AGENTS = ['claude-code', 'codex'] as const

type AgentOptions = { bin?: string; args?: string[] }

function adapterNamed(agent: string, options: AgentOptions): Adapter {
  if (agent === 'claude-code') return new ClaudeCodeAdapter(options)
  if (agent === 'codex') return new CodexAdapter(options)
  throw new ToolError('invalid_input', `sofar drive: --agent must be one of ${AGENTS.join('|')}, got "${agent}"`)
}

/**
 * The run's default adapter and everything a task may route to.
 *
 * `--bin` and `--agent-args` reach the agent `--agent` NAMED and no other: an
 * operator who points `--bin` at a wrapper script meant one binary, and
 * handing the same path to a routed codex session would launch the wrong
 * program under a name the record would still spell "codex". Routed adapters
 * therefore take their own defaults, and the default adapter is the SAME
 * instance in both places so a route back to it is the run's own adapter
 * rather than a second copy of it.
 */
function buildAgents(options: DriveCliOptions): { adapter: Adapter; agents: Map<string, Adapter> } {
  const agent = options.agent ?? 'claude-code'
  const adapter =
    options.adapter ??
    adapterNamed(agent, {
      ...(options.bin !== undefined ? { bin: options.bin } : {}),
      ...(options.agentArgs !== undefined ? { args: options.agentArgs } : {}),
    })
  const agents = new Map<string, Adapter>([[adapter.name, adapter]])
  for (const name of AGENTS) {
    if (agents.has(name)) continue
    agents.set(name, adapterNamed(name, {}))
  }
  return { adapter, agents }
}

export async function runDrive(
  rootDir: string,
  slug: string | undefined,
  options: DriveCliOptions = {},
  onProgress: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<CmdResult> {
  let driveOptions: DriveOptions
  try {
    const maxStalls = integer('--max-stalls', options.maxStalls)
    const maxSessions = integer('--max-sessions', options.maxSessions)
    const thresholdPct = integer('--threshold-pct', options.thresholdPct)
    const contextWindow = integer('--context-window', options.contextWindow)
    const costCapUsd = positive('--cost-cap', options.costCap)
    const sessionTimeoutSec = positive('--session-timeout', options.sessionTimeout)
    // The surface is built HERE, before anything is recorded: a bad
    // --permission-mode is a preflight refusal with no run_started behind it,
    // not a run that starts and dies on its first launch.
    const surface = buildSurface({
      ...(options.permissionMode !== undefined ? { mode: options.permissionMode } : {}),
      ...(options.allow !== undefined ? { allow: options.allow } : {}),
      ...(options.deny !== undefined ? { deny: options.deny } : {}),
      ...(options.bareTools === true ? { bare: true } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
    })
    const { adapter, agents } = buildAgents(options)
    driveOptions = {
      adapter,
      agents,
      ...(options.policy !== undefined ? { policy: options.policy as DriveOptions['policy'] } : {}),
      ...(thresholdPct !== undefined ? { thresholdPct } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxSessions !== undefined ? { maxSessions } : {}),
      ...(maxStalls !== undefined ? { maxStalls } : {}),
      ...(costCapUsd !== undefined ? { costCapUsd } : {}),
      ...(sessionTimeoutSec !== undefined ? { sessionTimeoutMs: sessionTimeoutSec * 1_000 } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.effort !== undefined ? { effort: options.effort } : {}),
      ...(options.resume === true ? { resume: true } : {}),
      surface,
      onProgress,
    }
  } catch (err) {
    return fail(err instanceof SurfaceError ? `sofar drive: ${err.message}` : errMessage(err))
  }

  // Policy names are checked before the run, so a typo never reaches the
  // payload validator as a run_started rejection.
  if (driveOptions.policy !== undefined && driveOptions.policy !== 'task' && driveOptions.policy !== 'threshold') {
    return fail(`sofar drive: --policy must be \`task\` or \`threshold\`, got "${driveOptions.policy}"`)
  }

  let outcome
  try {
    outcome = await drive(rootDir, slug, driveOptions)
  } catch (err) {
    return fail(errMessage(err))
  }

  const state = createToolContext(rootDir).foldState(outcome.initiative)
  const run = state.runs.find((r) => r.id === outcome.run)
  const lines = [run !== undefined ? describeRun(run) : `run ${outcome.run} — stopped: ${outcome.stop.reason}`]
  if (outcome.unresolved > 0) {
    lines.push(
      `${outcome.unresolved} launch(es) resolved to no session and carry no handoff — see the run's stop note`,
    )
  }
  if (outcome.cost_usd > 0) lines.push(`cost reported by the adapter: $${outcome.cost_usd.toFixed(2)}`)
  const stdout = `${lines.join('\n')}\n`
  return outcome.stop.reason === 'error' ? { exitCode: 1, stdout, stderr: '' } : ok(stdout)
}

/** How long `--stop` watches for the driver's `run_stopped` before reporting none came. */
export const STOP_WAIT_MS = 30_000

export interface DriveStopOptions {
  /** Test seam: how long to watch for the stop (default STOP_WAIT_MS). */
  waitMs?: number
  /** Test seam: how often to look (default 500ms). */
  pollMs?: number
}

/**
 * `sofar drive [slug] --stop` (in-session-drive D2): ask the driver of the
 * latest unstopped run to end it, through the record — the one channel a
 * detached driver, which no ^C can reach, is already reading. It REQUESTS;
 * only the driver writes `run_stopped`, after reading the handoff of the
 * session it signalled. So the command watches for that stop and says what it
 * saw: the stop with its reason, or that none came — which is also exactly
 * what a request to a driver that already died looks like, and the command
 * says so rather than guessing which it was.
 */
export async function runDriveStop(
  rootDir: string,
  slug: string | undefined,
  options: DriveStopOptions = {},
): Promise<CmdResult> {
  let initiative: string
  let runId: string
  let requests: number
  const ctx = createToolContext(rootDir)
  try {
    initiative = ctx.resolveInitiative(slug)
    const run = latestRun(ctx.foldState(initiative))
    if (run === undefined) return fail(`sofar drive --stop: "${initiative}" has never been driven — nothing to stop`)
    if (run.stopped !== undefined) {
      return fail(`sofar drive --stop: nothing to stop — the latest run on "${initiative}" already ended (${describeRun(run)})`)
    }
    runId = run.id
    requests = run.stop_requests.length + 1
    ctx.appendAndProject(initiative, 'run_stop_requested', { run: runId }, { session: 'cli', source: 'cli', actor: 'human' })
  } catch (err) {
    return fail(errMessage(err))
  }

  const deadline = Date.now() + (options.waitMs ?? STOP_WAIT_MS)
  for (;;) {
    const run = ctx.foldState(initiative).runs.find((r) => r.id === runId)
    if (run?.stopped !== undefined) return ok(`${describeRun(run)}\n`)
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500))
  }
  const escalation =
    requests > 1
      ? 'this was a repeat request, which kills the session outright'
      : 'a second `--stop` kills the session outright'
  return {
    exitCode: 1,
    stdout: '',
    stderr: [
      `sofar drive --stop: stop requested for run ${runId}, but no run_stopped within ${Math.round((options.waitMs ?? STOP_WAIT_MS) / 1000)}s.`,
      `A driver waiting on a session signals it and stops once the session exits; ${escalation}.`,
      `If no driver is running this run, it will never acknowledge — \`sofar drive ${initiative} --resume\` adopts the run, and a --stop after that ends it.`,
      '',
    ].join('\n'),
  }
}
