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
  it('the nine cases exist with sidecars and goldens', () => {
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
