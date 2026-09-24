import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { EdgeAccumulator } from '../core/adjacency'
import { countLines, decodeLines, finalizeFold, finalizeFrom, replayDecoded } from '../core/fold'
import { prefixOf, resumeFoldCheckpointFile, writeFoldCheckpointFile } from '../core/fold-checkpoint'
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
 *   sofar fold --events <jsonl> [--take <n>] --write-checkpoint <file>
 *   sofar fold --events <jsonl> --checkpoint <file>
 *
 * The checkpoint pair (rust-core 4.4, 01M39ED9) drives the edge-free fold
 * checkpoint the hooks keep in the state dir. The write folds the first n
 * lines (or all of them) and prints {ok: true, written}; the resume prints
 * {ok: true, resumed, state, warnings}. resumed is false when the fast path
 * refused and the whole log was refolded, which is what a hook does too.
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
  writeCheckpoint?: string
  checkpoint?: string
}

export function runFold(options: FoldCliOptions): CmdResult {
  if (options.events === undefined) return usage('--events <jsonl> is required')
  if (!existsSync(options.events)) return usage(`no such file: ${options.events}`)
  const take = options.take !== undefined ? Number(options.take) : undefined
  if (take !== undefined && !(Number.isInteger(take) && take >= 0)) return usage('--take must be a non-negative integer')
  const since = options.since !== undefined ? Number(options.since) : undefined
  if (since !== undefined && !(Number.isInteger(since) && since >= 0)) return usage('--since must be a non-negative integer')

  if (options.writeCheckpoint !== undefined || options.checkpoint !== undefined) {
    if (options.snapshot !== undefined || options.writeSnapshot !== undefined || since !== undefined) {
      return usage('the checkpoint options do not combine with the snapshot ones')
    }
    return options.checkpoint !== undefined
      ? resumeCheckpoint(options.events, options.checkpoint, take)
      : writeCheckpoint(options.events, options.writeCheckpoint!, take)
  }

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

/** The byte length of the first `n` lines (each with its newline), or null past the end. */
function bytesOfLines(buf: Buffer, n: number): number | null {
  let at = 0
  for (let i = 0; i < n; i++) {
    const nl = buf.indexOf(0x0a, at)
    if (nl === -1) return null
    at = nl + 1
  }
  return at
}

function writeCheckpoint(events: string, file: string, take: number | undefined): CmdResult {
  const whole = readFileSync(events)
  const all = whole.toString('utf8').split('\n')
  const n = take ?? countLines(all)
  const end = bytesOfLines(whole, n)
  if (end === null) return usage('--take is past the last complete line')
  const buf = whole.subarray(0, end)
  const lines = buf.toString('utf8').split('\n')
  const cp = replayDecoded(decodeLines(lines), '', countLines(lines))
  const prefix = prefixOf(buf, cp.lineCount)
  if (prefix !== null) {
    const acc = new EdgeAccumulator()
    acc.add(cp.edges)
    writeFoldCheckpointFile(file, '', cp, acc, prefix)
  }
  return ok(`${canonicalJSON({ ok: true, written: prefix !== null })}\n`)
}

function resumeCheckpoint(events: string, file: string, take: number | undefined): CmdResult {
  if (take !== undefined) return usage('--take applies to --write-checkpoint, not to --checkpoint')
  const r = resumeFoldCheckpointFile(file, '', events)
  if (r !== null) {
    r.acc.add(r.cp.edges)
    r.cp.edges = []
    const { state } = finalizeFrom(r.cp, r.acc)
    return ok(`${canonicalJSON({ ok: true, resumed: true, state, warnings: r.cp.warnings })}\n`)
  }
  const lines = readFileSync(events, 'utf8').split('\n')
  const result = finalizeFold(replayDecoded(decodeLines(lines), '', countLines(lines)))
  return ok(`${canonicalJSON({ ok: true, resumed: false, state: result.state, warnings: result.warnings })}\n`)
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
    .option('--write-checkpoint <file>', 'fold (the first --take lines) and write an edge-free fold checkpoint')
    .option('--checkpoint <file>', 'resume this edge-free fold checkpoint over the file tail (refolds when it cannot)')
    .action((opts: FoldCliOptions) => {
      const result = runFold(opts)
      if (result.stdout.length > 0) process.stdout.write(result.stdout)
      if (result.stderr.length > 0) process.stderr.write(`${result.stderr}\n`)
      process.exitCode = result.exitCode
    })
}
