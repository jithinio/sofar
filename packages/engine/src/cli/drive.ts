import { ToolError, createToolContext } from '../mcp/context'
import { describeRun } from '../projections/templates/shared'
import { ClaudeCodeAdapter } from '../driver/claude-code'
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
  cwd?: string
  model?: string
  effort?: string
  resume?: boolean
  /** Binary the Claude Code adapter spawns (default `claude`). */
  bin?: string
  /** Permission surface for every session in the run (2.4). */
  permissionMode?: string
  allow?: string[]
  deny?: string[]
  /** Drop sofar's default allow-list and use only what --allow states. */
  bareTools?: boolean
  /** Extra argv for the agent — the operator's escape hatch past everything above. */
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
    driveOptions = {
      adapter:
        options.adapter ??
        new ClaudeCodeAdapter({
          ...(options.bin !== undefined ? { bin: options.bin } : {}),
          ...(options.agentArgs !== undefined ? { args: options.agentArgs } : {}),
        }),
      ...(options.policy !== undefined ? { policy: options.policy as DriveOptions['policy'] } : {}),
      ...(thresholdPct !== undefined ? { thresholdPct } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxSessions !== undefined ? { maxSessions } : {}),
      ...(maxStalls !== undefined ? { maxStalls } : {}),
      ...(costCapUsd !== undefined ? { costCapUsd } : {}),
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
