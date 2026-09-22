import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runFold } from '../../../src/cli/fold'
import { discoverRealLogs } from './discover'

/**
 * The real-log parity gate (rust-core 5.1; engine-core 1.1, 4.1): the
 * candidate's fold deep-equals the TypeScript fold on EVERY real
 * events.jsonl — each worktree's working copy and every branch tip, local
 * and remote-tracking — of every repository named. Deep equality is the
 * canonical JSON `sofar fold` prints (keys sorted recursively), compared as
 * bytes: state, warnings, cursor and snapshot version. Each log is folded
 * whole and at its midpoint (`--take`), so a prefix state is proved too.
 *
 *   SOFAR_CONFORMANCE_BIN=<core>   the candidate (required; skipped without it)
 *   SOFAR_REAL_LOG_ROOTS=<a>:<b>   repositories to read (default: this one)
 *   SOFAR_REAL_LOG_PRIVATE=1       name logs by hash only and report a difference
 *                                  as a line number and JSON key, never a value:
 *                                  for a private repository's logs in any log
 *                                  someone else can read
 *
 * No surface in rust-core 5.2–5.4 switches to the core until this is green.
 * Logs are read, never copied into the repository: sofar-cloud's are
 * private, and its CI step passes its checkout as a root.
 */

const BIN = process.env.SOFAR_CONFORMANCE_BIN
const ROOTS = (process.env.SOFAR_REAL_LOG_ROOTS ?? resolve(__dirname, '..', '..', '..', '..', '..'))
  .split(':')
  .filter((r) => r.length > 0)

const PRIVATE = process.env.SOFAR_REAL_LOG_PRIVATE === '1'

const scratch = mkdtempSync(join(tmpdir(), 'real-log-parity-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function candidate(file: string, take?: number): string {
  const bin = BIN!.split(' ')
  const args = ['fold', '--events', file, ...(take !== undefined ? ['--take', String(take)] : [])]
  const r = spawnSync(bin[0]!, [...bin.slice(1), ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
  if (r.status !== 0) throw new Error(`${BIN} ${args.join(' ')} → exit ${r.status}: ${r.stderr}`)
  return r.stdout
}

function reference(file: string, take?: number): string {
  const r = runFold({ events: file, ...(take !== undefined ? { take: String(take) } : {}) })
  if (r.exitCode !== 0) throw new Error(`sofar fold → exit ${r.exitCode}: ${r.stderr}`)
  return r.stdout
}

/** The first line where two canonical outputs part, for a readable failure. */
function firstDifference(a: string, b: string): string {
  const x = a.split('\n')
  const y = b.split('\n')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (PRIVATE) {
      const key = /^\s*"([^"]+)":/.exec(x[i] ?? '')?.[1] ?? '(array element)'
      return `line ${i + 1} (key ${key})`
    }
    return `line ${i + 1}:\n  typescript: ${x[i] ?? '(end)'}\n  candidate:  ${y[i] ?? '(end)'}`
  }
  return 'identical'
}

describe.skipIf(BIN === undefined)('real-log parity (rust-core 5.1)', () => {
  // Collection runs even for a skipped block, so no git is spawned without a candidate.
  const logs = BIN === undefined ? [] : discoverRealLogs(ROOTS)

  it('found real logs to prove', () => {
    expect(logs.length).toBeGreaterThan(0)
  })

  for (const log of logs) {
    const name = PRIVATE ? log.sha.slice(0, 16) : `${log.slug} ${log.sha.slice(0, 12)}`
    it(`${name} (${log.sources.length} source${log.sources.length === 1 ? '' : 's'})`, () => {
      const file = join(scratch, `${log.sha}.jsonl`)
      writeFileSync(file, log.text)
      const lines = log.text.split('\n').filter((l, i, all) => i < all.length - 1 || l !== '').length
      for (const take of [undefined, Math.floor(lines / 2)]) {
        const want = reference(file, take)
        const got = candidate(file, take)
        if (got !== want) {
          const where = PRIVATE ? log.sha : `${log.slug} (${log.sources.join(', ')})`
          throw new Error(`${where}${take !== undefined ? ` --take ${take}` : ''} differs at ${firstDifference(want, got)}`)
        }
      }
    })
  }
})
