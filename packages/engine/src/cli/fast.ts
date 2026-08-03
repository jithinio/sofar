import { resolve } from 'node:path'
import { mirror, readStdin, SUBCOMMANDS } from './event'
import { PLAIN_CAPS, runStatusline, STATUSLINE_FORCED_CAPS } from './statusline'
import { readAllStdin } from './shared'

/**
 * Hot-path CLI entry (speed-2 T1).
 *
 * The five hook shims fire on every matched tool use and the statusline fires
 * on every status-bar render, and each one was paying to parse and compile the
 * ENTIRE CLI bundle — MCP SDK, chokidar, commander, serve, cloud, doctor,
 * upgrade — to append one line or print one row. Measured: 986 KB of bundle
 * behind a ~30 KB job, ~35 ms of dead compile per invocation on top of node's
 * own ~15 ms boot.
 *
 * This module is the small closure those commands actually need (core + mcp
 * context + status/statusline templates; commander appears in event.ts and
 * statusline.ts only as `import type`, so it is erased). Argument parsing here
 * is deliberately minimal and handles ONLY the shapes the shims emit.
 * Anything else — an unknown command, an unexpected flag, `event append` with
 * its eight options — returns false and the caller falls through to the full
 * CLI, so the command surface and every error message stay exactly as they
 * were. The fast path is an optimization, never a second implementation.
 */

/** `--root <dir>`, the only option the shims may pass. Null = shape we don't own. */
function parseRoot(rest: readonly string[]): { root: string; extra: string[] } | null {
  const extra: string[] = []
  let root: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string
    if (arg === '--root') {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('-')) return null // let commander report it
      root = value
      i++
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length)
      if (root.length === 0) return null
    } else {
      extra.push(arg)
    }
  }
  return { root: resolve(root ?? process.cwd()), extra }
}

/**
 * Run argv on the fast path. Returns false when this entry does not own the
 * shape — the caller must then load the full CLI, which owns every command,
 * every flag, --help and --version.
 */
export async function runFast(argv: readonly string[]): Promise<boolean> {
  const [command, ...rest] = argv.slice(2)

  if (command === 'event') {
    const [name, ...flags] = rest
    const sub = SUBCOMMANDS.find((s) => s.name === name)
    if (sub === undefined) return false // `append`, an unknown hook, or bare `event`
    const parsed = parseRoot(flags)
    if (parsed === null || parsed.extra.length > 0) return false
    mirror(sub.handler(parsed.root, await readStdin()))
    return true
  }

  if (command === 'statusline') {
    const parsed = parseRoot(rest)
    if (parsed === null) return false
    // Only the two flags the status bar itself sets; anything else falls through.
    if (parsed.extra.some((arg) => arg !== '--no-color' && arg !== '--color')) return false
    // The status bar renders ANSI + emoji even though stdout is piped — force
    // styled caps; --no-color / NO_COLOR opt back into plain (D7). Mirrors
    // registerStatuslineCommand exactly.
    const plain = parsed.extra.includes('--no-color') || process.env.NO_COLOR !== undefined
    const line = runStatusline(parsed.root, await readAllStdin(), plain ? PLAIN_CAPS : STATUSLINE_FORCED_CAPS)
    if (line.length > 0) process.stdout.write(`${line}\n`)
    return true
  }

  return false
}
