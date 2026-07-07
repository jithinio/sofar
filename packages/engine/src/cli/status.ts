import { existsSync } from 'node:fs'
import { createToolContext, ToolError } from '../mcp/context'
import { emptyState, foldLog, type InitiativeState } from '../core/fold'
import { renderFullStatus } from '../projections/templates/status'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar status [slug]` (task 4.3, SPEC §CLI) — fold and print goal,
 * progress %, phase tree with per-task statuses, next action, blocked_on,
 * and the last written-back session. Initiative resolution matches the MCP
 * tools (explicit slug wins, else branch → bindings.json, BD16). Output is
 * UNCAPPED — the 10k limit belongs to the SessionStart projection (BD3) —
 * and fold warnings go to stderr without failing the command.
 */

export function runStatus(rootDir: string, slug?: string): CmdResult {
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

  return ok(
    renderFullStatus(state),
    warnings.map((w) => `warning: ${w}`).join('\n'),
  )
}
