import type { EventEnvelope } from '../core/envelope'
import { readEvents } from '../core/cursor'
import { readDiagnostics } from '../core/diagnostics'
import { initiativeSlugs } from '../core/listing'
import { readSignalEnvironment, signalAvailability } from '../core/signals'
import { detect, renderTuneReport, type TuneReport } from '../core/tune'
import { createToolContext, ToolError } from '../mcp/context'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar tune [slug] --dry-run [--json]` (SPEC §Tune, self-improve 2.1).
 *
 * Reads the raw logs and the private store, runs the detectors the
 * availability map allows, prints the report. Nothing else: no event is
 * appended, no row is written, no file under .sofar or the store changes —
 * `--dry-run` is the ONLY mode, and it is required on the command line so a
 * reader of a shell history never wonders whether this invocation applied
 * something. A persisting or applying mode, if one ever exists (2.3), is a
 * separate, differently named surface.
 */
export function runTune(
  rootDir: string,
  options: { slug?: string; dryRun?: boolean; json?: boolean; all?: boolean } = {},
): CmdResult {
  if (options.dryRun !== true) {
    return fail(
      'sofar tune: only `--dry-run` exists (self-improve 2.1) — it detects and reports, and applies nothing. Re-run with --dry-run.',
    )
  }
  const ctx = createToolContext(rootDir)
  let slugs: string[]
  try {
    if (options.all === true) slugs = initiativeSlugs(ctx.sofarDir)
    else slugs = [ctx.resolveInitiative(options.slug)]
  } catch (err) {
    if (err instanceof ToolError) return fail(`sofar tune: ${err.message} (usage: sofar tune [slug|--all] --dry-run)`)
    return fail(`sofar tune: ${errMessage(err)}`)
  }
  try {
    const events = new Map<string, readonly EventEnvelope[]>()
    const warnings: string[] = []
    for (const slug of slugs) {
      const read = readEvents(ctx.eventsPath(slug))
      events.set(slug, read.events)
      for (const w of read.warnings) warnings.push(`${slug}: ${w}`)
    }
    const rows = readDiagnostics(rootDir).rows.filter((r) => slugs.includes(r.initiative))
    const signals = signalAvailability(readSignalEnvironment(rootDir))
    const report: TuneReport = detect({ events, rows, signals })
    if (options.json === true) return ok(`${JSON.stringify(report)}\n`, warnings.map((w) => `warning: ${w}`).join('\n'))
    return ok(renderTuneReport(report), warnings.map((w) => `warning: ${w}`).join('\n'))
  } catch (err) {
    return fail(`sofar tune: ${errMessage(err)}`)
  }
}
