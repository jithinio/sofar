import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { watch } from 'chokidar'
import { createToolContext, ToolError } from '../mcp/context'
import { emptyState, foldLog, type InitiativeState } from '../core/fold'
import { renderFullStatus } from '../projections/templates/status'
import { errMessage, fail, ok, type CmdResult } from './shared'
import {
  columnsOf,
  createStyle,
  renderInitiative,
  stdoutCaps,
  symbolsFor,
  terminalRows,
  type Caps,
} from './ui'

/**
 * `sofar status [slug]` (task 4.3, SPEC §CLI) — fold and print goal,
 * progress %, phase tree with per-task statuses, next action, blocked_on,
 * and the last written-back session. Initiative resolution matches the MCP
 * tools (explicit slug wins, else branch → bindings.json, BD16). Output is
 * UNCAPPED — the 10k limit belongs to the SessionStart projection (BD3) —
 * and fold warnings go to stderr without failing the command.
 *
 * Rendering (cli-ui 2.2) is capability-gated: `caps.color` picks the
 * full-zoom layout grammar (2.1) — the styled layout is inherently
 * color-coded (D1), so piped/NO_COLOR output keeps the pre-styling
 * renderFullStatus bytes, which the agent-facing surfaces also share.
 */

export function runStatus(
  rootDir: string,
  slug?: string,
  caps: Caps = stdoutCaps(),
  columns: number = columnsOf(process.stdout),
): CmdResult {
  const ctx = createToolContext(rootDir)

  let resolved: string
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    if (err instanceof ToolError) {
      return fail(`sofar status: ${err.message} (usage: sofar status [slug])`)
    }
    return fail(`sofar status: ${errMessage(err)}`)
  }

  const logPath = ctx.eventsPath(resolved)
  let state: InitiativeState
  let warnings: string[] = []
  if (existsSync(logPath)) {
    try {
      const result = foldLog(logPath)
      state = result.state
      warnings = result.warnings
    } catch (err) {
      return fail(`sofar status: failed to read ${logPath}: ${errMessage(err)}`)
    }
  } else {
    state = emptyState() // a created-but-unwritten initiative still has a status
  }
  if (state.slug === '') state.slug = resolved

  const stdout = caps.color
    ? `${renderInitiative(state, {
        zoom: 'full',
        style: createStyle(true),
        symbols: symbolsFor(caps.unicode),
        columns,
      }).join('\n')}\n`
    : renderFullStatus(state)

  return ok(stdout, warnings.map((w) => `warning: ${w}`).join('\n'))
}

/** Pulse beat interval — Codex's non-truecolor blink cadence (research D1). */
const PULSE_MS = 600

/**
 * `sofar status --watch` (cli-ui 4.3) — a live status: re-renders on
 * every record change (chokidar on the initiative dir, the serve
 * precedent) and pulses the active-task marker warn↔dim on a 600 ms
 * beat. The ONLY live surface a one-shot CLI ships: animation cannot
 * outlive a print-and-exit process, so the static `sofar status` stays
 * static and --watch holds the process open instead.
 *
 * TTY-gated by caps.animate: piped/CI/dumb terminals fall back to the
 * one-shot runStatus result (returned for the caller to emit). On the
 * live path this function starts the loop and returns undefined — the
 * watcher and timer keep the process alive until ^C, which restores the
 * cursor before the default SIGINT disposition applies.
 */
export function runStatusWatch(
  rootDir: string,
  slug?: string,
  caps: Caps = stdoutCaps(),
): CmdResult | undefined {
  if (!caps.animate) return runStatus(rootDir, slug, caps)

  const ctx = createToolContext(rootDir)
  let resolved: string
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    if (err instanceof ToolError) {
      return fail(`sofar status: ${err.message} (usage: sofar status --watch [slug])`)
    }
    return fail(`sofar status: ${errMessage(err)}`)
  }

  const logPath = ctx.eventsPath(resolved)
  const style = createStyle(caps.color)
  const symbols = symbolsFor(caps.unicode)
  let pulse = false
  let prevRows = 0

  const render = (): void => {
    let state: InitiativeState
    try {
      state = existsSync(logPath) ? foldLog(logPath).state : emptyState()
    } catch {
      state = emptyState() // fold errors never kill the watch; next event may heal
    }
    if (state.slug === '') state.slug = resolved
    const columns = columnsOf(process.stdout)
    const lines = renderInitiative(state, {
      zoom: 'full',
      style,
      symbols,
      columns,
      pulse,
    })
    lines.push('', style.dim('watching — ^C to exit'))
    const rewind = prevRows > 0 ? `\x1b[${prevRows}A\x1b[0J` : ''
    process.stdout.write(`${rewind}${lines.join('\n')}\n`)
    prevRows = terminalRows(lines, columns)
  }

  process.stdout.write('\x1b[?25l')
  render()
  const timer = setInterval(() => {
    pulse = !pulse
    render()
  }, PULSE_MS)
  const watcher = watch(dirname(logPath), { ignoreInitial: true, depth: 0 }).on('all', () =>
    render(),
  )
  process.once('SIGINT', () => {
    clearInterval(timer)
    void watcher.close()
    process.stdout.write('\x1b[?25h')
    process.kill(process.pid, 'SIGINT') // re-raise: default disposition exits
  })
  return undefined
}
