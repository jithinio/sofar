import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, resolve } from 'node:path'
import {
  API_URL_ENV,
  credentialsPath,
  readCredential,
  readRemote,
  readSyncState,
  resolveApiUrl,
  writeCredential,
  writeRemote,
  writeSyncState,
  type Env,
  type RemoteConfig,
  type StoredCredential,
  type SyncState,
} from '../client/config'
import { deviceLogin, DeviceFlowError, type DeviceCodeResponse } from '../client/device'
import { runDoorbell } from '../client/doorbell'
import { ApiError, type FetchLike, type Sleep } from '../client/http'
import { pullStream, type PullReport } from '../client/pull'
import { pushStream, type PushReport } from '../client/push'
import { createRepo } from '../client/repos'
import { createToolContext, ToolError } from '../mcp/context'
import { regenerateProjections } from '../projections/generator'
import { errMessage, fail, ok, type CmdResult } from './shared'
import { renderConfirmation, renderFailure, SLUG_RE } from './new'
import { createStyle, createSpinner, stderrCaps, stdoutCaps, symbolsFor, type Caps, type SpinnerStream } from './ui'

/**
 * Cloud commands — `sofar login | link | push | pull` (sync-client Phase 2/3,
 * SPEC §Sync client). Thin composition over src/client/*: resolve api_url +
 * credential + remote binding + per-clone cursors, run the client core,
 * render confirmations in the new/switch register (wording identical styled
 * or plain). All network deps are injectable for tests; the credential is
 * NEVER printed after mint.
 */

export interface CloudDeps {
  fetchImpl?: FetchLike
  sleep?: Sleep
  env?: Env
  /** Interactive lines printed BEFORE the final result (login only). */
  out?: (text: string) => void
  /** Browser opener override (login only). */
  openBrowser?: (url: string) => void
  /** Token display name override (login only; default: this machine's hostname). */
  tokenName?: string
  /** Spinner output override (tests). */
  spinnerStream?: SpinnerStream
}

function netDeps(deps: CloudDeps): { fetchImpl?: FetchLike } {
  return deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}
}

/** Best-effort platform browser open — failure is fine, the URL is printed. */
function defaultOpenBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // the printed verification URL is the fallback
  }
}

// ---------------------------------------------------------------------------
// sofar login
// ---------------------------------------------------------------------------

export interface LoginOptions {
  api?: string
  /** Comma-separated token scopes (default "sync"; "read" for read-only consumers). */
  scopes?: string
}

export async function runLogin(
  rootDir: string,
  options: LoginOptions = {},
  deps: CloudDeps = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): Promise<CmdResult> {
  const env = deps.env ?? process.env
  let remote: RemoteConfig | null
  try {
    remote = readRemote(rootDir)
  } catch (err) {
    return fail(renderFailure(`sofar login: ${errMessage(err)}`, errCaps))
  }
  const apiUrl = resolveApiUrl({ flag: options.api, remote, env })
  const scopes = (options.scopes ?? 'sync')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (scopes.length === 0) {
    return fail(renderFailure('sofar login: --scopes must name at least one scope (e.g. sync, read)', errCaps))
  }

  const out = deps.out ?? ((text: string) => process.stdout.write(text))
  const openBrowser = deps.openBrowser ?? defaultOpenBrowser
  const style = createStyle(caps.color)

  const onCode = (code: DeviceCodeResponse): void => {
    const url = code.verification_uri_complete.length > 0 ? code.verification_uri_complete : code.verification_uri
    out(
      `Sign in to ${apiUrl}\n\n` +
        `  code:  ${style.bold(code.user_code)}\n` +
        `  url:   ${url}\n\n` +
        `Opening your browser — approve the sign-in there, then come back here.\n` +
        `(If the browser did not open, visit the url above yourself.)\n\n`,
    )
    openBrowser(url)
  }

  // Network spinner while polling, only when stderr can animate (cli-ui 2.5):
  // piped/CI runs carry zero spinner bytes.
  const spinner = errCaps.animate
    ? createSpinner({
        caps: errCaps,
        text: 'waiting for browser approval',
        useCase: 'network',
        ...(deps.spinnerStream !== undefined ? { stream: deps.spinnerStream } : {}),
      })
    : null

  try {
    const minted = await deviceLogin({
      apiUrl,
      scopes,
      name: deps.tokenName ?? hostname(),
      onCode: (code) => {
        onCode(code)
        spinner?.start()
      },
      ...netDeps(deps),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    })
    spinner?.succeed()
    const credential: StoredCredential = {
      token: minted.token,
      ...(minted.token_id.length > 0 ? { token_id: minted.token_id } : {}),
      name: deps.tokenName ?? hostname(),
      scopes,
      created_at: new Date().toISOString(),
    }
    writeCredential(apiUrl, credential, env)
    return ok(
      `${renderConfirmation(
        [
          `logged in to ${apiUrl}`,
          `token "${credential.name}" (scopes: ${scopes.join(', ')}) stored in ${credentialsPath(env)}`,
        ],
        caps,
      )}\n`,
    )
  } catch (err) {
    spinner?.fail()
    if (err instanceof DeviceFlowError) {
      return fail(renderFailure(`sofar login: ${err.message}`, errCaps))
    }
    if (err instanceof ApiError) {
      return fail(renderFailure(`sofar login: ${apiUrl} answered ${err.status} (${err.code}) — ${err.message}`, errCaps))
    }
    return fail(
      renderFailure(
        `sofar login: cannot reach ${apiUrl} (${errMessage(err)}) — check the URL or ${API_URL_ENV}`,
        errCaps,
      ),
    )
  }
}

// ---------------------------------------------------------------------------
// sofar link
// ---------------------------------------------------------------------------

export interface LinkOptions {
  org: string
  name?: string
  api?: string
}

export async function runLink(
  rootDir: string,
  options: LinkOptions,
  deps: CloudDeps = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): Promise<CmdResult> {
  const env = deps.env ?? process.env
  let remote: RemoteConfig | null
  try {
    remote = readRemote(rootDir)
  } catch (err) {
    return fail(renderFailure(`sofar link: ${errMessage(err)}`, errCaps))
  }
  const apiUrl = resolveApiUrl({ flag: options.api, remote, env })
  let credential: StoredCredential | null
  try {
    credential = readCredential(apiUrl, env)
  } catch (err) {
    return fail(renderFailure(`sofar link: ${errMessage(err)}`, errCaps))
  }
  if (credential === null) {
    return fail(renderFailure(`sofar link: not logged in to ${apiUrl} — run \`sofar login\` first`, errCaps))
  }
  const name = options.name ?? basename(resolve(rootDir))

  try {
    const { repo_id } = await createRepo({
      apiUrl,
      token: credential.token,
      org: options.org,
      name,
      ...netDeps(deps),
    })
    writeRemote(rootDir, { version: 1, api_url: apiUrl, org: options.org, name, repo_id })
    return ok(
      `${renderConfirmation(
        [
          `linked ${options.org}/${name} on ${apiUrl}`,
          `repo ${repo_id} → .sofar/remote.json (committable — teammates share this binding)`,
        ],
        caps,
      )}\n`,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return fail(
        renderFailure(
          `sofar link: org "${options.org}" not found — or you are not a member of it (the server does not say which). Check the slug, or ask an owner for an invite.`,
          errCaps,
        ),
      )
    }
    if (err instanceof ApiError && err.status === 401) {
      return fail(
        renderFailure(`sofar link: ${apiUrl} rejected the stored token — run \`sofar login\` again`, errCaps),
      )
    }
    if (err instanceof ApiError) {
      return fail(renderFailure(`sofar link: ${apiUrl} answered ${err.status} (${err.code}) — ${err.message}`, errCaps))
    }
    return fail(renderFailure(`sofar link: cannot reach ${apiUrl} (${errMessage(err)})`, errCaps))
  }
}

// ---------------------------------------------------------------------------
// Shared push/pull target resolution.
// ---------------------------------------------------------------------------

export interface SyncOptions {
  slug?: string
  all?: boolean
  /** Drop this stream's cursor first — re-push/re-pull from genesis. */
  full?: boolean
  api?: string
}

interface SyncTarget {
  apiUrl: string
  remote: RemoteConfig
  credential: StoredCredential
  state: SyncState
  slugs: string[]
}

class TargetError extends Error {}

function resolveTarget(
  rootDir: string,
  command: 'push' | 'pull',
  options: SyncOptions,
  env: Env,
): SyncTarget {
  const remote = readRemote(rootDir) // throws its own actionable message
  if (remote === null) {
    throw new TargetError(`this repo is not linked — run \`sofar link --org <org>\` first`)
  }
  const apiUrl = resolveApiUrl({ flag: options.api, remote, env })
  const credential = readCredential(apiUrl, env)
  if (credential === null) {
    throw new TargetError(`not logged in to ${apiUrl} — run \`sofar login\` first`)
  }

  const ctx = createToolContext(rootDir)
  let slugs: string[]
  if (options.all === true) {
    try {
      slugs = readdirSync(resolve(rootDir, '.sofar', 'initiatives'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort()
    } catch {
      slugs = []
    }
    if (slugs.length === 0) throw new TargetError('no initiatives under .sofar/initiatives/ — nothing to sync')
  } else if (options.slug !== undefined) {
    if (!SLUG_RE.test(options.slug)) {
      throw new TargetError(`invalid slug "${options.slug}" — slugs are lowercase letters, digits, and hyphens only`)
    }
    // Pull may name a stream that exists only on the server (it creates the
    // local log); push needs a local log to read.
    if (command === 'push' && !existsSync(ctx.initiativeDir(options.slug))) {
      ctx.resolveInitiative(options.slug) // throws the oriented unknown_initiative error
    }
    slugs = [options.slug]
  } else {
    slugs = [ctx.resolveInitiative()] // branch binding; ToolError carries the hint
  }
  return { apiUrl, remote, credential, state: readSyncState(rootDir, { api_url: apiUrl, repo_id: remote.repo_id }, env), slugs }
}

function targetFailure(command: 'push' | 'pull', err: unknown, errCaps: Caps): CmdResult {
  const message = err instanceof TargetError || err instanceof ToolError || err instanceof Error ? err.message : String(err)
  return fail(renderFailure(`sofar ${command}: ${message}`, errCaps))
}

/** Confirmation-register rendering for a list of per-stream result lines. */
function renderSyncLines(lines: string[], caps: Caps): string {
  if (!caps.color) return `${lines.join('\n')}\n`
  const style = createStyle(true)
  const sym = symbolsFor(caps.unicode)
  return `${lines.map((line) => `${style.success(sym.ok)} ${line}`).join('\n')}\n`
}

function apiFailureMessage(command: 'push' | 'pull', apiUrl: string, err: unknown): string {
  if (err instanceof ApiError && err.status === 401) {
    return `sofar ${command}: ${apiUrl} rejected the stored token — run \`sofar login\` again`
  }
  if (err instanceof ApiError && err.status === 404) {
    return `sofar ${command}: repo not found on ${apiUrl} (or you are no longer a member) — check .sofar/remote.json or re-run \`sofar link\``
  }
  if (err instanceof ApiError) {
    return `sofar ${command}: ${apiUrl} answered ${err.status} (${err.code}) — ${err.message}`
  }
  const suffix =
    command === 'push'
      ? 'events stay queued locally; re-run `sofar push` when the API is reachable'
      : 'local state is unaffected; re-run `sofar pull` when the API is reachable'
  return `sofar ${command}: cannot reach ${apiUrl} (${errMessage(err)}) — ${suffix}`
}

// ---------------------------------------------------------------------------
// sofar push
// ---------------------------------------------------------------------------

function pushLine(report: PushReport): string {
  if (report.pending === 0) return `${report.slug}: up to date (nothing to push)`
  const parts = [`${report.accepted} new`, `${report.duplicates} already on server`]
  if (report.invalid > 0) parts.push(`${report.invalid} rejected`)
  return `pushed ${report.slug}: ${parts.join(', ')}${report.head !== undefined ? ` — head ${report.head}` : ''}`
}

export async function runPush(
  rootDir: string,
  options: SyncOptions = {},
  deps: CloudDeps = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): Promise<CmdResult> {
  const env = deps.env ?? process.env
  let target: SyncTarget
  try {
    target = resolveTarget(rootDir, 'push', options, env)
  } catch (err) {
    return targetFailure('push', err, errCaps)
  }

  const ctx = createToolContext(rootDir)
  const warnings: string[] = []
  const lines: string[] = []
  for (const slug of target.slugs) {
    const cursors = target.state.streams[slug] ?? {}
    if (options.full === true) delete cursors.pushed
    try {
      const report = await pushStream({
        logPath: ctx.eventsPath(slug),
        slug,
        apiUrl: target.apiUrl,
        token: target.credential.token,
        repoId: target.remote.repo_id,
        ...(cursors.pushed !== undefined ? { cursor: cursors.pushed } : {}),
        onCursor: (id) => {
          target.state.streams[slug] = { ...target.state.streams[slug], pushed: id }
          writeSyncState(rootDir, target.state, env)
        },
        onWarn: (w) => warnings.push(w),
        ...netDeps(deps),
        ...(deps.sleep !== undefined ? { retry: { sleep: deps.sleep } } : {}),
      })
      lines.push(pushLine(report))
    } catch (err) {
      // Everything acked so far is already persisted through onCursor — the
      // remainder is the offline queue, drained by the next `sofar push`.
      return {
        exitCode: 1,
        stdout: lines.length > 0 ? renderSyncLines(lines, caps) : '',
        stderr: [...warnings, renderFailure(apiFailureMessage('push', target.apiUrl, err), errCaps)].join('\n'),
      }
    }
  }
  return ok(renderSyncLines(lines, caps), warnings.join('\n'))
}

// ---------------------------------------------------------------------------
// sofar pull
// ---------------------------------------------------------------------------

function pullLine(report: PullReport): string {
  if (report.appended === 0 && report.fetched === 0) return `${report.slug}: up to date`
  return `pulled ${report.slug}: ${report.appended} new, ${report.skipped} already local`
}

async function pullOne(
  rootDir: string,
  target: SyncTarget,
  slug: string,
  options: SyncOptions,
  deps: CloudDeps,
  env: Env,
  onWarn: (w: string) => void,
): Promise<PullReport> {
  const ctx = createToolContext(rootDir)
  const cursors = target.state.streams[slug] ?? {}
  if (options.full === true) delete cursors.pulled
  const report = await pullStream({
    logPath: ctx.eventsPath(slug),
    slug,
    apiUrl: target.apiUrl,
    token: target.credential.token,
    repoId: target.remote.repo_id,
    ...(cursors.pulled !== undefined ? { cursor: cursors.pulled } : {}),
    onCursor: (cursor) => {
      target.state.streams[slug] = { ...target.state.streams[slug], pulled: cursor }
      writeSyncState(rootDir, target.state, env)
    },
    onWarn,
    ...netDeps(deps),
    ...(deps.sleep !== undefined ? { retry: { sleep: deps.sleep } } : {}),
  })
  if (report.appended > 0) {
    regenerateProjections(ctx.initiativeDir(slug), ctx.foldState(slug))
  }
  return report
}

export async function runPull(
  rootDir: string,
  options: SyncOptions = {},
  deps: CloudDeps = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): Promise<CmdResult> {
  const env = deps.env ?? process.env
  let target: SyncTarget
  try {
    target = resolveTarget(rootDir, 'pull', options, env)
  } catch (err) {
    return targetFailure('pull', err, errCaps)
  }

  const warnings: string[] = []
  const lines: string[] = []
  for (const slug of target.slugs) {
    try {
      const report = await pullOne(rootDir, target, slug, options, deps, env, (w) => warnings.push(w))
      lines.push(pullLine(report))
    } catch (err) {
      return {
        exitCode: 1,
        stdout: lines.length > 0 ? renderSyncLines(lines, caps) : '',
        stderr: [...warnings, renderFailure(apiFailureMessage('pull', target.apiUrl, err), errCaps)].join('\n'),
      }
    }
  }
  return ok(renderSyncLines(lines, caps), warnings.join('\n'))
}

// ---------------------------------------------------------------------------
// sofar pull --watch — doorbell-driven long-running pull.
// ---------------------------------------------------------------------------

export interface WatchDeps extends CloudDeps {
  /** Abort to stop watching (tests; the CLI runs until ^C). */
  signal?: AbortSignal
  /** Result-line sink (default: process.stdout). */
  onLine?: (line: string) => void
  /** Warning sink (default: process.stderr). */
  onWarnLine?: (line: string) => void
}

/**
 * Long-running: initial catch-up pull on connect (and on every reconnect),
 * then a since-cursor pull per doorbell ring. Returns a CmdResult only on a
 * fatal setup/auth failure; otherwise resolves when the signal aborts.
 */
export async function runPullWatch(
  rootDir: string,
  options: SyncOptions = {},
  deps: WatchDeps = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): Promise<CmdResult | undefined> {
  const env = deps.env ?? process.env
  let target: SyncTarget
  try {
    target = resolveTarget(rootDir, 'pull', options, env)
  } catch (err) {
    return targetFailure('pull', err, errCaps)
  }

  const onLine = deps.onLine ?? ((line: string) => process.stdout.write(`${line}\n`))
  const onWarnLine = deps.onWarnLine ?? ((line: string) => process.stderr.write(`${line}\n`))
  const style = createStyle(errCaps.color)
  onWarnLine(
    style.dim(
      `watching ${target.slugs.length} stream${target.slugs.length === 1 ? '' : 's'} on ${target.apiUrl} — pulling on doorbell (^C to stop)`,
    ),
  )

  const pullAndReport = async (slug: string): Promise<void> => {
    const report = await pullOne(rootDir, target, slug, options, deps, env, onWarnLine)
    if (report.appended > 0 || report.skipped > 0) {
      onLine(renderSyncLines([pullLine(report)], caps).trimEnd())
    }
  }
  const pullAll = async (): Promise<void> => {
    for (const slug of target.slugs) await pullAndReport(slug)
  }

  try {
    await runDoorbell({
      apiUrl: target.apiUrl,
      token: target.credential.token,
      streams: target.slugs.map((slug) => `${target.remote.repo_id}/${slug}`),
      signal: deps.signal ?? new AbortController().signal,
      onConnect: pullAll,
      // Doorbell down ≠ data down: pull on every gap too, so watch mode
      // degrades to capped-backoff polling instead of going deaf.
      onGap: pullAll,
      onRing: async ({ stream }) => {
        const prefix = `${target.remote.repo_id}/`
        const slug = stream.startsWith(prefix) ? stream.slice(prefix.length) : null
        if (slug !== null && target.slugs.includes(slug)) await pullAndReport(slug)
      },
      onWarn: onWarnLine,
      ...netDeps(deps),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    })
    return undefined
  } catch (err) {
    return fail(renderFailure(apiFailureMessage('pull', target.apiUrl, err), errCaps))
  }
}
