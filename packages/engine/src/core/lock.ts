import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * A cross-process mutex for SHORT check-then-append sections (r1-fixes 1.2).
 *
 * The append itself needs no lock — O_APPEND makes each line atomic
 * (core/log.ts). What it cannot make atomic is a DECISION taken on a read:
 * "is this session registered? no → append session_started". Two processes
 * that read before either appends both decide yes, and Cursor fires hooks in
 * parallel, so that window is the common case there rather than a rare one
 * (12 of 12 concurrent PostToolUse processes registered in the repro).
 *
 * The lock is an exclusive create (`O_CREAT|O_EXCL`), atomic on every local
 * filesystem Node supports, with no dependency and no native flock. Three
 * properties shape it:
 *
 *  - It DEGRADES rather than blocks. A caller that cannot get the lock within
 *    `waitMs` — or cannot create the lock file at all — runs its section
 *    unlocked. Every caller here is on a path that must never fail the
 *    session (BD22), and the worst an unlocked section can do is the duplicate
 *    the fold already tolerates. Liveness beats exclusion.
 *  - A lock is STALE once its file is older than `staleMs`, and is broken. The
 *    sections it guards take milliseconds, so an old lock means its holder
 *    died inside one. Two waiters breaking the same stale lock at the same
 *    instant can both get in; that needs a crash AND an exact tie, and costs
 *    the same tolerated duplicate.
 *  - Release is OWNED: the file carries a random token, and a holder only
 *    unlinks a lock that still carries its own — so a holder that overran
 *    `staleMs` never deletes the lock of whoever broke it.
 *
 * Lock files belong in the self-ignoring derived index (`.sofar/.index/`),
 * never beside a log: a lock left by a crash must not surface in `git status`
 * inside the committed record.
 */

export const LOCK_WAIT_MS = 2_000
export const LOCK_STALE_MS = 10_000

export interface LockOptions {
  waitMs?: number
  staleMs?: number
}

/** Run `section` holding the lock at `lockPath` when it can be had; unlocked otherwise. */
export function withFileLock<T>(lockPath: string, section: () => T, options: LockOptions = {}): T {
  const token = acquire(lockPath, options.waitMs ?? LOCK_WAIT_MS, options.staleMs ?? LOCK_STALE_MS)
  try {
    return section()
  } finally {
    if (token !== null) release(lockPath, token)
  }
}

/** The lock's token when held, null when the caller must proceed unlocked. */
function acquire(lockPath: string, waitMs: number, staleMs: number): string | null {
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch {
    return null
  }
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`
  const deadline = Date.now() + waitMs
  let pause = 1
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, token)
      } finally {
        closeSync(fd)
      }
      return token
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
        unlinkSync(lockPath)
        continue
      }
    } catch {
      continue // released between the create and the stat — try again at once
    }
    if (Date.now() >= deadline) return null
    sleepSync(pause + Math.random() * pause)
    pause = Math.min(pause * 2, 16)
  }
}

function release(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath)
  } catch {
    // already broken as stale, or removed — nothing of ours to release
  }
}

const SLEEPER = new Int32Array(new SharedArrayBuffer(4))

/** A synchronous pause: every caller is synchronous, and a hook has no event loop to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEPER, 0, 0, ms)
}
