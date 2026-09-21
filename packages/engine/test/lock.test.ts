import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { withFileLock } from '../src/core/lock'

/** core/lock.ts (r1-fixes 1.2) — the edges the registration race test cannot reach. */

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'sofar-lock-'))
  dirs.push(d)
  return d
}

describe('withFileLock', () => {
  it('holds the lock for the section, returns its value, and removes the lock', () => {
    const lock = join(scratch(), 'nested', 'a.lock')
    const seen = withFileLock(lock, () => existsSync(lock))
    expect(seen).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })

  it('releases when the section throws', () => {
    const lock = join(scratch(), 'b.lock')
    expect(() =>
      withFileLock(lock, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(lock)).toBe(false)
  })

  it('waits for a live holder, then degrades to unlocked without touching its lock', () => {
    const lock = join(scratch(), 'c.lock')
    writeFileSync(lock, 'someone-else')
    const started = Date.now()
    let ran = false
    withFileLock(
      lock,
      () => {
        ran = true
      },
      { waitMs: 60, staleMs: 60_000 },
    )
    expect(ran).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(50)
    expect(readFileSync(lock, 'utf8')).toBe('someone-else') // never ours to release
  })

  it('breaks a stale lock and takes it', () => {
    const lock = join(scratch(), 'd.lock')
    writeFileSync(lock, 'crashed-holder')
    const old = (Date.now() - 60_000) / 1000
    utimesSync(lock, old, old)
    const started = Date.now()
    const held = withFileLock(lock, () => readFileSync(lock, 'utf8'), { waitMs: 5_000, staleMs: 1_000 })
    expect(held).not.toBe('crashed-holder')
    expect(Date.now() - started).toBeLessThan(1_000) // broken at once, not waited out
    expect(existsSync(lock)).toBe(false)
  })

  it('does not delete a lock someone took after breaking ours as stale', () => {
    const lock = join(scratch(), 'e.lock')
    withFileLock(lock, () => {
      // Our hold overran: another process broke it and now holds its own.
      writeFileSync(lock, 'the-breaker')
    })
    expect(readFileSync(lock, 'utf8')).toBe('the-breaker')
  })

  it('runs unlocked when the lock cannot be created at all', () => {
    const base = scratch()
    writeFileSync(join(base, 'file'), 'x')
    // A lock "inside" a regular file: mkdir fails, so the section runs anyway.
    expect(withFileLock(join(base, 'file', 'f.lock'), () => 42)).toBe(42)
  })
})
