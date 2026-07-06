import { serializeEvent } from '../core/log'
import { exportEvents, importNDJSON } from '../core/cursor'
import { createToolContext, ToolError } from '../mcp/context'
import { regenerateProjections } from '../projections/generator'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `harness export [slug] [--since <id>]` / `harness import <file|-> [slug]`
 * (task 4.4, SPEC §CLI/§Cursor) — thin CLI wrappers over core/cursor.ts, the
 * entire future sync interface. Initiative resolution matches status/MCP
 * (explicit slug wins, else branch binding — BD16). Export writes NDJSON to
 * stdout; import reads a captured stream, dedupes by id (idempotent), prints
 * an {appended, skipped} JSON summary, and regenerates projections when
 * anything new landed.
 */

export interface ExportOptions {
  slug?: string
  since?: string
}

export function runExport(rootDir: string, options: ExportOptions = {}): CmdResult {
  const ctx = createToolContext(rootDir)
  let slug: string
  try {
    slug = ctx.resolveInitiative(options.slug)
  } catch (err) {
    if (err instanceof ToolError) {
      return fail(`harness export: ${err.message} (usage: harness export [slug] [--since <id>])`)
    }
    return fail(`harness export: ${errMessage(err)}`)
  }

  try {
    const { events, warnings } = exportEvents(ctx.eventsPath(slug), options.since)
    const ndjson = events.length === 0 ? '' : events.map(serializeEvent).join('\n') + '\n'
    return ok(ndjson, warnings.map((w) => `warning: ${w}`).join('\n'))
  } catch (err) {
    return fail(`harness export: ${errMessage(err)}`)
  }
}

export interface ImportOptions {
  slug?: string
}

/** `ndjson` is the already-read stream — commander wiring owns file/stdin IO. */
export function runImport(rootDir: string, ndjson: string, options: ImportOptions = {}): CmdResult {
  const ctx = createToolContext(rootDir)
  let slug: string
  try {
    slug = ctx.resolveInitiative(options.slug)
  } catch (err) {
    if (err instanceof ToolError) {
      return fail(`harness import: ${err.message} (usage: harness import <file|-> [slug])`)
    }
    return fail(`harness import: ${errMessage(err)}`)
  }

  try {
    const { appended, skipped, warnings } = importNDJSON(ctx.eventsPath(slug), ndjson)
    if (appended > 0) {
      regenerateProjections(ctx.initiativeDir(slug), ctx.foldState(slug))
    }
    return ok(
      `${JSON.stringify({ appended, skipped })}\n`,
      warnings.map((w) => `warning: ${w}`).join('\n'),
    )
  } catch (err) {
    return fail(`harness import: ${errMessage(err)}`)
  }
}
