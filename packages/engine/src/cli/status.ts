import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { watch } from 'chokidar'
import { createToolContext, ToolError } from '../mcp/context'
import { emptyState, foldLog, type InitiativeState } from '../core/fold'
import { currentBranch } from '../core/git'
import { scanRecordCopies, unionFold, type RecordProvenance } from '../core/record-copies'
import { renderFullStatus } from '../projections/templates/status'
import type { CopyOptions } from './list'
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

/** Slug shape, checked before an explicit slug is looked up on another copy. */
const SLUG = /^[a-z0-9-]+$/

export function runStatus(
  rootDir: string,
  slug?: string,
  caps: Caps = stdoutCaps(),
  columns: number = columnsOf(process.stdout),
  options: CopyOptions = {},
): CmdResult {
  const ctx = createToolContext(rootDir)
  const scanFor = (target: string) =>
    options.here === true
      ? null
      : scanRecordCopies(rootDir, { slugs: [target], remotes: options.remotes === true })

  let resolved: string
  let scan: ReturnType<typeof scanFor> = null
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    // An initiative that exists only on another branch still has a status
    // (branch-visibility D1): look for it there before giving up.
    if (err instanceof ToolError && slug !== undefined && SLUG.test(slug)) {
      scan = scanFor(slug)
    }
    if (scan !== null && (scan.logs.get(slug!)?.length ?? 0) > 0) {
      resolved = slug!
    } else if (err instanceof ToolError) {
      return fail(`sofar status: ${err.message} (usage: sofar status [slug])`)
    } else {
      return fail(`sofar status: ${errMessage(err)}`)
    }
  }

  const logPath = ctx.eventsPath(resolved)
  let state: InitiativeState
  let warnings: string[] = []
  let provenance: RecordProvenance | null = null
  scan ??= scanFor(resolved)
  const foreign = scan?.logs.get(resolved) ?? []
  if (foreign.length > 0) {
    let localText: string | null = null
    try {
      if (existsSync(logPath)) localText = readFileSync(logPath, 'utf8')
    } catch (err) {
      return fail(`sofar status: failed to read ${logPath}: ${errMessage(err)}`)
    }
    const union = unionFold(resolved, localText, foreign, currentBranch(rootDir))
    state = union.state
    warnings = union.warnings
    provenance = union.provenance
  } else if (existsSync(logPath)) {
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

  const home = homedir()
  const stdout = caps.color
    ? `${renderInitiative(state, {
        zoom: 'full',
        style: createStyle(true),
        symbols: symbolsFor(caps.unicode),
        columns,
        provenance,
        home,
      }).join('\n')}\n`
    : renderFullStatus(state, provenance, home)

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
