import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildCases, shuffle, type CaseSidecar } from './cases'

/**
 * fold-parity (r1-fixes 5.1, D20–D22) — the ONE shared suite, black-box.
 *
 * Every property here is proved on bytes and a command line, so a second
 * implementation proves the same thing: the runner drives `sofar fold`
 * through `SOFAR_CONFORMANCE_BIN` (default: this repository's built CLI, the
 * reference). Property names and case ids are public API (D21): procurement
 * cites them, and a rename needs a Decision naming old and new.
 *
 *   FOLD_PARITY_RECORD=1  rewrite cases/ and golden/ from cases.ts through the reference
 *   SOFAR_CONFORMANCE_BIN="node target/release/sofar-core"  run a candidate
 *
 * Needs `npm run build` first: the reference is dist/cli.js.
 */

const here = join(__dirname)
const CASES = join(here, 'cases')
const GOLDEN = join(here, 'golden')
const REFERENCE = ['node', join(here, '..', '..', '..', 'dist', 'cli.js')]
const BIN = process.env.SOFAR_CONFORMANCE_BIN !== undefined && process.env.SOFAR_CONFORMANCE_BIN !== ''
  ? process.env.SOFAR_CONFORMANCE_BIN.split(' ').filter((s) => s.length > 0)
  : REFERENCE

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'fold-parity-'))
  scratch.push(d)
  return d
}

interface FoldOut {
  ok: boolean
  reason?: string
  detail?: string
  found?: unknown
  expected?: unknown
  cursor?: string
  version?: { engine: string; schema: string }
  state?: unknown
  warnings?: string[]
  /** The checkpoint pair (rust-core 4.4, 01M39ED9). */
  written?: boolean
  resumed?: boolean
}

function run(bin: readonly string[], args: string[], env: NodeJS.ProcessEnv = process.env): FoldOut {
  const r = spawnSync(bin[0]!, [...bin.slice(1), 'fold', ...args], { encoding: 'utf8', env })
  if (r.status !== 0) throw new Error(`${bin.join(' ')} fold ${args.join(' ')} → exit ${r.status}: ${r.stderr}`)
  return JSON.parse(r.stdout) as FoldOut
}

const golden = (out: FoldOut) => ({ state: out.state, warnings: out.warnings })

// Record mode: the reference writes the files every run reads.
if (process.env.FOLD_PARITY_RECORD === '1') {
  mkdirSync(CASES, { recursive: true })
  mkdirSync(GOLDEN, { recursive: true })
  for (const c of buildCases()) {
    writeFileSync(join(CASES, `${c.id}.jsonl`), `${c.lines.join('\n')}\n`)
    writeFileSync(join(CASES, `${c.id}.json`), `${JSON.stringify(c.sidecar, null, 2)}\n`)
    const out = run(REFERENCE, ['--events', join(CASES, `${c.id}.jsonl`)])
    if (!out.ok) throw new Error(`reference refused ${c.id}: ${out.reason}`)
    writeFileSync(join(GOLDEN, `${c.id}.state.json`), `${JSON.stringify(golden(out), null, 2)}\n`)
  }
}

const caseIds = existsSync(CASES)
  ? readdirSync(CASES)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort()
  : []

describe('fold-parity (D22) — cases are committed and named', () => {
  it('every case exists with a sidecar and a golden', () => {
    expect(caseIds).toEqual(buildCases().map((c) => c.id))
    for (const id of caseIds) {
      expect(existsSync(join(CASES, `${id}.json`)), id).toBe(true)
      expect(existsSync(join(GOLDEN, `${id}.state.json`)), id).toBe(true)
    }
  })

  it('the committed cases are what cases.ts builds (a drift guard for the record mode)', () => {
    for (const c of buildCases()) {
      expect(readFileSync(join(CASES, `${c.id}.jsonl`), 'utf8')).toBe(`${c.lines.join('\n')}\n`)
    }
  })
})

for (const id of caseIds) {
  const file = join(CASES, `${id}.jsonl`)
  const sidecar = JSON.parse(readFileSync(join(CASES, `${id}.json`), 'utf8')) as CaseSidecar
  const expected = JSON.parse(readFileSync(join(GOLDEN, `${id}.state.json`), 'utf8')) as { state: unknown; warnings: string[] }

  it(`fold-parity/snapshot-plus-tail: ${id}`, () => {
    const full = run(BIN, ['--events', file])
    expect(full.ok).toBe(true)
    expect(golden(full)).toEqual(expected)
    const snap = join(tmp(), 'snapshot.json')
    const head = run(BIN, ['--events', file, '--take', String(sidecar.tail_at), '--write-snapshot', snap])
    expect(head.ok).toBe(true)
    expect(head.version).toEqual(full.version)
    const tail = run(BIN, ['--events', file, '--snapshot', snap, '--since', String(sidecar.tail_at)])
    if (sidecar.refusal !== undefined) {
      expect(tail).toMatchObject({ ok: false, reason: sidecar.refusal })
    } else {
      expect(tail.ok).toBe(true)
      expect(golden(tail)).toEqual(expected)
      expect(tail.cursor).toBe(full.cursor)
    }
  })

  // rust-core 4.4, decision 01M39ED9: the edge-free checkpoint path. The head
  // is checkpointed, the whole log resumed from it: the answer is the golden
  // either way, and the fast path is taken exactly when the tail holds
  // nothing it must refuse (the snapshot's refusals are the same events).
  it(`fold-parity/checkpoint-plus-tail: ${id}`, () => {
    const ckpt = join(tmp(), 'checkpoint.json')
    const head = run(BIN, ['--events', file, '--take', String(sidecar.tail_at), '--write-checkpoint', ckpt])
    expect(head.ok).toBe(true)
    const out = run(BIN, ['--events', file, '--checkpoint', ckpt])
    expect(out.ok).toBe(true)
    expect(golden(out)).toEqual(expected)
    expect(out.resumed).toBe(head.written === true && sidecar.refusal === undefined)
  })

  it(`fold-parity/order-independence: ${id}`, () => {
    if (!sidecar.order_independence) return
    const lines = readFileSync(file, 'utf8').split('\n')
    const body = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    for (const seed of sidecar.seeds) {
      const shuffled = join(tmp(), `${id}-${seed}.jsonl`)
      writeFileSync(shuffled, `${shuffle(body, seed).join('\n')}\n`)
      const out = run(BIN, ['--events', shuffled])
      expect(out.ok, `seed ${seed}`).toBe(true)
      expect(out.state, `seed ${seed}`).toEqual(expected.state)
    }
  })
}

// ---------------------------------------------------------------------------
// rust-core 1.6 — union-merge conformance. `sofar init` marks every
// events.jsonl `merge=union` (.gitattributes), so N branches that appended to
// the SAME log merge without a conflict and the merged file is the UNION of
// their lines. The fold is convergent (replay in id order, D-sync-1), so the
// merged log must fold to exactly what the union folds to — which for a case
// split head + tail across branches is the case's own golden state.
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[], home: string): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
      GIT_AUTHOR_NAME: 'fold-parity',
      GIT_AUTHOR_EMAIL: 'fold-parity@example.invalid',
      GIT_COMMITTER_NAME: 'fold-parity',
      GIT_COMMITTER_EMAIL: 'fold-parity@example.invalid',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} → exit ${r.status}: ${r.stderr}`)
  return r.stdout
}

const LOG_REL = (slug: string) => join('.sofar', 'initiatives', slug, 'events.jsonl')

/** A repo whose main holds `base` in each slug's log, with the union attribute in place. */
function repoWith(base: Record<string, string[]>): { root: string; home: string } {
  const dir = tmp()
  const root = join(dir, 'repo')
  const home = join(dir, 'home')
  mkdirSync(root, { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'gitconfig'), '')
  git(root, ['init', '-q', '-b', 'main'], home)
  writeFileSync(join(root, '.gitattributes'), '.sofar/**/events.jsonl merge=union\n')
  for (const [slug, lines] of Object.entries(base)) {
    mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
    writeFileSync(join(root, LOG_REL(slug)), lines.length === 0 ? '' : `${lines.join('\n')}\n`)
  }
  git(root, ['add', '-A'], home)
  git(root, ['commit', '-q', '-m', 'base'], home)
  return { root, home }
}

/** One branch off main appending `lines` to `slug`'s log, committed. */
function branchAppending(repo: { root: string; home: string }, name: string, slug: string, lines: string[]): void {
  git(repo.root, ['checkout', '-q', '-b', name, 'main'], repo.home)
  const log = join(repo.root, LOG_REL(slug))
  writeFileSync(log, `${readFileSync(log, 'utf8')}${lines.join('\n')}\n`)
  git(repo.root, ['add', '-A'], repo.home)
  git(repo.root, ['commit', '-q', '-m', name], repo.home)
  git(repo.root, ['checkout', '-q', 'main'], repo.home)
}

function mergeAll(repo: { root: string; home: string }, names: string[]): void {
  for (const name of names) git(repo.root, ['merge', '-q', '--no-edit', name], repo.home)
}

const bodyOf = (file: string) => {
  const lines = readFileSync(file, 'utf8').split('\n')
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

for (const id of caseIds) {
  const file = join(CASES, `${id}.jsonl`)
  const sidecar = JSON.parse(readFileSync(join(CASES, `${id}.json`), 'utf8')) as CaseSidecar
  const expected = JSON.parse(readFileSync(join(GOLDEN, `${id}.state.json`), 'utf8')) as { state: unknown }

  it(`fold-parity/union-merge: ${id}`, () => {
    if (!sidecar.order_independence) return
    const body = bodyOf(file)
    const head = body.slice(0, sidecar.tail_at)
    const tail = body.slice(sidecar.tail_at)
    // Three writers, the tail dealt round-robin, each on its own branch.
    const writers = 3
    // A short tail leaves a writer with nothing: no branch for it.
    const parts = Array.from({ length: writers }, (_, w) => tail.filter((_, i) => i % writers === w)).filter((p) => p.length > 0)
    const repo = repoWith({ demo: head })
    parts.forEach((lines, w) => branchAppending(repo, `writer-${w}`, 'demo', lines))
    mergeAll(repo, parts.map((_, w) => `writer-${w}`))
    // The merged file IS the union: every line once, none lost, none invented.
    const merged = bodyOf(join(repo.root, LOG_REL('demo')))
    expect([...merged].sort()).toEqual([...body].sort())
    // Its fold is the case's fold — whatever order git's union driver chose.
    const out = run(BIN, ['--events', join(repo.root, LOG_REL('demo'))])
    expect(out.ok).toBe(true)
    expect(out.state).toEqual(expected.state)
  })
}

describe('fold-parity/union-merge across initiatives', () => {
  it('branches that touched different records merge trivially and each folds to its golden', () => {
    const ids = caseIds.filter((id) => (JSON.parse(readFileSync(join(CASES, `${id}.json`), 'utf8')) as CaseSidecar).order_independence).slice(0, 2)
    if (ids.length < 2) return
    const bodies = ids.map((id) => bodyOf(join(CASES, `${id}.jsonl`)))
    const sidecars = ids.map((id) => JSON.parse(readFileSync(join(CASES, `${id}.json`), 'utf8')) as CaseSidecar)
    const repo = repoWith({ x: bodies[0]!.slice(0, sidecars[0]!.tail_at), y: bodies[1]!.slice(0, sidecars[1]!.tail_at) })
    branchAppending(repo, 'on-x', 'x', bodies[0]!.slice(sidecars[0]!.tail_at))
    branchAppending(repo, 'on-y', 'y', bodies[1]!.slice(sidecars[1]!.tail_at))
    // Both branches also append to BOTH records, so the same merge carries a
    // same-file union and a different-file union at once.
    git(repo.root, ['checkout', '-q', 'on-x'], repo.home)
    const yLog = join(repo.root, LOG_REL('y'))
    writeFileSync(yLog, `${readFileSync(yLog, 'utf8')}${bodies[1]!.slice(sidecars[1]!.tail_at, sidecars[1]!.tail_at + 1).join('\n')}\n`)
    git(repo.root, ['add', '-A'], repo.home)
    git(repo.root, ['commit', '-q', '-m', 'on-x touches y'], repo.home)
    git(repo.root, ['checkout', '-q', 'main'], repo.home)
    mergeAll(repo, ['on-x', 'on-y'])
    for (const [i, slug] of ['x', 'y'].entries()) {
      const merged = bodyOf(join(repo.root, LOG_REL(slug)))
      // The line on-x duplicated into y is byte-identical: the union keeps it
      // twice, and the convergent fold's stable sort skips the duplicate.
      expect(new Set(merged)).toEqual(new Set(bodies[i]!))
      const out = run(BIN, ['--events', join(repo.root, LOG_REL(slug))])
      expect(out.ok).toBe(true)
      expect(out.state).toEqual((JSON.parse(readFileSync(join(GOLDEN, `${ids[i]}.state.json`), 'utf8')) as { state: unknown }).state)
    }
  })

  it('merged-log fold time (measurement, never a claim — rust-core D5): the largest case, three writers, five spawns', () => {
    const largest = caseIds.map((id) => ({ id, n: bodyOf(join(CASES, `${id}.jsonl`)).length })).sort((a, b) => b.n - a.n)[0]
    if (largest === undefined) return
    const body = bodyOf(join(CASES, `${largest.id}.jsonl`))
    const repo = repoWith({ demo: body.slice(0, 2) })
    const tail = body.slice(2)
    const parts = [0, 1, 2].map((w) => tail.filter((_, i) => i % 3 === w)).filter((p) => p.length > 0)
    parts.forEach((lines, w) => branchAppending(repo, `writer-${w}`, 'demo', lines))
    mergeAll(repo, parts.map((_, w) => `writer-${w}`))
    const log = join(repo.root, LOG_REL('demo'))
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      run(BIN, ['--events', log])
      samples.push(performance.now() - t0)
    }
    samples.sort((a, b) => a - b)
    // eslint-disable-next-line no-console
    console.log(`fold-parity/union-merge fold time: ${largest.id} (${body.length} lines, 3 writers merged) min ${samples[0]!.toFixed(1)} ms, p50 ${samples[2]!.toFixed(1)} ms via ${BIN.join(' ')}`)
    expect(samples.length).toBe(5)
  })
})

describe('fold-parity sentinels (D22)', () => {
  const first = caseIds[0]

  it('fold-parity/version-mismatch-refolds', () => {
    if (first === undefined) return
    const file = join(CASES, `${first}.jsonl`)
    const dir = tmp()
    const snap = join(dir, 'snapshot.json')
    const head = run(BIN, ['--events', file, '--take', '2', '--write-snapshot', snap])
    expect(head.ok).toBe(true)
    const text = readFileSync(snap, 'utf8')
    const engine = head.version!.engine
    writeFileSync(join(dir, 'engine.json'), text.replace(`"engine":"${engine}"`, '"engine":"0.0.0-other"'))
    const byEngine = run(BIN, ['--events', file, '--snapshot', join(dir, 'engine.json')])
    expect(byEngine).toMatchObject({ ok: false, reason: 'version', found: { engine: '0.0.0-other', schema: head.version!.schema }, expected: head.version })
    writeFileSync(join(dir, 'schema.json'), text.replace(head.version!.schema, '0'.repeat(64)))
    const bySchema = run(BIN, ['--events', file, '--snapshot', join(dir, 'schema.json')])
    expect(bySchema).toMatchObject({ ok: false, reason: 'version', found: { engine, schema: '0'.repeat(64) }, expected: head.version })
    // The refold the refusal asks for is the golden.
    expect(golden(run(BIN, ['--events', file]))).toEqual(JSON.parse(readFileSync(join(GOLDEN, `${first}.state.json`), 'utf8')))
  })

  it('fold-parity/pure-of-clock-and-env', () => {
    if (first === undefined) return
    const file = join(CASES, `${first}.jsonl`)
    const expected = JSON.parse(readFileSync(join(GOLDEN, `${first}.state.json`), 'utf8')) as { state: unknown; warnings: string[] }
    const base: NodeJS.ProcessEnv = { PATH: process.env.PATH }
    const a = run(BIN, ['--events', file], { ...base, TZ: 'Asia/Kolkata', LANG: 'C', LC_ALL: 'C', HOME: tmp() })
    const b = run(BIN, ['--events', file], { ...base, TZ: 'Pacific/Kiritimati', LANG: 'en_US.UTF-8', HOME: tmp() })
    expect(golden(a)).toEqual(expected)
    expect(golden(b)).toEqual(expected)
    expect(a.cursor).toBe(b.cursor)
  })
})
