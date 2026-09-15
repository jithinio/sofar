import { buildSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * rust-core 1.2 — the black-box conformance harness.
 *
 * Drives an IMPLEMENTATION BINARY (the built TypeScript CLI by default, or
 * whatever `SOFAR_CONFORMANCE_BIN` names) through the hot-path surface that
 * docs/HOTPATH.md inventories — argv, stdin, env, files in, then stdout,
 * stderr, exit code and record bytes out — and compares every byte against a
 * golden recorded from the TypeScript reference. Nothing here imports the
 * engine: an implementation that passes has reproduced the contract from the
 * outside, which is the only sense in which rust-core D1 can be proven.
 *
 * Volatile bytes are MASKED BY SHAPE, never dropped (O6 in
 * docs/HOTPATH.md §Open decisions): a ulid minted during the run becomes `<ULID>` only
 * after its 48-bit time part decodes to the run's own window, an ISO
 * timestamp becomes `<TS>` only when it is newer than the run's start, and
 * the two relative-age labels (`Nm/Nh/Nd ago`, `~Nh since`) become `<AGO>`.
 * A fixture byte is never masked — fixtures are all older than any run — so
 * a wrong id in an unchanged line still fails. Every other source of
 * variance is pinned by construction: HOME, git identity, the peer
 * registry, the update cache, locale and TZ all point into a scratch home
 * the case owns (`childEnv`).
 */

export const here = fileURLToPath(new URL('.', import.meta.url))
export const FIXTURES = join(here, 'fixtures')
export const GOLDEN = join(here, 'golden')
const ENGINE_SRC = join(here, '..', '..', 'src')

/** `SOFAR_CONFORMANCE_RECORD=1` re-records every golden from the TypeScript reference. */
export const RECORD = process.env.SOFAR_CONFORMANCE_RECORD === '1'
/** `SOFAR_CONFORMANCE_BIN="<cmd> [args]"` runs the suite against another implementation. */
export const CANDIDATE = process.env.SOFAR_CONFORMANCE_BIN
/** `SOFAR_CONFORMANCE_KEEP=1` leaves each case's scratch root on disk for inspection. */
export const KEEP = process.env.SOFAR_CONFORMANCE_KEEP === '1'
/** `SOFAR_CONFORMANCE_SKIP=O2,O4` skips cases carrying those tags (see README). */
export const SKIP_TAGS = new Set(
  (process.env.SOFAR_CONFORMANCE_SKIP ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0),
)

export interface Implementation {
  name: string
  /** Full command; the case's argv is appended. */
  command: readonly string[]
}

let scratchRoot: string | null = null
export function scratch(): string {
  if (scratchRoot === null) scratchRoot = mkdtempSync(join(tmpdir(), 'sofar-conformance-'))
  return scratchRoot
}

export function cleanupScratch(): void {
  if (scratchRoot !== null && !KEEP) rmSync(scratchRoot, { recursive: true, force: true })
}

const REQUIRE_SHIM = [
  'import { createRequire as __createRequire } from "node:module";',
  'const require = __createRequire(import.meta.url);',
].join('\n')

let impl: Implementation | null = null

/**
 * The implementation under test. With no candidate named, the TypeScript CLI
 * is built EXACTLY as packages/engine/build.mjs ships it — the boot stub plus
 * the fast and full bundles — so the bytes come from the same dispatch the
 * shims exec, not from an in-process handler call.
 */
export function implementation(): Implementation {
  if (impl !== null) return impl
  if (CANDIDATE !== undefined && CANDIDATE.trim().length > 0) {
    if (RECORD) {
      throw new Error('goldens are recorded from the TypeScript reference only — unset SOFAR_CONFORMANCE_BIN')
    }
    impl = { name: 'candidate', command: CANDIDATE.trim().split(/\s+/) }
    return impl
  }
  const dir = join(scratch(), 'reference')
  mkdirSync(dir, { recursive: true })
  const shared = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    loader: { '.sh': 'text' },
    banner: { js: REQUIRE_SHIM },
    logLevel: 'silent',
  } as const
  buildSync({
    ...shared,
    entryPoints: [join(ENGINE_SRC, 'cli', 'boot.ts')],
    outfile: join(dir, 'cli.js'),
    external: ['./fast.js', './full.js'],
  })
  buildSync({ ...shared, entryPoints: [join(ENGINE_SRC, 'cli', 'fast.ts')], outfile: join(dir, 'fast.js') })
  buildSync({ ...shared, entryPoints: [join(ENGINE_SRC, 'cli', 'index.ts')], outfile: join(dir, 'full.js') })
  impl = { name: 'typescript', command: [process.execPath, join(dir, 'cli.js')] }
  return impl
}

// ---------------------------------------------------------------------------
// Fixtures and materialization.
// ---------------------------------------------------------------------------

export interface GitSpec {
  /** Branch name; null = detached HEAD (a raw sha in HEAD). */
  branch: string | null
  /** Full sha written to refs/heads/<branch>; omitted = no loose ref. */
  head?: string
  /** Full sha written to refs/remotes/origin/<branch>; omitted = never pushed. */
  upstream?: string
  /** Use a worktree-style `.git` FILE pointing at a gitdir elsewhere. */
  worktree?: boolean
}

export interface FixtureSpec {
  /** Directory under fixtures/ holding `dot-sofar/` (copied to `<root>/.sofar`). Omit for a root without a record. */
  record?: string
  /** `.git` layout; omit for a root with no git at all. */
  git?: GitSpec
}

export interface Materialized {
  name: string
  dir: string
  root: string
  home: string
  /** The fixture's `dot-sofar` source, for the record delta; null when the root had no record. */
  fixtureSofar: string | null
  /** Run start (ms): every fixture byte is older, every minted byte is newer. */
  floor: number
}

export const IDENTITY_EMAIL = 'conformance@example.invalid'

/**
 * The newest event timestamp in any fixture, plus the cold-resume gap
 * (docs/HOTPATH.md, session-start: 3,600,000 ms). Two session-start lines
 * exist or not depending on how far the wall clock is past the fixture —
 * the cold-resume advisory and the recent-work labels — so a golden is
 * only stable once every run is past this horizon. Re-snapshotting a real
 * record moves it: bump the constant with the fixture.
 */
export const FIXTURE_HORIZON = Date.parse('2026-09-15T16:11:51.483Z') + 3_600_000

/** A fresh root + home for one case: fixture copied, git and identity pinned. */
export function materialize(name: string, spec: FixtureSpec): Materialized {
  if (Date.now() < FIXTURE_HORIZON) {
    throw new Error(
      `conformance goldens are only stable after ${new Date(FIXTURE_HORIZON).toISOString()} (fixture horizon); the clock says ${new Date().toISOString()}`,
    )
  }
  const dir = join(scratch(), 'cases', name)
  rmSync(dir, { recursive: true, force: true })
  const root = join(dir, 'root')
  const home = join(dir, 'home')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
  mkdirSync(join(home, '.local', 'state'), { recursive: true })
  mkdirSync(join(home, '.config', 'git'), { recursive: true })
  writeFileSync(join(home, '.gitconfig'), `[user]\n\temail = ${IDENTITY_EMAIL}\n\tname = Conformance\n`)

  let fixtureSofar: string | null = null
  if (spec.record !== undefined) {
    fixtureSofar = join(FIXTURES, spec.record, 'dot-sofar')
    if (!existsSync(fixtureSofar)) throw new Error(`fixture missing: ${fixtureSofar}`)
    cpSync(fixtureSofar, join(root, '.sofar'), { recursive: true })
  }
  if (spec.git !== undefined) writeGit(root, dir, spec.git)
  return { name, dir, root, home, fixtureSofar, floor: Date.now() }
}

function writeGit(root: string, dir: string, git: GitSpec): void {
  const gitdir = git.worktree === true ? join(dir, 'gitdir') : join(root, '.git')
  mkdirSync(join(gitdir, 'refs', 'heads'), { recursive: true })
  mkdirSync(join(gitdir, 'refs', 'remotes', 'origin'), { recursive: true })
  const head = git.head ?? 'a'.repeat(40)
  writeFileSync(join(gitdir, 'HEAD'), git.branch === null ? `${head}\n` : `ref: refs/heads/${git.branch}\n`)
  if (git.branch !== null && git.head !== undefined) {
    const ref = join(gitdir, 'refs', 'heads', git.branch)
    mkdirSync(dirname(ref), { recursive: true })
    writeFileSync(ref, `${git.head}\n`)
  }
  if (git.branch !== null && git.upstream !== undefined) {
    const ref = join(gitdir, 'refs', 'remotes', 'origin', git.branch)
    mkdirSync(dirname(ref), { recursive: true })
    writeFileSync(ref, `${git.upstream}\n`)
  }
  // Identity is pinned twice: git may or may not accept this skeleton as a
  // repository, and both answers must resolve to the same email.
  writeFileSync(join(gitdir, 'config'), `[user]\n\temail = ${IDENTITY_EMAIL}\n`)
  if (git.worktree === true) writeFileSync(join(root, '.git'), `gitdir: ${gitdir}\n`)
}

/**
 * The child's environment, built from nothing: only PATH is inherited. Every
 * path the hot path reads outside the root (docs/HOTPATH.md §Environment variables) points
 * into the case's scratch home, so a developer's real ~/.claude, update
 * cache or git identity can never leak into a golden.
 */
export function childEnv(m: Materialized, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: m.home,
    XDG_CONFIG_HOME: join(m.home, '.config'),
    XDG_STATE_HOME: join(m.home, '.local', 'state'),
    CLAUDE_CONFIG_DIR: join(m.home, '.claude'),
    GIT_CONFIG_NOSYSTEM: '1',
    SOFAR_NO_UPDATE_CHECK: '1',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
    ...extra,
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  return env
}

// ---------------------------------------------------------------------------
// Steps.
// ---------------------------------------------------------------------------

export interface Step {
  /** Short label for the golden header. */
  title: string
  /** argv after the binary. `<ROOT>` and `<HOME>` are substituted. */
  argv: readonly string[]
  /** stdin bytes; an object is JSON-encoded. Omitted = empty stdin. */
  stdin?: string | Record<string, unknown>
  /** Extra env; a value of undefined REMOVES a default (e.g. SOFAR_NO_UPDATE_CHECK). */
  env?: Record<string, string | undefined>
  /** Filesystem setup before the step runs (transcripts, nudge files, registries). */
  before?: (m: Materialized) => void
  /** Bytes outside `.sofar` the step is judged on (a commit message file), read after it runs. */
  artifact?: (m: Materialized) => string
}

export interface StepOutcome {
  step: Step
  argv: string[]
  exit: number | null
  signal: string | null
  stdout: string
  stderr: string
  artifact: string | null
}

export function substitute(text: string, m: Materialized): string {
  return text.replaceAll('<ROOT>', m.root).replaceAll('<HOME>', m.home)
}

export function runStep(m: Materialized, step: Step): StepOutcome {
  step.before?.(m)
  const { command } = implementation()
  const argv = step.argv.map((a) => substitute(a, m))
  const input = substitute(
    step.stdin === undefined ? '' : typeof step.stdin === 'string' ? step.stdin : JSON.stringify(step.stdin),
    m,
  )
  const result = spawnSync(command[0]!, [...command.slice(1), ...argv], {
    cwd: m.root,
    input,
    env: childEnv(m, step.env),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error !== undefined) throw result.error
  return {
    step,
    argv,
    exit: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    artifact: step.artifact === undefined ? null : step.artifact(m),
  }
}

// ---------------------------------------------------------------------------
// Masking.
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g
const AGO_RE = /\b\d+[mhd] ago\b/g
const SINCE_RE = /~\d+[hd] since/g
/** Anything minted more than a day after the run started is not this run's. */
const RUN_WINDOW_MS = 24 * 3_600_000

function ulidTime(id: string): number {
  let ms = 0
  for (let i = 0; i < 10; i++) ms = ms * 32 + CROCKFORD.indexOf(id[i]!)
  return ms
}

/** Mask the bytes a run cannot help minting differently each time (see the module doc). */
export function mask(text: string, m: Materialized): string {
  const upper = m.floor + RUN_WINDOW_MS
  return text
    .replaceAll(m.root, '<ROOT>')
    .replaceAll(m.home, '<HOME>')
    .replace(ULID_RE, (id) => {
      const t = ulidTime(id)
      return t >= m.floor && t <= upper ? '<ULID>' : id
    })
    .replace(ISO_RE, (ts) => {
      const t = Date.parse(ts)
      return t >= m.floor && t <= upper ? '<TS>' : ts
    })
    .replace(AGO_RE, '<AGO> ago')
    .replace(SINCE_RE, '~<AGO> since')
}

// ---------------------------------------------------------------------------
// Record delta.
// ---------------------------------------------------------------------------

export interface RecordDelta {
  text: string
  /** Logs whose fixture bytes are no longer a byte-prefix of the file — a contract violation. */
  rewrittenLogs: string[]
}

function listFiles(base: string, sub = ''): string[] {
  const out: string[] = []
  const dir = join(base, sub)
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
    if (entry.isDirectory()) {
      // `.index/` is a derived cache (§Derived index on the hot path): absent or
      // stale it costs a cold start, never a wrong answer, so its bytes are an
      // implementation's own business and stay out of the contract.
      if (rel === '.index') continue
      out.push(...listFiles(base, rel))
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Everything the run changed under `<root>/.sofar`, relative to the fixture:
 * an appended-to file shows its unchanged prefix as a byte count and its
 * tail verbatim; a rewritten file shows in full; added and deleted files
 * are named. Read-only surfaces therefore golden to an EMPTY delta, which
 * is itself the contract (session-start appends nothing).
 */
export function recordDelta(m: Materialized): RecordDelta {
  const after = join(m.root, '.sofar')
  const beforeFiles = m.fixtureSofar === null ? [] : listFiles(m.fixtureSofar)
  const afterFiles = listFiles(after)
  const all = [...new Set([...beforeFiles, ...afterFiles])].sort(compareCodePoints)
  const lines: string[] = []
  const rewrittenLogs: string[] = []
  for (const rel of all) {
    const inBefore = beforeFiles.includes(rel)
    const inAfter = afterFiles.includes(rel)
    const isLog = rel.endsWith('/events.jsonl')
    if (inBefore && !inAfter) {
      lines.push(`=== .sofar/${rel} (deleted)`)
      if (isLog) rewrittenLogs.push(rel)
      continue
    }
    const now = readFileSync(join(after, rel))
    if (!inBefore) {
      lines.push(`=== .sofar/${rel} (added, ${now.length} bytes)`, body(now.toString('utf8'), m))
      continue
    }
    const was = readFileSync(join(m.fixtureSofar!, rel))
    if (was.equals(now)) continue
    if (now.length > was.length && now.subarray(0, was.length).equals(was)) {
      const tail = now.subarray(was.length).toString('utf8')
      lines.push(`=== .sofar/${rel} (appended ${now.length - was.length} bytes after ${was.length} unchanged)`, body(tail, m))
    } else {
      lines.push(`=== .sofar/${rel} (rewritten, ${now.length} bytes)`, body(now.toString('utf8'), m))
      if (isLog) rewrittenLogs.push(rel)
    }
  }
  return { text: lines.join('\n'), rewrittenLogs }
}

/** Content block: masked, with a visible marker when the bytes lack a final newline. */
function body(text: string, m: Materialized): string {
  if (text.length === 0) return '(empty)'
  const masked = mask(text, m)
  return masked.endsWith('\n') ? masked.slice(0, -1) : `${masked}\n<no trailing newline>`
}

// ---------------------------------------------------------------------------
// Golden text.
// ---------------------------------------------------------------------------

export function renderGolden(name: string, m: Materialized, outcomes: readonly StepOutcome[], delta: RecordDelta): string {
  const parts: string[] = [`# conformance golden: ${name}`, '']
  outcomes.forEach((o, i) => {
    parts.push(`## step ${i + 1}: ${o.step.title}`)
    parts.push(`argv: ${JSON.stringify(o.argv.map((a) => mask(a, m)))}`)
    if (o.step.stdin !== undefined) {
      const raw = typeof o.step.stdin === 'string' ? o.step.stdin : JSON.stringify(o.step.stdin)
      parts.push(`stdin: ${raw}`)
    }
    if (o.step.env !== undefined) parts.push(`env: ${JSON.stringify(o.step.env)}`)
    parts.push(`exit: ${o.exit ?? `signal ${o.signal}`}`)
    parts.push('--- stdout', body(o.stdout, m), '--- stderr', body(o.stderr, m))
    if (o.artifact !== null) parts.push('--- artifact', body(o.artifact, m))
    parts.push('')
  })
  parts.push('## record delta', delta.text.length === 0 ? '(no change)' : delta.text, '')
  return parts.join('\n')
}

export function goldenPath(name: string): string {
  return join(GOLDEN, `${name}.txt`)
}

