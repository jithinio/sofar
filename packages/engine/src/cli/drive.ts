import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolError, createToolContext } from '../mcp/context'
import { latestRun } from '../core/fold'
import { describeRun } from '../projections/templates/shared'
import { ClaudeCodeAdapter } from '../driver/claude-code'
import { CodexAdapter } from '../driver/codex'
import { drive, type DriveOptions } from '../driver/drive'
import { buildSurface, SurfaceError } from '../driver/permissions'
import { launchEnv, type Adapter } from '../driver/adapter'
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
  /** Called once the run is certain to start — a detached child answers its caller here. */
  onStarted?: (run: string) => void
  /** Test seam: the environment the command runs in (default process.env). */
  env?: NodeJS.ProcessEnv
}

/**
 * Variables an agent's shell exports and a terminal does not — how a
 * foreground `sofar drive` knows the agent's command timeout is coming for it
 * (in-session-drive D1). Detection, not a list to scrub: that is
 * CALLER_SESSION_ENV's job, and the detached child runs without these.
 */
const AGENT_SHELL_ENV = ['CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID'] as const

export function insideAgentShell(env: NodeJS.ProcessEnv): boolean {
  return AGENT_SHELL_ENV.some((name) => (env[name] ?? '').length > 0)
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
      ...(options.onStarted !== undefined ? { onStarted: options.onStarted } : {}),
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

  // Warned, not refused: the operator may have raised the agent's timeout.
  if (insideAgentShell(options.env ?? process.env)) {
    onProgress(
      "warning: this looks like an agent's shell — its command timeout will end the driver mid-run and orphan the session it is waiting on; `sofar drive --detach` starts a run that outlives the shell",
    )
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

/** The message a detached child sends once its run is certain to start. */
export const DETACH_STARTED = 'sofar-drive-started'
/** Set in the detached child's environment, so it knows to answer over IPC. */
export const DETACH_ENV = 'SOFAR_DRIVE_DETACHED'
/** How long `--detach` waits for the child to start or refuse. */
export const DETACH_START_TIMEOUT_MS = 60_000

/**
 * The detached child's side of the handshake: tell the parent the run started,
 * then let go of the channel. Undefined when this process is not a detached
 * child, so a foreground drive does nothing extra.
 */
export function detachedStartNotifier(env: NodeJS.ProcessEnv = process.env): ((run: string) => void) | undefined {
  if (env[DETACH_ENV] !== '1' || typeof process.send !== 'function') return undefined
  return (run) => {
    if (!process.connected) return
    process.send!({ type: DETACH_STARTED, run })
    process.disconnect?.()
  }
}

export interface DriveDetachOptions {
  /** The command line the CALLER was invoked with, after the binary; `--detach` is removed from it. */
  argv: string[]
  /** Test seam: the environment the caller runs in (default process.env). */
  env?: NodeJS.ProcessEnv
  /** Test seam: what to spawn instead of this same CLI — `[command, ...args]`, the child argv appended. */
  entry?: string[]
  /** Test seam: where the log goes (default <tmpdir>/sofar-drive). */
  logDir?: string
  /** Test seam (default DETACH_START_TIMEOUT_MS). */
  startTimeoutMs?: number
}

/**
 * `sofar drive --detach` (in-session-drive D1): start a run from an agent's
 * shell that outlives that shell.
 *
 * The same command is re-spawned as a detached process — its own session,
 * stdin closed, output to a log file — and this one waits on an IPC channel
 * until the child's run is CERTAIN to start, then prints what the child
 * printed so far (the run line and every D9 warning) with where to follow and
 * how to stop it, and returns. A child that exits first refused preflight, and
 * its refusal becomes this command's output: a refusal written only to a log
 * file is the silent trap D9 forbids.
 *
 * Refused before anything is spawned: a calling session that is registered on
 * the initiative and has not written back — its later write-back would become
 * the next action a driven session resumes from — and a caller whose sandbox
 * has no network, which every launched session would inherit.
 */
export async function runDriveDetached(
  rootDir: string,
  slug: string | undefined,
  options: DriveDetachOptions,
): Promise<CmdResult> {
  const env = options.env ?? process.env
  let initiative: string
  try {
    const ctx = createToolContext(rootDir)
    initiative = ctx.resolveInitiative(slug)
    const caller = env.CLAUDE_CODE_SESSION_ID
    if (caller !== undefined && caller.length > 0) {
      const session = ctx.foldState(initiative).sessions.find((s) => s.id === caller)
      if (session !== undefined && session.summary === undefined) {
        return fail(
          [
            `sofar drive --detach: this session (${caller}) is working on "${initiative}" and has not written back.`,
            'Write back first (sofar_end_session: summary + next action), then detach. A write-back filed after the',
            "run starts becomes the next action a driven session resumes from, instead of the previous session's.",
          ].join('\n'),
        )
      }
    }
  } catch (err) {
    return fail(errMessage(err))
  }
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    return fail(
      "sofar drive --detach: the calling agent's sandbox reports no network (CODEX_SANDBOX_NETWORK_DISABLED=1). A detached driver inherits that sandbox, so every session it launched would fail to reach its model. Run the agent with network access, or start the run from a terminal.",
    )
  }

  const logDir = options.logDir ?? join(tmpdir(), 'sofar-drive')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `${initiative}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  const readLog = (): string => {
    try {
      return readFileSync(logPath, 'utf8')
    } catch {
      return ''
    }
  }
  const childArgv = options.argv.filter((arg) => arg !== '--detach')
  const [command, ...entryArgs] = options.entry ?? [process.execPath, ...process.execArgv, process.argv[1]!]
  const fd = openSync(logPath, 'a')
  let child
  try {
    child = spawn(command!, [...entryArgs, ...childArgv], {
      cwd: process.cwd(),
      // The driver itself runs clean of its caller too (D3): it is no longer
      // inside that agent, and must not warn that it is.
      env: launchEnv({ [DETACH_ENV]: '1' }, env),
      stdio: ['ignore', fd, fd, 'ipc'],
      detached: process.platform !== 'win32',
    })
  } finally {
    closeSync(fd)
  }

  type Outcome = { kind: 'started'; run: string } | { kind: 'exited'; code: number | null } | { kind: 'error'; message: string } | { kind: 'timeout' }
  const outcome = await new Promise<Outcome>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), options.startTimeoutMs ?? DETACH_START_TIMEOUT_MS)
    const settle = (o: Outcome): void => {
      clearTimeout(timer)
      resolve(o)
    }
    child.on('message', (message: unknown) => {
      const m = message as { type?: unknown; run?: unknown }
      if (m.type === DETACH_STARTED && typeof m.run === 'string') settle({ kind: 'started', run: m.run })
    })
    child.on('exit', (code) => settle({ kind: 'exited', code }))
    child.on('error', (err) => settle({ kind: 'error', message: err.message }))
  })
  child.removeAllListeners()
  if (child.connected) child.disconnect()
  child.unref()

  if (outcome.kind === 'started') {
    const opening = readLog()
    return ok(
      [
        opening.trimEnd(),
        `detached: driver pid ${child.pid} is running run ${outcome.run} on "${initiative}"`,
        `  progress: ${logPath}`,
        `  status:   sofar status ${initiative}`,
        `  stop:     sofar drive ${initiative} --stop`,
        '',
      ]
        .filter((line, i) => i > 0 || line.length > 0)
        .join('\n'),
    )
  }
  if (outcome.kind === 'exited') {
    return fail(`sofar drive --detach: the driver did not start (exit ${outcome.code ?? 'by signal'}):\n${readLog().trimEnd()}`)
  }
  if (outcome.kind === 'error') {
    return fail(`sofar drive --detach: could not start the driver: ${outcome.message}`)
  }
  return fail(
    `sofar drive --detach: driver pid ${child.pid} has not confirmed a start within ${Math.round((options.startTimeoutMs ?? DETACH_START_TIMEOUT_MS) / 1000)}s and was left running. \`sofar status ${initiative}\` shows whether a run began; its log is ${logPath}`,
  )
}
