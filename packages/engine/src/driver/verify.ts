import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { TaskVerify, VerificationResult } from '@sofar/schema'
import type { RunState, TaskState, TaskVerification } from '../core/fold'
import { redactCommand } from '../core/redact'
import type { PermissionSurface } from './permissions'

/**
 * The verification gate (r1-fixes 3.1, D19): what `sofar drive` runs before
 * it accepts a task the agent marked done, and how it decides whether a
 * recorded pass still holds.
 *
 * Three facts, each derived rather than trusted:
 *
 *  - WHICH command: the task's own `verify` from the plan, else the run's
 *    `--verify` default. No built-in table (session-driver D8).
 *  - WHETHER it may run: the command runs in the DRIVER's process, with the
 *    operator's permissions, so it runs only when the operator approved it.
 *    `--verify` is that approval. A plan-level command — which an agent can
 *    write — runs only if the run's recorded surface would have let the agent
 *    run it (a `Bash(...)` allow rule that covers it); otherwise the result is
 *    `refused` and nothing executes. Never wider than the launched agent's.
 *  - WHAT it checked: HEAD plus a digest of every tracked change and every
 *    untracked file — the exact tree the command ran on. A pass recorded on a
 *    different tree, or for a different command, is stale and verifies again.
 */

/** Default wall-clock bound on one acceptance command; `--verify-timeout` and `verify.timeout_ms` override it. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000
/** Failed attempts on one task before the run stops; `--max-verify-attempts` overrides it. */
export const DEFAULT_MAX_VERIFY_ATTEMPTS = 3
/** Output kept on the record: the END, since the failing assertion comes last. */
export const DIAGNOSTICS_MAX = 1_024

export interface TreeFingerprint {
  head: string
  tree: string
}

/** One git call, or null when git is missing, the dir is no repo, or the call fails. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** The record is not the code under test: every check appends to it, and a fingerprint that moved with it would invalidate its own pass. */
const RECORD_DIR = '.sofar/'

/** The commit `cwd` is on, or null without a repository (typed-judge 4.1: the progress judge's diff base). */
export function headOf(cwd: string): string | null {
  const head = git(cwd, ['rev-parse', 'HEAD'])?.trim()
  return head === undefined || head.length === 0 ? null : head
}

/**
 * What changed since `head`, outside the record: `git diff --shortstat`
 * against the working tree (so commits and uncommitted edits both count), plus
 * how many untracked files appeared. Empty when nothing changed, null without
 * a repository. The record is excluded for the reason the fingerprint excludes
 * it: every session appends to it, so it says nothing about the work.
 */
export function diffStatSince(cwd: string, head: string): string | null {
  const stat = git(cwd, ['diff', '--shortstat', head, '--', '.', `:(exclude,top)${RECORD_DIR}`])
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (stat === null || untracked === null) return null
  const top = git(cwd, ['rev-parse', '--show-prefix'])?.trim() ?? ''
  const added = untracked.split('\0').filter((p) => p.length > 0 && !`${top}${p}`.startsWith(RECORD_DIR)).length
  return [stat.trim(), added > 0 ? `${added} untracked file${added === 1 ? '' : 's'}` : ''].filter((x) => x.length > 0).join(', ')
}

/**
 * The tree the command runs on. `head` is the commit; `tree` digests the
 * tracked diff against it and every untracked file's blob id, so an edit, a
 * new file and a commit each change it, and a clean checkout of the same
 * commit reproduces it. `.sofar/` is excluded on both sides: the record is
 * what the gate writes to, not what it tests. Null when there is no
 * repository to fingerprint — the gate then refuses to trust any earlier pass
 * and always verifies.
 */
export function fingerprintTree(cwd: string): TreeFingerprint | null {
  const head = git(cwd, ['rev-parse', 'HEAD'])?.trim()
  if (head === undefined || head.length === 0) return null
  const diff = git(cwd, ['diff', 'HEAD', '--', '.', `:(exclude,top)${RECORD_DIR}`])
  if (diff === null) return null
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
  if (untracked === null) return null
  const top = git(cwd, ['rev-parse', '--show-prefix'])?.trim() ?? ''
  const paths = untracked
    .split('\0')
    .filter((p) => p.length > 0 && !`${top}${p}`.startsWith(RECORD_DIR))
    .sort()
  let blobs = ''
  if (paths.length > 0) {
    try {
      blobs = execFileSync('git', ['hash-object', '--stdin-paths'], {
        cwd,
        input: paths.join('\n') + '\n',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      })
    } catch {
      return null
    }
  }
  const digest = createHash('sha256')
  digest.update(diff)
  digest.update('\0untracked\0')
  paths.forEach((p, i) => digest.update(`${p}\0${blobs.split('\n')[i] ?? ''}\0`))
  return { head, tree: digest.digest('hex') }
}

/** Which command applies to a task, and whose approval it carries. */
export interface ResolvedVerify {
  cmd: string
  /** Relative to the launch directory. */
  cwd: string
  timeout_ms: number
  source: 'plan' | 'run'
}

export function resolveVerify(
  task: Pick<TaskState, 'verify'>,
  run: { verify?: string },
  defaultTimeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): ResolvedVerify | undefined {
  if (task.verify !== undefined) {
    return {
      cmd: task.verify.cmd,
      cwd: task.verify.cwd ?? '.',
      timeout_ms: task.verify.timeout_ms ?? defaultTimeoutMs,
      source: 'plan',
    }
  }
  if (run.verify !== undefined) return { cmd: run.verify, cwd: '.', timeout_ms: defaultTimeoutMs, source: 'run' }
  return undefined
}

/**
 * Whether the run's surface would have let the AGENT run this command: a
 * `Bash(<prefix>:*)` rule whose prefix the command starts with (at a word
 * boundary), or a `Bash(<exact>)` rule equal to it. The same shapes Claude
 * Code's own allow rules take, and the only ones a driven session is
 * launched under (permissions.ts) — so a command the agent could not have
 * run is one the driver will not run for it either.
 */
export function commandAllowed(cmd: string, surface: PermissionSurface | undefined): boolean {
  if (surface === undefined) return false
  const command = cmd.trim()
  for (const rule of surface.allow) {
    const m = /^Bash\((.*)\)$/.exec(rule.trim())
    if (m === null) continue
    const body = m[1]!
    if (body.endsWith(':*')) {
      const prefix = body.slice(0, -2).trim()
      if (command === prefix || command.startsWith(`${prefix} `)) return true
    } else if (command === body.trim()) {
      return true
    }
  }
  return false
}

/** A recorded pass still holds: same command, same tree. */
export function verificationCovers(
  v: TaskVerification | undefined,
  cmd: string,
  fingerprint: TreeFingerprint | null,
): boolean {
  if (v === undefined || v.result !== 'pass' || fingerprint === null) return false
  return v.command === cmd && v.checked.head === fingerprint.head && v.checked.tree === fingerprint.tree
}

export interface VerificationOutcome {
  result: VerificationResult
  exit_code?: number
  signal?: string
  duration_ms: number
  diagnostics?: string
}

/**
 * Run the command and say how it ended. Nothing here decides acceptance —
 * the driver records the outcome and reads its own record (session-driver
 * D5). Output is kept only as a bounded, redacted tail.
 */
export function runVerification(cmd: string, cwd: string, timeoutMs: number): VerificationOutcome {
  if (!existsSync(cwd)) {
    return { result: 'error', duration_ms: 0, diagnostics: `verification cwd does not exist: ${cwd}` }
  }
  const t0 = Date.now()
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  })
  const duration_ms = Date.now() - t0
  const diagnostics = tail(`${r.stdout ?? ''}${r.stderr ?? ''}`)
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
  if (timedOut) {
    return { result: 'timeout', ...(r.signal !== null ? { signal: String(r.signal) } : {}), duration_ms, ...(diagnostics !== undefined ? { diagnostics } : {}) }
  }
  if (r.error !== undefined) {
    return { result: 'error', duration_ms, diagnostics: tail(`${diagnostics ?? ''}\n${r.error.message}`) }
  }
  if (r.status === 0) return { result: 'pass', exit_code: 0, duration_ms, ...(diagnostics !== undefined ? { diagnostics } : {}) }
  return {
    result: 'fail',
    ...(r.status !== null ? { exit_code: r.status } : {}),
    ...(r.signal !== null ? { signal: String(r.signal) } : {}),
    duration_ms,
    ...(diagnostics !== undefined ? { diagnostics } : {}),
  }
}

/** ANSI-stripped, redacted, last DIAGNOSTICS_MAX chars; undefined when empty. */
export function tail(text: string): string | undefined {
  const clean = redactCommand(
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\r\n?/g, '\n'),
  ).trim()
  if (clean.length === 0) return undefined
  return clean.length > DIAGNOSTICS_MAX ? `…${clean.slice(-(DIAGNOSTICS_MAX - 1))}` : clean
}

/** The launch-relative cwd a verification records, and the absolute one it runs in. */
export function verifyDirs(launchDir: string, cwd: string): { relative: string; absolute: string } {
  const absolute = isAbsolute(cwd) ? cwd : resolve(launchDir, cwd)
  const rel = relative(launchDir, absolute)
  return { relative: rel.length === 0 ? '.' : rel, absolute }
}

/** How many attempts this run has already recorded for the task. */
export function attemptsSoFar(run: RunState, taskId: string): number {
  return run.verifications.filter((v) => v.task === taskId).length
}

/**
 * How many of those FAILED — what `--max-verify-attempts` bounds ("once one
 * task has failed N times", D19). Not the attempt number: since decision
 * checks (memory-lead D9) record their passes on the same run, a task's
 * attempts outnumber its failures. A refused check never blocked anything, so
 * it is not a failure; a refused acceptance command is, as it always was.
 */
export function failuresSoFar(run: RunState, taskId: string): number {
  return run.verifications.filter(
    (v) => v.task === taskId && v.result !== 'pass' && !(v.decision !== undefined && v.result === 'refused'),
  ).length
}

/** One line for a handoff detail, a task note or a prompt: what ran, how it ended, the last thing it said. */
export function describeVerification(cmd: string, attempt: number, outcome: VerificationOutcome): string {
  const how =
    outcome.result === 'pass'
      ? 'passed'
      : outcome.result === 'refused'
        ? 'refused — not inside the run\'s permission surface (add --allow "Bash(<prefix>:*)" or state --verify)'
        : outcome.result === 'timeout'
          ? `timed out after ${Math.round(outcome.duration_ms / 1000)}s`
          : outcome.result === 'error'
            ? 'could not run'
            : outcome.exit_code !== undefined
              ? `exit ${outcome.exit_code}`
              : outcome.signal !== undefined
                ? `killed by ${outcome.signal}`
                : 'failed'
  const last = outcome.diagnostics
    ?.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop()
  return `verification attempt ${attempt}: \`${cmd}\` ${how}${last !== undefined && outcome.result !== 'pass' ? ` — ${last}` : ''}`
}
