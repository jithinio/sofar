import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import { canonicalJSON, foldAll, foldFileSince, parseSnapshot, serializeSnapshot, stateOf, type Snapshot } from '../core/snapshot'
import { fail, ok, type CmdResult } from './shared'

/**
 * `sofar fold` (r1-fixes 5.1, D22) — the black-box face of the incremental
 * fold, for the shared fold-parity suite: the same command drives this
 * engine and a second implementation, so the cited guarantee is proved on
 * bytes and a command line rather than on one library's types. Hidden: a
 * conformance surface, not an operator one.
 *
 *   sofar fold --events <jsonl> [--take <n>] [--write-snapshot <file>]
 *   sofar fold --events <jsonl> --snapshot <file> [--since <n>] [--write-snapshot <file>]
 *
 * Prints canonical JSON (keys sorted by code point, 2-space): on success
 * {ok: true, cursor, version, state, warnings}; on a refusal {ok: false,
 * reason, detail} or {ok: false, reason: 'version', found, expected}. Exit 0
 * either way — a refusal is an answer — and 2 for a usage error.
 */
export interface FoldCliOptions {
  events?: string
  take?: string
  snapshot?: string
  since?: string
  writeSnapshot?: string
}

export function runFold(options: FoldCliOptions): CmdResult {
  if (options.events === undefined) return usage('--events <jsonl> is required')
  if (!existsSync(options.events)) return usage(`no such file: ${options.events}`)
  const take = options.take !== undefined ? Number(options.take) : undefined
  if (take !== undefined && !(Number.isInteger(take) && take >= 0)) return usage('--take must be a non-negative integer')
  const since = options.since !== undefined ? Number(options.since) : undefined
  if (since !== undefined && !(Number.isInteger(since) && since >= 0)) return usage('--since must be a non-negative integer')

  let snapshot: Snapshot
  if (options.snapshot !== undefined) {
    if (take !== undefined) return usage('--take applies to a full fold, not to --snapshot')
    let text: string
    try {
      text = readFileSync(options.snapshot, 'utf8')
    } catch {
      return usage(`cannot read snapshot: ${options.snapshot}`)
    }
    const parsed = parseSnapshot(text)
    if (!parsed.ok) return ok(`${canonicalJSON(parsed)}\n`)
    const step = foldFileSince(parsed.snapshot, options.events, since)
    if (!step.ok) return ok(`${canonicalJSON({ ok: false, reason: step.reason, detail: step.detail })}\n`)
    snapshot = step.snapshot
  } else {
    if (since !== undefined) return usage('--since needs --snapshot')
    const lines = readFileSync(options.events, 'utf8').split('\n')
    const all = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    snapshot = foldAll(take !== undefined ? all.slice(0, take) : all)
  }
  if (options.writeSnapshot !== undefined) writeFileSync(options.writeSnapshot, serializeSnapshot(snapshot))
  const result = stateOf(snapshot)
  return ok(
    `${canonicalJSON({ ok: true, cursor: snapshot.cursor, version: snapshot.version, state: result.state, warnings: result.warnings })}\n`,
  )
}

function usage(message: string): CmdResult {
  return { ...fail(`sofar fold: ${message}`), exitCode: 2 }
}

export function registerFoldCommand(program: Command): void {
  program
    .command('fold', { hidden: true })
    .description('conformance surface: fold raw event lines, or apply a file tail to a serialized snapshot, and print canonical state JSON')
    .option('--events <jsonl>', 'the log file, raw lines')
    .option('--take <n>', 'fold only the first n lines')
    .option('--snapshot <file>', 'start from this serialized snapshot and apply the file tail')
    .option('--since <n>', 'assert the snapshot consumed exactly n lines')
    .option('--write-snapshot <file>', 'write the resulting snapshot')
    .action((opts: FoldCliOptions) => {
      const result = runFold(opts)
      if (result.stdout.length > 0) process.stdout.write(result.stdout)
      if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`)
      process.exitCode = result.exitCode
    })
}
