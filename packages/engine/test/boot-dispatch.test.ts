import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * rust-core 3.1 — the boot stub's dispatch to a native core, proved with a
 * FAKE core so `npm test` needs no cargo build: a shell script that records
 * its argv, stdin and environment, prints what it was told to print, and
 * exits with the code the test chooses. The real core's bytes are the
 * conformance suite's business (`SOFAR_CORE=target/release/sofar-core npx
 * vitest run conformance`); this file pins the stub's side of the contract:
 *
 * - which argv reach the core (`event`, `statusline`, `status`; nothing else)
 * - `SOFAR_CORE=<path>` names it, `SOFAR_CORE=0` forbids it, a missing
 *   platform package means TypeScript, silently
 * - the core's exit 64 means "TypeScript runs it", with stdin intact and no
 *   extra bytes on either stream; any other exit code is mirrored
 * - the core sees `SOFAR_CORE_DISPATCHED=1`
 * - a named core that cannot run warns once and falls back
 */

const posix = process.platform !== 'win32'
const scratch = mkdtempSync(join(tmpdir(), 'sofar-boot-dispatch-'))
const dist = join(scratch, 'dist')
const home = join(scratch, 'home')
const fake = join(scratch, 'fake-core')
const trace = join(scratch, 'trace.txt')
const src = join(__dirname, '..', 'src', 'cli')

const REQUIRE_SHIM = [
  'import { createRequire as __createRequire } from "node:module";',
  'const require = __createRequire(import.meta.url);',
].join('\n')

beforeAll(() => {
  mkdirSync(dist, { recursive: true })
  mkdirSync(join(home, '.local', 'state'), { recursive: true })
  const shared = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    loader: { '.sh': 'text' },
    banner: { js: REQUIRE_SHIM },
    logLevel: 'silent',
  } as const
  buildSync({ ...shared, entryPoints: [join(src, 'boot.ts')], outfile: join(dist, 'cli.js'), external: ['./fast.js', './full.js'] })
  buildSync({ ...shared, entryPoints: [join(src, 'fast.ts')], outfile: join(dist, 'fast.js') })
  buildSync({ ...shared, entryPoints: [join(src, 'index.ts')], outfile: join(dist, 'full.js') })
  // The fake core: argv, stdin and the dispatch marker to the trace file;
  // FAKE_STDOUT/FAKE_STDERR to the streams; FAKE_EXIT as the exit code.
  writeFileSync(
    fake,
    [
      '#!/bin/sh',
      `printf 'argv=%s\\n' "$*" >> "${trace}"`,
      `printf 'dispatched=%s\\n' "\${SOFAR_CORE_DISPATCHED-unset}" >> "${trace}"`,
      'if [ "${FAKE_READ_STDIN-0}" = "1" ]; then',
      `  printf 'stdin=%s\\n' "$(cat)" >> "${trace}"`,
      'fi',
      '[ -n "${FAKE_STDOUT-}" ] && printf \'%s\\n\' "$FAKE_STDOUT"',
      '[ -n "${FAKE_STDERR-}" ] && printf \'%s\\n\' "$FAKE_STDERR" >&2',
      'exit "${FAKE_EXIT-0}"',
    ].join('\n'),
  )
  chmodSync(fake, 0o755)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function run(argv: string[], env: Record<string, string | undefined>, stdin = '') {
  rmSync(trace, { force: true })
  const result = spawnSync(process.execPath, [join(dist, 'cli.js'), ...argv], {
    cwd: scratch,
    input: stdin,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CONFIG_HOME: join(home, '.config'),
      SOFAR_NO_UPDATE_CHECK: '1',
      TERM: 'dumb',
      ...env,
    },
  })
  return { ...result, trace: existsSync(trace) ? readFileSync(trace, 'utf8') : null }
}

describe.skipIf(!posix)('boot stub → native core dispatch (rust-core 3.1)', () => {
  it('hands a hook to the named core with stdio inherited and mirrors its exit code', () => {
    const r = run(['event', 'stop'], { SOFAR_CORE: fake, FAKE_STDOUT: 'from-core', FAKE_EXIT: '2', FAKE_READ_STDIN: '1' }, '{"session_id":"s"}')
    expect(r.status).toBe(2)
    expect(r.stdout).toBe('from-core\n')
    expect(r.stderr).toBe('')
    expect(r.trace).toBe('argv=event stop\ndispatched=1\nstdin={"session_id":"s"}\n')
  })

  it('hands statusline and status to the core, with their flags verbatim', () => {
    for (const argv of [['statusline', '--no-color'], ['status', '--root', scratch, 'slug', '--color']]) {
      const r = run(argv, { SOFAR_CORE: fake, FAKE_STDOUT: 'ok' })
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('ok\n')
      expect(r.trace).toContain(`argv=${argv.join(' ')}\n`)
    }
  })

  it('never spawns the core for a shape outside event / statusline / status', () => {
    const r = run(['--version'], { SOFAR_CORE: fake, FAKE_STDOUT: 'from-core' })
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('from-core')
    expect(r.trace).toBeNull()
  })

  it('exit 64 from the core means the TypeScript CLI runs it, with nothing leaked', () => {
    // A no-core run is the oracle for what the fallback must reproduce.
    const oracle = run(['event', 'append'], { SOFAR_CORE: '0' })
    const r = run(['event', 'append'], { SOFAR_CORE: fake, FAKE_EXIT: '64' })
    expect(r.trace).toBe('argv=event append\ndispatched=1\n')
    expect(r.status).toBe(oracle.status)
    expect(r.stdout).toBe(oracle.stdout)
    expect(r.stderr).toBe(oracle.stderr)
    expect(oracle.stderr).toContain('--type')
  })

  it('exit 64 leaves stdin whole for the fallback', () => {
    // The fake does not read stdin (FAKE_READ_STDIN unset), as the real core
    // does not before dispatching; the TypeScript statusline then reads it.
    const oracle = run(['statusline', '--no-color'], { SOFAR_CORE: '0' }, '{"model":{"display_name":"Sonnet 5"}}')
    const r = run(['statusline', '--no-color'], { SOFAR_CORE: fake, FAKE_EXIT: '64' }, '{"model":{"display_name":"Sonnet 5"}}')
    expect(oracle.stdout).toContain('Sonnet 5')
    expect(r.stdout).toBe(oracle.stdout)
    expect(r.status).toBe(0)
  })

  it('SOFAR_CORE=0 and an empty SOFAR_CORE mean TypeScript, without a spawn', () => {
    for (const value of ['0', '']) {
      const r = run(['statusline', '--no-color'], { SOFAR_CORE: value, FAKE_STDOUT: 'from-core' }, '{}')
      expect(r.status).toBe(0)
      expect(r.stdout).not.toContain('from-core')
      expect(r.trace).toBeNull()
    }
  })

  it('no override and no platform package: TypeScript, silently', () => {
    const r = run(['statusline', '--no-color'], {}, '{}')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.trace).toBeNull()
  })

  it('a named core that cannot run warns once and falls back', () => {
    const missing = join(scratch, 'no-such-core')
    const r = run(['statusline', '--no-color'], { SOFAR_CORE: missing }, '{}')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe(`sofar: SOFAR_CORE=${missing} could not be run (spawnSync ${missing} ENOENT); using the TypeScript CLI\n`)
    expect(r.trace).toBeNull()
  })

  it('a core killed by a signal is reported, not retried', () => {
    const killer = join(scratch, 'killer-core')
    writeFileSync(killer, '#!/bin/sh\nkill -TERM $$\n')
    chmodSync(killer, 0o755)
    const r = run(['event', 'stop'], { SOFAR_CORE: killer }, '{}')
    expect(r.status).toBe(1)
    expect(r.stderr).toBe('sofar: sofar-core died with SIGTERM\n')
  })
})
