import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_TTL_MS,
  OPT_OUT_ENV,
  isNewer,
  noticeFrom,
  noticeLine,
  readUpdateCache,
  refreshEntry,
  runCheckStatus,
  runRefresh,
  shouldRefresh,
  updateCachePath,
  updateNotice,
  withUpdateNotice,
  writeUpdateCache,
  type Env,
  type UpdateCache,
} from '../src/cli/update-check'
import { readAutoUpgrade, userConfigPath, writeAutoUpgrade } from '../src/cli/user-config'
import { ok, fail } from '../src/cli/shared'
import { runStatusline } from '../src/cli/statusline'
import { runUpgrade } from '../src/cli/upgrade'
import { version as CURRENT_VERSION } from '../package.json'

/**
 * The background update check (auto-update D1). The load-bearing property is
 * that NO foreground surface ever waits on the network: everything here reads
 * a cache file, and the only thing that touches npm is a detached child. The
 * tests therefore drive the pure gate + the injected spawn, never a real one.
 */

const tmpDirs: string[] = []

function sandbox(): { env: Env; state: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-update-'))
  tmpDirs.push(dir)
  const state = join(dir, 'state')
  const config = join(dir, 'config')
  mkdirSync(state, { recursive: true })
  mkdirSync(config, { recursive: true })
  return { env: { XDG_STATE_HOME: state, XDG_CONFIG_HOME: config }, state, config }
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const globalSelf = '/Users/x/.local/lib/node_modules/sofar.sh/dist/cli.js'
const sourceSelf = '/Users/x/proj/packages/engine/src/cli/update-check.ts'

const cacheAt = (latest: string | null, checkedAt: string): UpdateCache => ({
  version: 1,
  latest,
  checked_at: checkedAt,
})

// ---------------------------------------------------------------------------
// isNewer — dependency-free semver compare.
// ---------------------------------------------------------------------------

describe('isNewer', () => {
  it('compares the numeric triple', () => {
    expect(isNewer('0.17.3', '0.17.2')).toBe(true)
    expect(isNewer('0.18.0', '0.17.9')).toBe(true)
    expect(isNewer('1.0.0', '0.99.99')).toBe(true)
    expect(isNewer('0.17.2', '0.17.2')).toBe(false)
  })

  it('is STRICTLY newer, so a locally-built version ahead of the registry never nags', () => {
    expect(isNewer('0.17.1', '0.17.2')).toBe(false)
    expect(isNewer('0.17.2', '0.18.0')).toBe(false)
  })

  it('sorts a prerelease below its own release', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true)
    expect(isNewer('1.0.0-alpha', '1.0.0-beta')).toBe(false)
    expect(isNewer('1.0.0-rc.1.1', '1.0.0-rc.1')).toBe(true)
  })

  it('refuses to guess at an unparseable version', () => {
    expect(isNewer('latest', '0.17.2')).toBe(false)
    expect(isNewer('0.17.3', 'nonsense')).toBe(false)
    expect(isNewer('', '0.17.2')).toBe(false)
  })

  it('tolerates a v prefix and build metadata', () => {
    expect(isNewer('v0.17.3', '0.17.2')).toBe(true)
    expect(isNewer('0.17.3+build.5', '0.17.2')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The cache file.
// ---------------------------------------------------------------------------

describe('update cache', () => {
  it('round-trips through the XDG state dir', () => {
    const { env, state } = sandbox()
    expect(updateCachePath(env)).toBe(join(state, 'sofar', 'update.json'))
    writeUpdateCache(cacheAt('0.17.3', '2026-08-05T00:00:00.000Z'), env)
    expect(readUpdateCache(env)).toEqual(cacheAt('0.17.3', '2026-08-05T00:00:00.000Z'))
  })

  it('reads missing, corrupt, and shape-wrong files as null instead of throwing', () => {
    const { env } = sandbox()
    expect(readUpdateCache(env)).toBeNull()
    const path = updateCachePath(env)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{ not json', 'utf8')
    expect(readUpdateCache(env)).toBeNull()
    writeFileSync(path, '{"version":1,"latest":"0.17.3"}', 'utf8') // no checked_at
    expect(readUpdateCache(env)).toBeNull()
    writeFileSync(path, 'null', 'utf8')
    expect(readUpdateCache(env)).toBeNull()
  })

  it('survives a state dir it cannot write, rather than failing the command', () => {
    const env: Env = { XDG_STATE_HOME: '/proc/definitely-not-writable' }
    expect(() => writeUpdateCache(cacheAt('0.17.3', '2026-08-05T00:00:00.000Z'), env)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// The gate.
// ---------------------------------------------------------------------------

describe('shouldRefresh', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const plan = { kind: 'global-npm', prefix: '/Users/x/.local', selfPath: globalSelf } as const

  it('checks when there is no cache at all', () => {
    expect(shouldRefresh({ plan, cache: null, now, env: {} })).toBe(true)
  })

  it('holds off inside the TTL and checks once past it', () => {
    const fresh = cacheAt('0.17.3', new Date(now - CHECK_TTL_MS + 60_000).toISOString())
    const stale = cacheAt('0.17.3', new Date(now - CHECK_TTL_MS - 1).toISOString())
    expect(shouldRefresh({ plan, cache: fresh, now, env: {} })).toBe(false)
    expect(shouldRefresh({ plan, cache: stale, now, env: {} })).toBe(true)
  })

  it('treats an unparseable or future timestamp as stale, so a bad clock cannot pin it off forever', () => {
    expect(shouldRefresh({ plan, cache: cacheAt(null, 'whenever'), now, env: {} })).toBe(true)
    const future = cacheAt('0.17.3', new Date(now + CHECK_TTL_MS).toISOString())
    expect(shouldRefresh({ plan, cache: future, now, env: {} })).toBe(true)
  })

  it('is off under CI and under the opt-out env var', () => {
    expect(shouldRefresh({ plan, cache: null, now, env: { CI: 'true' } })).toBe(false)
    expect(shouldRefresh({ plan, cache: null, now, env: { [OPT_OUT_ENV]: '1' } })).toBe(false)
    // An empty value is not an opt-out.
    expect(shouldRefresh({ plan, cache: null, now, env: { CI: '' } })).toBe(true)
  })

  it('is off under a test runner — the leak that caught the packaging suite', () => {
    // packaging.test.ts installs the tarball into a temp prefix, which IS a
    // real global-npm layout: without this gate a unit-test run made a live
    // `npm view` call and wrote the developer's own ~/.local/state.
    expect(shouldRefresh({ plan, cache: null, now, env: { VITEST: 'true' } })).toBe(false)
    expect(shouldRefresh({ plan, cache: null, now, env: { NODE_ENV: 'test' } })).toBe(false)
    expect(shouldRefresh({ plan, cache: null, now, env: { NODE_ENV: 'production' } })).toBe(true)
  })

  it('never checks for an install that could not act on the answer', () => {
    const notGlobal = { kind: 'not-global', selfPath: sourceSelf, reason: 'source checkout' } as const
    expect(shouldRefresh({ plan: notGlobal, cache: null, now, env: {} })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// updateNotice — read, claim, spawn.
// ---------------------------------------------------------------------------

describe('updateNotice', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')

  it('claims the slot BEFORE spawning, so a per-prompt caller cannot start a herd', () => {
    const { env } = sandbox()
    const spawns: string[] = []
    updateNotice({ env, now, selfPath: globalSelf, spawnRefresh: (p) => spawns.push(p) })
    expect(spawns).toEqual([globalSelf])
    // The claim is on disk, so the very next call sees a fresh cache.
    expect(readUpdateCache(env)?.checked_at).toBe(new Date(now).toISOString())
    updateNotice({ env, now, selfPath: globalSelf, spawnRefresh: (p) => spawns.push(p) })
    expect(spawns).toHaveLength(1)
  })

  it('preserves the known latest while claiming, so the hint does not blink off during a refresh', () => {
    const { env } = sandbox()
    writeUpdateCache(cacheAt('9.9.9', new Date(now - CHECK_TTL_MS - 1).toISOString()), env)
    const notice = updateNotice({ env, now, selfPath: globalSelf, spawnRefresh: () => {} })
    expect(notice).toEqual({ latest: '9.9.9', current: CURRENT_VERSION, installed: false })
    expect(readUpdateCache(env)?.latest).toBe('9.9.9')
  })

  it('re-launches the ENTRY bundle, not whichever bundle the caller landed in', () => {
    // The statusline runs inside dist/fast.js, which has no top-level entry:
    // spawning it would exit silently and the check would never happen.
    expect(refreshEntry('/p/lib/node_modules/sofar.sh/dist/fast.js')).toBe(
      '/p/lib/node_modules/sofar.sh/dist/cli.js',
    )
    expect(refreshEntry('/p/lib/node_modules/sofar.sh/dist/full.js')).toBe(
      '/p/lib/node_modules/sofar.sh/dist/cli.js',
    )
  })

  it('does not spawn from a source checkout', () => {
    const { env } = sandbox()
    const spawns: string[] = []
    updateNotice({ env, now, selfPath: sourceSelf, spawnRefresh: (p) => spawns.push(p) })
    expect(spawns).toEqual([])
  })
})

describe('noticeFrom', () => {
  it('is null with no cache, an unknown latest, or a latest that is not newer', () => {
    expect(noticeFrom(null, '0.17.2')).toBeNull()
    expect(noticeFrom(cacheAt(null, '2026-08-05T00:00:00.000Z'), '0.17.2')).toBeNull()
    expect(noticeFrom(cacheAt('0.17.2', '2026-08-05T00:00:00.000Z'), '0.17.2')).toBeNull()
    expect(noticeFrom(cacheAt('0.17.1', '2026-08-05T00:00:00.000Z'), '0.17.2')).toBeNull()
  })

  it('reports an available release', () => {
    expect(noticeFrom(cacheAt('0.17.3', '2026-08-05T00:00:00.000Z'), '0.17.2')).toEqual({
      latest: '0.17.3',
      current: '0.17.2',
      installed: false,
    })
  })

  it('reports a background install as installed, and stops once the process has caught up', () => {
    const installed = {
      ...cacheAt('0.17.3', '2026-08-05T00:00:00.000Z'),
      installed: { version: '0.17.3', at: '2026-08-05T00:00:00.000Z' },
    }
    expect(noticeFrom(installed, '0.17.2')).toEqual({
      latest: '0.17.3',
      current: '0.17.2',
      installed: true,
    })
    // Same cache, but the user restarted into the new build: the reminder is spent.
    expect(noticeFrom(installed, '0.17.3')).toBeNull()
  })

  it('words the two cases differently — one asks for an upgrade, one for a restart', () => {
    expect(noticeLine({ latest: '0.17.3', current: '0.17.2', installed: false })).toContain(
      'sofar upgrade',
    )
    expect(noticeLine({ latest: '0.17.3', current: '0.17.2', installed: true })).toContain('sofar init')
  })
})

// ---------------------------------------------------------------------------
// withUpdateNotice — the stdout/exit-code contract.
// ---------------------------------------------------------------------------

describe('withUpdateNotice', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')

  function noticed(result: ReturnType<typeof ok>) {
    const { env } = sandbox()
    writeUpdateCache(cacheAt('99.0.0', new Date(now).toISOString()), env)
    return withUpdateNotice(result, { env, now, selfPath: globalSelf, spawnRefresh: () => {} })
  }

  it('leaves stdout and the exit code untouched and appends to stderr', () => {
    const out = noticed(ok('record body\n'))
    expect(out.stdout).toBe('record body\n')
    expect(out.exitCode).toBe(0)
    expect(out.stderr).toContain('99.0.0')
  })

  it('cannot flip a doctor verdict — a failing result stays failing, a passing one passing', () => {
    expect(noticed(fail('doctor: 2 problems')).exitCode).toBe(1)
    const failed = noticed(fail('doctor: 2 problems'))
    expect(failed.stderr.startsWith('doctor: 2 problems')).toBe(true)
    expect(failed.stderr).toContain('99.0.0')
  })

  it('adds nothing when there is no newer release', () => {
    const { env } = sandbox()
    writeUpdateCache(cacheAt(CURRENT_VERSION, new Date(now).toISOString()), env)
    const out = withUpdateNotice(ok('body\n'), { env, now, selfPath: globalSelf, spawnRefresh: () => {} })
    expect(out).toEqual(ok('body\n'))
  })
})

// ---------------------------------------------------------------------------
// The statusline segment.
// ---------------------------------------------------------------------------

describe('statusline update segment', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')
  const hookJson = JSON.stringify({ model: { display_name: 'Opus' } })

  function line(latest: string, extra: Partial<UpdateCache> = {}) {
    const { env } = sandbox()
    writeUpdateCache({ ...cacheAt(latest, new Date(now).toISOString()), ...extra }, env)
    return runStatusline(process.cwd(), hookJson, { color: false, unicode: true, animate: false }, {
      env,
      now,
      selfPath: globalSelf,
      spawnRefresh: () => {},
    })
  }

  it('renders ↑<version> when an update is available', () => {
    expect(line('99.0.0')).toContain('↑99.0.0')
  })

  it('asks for a restart after a background install', () => {
    expect(line('99.0.0', { installed: { version: '99.0.0', at: '2026-08-05T00:00:00.000Z' } })).toContain(
      '↻99.0.0',
    )
  })

  it('falls back to a word without unicode', () => {
    const { env } = sandbox()
    writeUpdateCache(cacheAt('99.0.0', new Date(now).toISOString()), env)
    const out = runStatusline(process.cwd(), hookJson, { color: false, unicode: false, animate: false }, {
      env,
      now,
      selfPath: globalSelf,
      spawnRefresh: () => {},
    })
    expect(out).toContain('update 99.0.0')
  })

  it('is absent when up to date, and absent by default so existing callers stay hermetic', () => {
    expect(line(CURRENT_VERSION)).not.toContain('↑')
    expect(runStatusline(process.cwd(), hookJson)).not.toContain('↑')
  })
})

// ---------------------------------------------------------------------------
// The opt-in flag + the refresh child.
// ---------------------------------------------------------------------------

describe('auto-upgrade preference', () => {
  it('defaults off, round-trips, and treats an unreadable config as no consent', () => {
    const { env, config } = sandbox()
    expect(readAutoUpgrade(env)).toBe(false)
    writeAutoUpgrade(true, env)
    expect(readAutoUpgrade(env)).toBe(true)
    writeAutoUpgrade(false, env)
    expect(readAutoUpgrade(env)).toBe(false)
    writeFileSync(join(config, 'sofar', 'config.json'), '{ broken', 'utf8')
    expect(readAutoUpgrade(env)).toBe(false)
  })

  it('preserves unrelated keys already in the config file', () => {
    const { env } = sandbox()
    mkdirSync(join(userConfigPath(env), '..'), { recursive: true })
    writeFileSync(userConfigPath(env), JSON.stringify({ keep: 'me' }), 'utf8')
    writeAutoUpgrade(true, env)
    expect(JSON.parse(readFileSync(userConfigPath(env), 'utf8'))).toEqual({
      keep: 'me',
      version: 1,
      auto_upgrade: true,
    })
  })
})

describe('runRefresh', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z')

  it('persists the resolved latest and installs nothing while auto is off', () => {
    const { env } = sandbox()
    const installs: string[] = []
    runRefresh({
      env,
      now,
      selfPath: globalSelf,
      fetchLatest: () => '99.0.0',
      install: (_p, t) => {
        installs.push(t)
        return 0
      },
    })
    expect(readUpdateCache(env)).toEqual(cacheAt('99.0.0', new Date(now).toISOString()))
    expect(installs).toEqual([])
  })

  it('keeps the last known latest when the registry is unreachable', () => {
    const { env } = sandbox()
    writeUpdateCache(cacheAt('99.0.0', '2026-08-01T00:00:00.000Z'), env)
    runRefresh({ env, now, selfPath: globalSelf, fetchLatest: () => null })
    expect(readUpdateCache(env)).toEqual(cacheAt('99.0.0', new Date(now).toISOString()))
  })

  it('installs and records it once the user has opted in', () => {
    const { env } = sandbox()
    writeAutoUpgrade(true, env)
    const installs: Array<[string, string]> = []
    runRefresh({
      env,
      now,
      selfPath: globalSelf,
      fetchLatest: () => '99.0.0',
      install: (p, t) => {
        installs.push([p, t])
        return 0
      },
    })
    expect(installs).toEqual([['/Users/x/.local', '99.0.0']])
    expect(readUpdateCache(env)?.installed).toEqual({ version: '99.0.0', at: new Date(now).toISOString() })
  })

  it('records nothing installed when npm fails', () => {
    const { env } = sandbox()
    writeAutoUpgrade(true, env)
    const out = runRefresh({
      env,
      now,
      selfPath: globalSelf,
      fetchLatest: () => '99.0.0',
      install: () => 7,
    })
    expect(readUpdateCache(env)?.installed).toBeUndefined()
    expect(out.stdout).toContain('npm exited 7')
  })

  it('drops a spent install marker once the running binary has caught up', () => {
    const { env } = sandbox()
    writeUpdateCache(
      {
        ...cacheAt(CURRENT_VERSION, '2026-08-01T00:00:00.000Z'),
        installed: { version: CURRENT_VERSION, at: '2026-08-01T00:00:00.000Z' },
      },
      env,
    )
    runRefresh({ env, now, selfPath: globalSelf, fetchLatest: () => CURRENT_VERSION })
    expect(readUpdateCache(env)?.installed).toBeUndefined()
  })

  it('never installs from a non-global install, even with auto on', () => {
    const { env } = sandbox()
    writeAutoUpgrade(true, env)
    const installs: string[] = []
    runRefresh({
      env,
      now,
      selfPath: sourceSelf,
      fetchLatest: () => '99.0.0',
      install: (_p, t) => {
        installs.push(t)
        return 0
      },
    })
    expect(installs).toEqual([])
  })
})

describe('runCheckStatus', () => {
  it('reports the cache without touching it', () => {
    const { env } = sandbox()
    writeUpdateCache(cacheAt('99.0.0', '2026-08-05T00:00:00.000Z'), env)
    const before = readFileSync(updateCachePath(env), 'utf8')
    const out = runCheckStatus({ env })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('latest:     99.0.0')
    expect(out.stdout).toContain('auto:       off')
    expect(out.stdout).toContain('99.0.0 is available')
    expect(readFileSync(updateCachePath(env), 'utf8')).toBe(before)
  })

  it('says so when the check has never run', () => {
    const { env } = sandbox()
    const out = runCheckStatus({ env })
    expect(out.stdout).toContain('checked:    never')
    expect(out.stdout).toContain('notice:     none')
  })
})

// ---------------------------------------------------------------------------
// The pitch — the one place the opt-in is advertised.
// ---------------------------------------------------------------------------

describe('the --auto pitch in runUpgrade', () => {
  const deps = {
    selfPath: globalSelf,
    fetchLatest: () => '99.0.0',
    spawnInstall: async () => 0,
  }
  const plainCaps = { color: false, unicode: false, animate: false }

  it('offers the opt-in after a successful upgrade, while it is off', async () => {
    const out = await runUpgrade({}, { ...deps, readAuto: () => false }, plainCaps)
    expect(out.stdout).toContain('sofar upgrade --auto on')
    expect(out.stdout).toContain('sofar init') // the wiring reminder still leads
  })

  it('goes quiet once the user has taken it', async () => {
    const out = await runUpgrade({}, { ...deps, readAuto: () => true }, plainCaps)
    expect(out.stdout).not.toContain('--auto on')
    expect(out.stdout).toContain('sofar upgraded (99.0.0)')
  })

  it('is not printed when nothing was installed', async () => {
    const out = await runUpgrade({ check: true }, { ...deps, readAuto: () => false }, plainCaps)
    expect(out.stdout).not.toContain('--auto on')
  })
})
