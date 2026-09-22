import { buildSync } from 'esbuild'
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foldLog, latestRun, type InitiativeState } from '../src/core/fold'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { claimRunLock, probeRunLock, type LockPrimitive, type RunLiveness } from '../src/core/run-lock'
import type { StateEnv } from '../src/core/state-dir'
import type { Adapter, AgentSession, SessionExit } from '../src/driver/adapter'
import { drive } from '../src/driver/drive'
import { FakeAdapter } from './helpers/fake-adapter'

/**
 * The run lock (drive-visibility 2.1, D2, D3; SPEC §Driver, "One driver per
 * run"): one run has one driver, told apart from a dead one by a lock the
 * kernel releases — never a pid, a heartbeat or a record event.
 *
 * Every primitive the platform can use is exercised the same way. The Linux
 * one shells out to flock(1); where that binary is absent (macOS) a perl
 * stand-in built on flock(2) takes its place, so its wiring — the handshake,
 * the pipe that ties the lock to the driver — is tested here too, and against
 * the real binary on CI. perl doubles as the Rust/Swift stand-in: its `flock`
 * IS flock(2), which is what `File::try_lock` and Swift's `flock` take.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'sofar-run-lock-'))
const holderBundle = join(scratch, 'holder.mjs')
const cliBundle = join(scratch, 'cli.mjs')
const stub = join(here, 'helpers', 'claude-driven-session.cjs')
const roots: string[] = []

const hasPerl = spawnSync('perl', ['-v']).status === 0
const hasRealFlock = spawnSync('flock', ['--version']).error === undefined
const canSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')

const PRIMITIVES: LockPrimitive[] = [
  ...(process.platform === 'darwin' ? (['exlock'] as const) : []),
  ...((process.platform === 'darwin' || process.platform === 'linux') && (hasRealFlock || hasPerl) ? (['flock1'] as const) : []),
]
/** What `drive()` uses when a test does not pin one. */
const PLATFORM_LOCK = process.platform === 'darwin' || process.platform === 'linux'

const esm = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  loader: { '.sh': 'text' },
} as const

beforeAll(() => {
  buildSync({ ...esm, entryPoints: [join(here, 'helpers', 'run-lock-holder.ts')], outfile: holderBundle })
  buildSync({ ...esm, entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')], outfile: cliBundle })
  chmodSync(stub, 0o755)
  if (!hasRealFlock && hasPerl) {
    // Children inherit PATH, so the holder and the CLI find the stand-in too.
    const bin = join(scratch, 'bin')
    mkdirSync(bin)
    copyFileSync(join(here, 'helpers', 'flock-shim.pl'), join(bin, 'flock'))
    chmodSync(join(bin, 'flock'), 0o755)
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`
  }
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A state base of the test's own, so no two tests share a lock file. */
function stateEnv(): StateEnv {
  return { XDG_STATE_HOME: mkdtempSync(join(scratch, 'state-')) }
}

function lockFile(env: StateEnv, run: string): string {
  return join(env.XDG_STATE_HOME!, 'sofar', 'runs', `${run}.lock`)
}

function plainRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sofar-lock-root-'))
  roots.push(root)
  return root
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** flock(2) from another process, non-blocking: true when it got the lock. */
function flock2(path: string, mode: 'SH' | 'EX'): boolean {
  const script = `use Fcntl qw(:flock); open(F, "<", $ARGV[0]) or exit 3; exit(flock(F, LOCK_${mode} | LOCK_NB) ? 0 : 1)`
  const res = spawnSync('perl', ['-e', script, path])
  if (res.status === 3) throw new Error(`perl could not open ${path}`)
  return res.status === 0
}

/** A process holding flock(2) on `path` until killed (or for `seconds`); resolves once it holds. */
async function flock2Holder(path: string, mode: 'SH' | 'EX', seconds = 30): Promise<ChildProcess> {
  const script = `use Fcntl qw(:flock); $|=1; open(F, "<", $ARGV[0]) or exit 3; flock(F, LOCK_${mode}) or exit 1; print "locked\\n"; select(undef, undef, undef, ${seconds})`
  const child = spawn('perl', ['-e', script, path], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => d.toString().includes('locked') && resolve())
    child.on('exit', (code) => reject(new Error(`perl holder exited ${code}`)))
  })
  return child
}

/** The holder helper as its own process; resolves once it has printed its claim. */
async function holder(
  root: string,
  run: string,
  env: StateEnv,
  primitive?: LockPrimitive,
  wrap: string[] = [],
): Promise<{ child: ChildProcess; said: string }> {
  const argv = [...wrap, process.execPath, holderBundle, root, run, ...(primitive !== undefined ? [primitive] : [])]
  const child = spawn(argv[0]!, argv.slice(1), {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  })
  const said = await new Promise<string>((resolve, reject) => {
    let out = ''
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes('\n')) resolve(out.trim())
    })
    child.on('exit', (code) => reject(new Error(`holder exited ${code}: ${out}`)))
  })
  child.removeAllListeners('exit')
  return { child, said }
}

async function probeUntil(root: string, run: string, want: RunLiveness, opts: { env: StateEnv; primitive?: LockPrimitive }): Promise<void> {
  await until(() => probeRunLock(root, run, opts) === want)
}

describe.each(PRIMITIVES)('the run lock, via %s', (primitive) => {
  it('is held until released, empty, seen held by flock(2), and never unlinked', async () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    const claim = await claimRunLock(root, run, { env, primitive })
    expect(claim.kind).toBe('claimed')
    if (claim.kind !== 'claimed') return
    expect(claim.lock.path).toBe(lockFile(env, run))
    expect(probeRunLock(root, run, { env, primitive })).toBe('held')
    if (hasPerl) {
      // The Rust and Swift primitive sees a Node-taken lock as held.
      expect(flock2(claim.lock.path, 'SH')).toBe(false)
      expect(flock2(claim.lock.path, 'EX')).toBe(false)
    }
    expect(statSync(claim.lock.path).size).toBe(0)

    claim.lock.release()
    claim.lock.release() // idempotent
    await probeUntil(root, run, 'free', { env, primitive })
    if (hasPerl) expect(flock2(claim.lock.path, 'EX')).toBe(true)
    // Released, the file stays: unlinking a lock someone may hold splits it in two.
    expect(existsSync(claim.lock.path)).toBe(true)
    expect(statSync(claim.lock.path).size).toBe(0)
  })

  it('refuses a second claim on a held run once the retry window has passed', async () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    const first = await claimRunLock(root, run, { env, primitive })
    expect(first.kind).toBe('claimed')
    const started = Date.now()
    const second = await claimRunLock(root, run, { env, primitive })
    expect(second.kind).toBe('held')
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
    if (first.kind === 'claimed') first.lock.release()
    await probeUntil(root, run, 'free', { env, primitive })
    const third = await claimRunLock(root, run, { env, primitive })
    expect(third.kind).toBe('claimed')
    if (third.kind === 'claimed') third.lock.release()
  })

  it('reads a run nobody locked as absent — liveness unknown, never gone — and creates nothing', () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    expect(probeRunLock(root, run, { env, primitive })).toBe('absent')
    expect(existsSync(lockFile(env, run))).toBe(false)
  })

  it.skipIf(!hasPerl)('is seen held while flock(2) — the Rust and Swift primitive — holds it', async () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    mkdirSync(join(env.XDG_STATE_HOME!, 'sofar', 'runs'), { recursive: true })
    writeFileSync(lockFile(env, run), '')
    const perl = await flock2Holder(lockFile(env, run), 'EX')
    try {
      expect(probeRunLock(root, run, { env, primitive })).toBe('held')
      expect((await claimRunLock(root, run, { env, primitive })).kind).toBe('held')
    } finally {
      perl.kill('SIGKILL')
    }
    await probeUntil(root, run, 'free', { env, primitive })
  })

  it.skipIf(!hasPerl)('a probe never blocks another probe, and a claim waits out a probe in flight', async () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    mkdirSync(join(env.XDG_STATE_HOME!, 'sofar', 'runs'), { recursive: true })
    writeFileSync(lockFile(env, run), '')
    // A reader mid-probe holds a SHARED lock for an instant; here, for 200ms.
    const reader = await flock2Holder(lockFile(env, run), 'SH', 0.2)
    expect(probeRunLock(root, run, { env, primitive })).toBe('free')
    const claim = await claimRunLock(root, run, { env, primitive })
    expect(claim.kind).toBe('claimed')
    if (claim.kind === 'claimed') claim.lock.release()
    reader.kill('SIGKILL')
  })

  it('is kept through SIGSTOP and released by the kernel on kill -9', async () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    const { child, said } = await holder(root, run, env, primitive)
    expect(said).toBe('claimed')
    try {
      child.kill('SIGSTOP')
      expect(probeRunLock(root, run, { env, primitive })).toBe('held')
      expect((await claimRunLock(root, run, { env, primitive })).kind).toBe('held')
      child.kill('SIGCONT')
    } finally {
      child.kill('SIGKILL')
    }
    await probeUntil(root, run, 'free', { env, primitive })
    const after = await claimRunLock(root, run, { env, primitive })
    expect(after.kind).toBe('claimed')
    if (after.kind === 'claimed') after.lock.release()
  })
})

describe('where the run lock cannot be taken', () => {
  it('refuses a state base inside the repo, and puts nothing there', async () => {
    const root = plainRoot()
    const env = { XDG_STATE_HOME: join(root, 'state') }
    const run = ulid()
    const claim = await claimRunLock(root, run, { env })
    expect(claim.kind).toBe('unavailable')
    if (claim.kind === 'unavailable') expect(claim.why).toContain('resolves inside this repo')
    expect(probeRunLock(root, run, { env })).toBe('absent')
    expect(existsSync(join(root, 'state'))).toBe(false)
  })

  it('takes no lock for a run id that could name a path', async () => {
    const root = plainRoot()
    const claim = await claimRunLock(root, '../escape', { env: stateEnv() })
    expect(claim.kind).toBe('unavailable')
  })

  it('says a platform with no primitive has none, rather than pretending', async () => {
    const root = plainRoot()
    const claim = await claimRunLock(root, ulid(), { env: stateEnv(), primitive: null })
    expect(claim.kind).toBe('unavailable')
    if (claim.kind === 'unavailable') expect(claim.why).toContain('cannot take a flock-semantics lock')
  })
})

// ---------------------------------------------------------------------------
// The driver holding it
// ---------------------------------------------------------------------------

const ONE_PHASE = (tasks: string[]): Record<string, unknown> => ({
  plan: {
    goal: 'g',
    phases: [{ name: 'P1', status: 'active', tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) }],
  },
})

interface Repo {
  root: string
  log: string
  out: string
  logs: string
}

function repo(tasks = ['1.1', '1.2']): Repo {
  const root = mkdtempSync(join(tmpdir(), 'sofar-lock-drive-'))
  roots.push(root)
  const dir = join(root, '.sofar', 'initiatives', 'demo')
  const out = join(root, 'out')
  const logs = join(root, 'logs')
  for (const d of [dir, out, logs]) mkdirSync(d, { recursive: true })
  const log = join(dir, 'events.jsonl')
  writeFileSync(log, '')
  for (const [type, payload] of [
    ['initiative_created', { slug: 'demo', goal: 'g' }],
    ['plan_updated', ONE_PHASE(tasks)],
  ] as const) {
    appendEvent(log, makeEvent({ initiative: 'demo', session: 'cli', type, payload, source: 'cli', actor: 'agent' }))
  }
  return { root, log, out, logs }
}

const fold = (r: Repo): InitiativeState => foldLog(r.log).state

/** A run with no stop, as a driver that died leaves it. */
function openRun(r: Repo): string {
  const run = ulid()
  appendEvent(
    r.log,
    makeEvent({
      initiative: 'demo',
      session: 'cli',
      type: 'run_started',
      payload: { run, adapter: 'fake', policy: 'task', max_sessions: 1 },
      source: 'cli',
      actor: 'human',
    }),
  )
  return run
}

const worker = (r: Repo, id: string) => ({ logPath: r.log, initiative: 'demo', session_id: id, write_back: true, complete: true })

/** An adapter whose one session runs until the test lets it end — a driver caught mid-run. */
class GateAdapter implements Adapter {
  readonly name = 'fake'
  readonly capabilities = { usage: false, nudge: false, model: false, effort: false, permission_rules: true, cost: false }
  private open!: (exit: SessionExit) => void
  private readonly gate = new Promise<SessionExit>((resolve) => (this.open = resolve))
  private signalLaunched!: () => void
  readonly launched = new Promise<void>((resolve) => (this.signalLaunched = resolve))
  end(): void {
    this.open({ code: 0 })
  }
  launch(): AgentSession {
    this.signalLaunched()
    return { usage: () => undefined, kill: () => this.end(), wait: () => this.gate }
  }
}

describe.skipIf(!PLATFORM_LOCK)('one driver per run (drive-visibility 2.1)', () => {
  it('a second driver is refused, fresh or --resume, while the first holds the run — and the lock falls after run_stopped', async () => {
    const r = repo()
    const env = stateEnv()
    const gate = new GateAdapter()
    const first = drive(r.root, 'demo', { adapter: gate, maxSessions: 1, lock: { env } })
    await gate.launched
    const run = latestRun(fold(r))!.id
    expect(probeRunLock(r.root, run, { env })).toBe('held')

    for (const resume of [false, true]) {
      const attempt = drive(r.root, 'demo', { adapter: new FakeAdapter([worker(r, 'X')]), resume, lock: { env } })
      await expect(attempt).rejects.toThrow(`run ${run} on "demo" is being driven right now`)
      await expect(attempt).rejects.toThrow('`sofar status demo`')
      await expect(attempt).rejects.toThrow('`sofar drive demo --stop`')
    }
    // Nothing was recorded by either refusal: one run, never adopted twice.
    expect(fold(r).runs).toHaveLength(1)

    gate.end()
    const outcome = await first
    expect(outcome.stop.reason).toBe('max_sessions')
    expect(latestRun(fold(r))!.stopped).toBeDefined()
    expect(probeRunLock(r.root, run, { env })).toBe('free')
  })

  it("a run whose driver is gone: a fresh start says so and names --resume, and --resume takes it", async () => {
    const r = repo()
    const env = stateEnv()
    const run = openRun(r)
    // The lock a driver took and the kernel released when it died.
    const died = await claimRunLock(r.root, run, { env })
    if (died.kind === 'claimed') died.lock.release()
    expect(probeRunLock(r.root, run, { env })).toBe('free')

    await expect(drive(r.root, 'demo', { adapter: new FakeAdapter([worker(r, 'S1')]), lock: { env } })).rejects.toThrow(
      new RegExp(`run ${run} on "demo" has no stop and its driver is gone .* --resume`),
    )
    const outcome = await drive(r.root, 'demo', { adapter: new FakeAdapter([worker(r, 'S1')]), resume: true, lock: { env } })
    expect(outcome.run).toBe(run)
    expect(probeRunLock(r.root, run, { env })).toBe('free')
  })

  it("a run no lock was ever taken for keeps the record's own words — liveness unknown, never gone", async () => {
    const r = repo()
    const run = openRun(r)
    const attempt = drive(r.root, 'demo', { adapter: new FakeAdapter([worker(r, 'S1')]), lock: { env: stateEnv() } })
    await expect(attempt).rejects.toThrow(`run ${run} on "demo" has no stop — either a driver is still running it or one died mid-run, and the record cannot tell which`)
  })

  it('where the lock cannot be taken, the opening lines say liveness is unavailable and the run proceeds (D9)', async () => {
    const r = repo(['1.1'])
    const lines: string[] = []
    const outcome = await drive(r.root, 'demo', {
      adapter: new FakeAdapter([worker(r, 'S1')]),
      lock: { env: { XDG_STATE_HOME: join(r.root, 'state') } },
      onProgress: (line) => lines.push(line),
    })
    expect(outcome.stop.reason).toBe('closed')
    const warning = lines.find((l) => l.includes('liveness unavailable for this run'))
    expect(warning).toContain('resolves inside this repo')
    expect(warning).toContain('liveness unknown')
    expect(existsSync(join(r.root, 'state'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Real processes, through the built CLI
// ---------------------------------------------------------------------------

function cli(r: Repo, args: string[], env: Record<string, string | undefined>, wrap: string[] = []): SpawnSyncReturns<string> {
  const argv = [...wrap, process.execPath, cliBundle, ...args]
  return spawnSync(argv[0]!, argv.slice(1), {
    cwd: r.root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, TMPDIR: r.logs, STUB_OUT: r.out, ...env },
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!PLATFORM_LOCK)('kill -9 the driver (drive-visibility 2.1)', () => {
  it('frees the lock even while its session lives on; a fresh start says gone, and --resume succeeds', async () => {
    const r = repo(['1.1', '1.2'])
    const env = stateEnv()
    const res = cli(r, ['drive', 'demo', '--detach', '--bin', stub], { ...env, STUB_LINGER: '1' })
    expect(res.status, res.stderr).toBe(0)
    const driverPid = Number(/driver pid (\d+)/.exec(res.stdout)?.[1])
    const run = latestRun(fold(r))!.id
    // The first session has done its work and lingers, so the driver is waiting on it.
    await until(() => fold(r).sessions.some((s) => s.summary !== undefined), 30_000)
    expect(probeRunLock(r.root, run, { env })).toBe('held')

    const whileAlive = cli(r, ['drive', 'demo', '--resume', '--bin', stub], env)
    expect(whileAlive.status).toBe(1)
    expect(whileAlive.stderr).toContain(`run ${run} on "demo" is being driven right now`)

    process.kill(driverPid, 'SIGKILL')
    await probeUntil(r.root, run, 'free', { env })
    // No child inherited the lock: the session the dead driver launched is
    // still running, and the lock is free regardless.
    const sessionPid = Number(readFileSync(join(r.out, readdirSync(r.out).find((f) => f.startsWith('pid-'))!), 'utf8'))
    expect(alive(sessionPid)).toBe(true)
    process.kill(sessionPid, 'SIGKILL')

    const fresh = cli(r, ['drive', 'demo', '--bin', stub], env)
    expect(fresh.status).toBe(1)
    expect(fresh.stderr).toContain('has no stop and its driver is gone')
    expect(fresh.stderr).toContain('--resume')

    const resumed = cli(r, ['drive', 'demo', '--resume', '--bin', stub], env)
    expect(resumed.status, resumed.stderr).toBe(0)
    const ended = latestRun(fold(r))!
    expect(ended.id).toBe(run)
    expect(ended.stop_reason).toBe('closed')
    expect(probeRunLock(r.root, run, { env })).toBe('free')
  })
})

describe.skipIf(!canSandbox)('inside a sandbox (drive-visibility 2.1)', () => {
  it('takes and holds the lock where network is denied — the Seatbelt rule that broke sockets', async () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    const { child, said } = await holder(root, run, env, undefined, ['sandbox-exec', '-p', '(version 1)(allow default)(deny network*)'])
    try {
      expect(said).toBe('claimed')
      expect(probeRunLock(root, run, { env })).toBe('held')
    } finally {
      child.kill('SIGKILL')
    }
    await probeUntil(root, run, 'free', { env })
  })

  it('where the sandbox denies the state base, the run says liveness is unavailable and still runs', () => {
    const r = repo(['1.1'])
    const env = stateEnv()
    const denied = realpathSync(env.XDG_STATE_HOME!)
    const profile = `(version 1)(allow default)(deny file-write* (subpath "${denied}"))`
    const res = cli(r, ['drive', 'demo', '--bin', stub], env, ['sandbox-exec', '-p', profile])
    expect(res.status, res.stderr).toBe(0)
    expect(res.stderr).toContain('liveness unavailable for this run')
    expect(res.stderr).toContain('could not')
    expect(latestRun(fold(r))!.stop_reason).toBe('closed')
  })
})

// Guard against a probe that could only ever say "free": the macOS flags are
// raw numbers, and a wrong one would open without locking anything.
describe.skipIf(process.platform !== 'darwin')('the macOS lock flags', () => {
  it('O_EXLOCK really excludes: a second exclusive open of a held file would block', async () => {
    const root = plainRoot()
    const env = stateEnv()
    const run = ulid()
    const claim = await claimRunLock(root, run, { env, primitive: 'exlock' })
    expect(claim.kind).toBe('claimed')
    if (claim.kind !== 'claimed') return
    let code: string | undefined
    try {
      closeSync(openSync(claim.lock.path, constants.O_RDONLY | 0x20 | constants.O_NONBLOCK))
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code
    }
    expect(code).toBe('EAGAIN')
    claim.lock.release()
  })
})
