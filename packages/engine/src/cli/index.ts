import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import { version } from '../../package.json'
import { createSofarServer } from '../mcp/server'
import { registerEventCommand } from './event'
import { runAdopt } from './adopt'
import { runInit } from './init'
import { runDoctor } from './doctor'
import { runUninit } from './uninit'
import { runNew, runSwitch } from './new'
import { runStatus } from './status'
import { runList } from './list'
import { startServer, renderServeBanner, DEFAULT_PORT } from './serve'
import { runExport, runImport } from './transfer'
import { runUpgrade } from './upgrade'
import { emit, readAllStdin } from './shared'

const program = new Command()

program
  .name('sofar')
  .description('Sofar v1 engine — event-log initiative memory for coding agents')
  // Single-sourced from package.json (task 6.4, BD39) — esbuild inlines the
  // JSON import, so the bundle always carries the manifest's version.
  .version(version)
  // Registration only: the UI kernel (cli/ui/caps.ts) reads these straight
  // from process.argv, so commander merely has to accept them anywhere on
  // the line (SPEC §CLI UI ladder). --no-color also defines the paired
  // opts.color default; the value is unused.
  .option('--color', 'force styled output, even piped')
  .option('--no-color', 'plain output, even on a TTY')

/** Every repo-scoped command takes --root (default: cwd) — the mcp/event precedent. */
function rootOf(opts: { root?: string }): string {
  return resolve(opts.root ?? process.cwd())
}

program
  .command('init')
  .description(
    'make this repo sofar-ready: .sofar/, hook shims + settings, .mcp.json entry, CLAUDE.md + AGENTS.md protocol blocks (idempotent)',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { root?: string }) => {
    emit(runInit(rootOf(opts)))
  })

program
  .command('uninit')
  .description(
    'exact inverse of init: remove hook shims, settings hook entries, the .mcp.json server entry, and the protocol blocks; .sofar/ is kept unless --purge',
  )
  .option('--purge', 'also delete the .sofar/ record (irreversible)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { purge?: boolean; root?: string }) => {
    emit(runUninit(rootOf(opts), { purge: opts.purge === true }))
  })

program
  .command('doctor')
  .description(
    'audit this repo: wiring integrity, record health, and tree-wide scanner hazards (Tailwind v4 ingesting .sofar); --fix inserts the @source not exclusion',
  )
  .option('--fix', 'apply the safe scanner fix (insert `@source not "…/.sofar"` after the tailwindcss import)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { fix?: boolean; root?: string }) => {
    emit(runDoctor(rootOf(opts), { fix: opts.fix === true }))
  })

program
  .command('new <slug>')
  .description('create an initiative and bind the current branch to it')
  .option('--goal <text>', 'initiative goal recorded in initiative_created')
  .option('--no-bind', 'skip binding the current branch in .sofar/bindings.json')
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
  .command('adopt <legacy-file> [slug]')
  .description(
    'guided migration of a pre-sofar prose record: print the replay brief for an agent to execute; --mark stamps the legacy file superseded',
  )
  .option('--mark', 'prepend an idempotent SUPERSEDED banner to the legacy file')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((legacyFile: string, slug: string | undefined, opts: { mark?: boolean; root?: string }) => {
    emit(runAdopt(rootOf(opts), legacyFile, slug, { mark: opts.mark === true }))
  })

program
  .command('status [slug]')
  .description('fold and print the initiative: goal, progress, phase tree, next action, blocked, last session')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string | undefined, opts: { root?: string }) => {
    emit(runStatus(rootOf(opts), slug))
  })

program
  .command('list')
  .description('one line per initiative: slug, bound branch, progress, active phase, next action — most recently active first')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { root?: string }) => {
    emit(runList(rootOf(opts)))
  })

program
  .command('export [slug]')
  .description('write the initiative event log to stdout as NDJSON (sync cursor primitive)')
  .option('--since <id>', 'only events with ulid strictly after this id')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string | undefined, opts: { since?: string; root?: string }) => {
    emit(
      runExport(rootOf(opts), {
        ...(slug !== undefined ? { slug } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      }),
    )
  })

program
  .command('import <file> [slug]')
  .description('import an NDJSON event stream (file, or "-" for stdin) — dedupes by id, idempotent')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (file: string, slug: string | undefined, opts: { root?: string }) => {
    let stream: string
    try {
      stream = file === '-' ? await readAllStdin() : readFileSync(file, 'utf8')
    } catch (err) {
      emit({
        exitCode: 1,
        stdout: '',
        stderr: `sofar import: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    emit(runImport(rootOf(opts), stream, slug !== undefined ? { slug } : {}))
  })

program
  .command('serve')
  .description('watch .sofar/ and serve initiative state as JSON on 127.0.0.1 (GET /state, /state/<slug>, /events SSE)')
  .option('--port <port>', 'port to bind on 127.0.0.1', String(DEFAULT_PORT))
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (opts: { port: string; root?: string }) => {
    const port = Number.parseInt(opts.port, 10)
    if (Number.isNaN(port) || port < 0 || port > 65_535) {
      emit({ exitCode: 1, stdout: '', stderr: `sofar serve: invalid port "${opts.port}"` })
      return
    }
    const handle = await startServer({ root: rootOf(opts), port })
    process.stderr.write(renderServeBanner(handle.url))
    // long-running: the server keeps the event loop alive until Ctrl-C
  })

program
  .command('mcp')
  .description('start the stdio MCP server (server name: sofar) exposing the SPEC §MCP tools')
  .option('--root <dir>', 'repo root containing .sofar/ (default: current directory)')
  .action(async (opts: { root?: string }) => {
    const handle = createSofarServer({ rootDir: opts.root })
    await handle.connectStdio()
    // stdio transport keeps the process alive until the client disconnects
  })

program
  .command('upgrade [version]')
  .description(
    'self-update the globally-installed sofar to the latest release (or a given version), resolving the true install prefix from sofar\'s own location so a custom npm prefix is handled correctly',
  )
  .option('--check', 'report installed-vs-latest and the resolved install; change nothing')
  .option('--dry-run', 'print the exact npm command that would run; change nothing')
  .option('--force', 'reinstall even when already at the target version')
  .action(async (version: string | undefined, opts: { check?: boolean; dryRun?: boolean; force?: boolean }) => {
    emit(
      await runUpgrade({
        ...(version !== undefined ? { version } : {}),
        check: opts.check === true,
        dryRun: opts.dryRun === true,
        force: opts.force === true,
      }),
    )
  })

registerEventCommand(program)

await program.parseAsync(process.argv)
