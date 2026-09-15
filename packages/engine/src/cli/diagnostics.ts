import { diagnosticsStats, purgeDiagnostics } from '../core/diagnostics'
import { readSignalEnvironment, renderSignals, signalAvailability } from '../core/signals'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar diagnostics [--purge] [--json]` (SPEC §CLI, self-improve D3) — the
 * one human window onto the private store: where it is, how much sits in it,
 * per initiative and kind, and the switch that deletes it. It prints
 * counts and paths only, never row contents: a row can carry redacted error
 * text, and a summary surface must not become a second way to read it.
 */
export function runDiagnostics(
  rootDir: string,
  options: { purge?: boolean; json?: boolean; signals?: boolean } = {},
): CmdResult {
  try {
    if (options.signals === true) {
      // The availability map (self-improve 1.3): what a consumer may report as
      // a number here, and what it must print as UNKNOWN.
      const environment = readSignalEnvironment(rootDir)
      const signals = signalAvailability(environment)
      if (options.json === true) return ok(`${JSON.stringify({ environment, signals })}\n`)
      return ok(renderSignals(signals))
    }
    if (options.purge === true) {
      const removed = purgeDiagnostics(rootDir)
      if (options.json === true) return ok(`${JSON.stringify({ purged: removed })}\n`)
      return ok(removed === null ? 'sofar diagnostics: nothing to purge\n' : `purged ${removed}\n`)
    }
    const stats = diagnosticsStats(rootDir)
    if (options.json === true) return ok(`${JSON.stringify(stats)}\n`)
    if (stats.dir === null) {
      return ok(
        'sofar diagnostics: store REFUSED — XDG_STATE_HOME resolves inside this repo, and private diagnostics never live under the clone (self-improve D3). Nothing is being recorded.\n',
      )
    }
    const lines = [`store: ${stats.dir}`, `total: ${stats.files.length} file(s), ${stats.bytes} bytes`]
    if (stats.files.length === 0) lines.push('(empty — no observations recorded for this clone yet)')
    for (const file of stats.files) {
      const kinds = Object.entries(file.kinds)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([kind, n]) => `${kind} ${n}`)
        .join(', ')
      lines.push(`- ${file.initiative}: ${file.rows} row(s), ${file.bytes} bytes${kinds.length > 0 ? ` — ${kinds}` : ''}`)
    }
    lines.push('rows expire after 90 days; `sofar diagnostics --purge` deletes the store for this clone')
    return ok(`${lines.join('\n')}\n`)
  } catch (err) {
    return fail(`sofar diagnostics: ${errMessage(err)}`)
  }
}
