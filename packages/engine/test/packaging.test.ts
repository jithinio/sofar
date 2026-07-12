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

const scratch = mkdtempSync(join(tmpdir(), 'sofar-packaging-'))
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

/** Run the INSTALLED bin (a symlink to lib/node_modules/sofar/dist/cli.js). */
function sofar(args: string[], opts: { cwd?: string; input?: string } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(prefix, 'bin', 'sofar'), ...args], {
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
  const tarballBase = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
const tarball = join(packDest, tarballBase)

  it('npm pack produces the tarball (prepack rebuilds dist; private only blocks publish, not pack)', () => {
    const packed = npm(['pack', '--pack-destination', packDest], engineDir)
    expect(packed.status).toBe(0)
    expect(packed.stdout).toContain(tarballBase)
    expect(existsSync(tarball)).toBe(true)

    // postpack cleans the prepack README copy — the working tree stays tidy
    expect(existsSync(join(engineDir, 'README.md'))).toBe(false)

    // manifest law: a consumer installs ZERO dependencies (BD7 set is devDeps,
    // bundled into dist/cli.js) — the tarball must not declare any.
    const spec = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(spec.dependencies).toBeUndefined()
  }, 120_000)

  it('the tarball installs into a temp prefix and the installed bin answers --version', () => {
    const installed = npm(['install', '-g', '--prefix', prefix, tarball], scratch)
    expect(installed.status).toBe(0)

    const pkgDir = join(prefix, 'lib', 'node_modules', '@alignlabs', 'sofar')
    expect(existsSync(join(pkgDir, 'dist', 'cli.js'))).toBe(true)
    expect(existsSync(join(prefix, 'bin', 'sofar'))).toBe(true)
    // npm auto-includes README.md (prepack copies the repo-root one in)
    expect(readFileSync(join(pkgDir, 'README.md'), 'utf8')).toContain(
      'Event-sourced initiative memory for coding agents',
    )

    // zero runtime deps landed — the bundled-CLI contract
    const depDirs = existsSync(join(pkgDir, 'node_modules'))
      ? readdirSync(join(pkgDir, 'node_modules')).filter((d) => !d.startsWith('.'))
      : []
    expect(depDirs).toEqual([])

    const version = sofar(['--version'])
    expect(version.status).toBe(0)
    expect(version.stdout.trim()).toBe(manifest.version) // 6.4 single-sourcing, through the channel
  }, 120_000)

  it('the installed sofar drives init → new → status in a fixture repo', () => {
    const root = freshRepo()

    const init = sofar(['init', '--root', root])
    expect(init.status).toBe(0)
    expect(init.stdout).toContain('sofar init: done')

    // record scaffold + shims + registrations + protocol blocks (SPEC §CLI)
    expect(existsSync(join(root, '.sofar', 'repo.md'))).toBe(true)
    expect(existsSync(join(root, '.sofar', 'bindings.json'))).toBe(true)
    for (const shim of ['session-start.sh', 'post-tool-use.sh', 'stop.sh', 'session-end.sh']) {
      const path = join(root, '.claude', 'hooks', shim)
      expect(existsSync(path)).toBe(true)
      expect(statSync(path).mode & 0o777).toBe(0o755)
    }
    expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toContain('"sofar"')
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain('<!-- sofar:protocol -->')
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toContain('<!-- sofar:protocol -->')

    const created = sofar(['new', 'demo', '--goal', 'prove the tarball', '--root', root])
    expect(created.status).toBe(0)

    // projections regenerated (atomically, 6.3) — targets complete, no temp litter
    const initiativeDir = join(root, '.sofar', 'initiatives', 'demo')
    expect(readFileSync(join(initiativeDir, 'plan.md'), 'utf8')).toContain('prove the tarball')
    const litter = readdirSync(initiativeDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.tmp'))
    expect(litter).toEqual([])

    const status = sofar(['status', '--root', root])
    expect(status.status).toBe(0)
    expect(status.stdout).toContain('# demo')
    expect(status.stdout).toContain('Goal: prove the tarball')
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Library surface E2E (library-surface 1.3, L1/L2) — the SAME tarball also
// serves programmatic consumers: subpath exports with self-contained types,
// no side effects on import, and fold/cursor parity with the CLI. Reuses the
// pack + global install from the suite above (vitest runs files in order).
// ---------------------------------------------------------------------------

/** The globally installed package dir — the packed artifact, post-install. */
const installedPkg = join(prefix, 'lib', 'node_modules', '@alignlabs', 'sofar')

/** This repo's own record — the dogfood fixture the acceptance demands. */
const repoRecord = join(here, '..', '..', '..', '.sofar', 'initiatives', 'harness-build', 'events.jsonl')

/** Copy the live record into a hermetic fixture repo (the log may grow under us). */
function recordFixture(): { root: string; log: string } {
  const root = freshRepo()
  const dir = join(root, '.sofar', 'initiatives', 'harness-build')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), '{\n  "main": "harness-build"\n}\n')
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, readFileSync(repoRecord))
  return { root, log }
}

describe('library surface E2E (library-surface 1.3) — subpath exports from the same tarball', () => {
  it('ships the library bundles and a self-contained d.ts tree; bin and manifest law unchanged', () => {
    for (const file of [
      join('dist', 'schema.js'),
      join('dist', 'engine.js'),
      join('dist', 'types', 'engine', 'src', 'lib', 'schema.d.ts'),
      join('dist', 'types', 'engine', 'src', 'lib', 'engine.d.ts'),
      join('dist', 'types', 'schema', 'src', 'events.d.ts'),
    ]) {
      expect(existsSync(join(installedPkg, file)), `${file} missing from installed package`).toBe(true)
    }

    // Self-contained types (L2): the private workspace package's bare name
    // must not appear anywhere in the published declaration tree.
    const dtsDir = join(installedPkg, 'dist', 'types')
    const leaked = readdirSync(dtsDir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.d.ts'))
      .filter((f) => readFileSync(join(dtsDir, f), 'utf8').includes('@sofar/schema'))
    expect(leaked).toEqual([])

    const spec = JSON.parse(readFileSync(join(installedPkg, 'package.json'), 'utf8')) as {
      bin: Record<string, string>
      exports: Record<string, unknown>
      dependencies?: unknown
    }
    expect(spec.bin).toEqual({ sofar: 'dist/cli.js' }) // bin unchanged
    expect(Object.keys(spec.exports)).toEqual(['./schema', './engine', './package.json'])
    expect(spec.dependencies).toBeUndefined() // still zero runtime deps
  })

  it('a fresh ESM project imports both subpaths with no side effects, and the guard tolerates corruption', () => {
    const proj = join(scratch, 'consumer')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n')
    const tarball = join(packDest, tarballName())
    expect(npm(['install', tarball], proj).status).toBe(0)

    // Import both subpaths and exercise guard + fold. Stdout must be EXACTLY
    // the probe's own output — any extra byte means import ran CLI code.
    writeFileSync(
      join(proj, 'probe.mjs'),
      [
        "import { validateEnvelope, makeEvent } from '@alignlabs/sofar/schema'",
        "import { foldLines } from '@alignlabs/sofar/engine'",
        "const bad = validateEnvelope('not an event')",
        "if (bad.ok !== false) throw new Error('guard accepted junk')",
        "const ev = makeEvent({ initiative: 'demo', session: 'cli', source: 'cli', actor: 'human', type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } })",
        'const good = validateEnvelope(ev)',
        "if (!good.ok) throw new Error('guard rejected a minted event')",
        "const { state, warnings } = foldLines([JSON.stringify(ev), '{\"torn', ''])",
        "if (warnings.length !== 1) throw new Error('corrupt line did not warn')",
        "if (state.slug !== 'demo') throw new Error('fold missed the valid line')",
        "console.log('LIBRARY-OK')",
      ].join('\n'),
    )
    const probe = spawnSync(process.execPath, [join(proj, 'probe.mjs')], { encoding: 'utf8', timeout: 30_000 })
    expect(probe.status).toBe(0)
    expect(probe.stdout).toBe('LIBRARY-OK\n') // exactly — no side-effect output
    expect(probe.stderr).toBe('')

    // Types resolve for a TS consumer (bundler-style resolution, strict).
    writeFileSync(
      join(proj, 'probe.ts'),
      [
        "import { validateEnvelope, type EventEnvelope } from '@alignlabs/sofar/schema'",
        "import { foldLines, type InitiativeState } from '@alignlabs/sofar/engine'",
        'const check = validateEnvelope({})',
        'const events: string[] = []',
        'const state: InitiativeState = foldLines(events).state',
        'export function keep(e: EventEnvelope): string {',
        '  return check.ok ? state.slug : e.id',
        '}',
      ].join('\n'),
    )
    writeFileSync(
      join(proj, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            strict: true,
            noEmit: true,
            skipLibCheck: false,
          },
          include: ['probe.ts'],
        },
        null,
        2,
      ),
    )
    const tsc = spawnSync(
      join(engineDir, '..', '..', 'node_modules', '.bin', 'tsc'),
      ['-p', join(proj, 'tsconfig.json')],
      { cwd: proj, encoding: 'utf8', timeout: 60_000 },
    )
    expect(tsc.stdout).toBe('')
    expect(tsc.status).toBe(0)
  }, 120_000)

  it('fold parity: the installed bundle folds this repo\'s own record identically to the source fold', async () => {
    const { foldLines: bundleFold } = (await import(
      join(installedPkg, 'dist', 'engine.js')
    )) as typeof import('../src/lib/engine')
    const { foldLines: sourceFold } = await import('../src/core/fold')

    const lines = readFileSync(repoRecord, 'utf8').split('\n')
    const viaBundle = bundleFold(lines)
    const viaSource = sourceFold(lines)
    expect(viaBundle.state).toEqual(viaSource.state)
    expect(viaBundle.warnings).toEqual(viaSource.warnings)
    expect(viaBundle.state.slug).toBe('harness-build') // the fixture is real
  })

  it('cursor round-trip: exportNDJSON via the library == sofar export --since via the CLI', async () => {
    const { root, log } = recordFixture()
    const { exportNDJSON, readEvents } = (await import(
      join(installedPkg, 'dist', 'engine.js')
    )) as typeof import('../src/lib/engine')

    const events = readEvents(log).events
    expect(events.length).toBeGreaterThan(10)
    const since = events[Math.floor(events.length / 2)]!.id

    const viaLibrary = exportNDJSON(log, since)
    const viaCli = sofar(['export', 'harness-build', '--since', since], { cwd: root })
    expect(viaCli.status).toBe(0)
    expect(viaCli.stdout).toBe(viaLibrary) // byte-identical NDJSON
    expect(viaLibrary.length).toBeGreaterThan(0)
  })
})

/** Tarball filename for the current manifest — shared by both suites. */
function tarballName(): string {
  return `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`
}
