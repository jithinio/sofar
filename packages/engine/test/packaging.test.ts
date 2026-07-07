import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * Task 6.2 (BD41) — the distribution channel is npm (BD1), so the tarball
 * IS the product boundary: `npm pack` on packages/engine must produce an
 * artifact that installs anywhere with ZERO runtime dependencies (dist/cli.js
 * is fully esbuild-bundled; every manifest dep is a devDependency).
 *
 * This suite runs the REAL channel end to end:
 *   npm pack (prepack → fresh build) → npm install -g --prefix <tmp> the
 *   tarball → execute the INSTALLED bin: --version, init on a fixture repo,
 *   new + status — asserting artifacts at each step.
 *
 * Deliberately slow (~10-30s): it guards the install path no unit test can.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const engineDir = join(here, '..')
const manifest = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8')) as {
  name: string
  version: string
}

const scratch = mkdtempSync(join(tmpdir(), 'harness-packaging-'))
const packDest = join(scratch, 'tarballs')
const prefix = join(scratch, 'prefix') // npm -g install target
mkdirSync(packDest, { recursive: true })
mkdirSync(prefix, { recursive: true })

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** npm inherits npm_config_* from the running `npm test` — strip them so the
 * child npm behaves like a user's shell, not our workspace script. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toLowerCase().startsWith('npm_')) env[key] = value
  }
  return env
}

function npm(args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync('npm', [...args, '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout: 120_000,
  })
}

/** Run the INSTALLED bin (a symlink to lib/node_modules/harness/dist/cli.js). */
function harness(args: string[], opts: { cwd?: string; input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(prefix, 'bin', 'harness'), ...args], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    encoding: 'utf8',
    timeout: 30_000,
  })
}

/** Fixture repo: .git/HEAD on main — what a user's repo looks like to init. */
function freshRepo(): string {
  const root = join(scratch, `repo-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

describe('packaging E2E (6.2, BD41) — npm pack → global install → installed bin works', () => {
  const tarball = join(packDest, `${manifest.name}-${manifest.version}.tgz`)

  it('npm pack produces the tarball (prepack rebuilds dist; private only blocks publish, not pack)', () => {
    const packed = npm(['pack', '--pack-destination', packDest], engineDir)
    expect(packed.status).toBe(0)
    expect(packed.stdout.trim().split('\n').at(-1)).toBe(`${manifest.name}-${manifest.version}.tgz`)
    expect(existsSync(tarball)).toBe(true)

    // manifest law: a consumer installs ZERO dependencies (BD7 set is devDeps,
    // bundled into dist/cli.js) — the tarball must not declare any.
    const spec = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(spec.dependencies).toBeUndefined()
  }, 120_000)

  it('the tarball installs into a temp prefix and the installed bin answers --version', () => {
    const installed = npm(['install', '-g', '--prefix', prefix, tarball], scratch)
    expect(installed.status).toBe(0)

    const pkgDir = join(prefix, 'lib', 'node_modules', 'harness')
    expect(existsSync(join(pkgDir, 'dist', 'cli.js'))).toBe(true)
    expect(existsSync(join(prefix, 'bin', 'harness'))).toBe(true)

    // zero runtime deps landed — the bundled-CLI contract
    const depDirs = existsSync(join(pkgDir, 'node_modules'))
      ? readdirSync(join(pkgDir, 'node_modules')).filter((d) => !d.startsWith('.'))
      : []
    expect(depDirs).toEqual([])

    const version = harness(['--version'])
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe(manifest.version) // 6.4 single-sourcing, through the channel
  }, 120_000)

  it('the installed harness drives init → new → status in a fixture repo', () => {
    const root = freshRepo()

    const init = harness(['init', '--root', root])
    expect(init.status).toBe(0)
    expect(init.stdout).toContain('harness init: done')

    // record scaffold + shims + registrations + protocol blocks (SPEC §CLI)
    expect(existsSync(join(root, '.harness', 'repo.md'))).toBe(true)
    expect(existsSync(join(root, '.harness', 'bindings.json'))).toBe(true)
    for (const shim of ['session-start.sh', 'post-tool-use.sh', 'stop.sh', 'session-end.sh']) {
      const path = join(root, '.claude', 'hooks', shim)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o777).toBe(0o755)
    }
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toContain('"harness"')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('<!-- harness:protocol -->')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('<!-- harness:protocol -->')

    const created = harness(['new', 'demo', '--goal', 'prove the tarball', '--root', root])
    expect(created.status).toBe(0)

    // projections regenerated (atomically, 6.3) — targets complete, no temp litter
    const initiativeDir = join(root, '.harness', 'initiatives', 'demo')
    expect(readFileSync(join(initiativeDir, 'plan.md'), 'utf8')).toContain('prove the tarball')
    const litter = readdirSync(initiativeDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.tmp'))
    expect(litter).toEqual([])

    const status = harness(['status', '--root', root])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('# demo')
    expect(status.stdout).toContain('Goal: prove the tarball')
  }, 60_000)
})
