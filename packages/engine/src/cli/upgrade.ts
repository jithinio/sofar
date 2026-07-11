import { spawn, execFileSync } from 'node:child_process'
import { basename, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { version as CURRENT_VERSION } from '../../package.json'
import { errMessage, fail, ok, type CmdResult } from './shared'

/**
 * `sofar upgrade [version]` — self-update the globally-installed sofar.
 *
 * The paper-cut this removes: sofar is often installed under a NON-DEFAULT npm
 * prefix (e.g. ~/.local while `npm config get prefix` reports /usr/local), so a
 * plain `npm i -g @alignlabs/sofar@latest` installs into the wrong place and
 * leaves the copy actually on $PATH untouched. The fix is to stop trusting
 * npm's configured prefix and instead derive the real one from the running
 * binary's own location — the file that IS on $PATH knows where it lives.
 */

export const PACKAGE_NAME = '@alignlabs/sofar'

export interface UpgradeOptions {
  /** Explicit target version; omit for the `latest` dist-tag. */
  version?: string
  /** Report installed-vs-latest and the resolved install; change nothing. */
  check?: boolean
  /** Print the exact npm command that would run; change nothing. */
  dryRun?: boolean
  /** Reinstall even when already at the target version. */
  force?: boolean
}

export type UpgradePlan =
  | { kind: 'global-npm'; prefix: string; selfPath: string }
  | { kind: 'not-global'; selfPath: string; reason: string }

/**
 * Decide whether — and where — this binary can self-upgrade, PURELY from its
 * own on-disk path. Deliberately does not consult `npm config get prefix`:
 * that value is exactly what lies when sofar was installed under a custom
 * prefix, which is the whole reason a naive global install misses the live
 * copy. npm's posix global layout is
 * `<prefix>/lib/node_modules/@alignlabs/sofar/…`, so the prefix is the
 * directory holding `lib`. Anything that is not that layout — a project-local
 * dependency, an npx cache, a source checkout, or a Windows global root — is
 * reported `not-global` with a reason, and the caller prints manual guidance
 * rather than guessing a prefix and installing into the wrong place.
 */
export function planUpgrade(selfPath: string): UpgradePlan {
  const segments = selfPath.split(sep)
  const nmIndex = segments.lastIndexOf('node_modules')
  if (nmIndex < 0) {
    return {
      kind: 'not-global',
      selfPath,
      reason: 'not running from an installed package (looks like a source checkout)',
    }
  }
  const beforeNodeModules = segments.slice(0, nmIndex).join(sep)
  // posix npm global: node_modules sits directly inside `lib`, and the prefix
  // is lib's parent. A local dep (`<project>/node_modules`) or an npx cache
  // (`…/_npx/<hash>/node_modules`) has some other parent and must not self-upgrade.
  if (basename(beforeNodeModules) !== 'lib') {
    return {
      kind: 'not-global',
      selfPath,
      reason: 'not a global npm install (local dependency, npx cache, or non-npm layout)',
    }
  }
  return { kind: 'global-npm', prefix: dirname(beforeNodeModules), selfPath }
}

/** npm argv that installs the target into the resolved prefix. */
export function npmInstallArgs(prefix: string, target: string): string[] {
  return ['install', '-g', '--prefix', prefix, `${PACKAGE_NAME}@${target}`]
}

/** The install command as a copy-pasteable line (for --dry-run and --check). */
function commandLine(prefix: string, target: string): string {
  return `npm ${npmInstallArgs(prefix, target).join(' ')}`
}

/** Query the registry for the `latest` dist-tag; null on any failure. */
export function fetchLatestVersion(): string | null {
  try {
    const out = execFileSync('npm', ['view', PACKAGE_NAME, 'version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

export interface UpgradeContext {
  plan: UpgradePlan
  currentVersion: string
  /** Resolved `latest`, or null if unknown/unqueried. */
  latestVersion: string | null
}

export type UpgradeDecision =
  | { action: 'report'; result: CmdResult }
  | { action: 'install'; prefix: string; target: string }

function renderCheck(
  plan: UpgradePlan,
  current: string,
  latest: string | null,
  target: string,
): string {
  const lines = [`installed: ${current}`]
  if (latest) {
    lines.push(`latest:    ${latest}${latest === current ? ' (up to date)' : ' (update available)'}`)
  } else {
    lines.push('latest:    unknown (could not reach the npm registry)')
  }
  if (plan.kind === 'global-npm') {
    lines.push(`prefix:    ${plan.prefix}`)
    lines.push(`command:   ${commandLine(plan.prefix, target)}`)
  } else {
    lines.push(`self-upgrade unavailable: ${plan.reason}`)
    lines.push(`manual:    npm install -g ${PACKAGE_NAME}@${target}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * Pure decision core: given the plan, the installed version, and the (maybe
 * unknown) latest, decide whether to report or to install. No I/O — the entire
 * control flow is unit-testable without spawning npm or hitting the network.
 */
export function resolveUpgrade(opts: UpgradeOptions, ctx: UpgradeContext): UpgradeDecision {
  const { plan, currentVersion, latestVersion } = ctx
  const target = opts.version ?? latestVersion ?? 'latest'

  // --check reports and exits for ANY install shape, global or not.
  if (opts.check) {
    return { action: 'report', result: ok(renderCheck(plan, currentVersion, latestVersion, target)) }
  }

  if (plan.kind === 'not-global') {
    return {
      action: 'report',
      result: fail(
        `sofar upgrade: ${plan.reason}.\n` +
          `Update it the way you installed it — e.g.\n` +
          `  npm install -g ${PACKAGE_NAME}@${target}\n` +
          `(append --prefix <dir> if you installed under a custom prefix).`,
      ),
    }
  }

  const alreadyAtTarget =
    !opts.force &&
    (opts.version
      ? opts.version === currentVersion
      : latestVersion !== null && latestVersion === currentVersion)
  if (alreadyAtTarget && !opts.dryRun) {
    return {
      action: 'report',
      result: ok(`sofar is already at ${currentVersion}${opts.version ? '' : ' (latest)'}.\n`),
    }
  }

  if (opts.dryRun) {
    return { action: 'report', result: ok(`${commandLine(plan.prefix, target)}\n`) }
  }

  return { action: 'install', prefix: plan.prefix, target }
}

/** Resolve the running cli.js path — the realpath Node runs, following the bin symlink. */
function resolveSelfPath(): string {
  return fileURLToPath(import.meta.url)
}

/** Spawn `npm install`, streaming npm's own output; resolves with the exit code. */
function defaultSpawnInstall(prefix: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', npmInstallArgs(prefix, target), { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export interface UpgradeDeps {
  /** Override the resolved binary path (tests). */
  selfPath?: string
  /** Override the registry query (tests). */
  fetchLatest?: () => string | null
  /** Override the installer (tests). */
  spawnInstall?: (prefix: string, target: string) => Promise<number>
}

export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps = {}): Promise<CmdResult> {
  const selfPath = deps.selfPath ?? resolveSelfPath()
  const plan = planUpgrade(selfPath)

  // Fetch `latest` only when we actually need it: to display (--check) or as
  // the target / no-op guard when the user didn't pin a version.
  const needLatest = opts.check === true || opts.version === undefined
  const fetchLatest = deps.fetchLatest ?? fetchLatestVersion
  const latestVersion = needLatest ? fetchLatest() : null

  const decision = resolveUpgrade(opts, { plan, currentVersion: CURRENT_VERSION, latestVersion })
  if (decision.action === 'report') return decision.result

  const spawnInstall = deps.spawnInstall ?? defaultSpawnInstall
  let code: number
  try {
    code = await spawnInstall(decision.prefix, decision.target)
  } catch (err) {
    return fail(`sofar upgrade: could not run npm (${errMessage(err)}). Is npm on your PATH?`)
  }
  if (code === 0) {
    return ok(
      `\nsofar upgraded (${decision.target}). ` +
        `Reconnect the sofar MCP server (/mcp) or restart your agent to load it.\n`,
    )
  }
  // Preserve npm's exit code so CI/callers see the real failure code, not a flat 1.
  return { exitCode: code, stdout: '', stderr: `sofar upgrade: npm exited ${code} (see output above).` }
}
