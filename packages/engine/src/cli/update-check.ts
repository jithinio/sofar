import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version as CURRENT_VERSION } from '../../package.json'
import { ok, type CmdResult } from './shared'
import { createStyle, stderrCaps, symbolsFor } from './ui'
import { fetchLatestVersion, npmInstallArgs, planUpgrade, type UpgradePlan } from './upgrade'
import { readAutoUpgrade } from './user-config'

/**
 * Background update check (auto-update D1) — the half of "auto update" that
 * only ever TELLS you.
 *
 * The split that makes this free: a detached child does the network work and
 * writes ~/.local/state/sofar/update.json; every foreground surface only READS
 * that file. No command — least of all `sofar statusline`, which renders on
 * every prompt — ever waits on `npm view`. Installing stays a thing the user
 * chose, because an upgrade replaces the binary AND leaves repo wiring stale
 * (see runUpgrade's success message).
 */

/** How long a completed check stays fresh. */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000

/** Set to any non-empty value to silence the check entirely. */
export const OPT_OUT_ENV = 'SOFAR_NO_UPDATE_CHECK'

export type Env = Record<string, string | undefined>

export interface UpdateCache {
  version: 1
  /** Last successfully resolved `latest` dist-tag; null when never resolved. */
  latest: string | null
  /** ISO timestamp of the last check ATTEMPT (claimed before the network call). */
  checked_at: string
  /** Set by an auto-install so a later surface can say wiring needs refreshing. */
  installed?: { version: string; at: string }
}

export function updateCachePath(env: Env = process.env): string {
  const base = nonEmpty(env.XDG_STATE_HOME) ?? join(homedir(), '.local', 'state')
  return join(base, 'sofar', 'update.json')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/**
 * The cache, or null when absent/unreadable/corrupt. NEVER throws: this is
 * read from the statusline and from init's tail, where a malformed cache file
 * must degrade to "no notice", never to a failed command.
 */
export function readUpdateCache(env: Env = process.env): UpdateCache | null {
  const path = updateCachePath(env)
  if (!existsSync(path)) return null
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateCache> | null
    if (typeof decoded !== 'object' || decoded === null) return null
    if (typeof decoded.checked_at !== 'string' || decoded.checked_at.length === 0) return null
    const latest = typeof decoded.latest === 'string' && decoded.latest.length > 0 ? decoded.latest : null
    const installed =
      typeof decoded.installed === 'object' &&
      decoded.installed !== null &&
      typeof decoded.installed.version === 'string' &&
      typeof decoded.installed.at === 'string'
        ? decoded.installed
        : undefined
    return {
      version: 1,
      latest,
      checked_at: decoded.checked_at,
      ...(installed !== undefined ? { installed } : {}),
    }
  } catch {
    return null
  }
}

/** Write via temp + rename so a reader never sees a half-written file. */
export function writeUpdateCache(cache: UpdateCache, env: Env = process.env): void {
  const path = updateCachePath(env)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    // A cache we cannot persist costs a redundant check, never a broken command.
  }
}

// ---------------------------------------------------------------------------
// Version comparison — dependency-free (CLAUDE.md: no new deps without a Decision).
// ---------------------------------------------------------------------------

/**
 * Is `candidate` strictly newer than `current`? Numeric triple first, then
 * prerelease: `1.0.0-rc.1` sorts BELOW `1.0.0`, and two prereleases compare
 * by their dot-separated identifiers (numeric parts numerically). Strictly —
 * not `!==` — so a locally-built version ahead of the registry never nags.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i += 1) {
    const cmp = (a.release[i] ?? 0) - (b.release[i] ?? 0)
    if (cmp !== 0) return cmp > 0
  }
  // Equal releases: a release beats a prerelease; two prereleases compare by id.
  if (a.pre === null) return b.pre !== null
  if (b.pre === null) return false
  return comparePrerelease(a.pre, b.pre) > 0
}

function parseVersion(value: string): { release: number[]; pre: string[] | null } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split('.'),
  }
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1 // fewer identifiers sorts lower
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1 // numeric identifiers sort below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// Gating + the notice.
// ---------------------------------------------------------------------------

export interface RefreshContext {
  plan: UpgradePlan
  cache: UpdateCache | null
  now: number
  env: Env
}

/**
 * Should a refresh be spawned right now?
 *
 * Gated on global-npm because nothing else can act on the answer: a source
 * checkout (this repo, during development) has nothing to upgrade, a local
 * dependency is pinned by its own package.json, and an npx run already
 * resolves latest. Nagging any of them is noise with no button attached.
 */
export function shouldRefresh(ctx: RefreshContext): boolean {
  if (nonEmpty(ctx.env[OPT_OUT_ENV]) !== undefined) return false
  // Nobody is present to read a notice in CI or under a test runner, and both
  // spend a real network call plus a write to the USER's home state dir to
  // learn it. This is not hypothetical: sofar's own packaging test installs
  // the tarball into a temp prefix — a true global-npm layout — and drove a
  // live `npm view` out of a unit-test run before this line existed.
  if (nonEmpty(ctx.env.CI) !== undefined) return false
  if (nonEmpty(ctx.env.VITEST) !== undefined || ctx.env.NODE_ENV === 'test') return false
  if (ctx.plan.kind !== 'global-npm') return false
  if (ctx.cache === null) return true
  const checkedAt = Date.parse(ctx.cache.checked_at)
  if (Number.isNaN(checkedAt)) return true
  // A clock that moved backwards (or a cache from the future) reads as stale
  // rather than pinning the check off forever.
  return ctx.now - checkedAt >= CHECK_TTL_MS || checkedAt > ctx.now
}

export interface UpdateNotice {
  latest: string
  current: string
  /** True when the auto-installer already applied it and wiring may be stale. */
  installed: boolean
}

/**
 * The notice to render, or null. Reads only — the comparison against the
 * RUNNING version is what makes the cache self-healing: after an upgrade,
 * latest === current and the notice disappears with no cache write.
 */
export function noticeFrom(
  cache: UpdateCache | null,
  currentVersion: string = CURRENT_VERSION,
): UpdateNotice | null {
  if (cache?.installed !== undefined && cache.installed.version === currentVersion) {
    // Already running the auto-installed build — the wiring reminder is spent.
    return null
  }
  if (cache?.installed !== undefined && isNewer(cache.installed.version, currentVersion)) {
    return { latest: cache.installed.version, current: currentVersion, installed: true }
  }
  if (cache === null || cache.latest === null) return null
  if (!isNewer(cache.latest, currentVersion)) return null
  return { latest: cache.latest, current: currentVersion, installed: false }
}

export interface UpdateCheckDeps {
  /** Override the resolved binary path (tests). */
  selfPath?: string
  /** Override the detached spawn (tests). */
  spawnRefresh?: (selfPath: string) => void
  now?: number
  env?: Env
}

/**
 * The bundle to re-launch for the refresh — always the sibling `cli.js`.
 *
 * NOT selfPath. The build splits the CLI into three bundles (boot → cli.js,
 * hot path → fast.js, everything else → full.js, speed-2 T1), and the surface
 * that most needs this check — the statusline — runs inside fast.js. Spawning
 * selfPath there would run fast.js as a script: it has no top-level entry, so
 * it would exit silently and the check would never once happen. cli.js is the
 * only file that routes a command.
 */
export function refreshEntry(selfPath: string): string {
  return join(dirname(selfPath), 'cli.js')
}

/** Detached, unref'd, output discarded — the parent exits without waiting. */
function defaultSpawnRefresh(selfPath: string): void {
  try {
    const child = spawn(process.execPath, [refreshEntry(selfPath), 'update-check', '--refresh'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch {
    // No child, no check. Never fatal to the foreground command.
  }
}

/**
 * The one call every surface makes: return the notice to render, and — when
 * the cache has gone stale — kick off a background refresh for NEXT time.
 *
 * The parent claims the slot (stamps checked_at before spawning) because the
 * statusline renders on every prompt: without the claim, a stale cache would
 * spawn one `npm view` per keystroke-round until the first child finished.
 */
export function updateNotice(deps: UpdateCheckDeps = {}): UpdateNotice | null {
  const env = deps.env ?? process.env
  const cache = readUpdateCache(env)
  const selfPath = deps.selfPath ?? currentSelfPath()
  const now = deps.now ?? Date.now()
  if (shouldRefresh({ plan: planUpgrade(selfPath), cache, now, env })) {
    writeUpdateCache(
      { version: 1, latest: cache?.latest ?? null, checked_at: new Date(now).toISOString(),
        ...(cache?.installed !== undefined ? { installed: cache.installed } : {}) },
      env,
    )
    ;(deps.spawnRefresh ?? defaultSpawnRefresh)(selfPath)
  }
  return noticeFrom(cache)
}

function currentSelfPath(): string {
  return fileURLToPath(import.meta.url)
}

/** One-line hint for the text surfaces (status, init, doctor). */
export function noticeLine(notice: UpdateNotice): string {
  if (notice.installed) {
    return (
      `sofar auto-upgraded to ${notice.latest} (you are running ${notice.current}). ` +
      'Restart your agent, and run `sofar init` in each repo to refresh its wiring.'
    )
  }
  return `sofar ${notice.latest} is available (you have ${notice.current}) — run \`sofar upgrade\`.`
}

/**
 * Append the notice to a command's STDERR, leaving every stdout byte and the
 * exit code untouched.
 *
 * Both properties are load-bearing. stdout stays identical so piping `sofar
 * status` never gains a line it did not have; the exit code stays identical so
 * `sofar doctor` cannot start failing CI merely because a release landed —
 * which is exactly why this is a trailing line and not a doctor axis (D1).
 */
export function withUpdateNotice(result: CmdResult, deps: UpdateCheckDeps = {}): CmdResult {
  let notice: UpdateNotice | null
  try {
    notice = updateNotice(deps)
  } catch {
    return result
  }
  if (notice === null) return result
  const caps = stderrCaps()
  const style = createStyle(caps.color)
  const sym = symbolsFor(caps.unicode)
  // Cyan: the color law's info tone (cli-ui D1). An available release is
  // information, not a warning about the user's state — yellow would claim
  // something is wrong when nothing is.
  const line = `${style.info(sym.info)} ${style.info(noticeLine(notice))}`
  const stderr = result.stderr.length > 0 ? `${result.stderr.replace(/\n*$/, '\n')}${line}` : line
  return { ...result, stderr }
}

// ---------------------------------------------------------------------------
// `sofar update-check` — what the detached child runs, and how a human looks.
// ---------------------------------------------------------------------------

export interface UpdateCheckRunDeps {
  fetchLatest?: () => string | null
  install?: (prefix: string, target: string) => number
  selfPath?: string
  now?: number
  env?: Env
}

/**
 * Perform the check the foreground deliberately skipped: resolve `latest`,
 * persist it, and — only when the user opted in — install it. Runs detached
 * with stdio ignored, so its cost is invisible; the returned text exists for
 * the human who runs `sofar update-check --refresh` directly.
 */
export function runRefresh(deps: UpdateCheckRunDeps = {}): CmdResult {
  const env = deps.env ?? process.env
  const now = deps.now ?? Date.now()
  const selfPath = deps.selfPath ?? currentSelfPath()
  const plan = planUpgrade(selfPath)
  const previous = readUpdateCache(env)
  const latest = (deps.fetchLatest ?? fetchLatestVersion)()

  const cache: UpdateCache = {
    version: 1,
    latest: latest ?? previous?.latest ?? null,
    checked_at: new Date(now).toISOString(),
  }
  // Carry a PENDING install marker forward; drop it once the running binary
  // has caught up, so the "restart your agent" line cannot outlive its cause.
  if (previous?.installed !== undefined && isNewer(previous.installed.version, CURRENT_VERSION)) {
    cache.installed = previous.installed
  }

  const lines: string[] = [
    `installed: ${CURRENT_VERSION}`,
    `latest:    ${latest ?? 'unknown (could not reach the npm registry)'}`,
  ]

  const wantsAuto = readAutoUpgrade(env)
  if (wantsAuto && latest !== null && plan.kind === 'global-npm' && isNewer(latest, CURRENT_VERSION)) {
    const code = (deps.install ?? defaultInstall)(plan.prefix, latest)
    if (code === 0) {
      cache.installed = { version: latest, at: new Date(now).toISOString() }
      lines.push(`auto-upgrade: installed ${latest}`)
    } else {
      lines.push(`auto-upgrade: npm exited ${code} — left at ${CURRENT_VERSION}`)
    }
  } else if (wantsAuto) {
    lines.push('auto-upgrade: on (nothing to install)')
  }

  writeUpdateCache(cache, env)
  return ok(`${lines.join('\n')}\n`)
}

function defaultInstall(prefix: string, target: string): number {
  try {
    execFileSync('npm', npmInstallArgs(prefix, target), { stdio: 'ignore', timeout: 300_000 })
    return 0
  } catch (err) {
    const code = (err as { status?: number }).status
    return typeof code === 'number' && code !== 0 ? code : 1
  }
}

/** `sofar update-check` with no flag: report the cache without touching it. */
export function runCheckStatus(deps: UpdateCheckRunDeps = {}): CmdResult {
  const env = deps.env ?? process.env
  const cache = readUpdateCache(env)
  const notice = noticeFrom(cache, CURRENT_VERSION)
  const lines = [
    `installed:  ${CURRENT_VERSION}`,
    `latest:     ${cache?.latest ?? 'unknown (never checked)'}`,
    `checked:    ${cache?.checked_at ?? 'never'}`,
    `auto:       ${readAutoUpgrade(env) ? 'on' : 'off'} (\`sofar upgrade --auto on|off\`)`,
    `cache:      ${updateCachePath(env)}`,
    `notice:     ${notice === null ? 'none' : noticeLine(notice)}`,
  ]
  return ok(`${lines.join('\n')}\n`)
}
