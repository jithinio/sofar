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
import { runStatus, runStatusWatch } from './status'
import { runList } from './list'
import { runNext } from './next'
import { runRelated, runWhy } from './graph'
import { runRemember } from './remember'
import { registerStatuslineCommand } from './statusline'
import { startServer, renderServeBanner, DEFAULT_PORT } from './serve'
import { runExport, runImport } from './transfer'
import { runLogin, runLink, runPush, runPull, runPullWatch } from './cloud'
import { runUpgrade } from './upgrade'
import { runCheckStatus, runRefresh, withUpdateNotice } from './update-check'
import { writeAutoUpgrade } from './user-config'
import { emit, fail, ok, readAllStdin } from './shared'

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
  .option(
    '--statusline',
    'also wire `sofar statusline` as the project statusLine (merged only when settings.json has none — an existing statusLine is never touched)',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { statusline?: boolean; root?: string }) => {
    emit(withUpdateNotice(runInit(rootOf(opts), { statusline: opts.statusline === true })))
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
    // withUpdateNotice touches stderr only — doctor's exit code is its verdict
    // on the RECORD, and a new release must never be able to change it (D1).
    emit(withUpdateNotice(runDoctor(rootOf(opts), { fix: opts.fix === true })))
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
  .option('--watch', 'live status (TTY only; piped falls back to one shot): re-render on record changes, active tasks pulse, ^C to exit')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((slug: string | undefined, opts: { watch?: boolean; root?: string }) => {
    if (opts.watch === true) {
      const result = runStatusWatch(rootOf(opts), slug)
      if (result !== undefined) emit(result) // non-TTY fallback / resolution failure
      return // live path: watcher + timer hold the process until ^C
    }
    emit(withUpdateNotice(runStatus(rootOf(opts), slug)))
  })

program
  .command('list')
  .description('one line per initiative: slug, bound branch, progress, active phase, next action — most recently active first')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { root?: string }) => {
    emit(runList(rootOf(opts)))
  })

program
  .command('next')
  .description(
    "every initiative's next action, one line each, most recently active first — entries with record drift since their last write-back flagged ⚠ may be stale",
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((opts: { root?: string }) => {
    emit(runNext(rootOf(opts)))
  })

program
  .command('why <path>')
  .description(
    'every task, session and decision behind a path, across ALL initiatives, newest-first — the cross-initiative provenance a single-log fold cannot see',
  )
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((path: string, opts: { root?: string }) => {
    emit(runWhy(rootOf(opts), path))
  })

program
  .command('related <task-id>')
  .description(
    'tasks that worked on the same files as this one, ranked by shared paths — cross-initiative neighbours included; accepts <task-id>, <slug>#<task-id>, or "<slug> <task-id>"',
  )
  .option('--initiative <slug>', 'initiative the task id belongs to (default: the branch-bound one)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((taskId: string, opts: { initiative?: string; root?: string }) => {
    emit(runRelated(rootOf(opts), taskId, opts.initiative !== undefined ? { initiative: opts.initiative } : {}))
  })

program
  .command('remember <text>')
  .description(
    'promote an operational fact to repo memory — a release command, a failure mode, a convention future sessions must know; recorded as <slug> M<n> for .sofar/repo.md to name',
  )
  .option('--initiative <slug>', 'initiative to record it under (default: the branch-bound one)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action((text: string, opts: { initiative?: string; root?: string }) => {
    emit(runRemember(rootOf(opts), text, opts.initiative !== undefined ? { initiative: opts.initiative } : {}))
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
  .command('login')
  .description('sign in to api.sofar.sh (RFC-8628 device flow) and store a machine token — the credential never touches the repo')
  .option('--api <url>', 'API base URL (default: SOFAR_API_URL, .sofar/remote.json, then https://api.sofar.sh)')
  .option('--scopes <scopes>', 'comma-separated token scopes: sync (read-write) or read (read-only)', 'sync')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (opts: { api?: string; scopes?: string; root?: string }) => {
    emit(
      await runLogin(rootOf(opts), {
        ...(opts.api !== undefined ? { api: opts.api } : {}),
        ...(opts.scopes !== undefined ? { scopes: opts.scopes } : {}),
      }),
    )
  })

program
  .command('link')
  .description('bind this repo to a sofar-cloud org/repo: writes the committable .sofar/remote.json (idempotent on org+name)')
  .requiredOption('--org <slug>', 'organization slug on the server')
  .option('--name <repo>', 'repo name on the server (default: this directory\'s basename)')
  .option('--api <url>', 'API base URL (default: SOFAR_API_URL, .sofar/remote.json, then https://api.sofar.sh)')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (opts: { org: string; name?: string; api?: string; root?: string }) => {
    emit(
      await runLink(rootOf(opts), {
        org: opts.org,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.api !== undefined ? { api: opts.api } : {}),
      }),
    )
  })

/** Shared option shape for push/pull. */
function syncOptions(slug: string | undefined, opts: { all?: boolean; full?: boolean; api?: string }) {
  return {
    ...(slug !== undefined ? { slug } : {}),
    all: opts.all === true,
    full: opts.full === true,
    ...(opts.api !== undefined ? { api: opts.api } : {}),
  }
}

program
  .command('push [slug]')
  .description('push initiative events to the linked sofar-cloud repo (ulid order, from genesis on first push; idempotent by event id)')
  .option('--all', 'push every initiative under .sofar/initiatives/')
  .option('--full', 'ignore the ack cursor and re-push the stream from event zero')
  .option('--api <url>', 'API base URL override')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (slug: string | undefined, opts: { all?: boolean; full?: boolean; api?: string; root?: string }) => {
    emit(await runPush(rootOf(opts), syncOptions(slug, opts)))
  })

program
  .command('pull [slug]')
  .description('pull initiative events from the linked sofar-cloud repo (since-cursor paging, dedupe by id); --watch keeps pulling on the doorbell')
  .option('--all', 'pull every initiative under .sofar/initiatives/')
  .option('--full', 'ignore the inbound cursor and re-pull the stream from genesis')
  .option('--watch', 'stay connected: subscribe to the doorbell (SSE) and pull on every ring (^C to stop)')
  .option('--api <url>', 'API base URL override')
  .option('--root <dir>', 'repo root (default: current directory)')
  .action(async (slug: string | undefined, opts: { all?: boolean; full?: boolean; watch?: boolean; api?: string; root?: string }) => {
    if (opts.watch === true) {
      const result = await runPullWatch(rootOf(opts), syncOptions(slug, opts))
      if (result !== undefined) emit(result) // fatal setup/auth failure
      return
    }
    emit(await runPull(rootOf(opts), syncOptions(slug, opts)))
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
  .option(
    '--auto <on|off>',
    'turn background auto-install on or off and exit — when on, the daily check installs the update itself instead of only telling you about it',
  )
  .action(
    async (
      version: string | undefined,
      opts: { check?: boolean; dryRun?: boolean; force?: boolean; auto?: string },
    ) => {
      if (opts.auto !== undefined) {
        const value = opts.auto.trim().toLowerCase()
        if (value !== 'on' && value !== 'off') {
          emit(fail(`sofar upgrade: --auto takes "on" or "off" (got "${opts.auto}")`))
          return
        }
        writeAutoUpgrade(value === 'on')
        emit(
          ok(
            value === 'on'
              ? 'auto-upgrade on — the daily check will install updates in the background.\n' +
                  'Each install still asks you to run `sofar init` per repo to refresh its wiring.\n'
              : 'auto-upgrade off — sofar will tell you about updates and let you install them.\n',
          ),
        )
        return
      }
      emit(
        await runUpgrade({
          ...(version !== undefined ? { version } : {}),
          check: opts.check === true,
          dryRun: opts.dryRun === true,
          force: opts.force === true,
        }),
      )
    },
  )

program
  .command('update-check')
  .description(
    'inspect the cached update check (installed vs latest, when it last ran, whether auto-install is on); --refresh performs the check that the background child normally does',
  )
  .option('--refresh', 'query the registry now and rewrite the cache — the detached child\'s own entry point')
  .action((opts: { refresh?: boolean }) => {
    emit(opts.refresh === true ? runRefresh() : runCheckStatus())
  })

registerEventCommand(program)
registerStatuslineCommand(program, rootOf)

await program.parseAsync(process.argv)
