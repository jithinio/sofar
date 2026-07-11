import { describe, expect, it } from 'vitest'
import {
  PACKAGE_NAME,
  npmInstallArgs,
  planUpgrade,
  resolveUpgrade,
  runUpgrade,
  type UpgradePlan,
} from '../src/cli/upgrade'

/**
 * `sofar upgrade` — self-update the globally-installed CLI. The whole point is
 * to derive the real install prefix from the running binary's own path instead
 * of trusting `npm config get prefix` (which lies under a custom prefix), so
 * the plan derivation and the pure decision core carry the coverage; the
 * network/spawn edges are exercised via injected deps.
 */

const posixGlobal = '/Users/x/.local/lib/node_modules/@alignlabs/sofar/dist/cli.js'
const defaultGlobal = '/usr/local/lib/node_modules/@alignlabs/sofar/dist/cli.js'
const localDep = '/Users/x/proj/node_modules/@alignlabs/sofar/dist/cli.js'
const npxCache = '/Users/x/.npm/_npx/abc123/node_modules/@alignlabs/sofar/dist/cli.js'
const sourceCheckout = '/Users/x/proj/packages/engine/src/cli/upgrade.ts'

const globalPlan = (prefix: string): UpgradePlan => ({ kind: 'global-npm', prefix, selfPath: 'x' })
const notGlobalPlan: UpgradePlan = { kind: 'not-global', selfPath: 'x', reason: 'local dependency' }

describe('planUpgrade — derive prefix from the running binary', () => {
  it('resolves a custom-prefix global install to that prefix (the paper-cut case)', () => {
    expect(planUpgrade(posixGlobal)).toEqual({
      kind: 'global-npm',
      prefix: '/Users/x/.local',
      selfPath: posixGlobal,
    })
  })

  it('resolves the default /usr/local global install', () => {
    expect(planUpgrade(defaultGlobal)).toMatchObject({ kind: 'global-npm', prefix: '/usr/local' })
  })

  it('treats a project-local dependency as not-global', () => {
    expect(planUpgrade(localDep).kind).toBe('not-global')
  })

  it('treats an npx cache path as not-global', () => {
    expect(planUpgrade(npxCache).kind).toBe('not-global')
  })

  it('treats a source checkout (no node_modules) as not-global', () => {
    expect(planUpgrade(sourceCheckout).kind).toBe('not-global')
  })
})

describe('npmInstallArgs', () => {
  it('installs the target into the resolved prefix', () => {
    expect(npmInstallArgs('/Users/x/.local', 'latest')).toEqual([
      'install',
      '-g',
      '--prefix',
      '/Users/x/.local',
      `${PACKAGE_NAME}@latest`,
    ])
  })
})

describe('resolveUpgrade — pure decision core', () => {
  const ctx = (over: Partial<Parameters<typeof resolveUpgrade>[1]>) => ({
    plan: globalPlan('/Users/x/.local'),
    currentVersion: '0.3.2',
    latestVersion: '0.4.0',
    ...over,
  })

  it('installs latest when behind', () => {
    const d = resolveUpgrade({}, ctx({}))
    expect(d).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.4.0' })
  })

  it('no-ops when already at latest', () => {
    const d = resolveUpgrade({}, ctx({ latestVersion: '0.3.2' }))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(0)
      expect(d.result.stdout).toContain('already at 0.3.2 (latest)')
    }
  })

  it('--force reinstalls even when already at latest', () => {
    const d = resolveUpgrade({ force: true }, ctx({ latestVersion: '0.3.2' }))
    expect(d).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.3.2' })
  })

  it('installs a pinned version regardless of latest', () => {
    const d = resolveUpgrade({ version: '0.3.5' }, ctx({ latestVersion: null }))
    expect(d).toEqual({ action: 'install', prefix: '/Users/x/.local', target: '0.3.5' })
  })

  it('no-ops when the pinned version equals the installed one', () => {
    const d = resolveUpgrade({ version: '0.3.2' }, ctx({ latestVersion: null }))
    expect(d.action).toBe('report')
  })

  it('--dry-run prints the command and installs nothing', () => {
    const d = resolveUpgrade({ dryRun: true }, ctx({}))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.stdout.trim()).toBe(
        'npm install -g --prefix /Users/x/.local @alignlabs/sofar@0.4.0',
      )
    }
  })

  it('--check reports installed/latest/prefix without mutating', () => {
    const d = resolveUpgrade({ check: true }, ctx({}))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(0)
      expect(d.result.stdout).toContain('installed: 0.3.2')
      expect(d.result.stdout).toContain('latest:    0.4.0 (update available)')
      expect(d.result.stdout).toContain('prefix:    /Users/x/.local')
    }
  })

  it('fails with manual guidance on a non-global install', () => {
    const d = resolveUpgrade({}, ctx({ plan: notGlobalPlan }))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(1)
      expect(d.result.stderr).toContain('local dependency')
      expect(d.result.stderr).toContain(`npm install -g ${PACKAGE_NAME}@`)
    }
  })

  it('--check still reports (exit 0) on a non-global install', () => {
    const d = resolveUpgrade({ check: true }, ctx({ plan: notGlobalPlan }))
    expect(d.action).toBe('report')
    if (d.action === 'report') {
      expect(d.result.exitCode).toBe(0)
      expect(d.result.stdout).toContain('self-upgrade unavailable')
    }
  })
})

describe('runUpgrade — install orchestration (injected deps, no real npm)', () => {
  it('reports success and the reconnect reminder when npm exits 0', async () => {
    const calls: Array<[string, string]> = []
    const res = await runUpgrade(
      { version: '9.9.9' },
      {
        selfPath: posixGlobal,
        spawnInstall: async (prefix, target) => {
          calls.push([prefix, target])
          return 0
        },
      },
    )
    expect(calls).toEqual([['/Users/x/.local', '9.9.9']])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('sofar upgraded (9.9.9)')
    expect(res.stdout).toContain('Reconnect the sofar MCP server')
  })

  it('surfaces a non-zero npm exit as a failure', async () => {
    const res = await runUpgrade(
      { version: '9.9.9' },
      { selfPath: posixGlobal, spawnInstall: async () => 3 },
    )
    expect(res.exitCode).toBe(3)
    expect(res.stderr).toContain('npm exited 3')
  })

  it('reports a clear error when npm cannot be spawned', async () => {
    const res = await runUpgrade(
      { version: '9.9.9' },
      {
        selfPath: posixGlobal,
        spawnInstall: async () => {
          throw new Error('spawn npm ENOENT')
        },
      },
    )
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('Is npm on your PATH?')
  })

  it('never spawns on a non-global install; prints manual guidance', async () => {
    let spawned = false
    const res = await runUpgrade(
      { version: '9.9.9' },
      {
        selfPath: localDep,
        spawnInstall: async () => {
          spawned = true
          return 0
        },
      },
    )
    expect(spawned).toBe(false)
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('not a global npm install')
  })
})
