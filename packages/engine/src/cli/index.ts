import { resolve } from 'node:path'
import { Command } from 'commander'
import { createHarnessServer } from '../mcp/server'
import { registerEventCommand } from './event'
import { runInit } from './init'
import { runNew, runSwitch } from './new'
import { emit } from './shared'

const program = new Command()

program
  .name('harness')
  .description('Harness v1 engine — event-log initiative memory for coding agents')
  .version('0.1.0')

/** Every repo-scoped command takes --root (default: cwd) — the mcp/event precedent. */
function rootOf(opts: { root?: string }): string {
  return resolve(opts.root ?? process.cwd())
}

program
  .command('init')
  .description(
    'make this repo harness-ready: .harness/, hook shims + settings, .mcp.json entry, CLAUDE.md protocol block (idempotent)',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { root?: string }) => {
    emit(runInit(rootOf(opts)))
  })

program
  .command('new <slug>')
  .description('create an initiative and bind the current branch to it')
  .option('--goal <text>', 'initiative goal recorded in initiative_created')
  .option('--no-bind', 'skip binding the current branch in .harness/bindings.json')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string, opts: { goal?: string; bind?: boolean; root?: string }) => {
    emit(runNew(rootOf(opts), slug, { ...(opts.goal !== undefined ? { goal: opts.goal } : {}), bind: opts.bind !== false }))
  })

program
  .command('switch <slug>')
  .description('rebind the current branch to an existing initiative')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string, opts: { root?: string }) => {
    emit(runSwitch(rootOf(opts), slug))
  })

program
  .command('mcp')
  .description('start the stdio MCP server (server name: harness) exposing the SPEC §MCP tools')
  .option('--root <dir>', 'repo root containing .harness/ (default: current directory)')
  .action(async (opts: { root?: string }) => {
    const handle = createHarnessServer({ rootDir: opts.root })
    await handle.connectStdio()
    // stdio transport keeps the process alive until the client disconnects
  })

registerEventCommand(program)

await program.parseAsync(process.argv)
