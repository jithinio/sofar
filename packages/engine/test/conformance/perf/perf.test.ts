import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { foldLog } from '../../../src/core/fold'
import { renderStatus } from '../../../src/projections/templates/status'
import { CANDIDATE, FIXTURES, KEEP, childEnv, cleanupScratch, here, implementation, materialize, type Materialized } from '../harness'
import { BOUND_SLUG, SCALE_CELLS, writeScale, type ScaleCell } from './scale'

/**
 * rust-core 1.3 — the perf baseline harness.
 *
 * Measures the hot path the way the user pays for it: one process per hook
 * invocation, spawned exactly as the shims spawn it, wall clock from spawn
 * to exit. Every number is a black-box measurement of an IMPLEMENTATION
 * BINARY (the built TypeScript CLI by default, `SOFAR_CONFORMANCE_BIN` for a
 * candidate), so the same runner that records the TypeScript target later
 * measures the Rust core against it. The scale axes are the ones the task
 * names: 10 / 100 / 1,000 initiatives in the `.sofar/`, and a bound log of
 * 1 MB and 10 MB, plus this repository's real record and a boot floor.
 *
 * Per cell and command: `iterations` sequential spawns, p50 / p95 by
 * nearest rank, plus the minimum. The index (`.sofar/.index/`) is primed
 * before the timed loop so hooks measure their steady state; `session-start
 * (index cold)` deletes it before every spawn, which is the first-hook cost
 * of a fresh clone or an upgraded engine.
 *
 *   SOFAR_PERF=1                  run at all (skipped otherwise: minutes, not seconds)
 *   SOFAR_PERF_ITER=<n>           spawns per measurement (default 20)
 *   SOFAR_PERF_RECORD=1           write baseline.typescript.json (TypeScript reference only)
 *   SOFAR_PERF_GATE=1             fail unless every candidate p50 and p95 ≤ the recorded target
 *   SOFAR_PERF_CELLS=i10-1mb,repo run a subset of cells
 *   SOFAR_CONFORMANCE_BIN=…       measure another implementation
 *
 * The in-process section (fold and digest render called directly) runs for
 * the TypeScript reference only: it separates the engine's own work from
 * node's boot, which is what a native core removes.
 */

const PERF = process.env.SOFAR_PERF === '1'
const ITER = Math.max(3, Number.parseInt(process.env.SOFAR_PERF_ITER ?? '20', 10) || 20)
const RECORD = process.env.SOFAR_PERF_RECORD === '1'
const GATE = process.env.SOFAR_PERF_GATE === '1'
const ONLY = new Set((process.env.SOFAR_PERF_CELLS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0))

export const BASELINE_PATH = join(here, 'perf', 'baseline.typescript.json')

// ---------------------------------------------------------------------------
// Statistics.
// ---------------------------------------------------------------------------

export interface Stat {
  n: number
  min: number
  p50: number
  p95: number
}

/** Nearest-rank percentile over sorted samples. */
function percentile(sorted: readonly number[], q: number): number {
  const rank = Math.max(1, Math.ceil(q * sorted.length))
  return sorted[rank - 1]!
}

export function stat(samples: readonly number[]): Stat {
  const sorted = [...samples].sort((a, b) => a - b)
  return { n: sorted.length, min: round(sorted[0]!), p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)) }
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100
}

// ---------------------------------------------------------------------------
// Cells.
// ---------------------------------------------------------------------------

interface Cell {
  name: string
  /** What the cell holds, for the report. */
  initiatives: number
  boundBytes: number
  totalBytes: number
  boundLines: number
  slug: string
  m: Materialized
}

interface Measure {
  name: string
  argv: string[]
  stdin: (i: number) => string | Record<string, unknown> | undefined
  expectedExit: number
  /** Run before EVERY spawn, outside the timed window. */
  before?: (cell: Cell) => void
}

interface CellResult {
  name: string
  recordedAt: string
  initiatives: number
  boundBytes: number
  boundLines: number
  totalBytes: number
  measures: Record<string, Stat>
}

interface InProcessResult {
  name: string
  fold: Stat
  render: Stat
}

interface PerfReport {
  implementation: string
  command: string[]
  recordedAt: string
  iterations: number
  machine: { cpu: string; cores: number; node: string; platform: string; release: string }
  commit: string | null
  /** Bare `node -e 0` spawn, for reference: the floor no JavaScript implementation can go below. */
  nodeSpawnMs: Stat
  cells: CellResult[]
  inProcess?: InProcessResult[]
}

const OPEN_SESSION = 'perf-open'
const closable = (i: number) => `perf-closable-${i}`

function hook(cell: Cell, name: string, sessionId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    session_id: sessionId,
    transcript_path: join(cell.m.root, 'transcript.jsonl'),
    cwd: cell.m.root,
    hook_event_name: name,
    ...fields,
  }
}

const edit = (cell: Cell, sessionId: string, path: string) =>
  hook(cell, 'PostToolUse', sessionId, {
    tool_name: 'Edit',
    tool_input: { file_path: join(cell.m.root, path), old_string: 'a', new_string: 'b' },
    tool_response: {},
  })

function statuslineInput(cell: Cell): Record<string, unknown> {
  return {
    hook_event_name: 'Status',
    session_id: OPEN_SESSION,
    transcript_path: join(cell.m.root, 'transcript.jsonl'),
    cwd: cell.m.root,
    model: { id: 'claude-fable-5-1', display_name: 'Fable 5.1 (1M context)' },
    workspace: { current_dir: cell.m.root, project_dir: cell.m.root },
    version: '2.1.0',
    context_window: {
      used_percentage: 42.4,
      current_usage: { input_tokens: 1_200, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 40_000 },
    },
  }
}

const dropIndex = (cell: Cell) => rmSync(join(cell.m.root, '.sofar', '.index'), { recursive: true, force: true })

/** The matrix every record cell is measured on. */
function measures(cell: Cell): Measure[] {
  return [
    {
      name: 'session-start (index warm)',
      argv: ['event', 'session-start'],
      stdin: (i) => hook(cell, 'SessionStart', `perf-start-${i}`, { source: 'startup' }),
      expectedExit: 0,
    },
    {
      name: 'session-start (index cold)',
      argv: ['event', 'session-start'],
      stdin: (i) => hook(cell, 'SessionStart', `perf-cold-${i}`, { source: 'startup' }),
      expectedExit: 0,
      before: dropIndex,
    },
    {
      name: 'post-tool Edit',
      argv: ['event', 'post-tool'],
      stdin: (i) => edit(cell, OPEN_SESSION, `src/perf/edit-${i}.ts`),
      expectedExit: 0,
    },
    {
      name: 'user-prompt (nudge)',
      argv: ['event', 'user-prompt'],
      stdin: () => hook(cell, 'UserPromptSubmit', OPEN_SESSION, { prompt: 'continue' }),
      expectedExit: 0,
    },
    {
      name: 'stop (blocked)',
      argv: ['event', 'stop'],
      stdin: () => hook(cell, 'Stop', OPEN_SESSION, { stop_hook_active: false }),
      expectedExit: 2,
    },
    {
      name: 'session-end',
      argv: ['event', 'session-end'],
      stdin: (i) => hook(cell, 'SessionEnd', closable(i), { reason: 'exit' }),
      expectedExit: 0,
    },
    {
      name: 'statusline',
      argv: ['statusline'],
      stdin: () => statuslineInput(cell),
      expectedExit: 0,
    },
    {
      name: 'status <slug> (full CLI, plain)',
      argv: ['status', cell.slug],
      stdin: () => undefined,
      expectedExit: 0,
    },
  ]
}

// ---------------------------------------------------------------------------
// Spawning.
// ---------------------------------------------------------------------------

function spawnTimed(cell: Cell, argv: readonly string[], stdin: string | Record<string, unknown> | undefined): { ms: number; exit: number | null; stderr: string } {
  const { command } = implementation()
  const input = stdin === undefined ? '' : typeof stdin === 'string' ? stdin : JSON.stringify(stdin)
  const env = childEnv(cell.m)
  const startedAt = performance.now()
  const result = spawnSync(command[0]!, [...command.slice(1), ...argv], {
    cwd: cell.m.root,
    input,
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const ms = performance.now() - startedAt
  if (result.error !== undefined) throw result.error
  return { ms, exit: result.status, stderr: result.stderr }
}

function measure(cell: Cell, m: Measure): Stat {
  const samples: number[] = []
  for (let i = 0; i < ITER; i++) {
    m.before?.(cell)
    const { ms, exit, stderr } = spawnTimed(cell, m.argv, m.stdin(i))
    expect(exit, `${cell.name} / ${m.name} run ${i}: exit ${exit}\n${stderr}`).toBe(m.expectedExit)
    samples.push(ms)
  }
  return stat(samples)
}

/**
 * Register the sessions the matrix needs, through the binary itself so the
 * cell stays implementation-agnostic: the open session drifts five edits
 * past any write-back (nudge + block fire), and one closable session per
 * iteration exists for session-end to close. Also primes the index.
 */
function prepare(cell: Cell): void {
  for (let i = 0; i < 5; i++) {
    const r = spawnTimed(cell, ['event', 'post-tool'], edit(cell, OPEN_SESSION, `src/perf/drift-${i}.ts`))
    expect(r.exit, r.stderr).toBe(0)
  }
  for (let i = 0; i < ITER; i++) {
    const r = spawnTimed(cell, ['event', 'post-tool'], edit(cell, closable(i), `src/perf/closable-${i}.ts`))
    expect(r.exit, r.stderr).toBe(0)
  }
  writeFileSync(join(cell.m.root, 'transcript.jsonl'), `${'{"type":"assistant","text":"padding"}\n'.repeat(50)}`)
  // Prime: one of each read path so the index tiers exist before timing.
  spawnTimed(cell, ['event', 'session-start'], hook(cell, 'SessionStart', 'perf-prime', { source: 'startup' }))
  spawnTimed(cell, ['event', 'user-prompt'], hook(cell, 'UserPromptSubmit', OPEN_SESSION, { prompt: 'prime' }))
}

/** A real git repository with one commit: the shipping notice and identity read what a developer's clone has. */
function gitInit(m: Materialized, branch: string): void {
  const env = childEnv(m, { GIT_AUTHOR_DATE: '2026-09-01T10:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T10:00:00Z' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: m.root, env, stdio: ['ignore', 'ignore', 'pipe'] })
  git('init', '-q', '-b', branch)
  writeFileSync(join(m.root, 'README.md'), '# perf cell\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'perf cell root', '--no-gpg-sign')
}

function scaleCell(spec: ScaleCell): Cell {
  const m = materialize(`perf.${spec.name}`, {})
  const sizes = writeScale(m.root, spec)
  gitInit(m, 'main')
  return { name: spec.name, initiatives: spec.initiatives, slug: BOUND_SLUG, m, ...sizes }
}

/** This repository's own record (the 1.2 fixture) on `main`, bound to session-driver (0.6 MB, its second-largest log). */
function repoCell(): Cell {
  const m = materialize('perf.repo', { record: 'records/repo' })
  gitInit(m, 'main')
  const dir = join(FIXTURES, 'records', 'repo', 'dot-sofar', 'initiatives')
  const slug = 'session-driver'
  const bound = readFileSync(join(dir, slug, 'events.jsonl'))
  let totalBytes = 0
  let initiatives = 0
  for (const entry of readdirSync(dir)) {
    const log = join(dir, entry, 'events.jsonl')
    if (!existsSync(log)) continue
    totalBytes += readFileSync(log).length
    initiatives++
  }
  return {
    name: 'repo',
    initiatives,
    boundBytes: bound.length,
    boundLines: bound.toString('utf8').split('\n').length - 1,
    totalBytes,
    slug,
    m,
  }
}

/** A root with no record and no git: parse stdin, find nothing, print the unbound notice. */
function floorCell(): Cell {
  const m = materialize('perf.floor', {})
  return { name: 'floor (no record)', initiatives: 0, boundBytes: 0, boundLines: 0, totalBytes: 0, slug: '', m }
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

function machine(): PerfReport['machine'] {
  const [cpu] = cpus()
  return { cpu: cpu?.model ?? 'unknown', cores: cpus().length, node: process.version, platform: platform(), release: release() }
}

function commitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function nodeSpawn(): Stat {
  const samples: number[] = []
  for (let i = 0; i < ITER; i++) {
    const t = performance.now()
    spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' })
    samples.push(performance.now() - t)
  }
  return stat(samples)
}

function fmt(ms: number): string {
  return ms.toFixed(1)
}

function table(report: PerfReport, baseline: PerfReport | null): string {
  const lines: string[] = []
  lines.push(
    `perf baseline — ${report.implementation} (${report.command.join(' ')}) · ${report.iterations} spawns per cell · ${report.machine.cpu}, node ${report.machine.node}`,
    `node spawn floor: p50 ${fmt(report.nodeSpawnMs.p50)} ms · p95 ${fmt(report.nodeSpawnMs.p95)} ms`,
    '',
  )
  for (const cell of report.cells) {
    const base = baseline?.cells.find((c) => c.name === cell.name)
    lines.push(
      cell.initiatives === 0
        ? `## ${cell.name} — a root with no record`
        : `## ${cell.name} — ${cell.initiatives} initiatives, bound log ${(cell.boundBytes / 1e6).toFixed(1)} MB (${cell.boundLines} lines), ${(cell.totalBytes / 1e6).toFixed(1)} MB total`,
    )
    lines.push(base ? '| command | p50 ms | p95 ms | min ms | vs target p50 | vs target p95 |' : '| command | p50 ms | p95 ms | min ms |')
    lines.push(base ? '| --- | ---: | ---: | ---: | ---: | ---: |' : '| --- | ---: | ---: | ---: |')
    for (const [name, s] of Object.entries(cell.measures)) {
      const b = base?.measures[name]
      const cmp = b ? ` ${ratio(s.p50, b.p50)} | ${ratio(s.p95, b.p95)} |` : ''
      lines.push(`| ${name} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.min)} |${cmp}`)
    }
    lines.push('')
  }
  if (report.inProcess !== undefined) {
    lines.push('## in-process (TypeScript reference only): fold of the bound log, digest render of the folded state')
    lines.push('| cell | fold p50 ms | fold p95 ms | render p50 ms | render p95 ms |', '| --- | ---: | ---: | ---: | ---: |')
    for (const r of report.inProcess) lines.push(`| ${r.name} | ${fmt(r.fold.p50)} | ${fmt(r.fold.p95)} | ${fmt(r.render.p50)} | ${fmt(r.render.p95)} |`)
    lines.push('')
  }
  return lines.join('\n')
}

function ratio(now: number, target: number): string {
  return target === 0 ? 'n/a' : `${(now / target).toFixed(2)}×`
}

function merge(previous: PerfReport | null, now: PerfReport): PerfReport {
  if (previous === null) return now
  const cells = previous.cells.map((c) => now.cells.find((n) => n.name === c.name) ?? c)
  for (const n of now.cells) if (!cells.some((c) => c.name === n.name)) cells.push(n)
  const inProcess = (previous.inProcess ?? []).map((c) => now.inProcess?.find((n) => n.name === c.name) ?? c)
  for (const n of now.inProcess ?? []) if (!inProcess.some((c) => c.name === n.name)) inProcess.push(n)
  return { ...now, cells, ...(inProcess.length > 0 ? { inProcess } : {}) }
}

function readBaseline(): PerfReport | null {
  return existsSync(BASELINE_PATH) ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as PerfReport) : null
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

function selected<T extends { name: string }>(cells: readonly T[]): T[] {
  return ONLY.size === 0 ? [...cells] : cells.filter((c) => ONLY.has(c.name))
}

describe.skipIf(!PERF)('perf baseline (rust-core 1.3)', () => {
  const report: PerfReport = {
    implementation: '',
    command: [],
    recordedAt: '',
    iterations: ITER,
    machine: machine(),
    commit: commitSha(),
    nodeSpawnMs: stat([0]),
    cells: [],
  }
  const cells: Cell[] = []

  beforeAll(() => {
    if (RECORD && CANDIDATE !== undefined) throw new Error('the baseline is recorded from the TypeScript reference only — unset SOFAR_CONFORMANCE_BIN')
    const impl = implementation()
    report.implementation = impl.name
    // The reference is built into a scratch dir whose path means nothing later.
    report.command = impl.name === 'typescript' ? ['node', 'dist/cli.js (built from source as build.mjs ships it)'] : [...impl.command]
    report.recordedAt = new Date().toISOString()
    report.nodeSpawnMs = nodeSpawn()
  })

  afterAll(() => {
    const baseline = CANDIDATE === undefined ? null : readBaseline()
    const text = table(report, baseline)
    // eslint-disable-next-line no-console
    console.log(`\n${text}`)
    const out = RECORD ? BASELINE_PATH : join(tmpdir(), `sofar-perf.${report.implementation}.json`)
    // A partial record (SOFAR_PERF_CELLS) replaces only the cells it measured.
    const written = RECORD && ONLY.size > 0 ? merge(readBaseline(), report) : report
    writeFileSync(out, `${JSON.stringify(written, null, 2)}\n`)
    writeFileSync(out.replace(/\.json$/, '.md'), `${table(written, baseline)}\n`)
    // eslint-disable-next-line no-console
    console.log(`written: ${out}`)
    if (!KEEP) cleanupScratch()
  })

  for (const spec of selected([...SCALE_CELLS.map((c) => ({ name: c.name, build: () => scaleCell(c) })), { name: 'repo', build: repoCell }])) {
    it(`${spec.name}: every hook, statusline and status`, () => {
      const cell = spec.build()
      cells.push(cell)
      prepare(cell)
      const result: CellResult = {
        name: cell.name,
        recordedAt: new Date().toISOString(),
        initiatives: cell.initiatives,
        boundBytes: cell.boundBytes,
        boundLines: cell.boundLines,
        totalBytes: cell.totalBytes,
        measures: {},
      }
      for (const m of measures(cell)) result.measures[m.name] = measure(cell, m)
      report.cells.push(result)
      if (CANDIDATE === undefined) {
        // In-process, reference only: the engine's own work, no boot.
        const log = join(cell.m.root, '.sofar', 'initiatives', cell.slug, 'events.jsonl')
        const fold: number[] = []
        const render: number[] = []
        for (let i = 0; i < ITER; i++) {
          const t0 = performance.now()
          const { state } = foldLog(log)
          const t1 = performance.now()
          renderStatus(state, { sessionId: 'perf-in-process', repoMemory: readFileSync(join(cell.m.root, '.sofar', 'repo.md'), 'utf8') })
          const t2 = performance.now()
          fold.push(t1 - t0)
          render.push(t2 - t1)
        }
        report.inProcess ??= []
        report.inProcess.push({ name: cell.name, fold: stat(fold), render: stat(render) })
      }
      if (!KEEP) rmSync(cell.m.dir, { recursive: true, force: true })
    })
  }

  if (ONLY.size === 0 || ONLY.has('floor')) {
    it('floor: a root with no record', () => {
      const cell = floorCell()
      cells.push(cell)
      const samples: number[] = []
      for (let i = 0; i < ITER; i++) {
        const { ms, exit } = spawnTimed(cell, ['event', 'session-start'], hook(cell, 'SessionStart', `floor-${i}`, { source: 'startup' }))
        expect(exit).toBe(0)
        samples.push(ms)
      }
      report.cells.push({ name: 'floor', recordedAt: new Date().toISOString(), initiatives: 0, boundBytes: 0, boundLines: 0, totalBytes: 0, measures: { 'session-start (no record)': stat(samples) } })
      if (!KEEP) rmSync(cell.m.dir, { recursive: true, force: true })
    })
  }

  it.skipIf(!GATE || CANDIDATE === undefined)('gate: every candidate p50 and p95 is at or under the TypeScript target', () => {
    const baseline = readBaseline()
    expect(baseline, `no baseline at ${BASELINE_PATH} — record it with SOFAR_PERF_RECORD=1`).not.toBeNull()
    const misses: string[] = []
    for (const cell of report.cells) {
      const base = baseline!.cells.find((c) => c.name === cell.name)
      if (base === undefined) continue
      for (const [name, s] of Object.entries(cell.measures)) {
        const b = base.measures[name]
        if (b === undefined) continue
        if (s.p50 > b.p50) misses.push(`${cell.name} / ${name}: p50 ${fmt(s.p50)} > ${fmt(b.p50)}`)
        if (s.p95 > b.p95) misses.push(`${cell.name} / ${name}: p95 ${fmt(s.p95)} > ${fmt(b.p95)}`)
      }
    }
    expect(misses).toEqual([])
  })
})
