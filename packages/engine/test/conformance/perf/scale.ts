import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EPOCH, LogBuilder, type FixtureFiles } from '../synthetic'

/**
 * Scale fixtures for the perf baseline (rust-core 1.3): records shaped like
 * the real ones but sized on two axes the hot path is sensitive to — how
 * many initiatives share the `.sofar/` (the registration scan, the index,
 * the neighbour derivation) and how big the BOUND log is (the fold, the
 * digest). Every id and timestamp is fixed (the synthetic builders' clock),
 * so a cell is the same bytes on every run and on every machine; the files
 * are generated into scratch, never checked in.
 *
 * One record layout per cell:
 *   .sofar/bindings.json          main → perf-bound
 *   .sofar/repo.md                12 memory lines
 *   .sofar/initiatives/perf-bound/events.jsonl   ≥ `boundBytes` of sessions
 *   .sofar/initiatives/perf-sib-NNNN/events.jsonl  small siblings; every
 *                                 tenth leaves a session open on a path the
 *                                 bound record also edits
 */

export interface ScaleCell {
  name: string
  initiatives: number
  /** Minimum size of the bound log, in bytes. */
  boundBytes: number
}

const MB = 1_000_000

export const SCALE_CELLS: readonly ScaleCell[] = [
  { name: 'i10-1mb', initiatives: 10, boundBytes: 1 * MB },
  { name: 'i10-10mb', initiatives: 10, boundBytes: 10 * MB },
  { name: 'i100-1mb', initiatives: 100, boundBytes: 1 * MB },
  { name: 'i100-10mb', initiatives: 100, boundBytes: 10 * MB },
  { name: 'i1000-1mb', initiatives: 1_000, boundBytes: 1 * MB },
  { name: 'i1000-10mb', initiatives: 1_000, boundBytes: 10 * MB },
]

export const BOUND_SLUG = 'perf-bound'
/** A path the bound record and every tenth sibling both edit (conflict + neighbour work). */
export const SHARED_PATH = 'src/shared/config.ts'

const HOOK = { source: 'hook' } as const
/** One second per event: a 10 MB log spans hours, never reaching past the wall clock. */
const TICK = { after: 1_000 } as const

function plan(goal: string, phases: number, tasksPerPhase: number): Record<string, unknown> {
  return {
    plan: {
      goal,
      phases: Array.from({ length: phases }, (_, p) => ({
        name: `Phase ${p + 1} — a phase name of realistic length`,
        status: p === 0 ? 'done' : p === 1 ? 'active' : 'pending',
        tasks: Array.from({ length: tasksPerPhase }, (_, t) => ({
          id: `${p + 1}.${t + 1}`,
          title: `task ${p + 1}.${t + 1}: a realistically sized task title that keeps going`,
          status: p === 0 ? 'done' : p === 1 && t === 0 ? 'active' : 'pending',
        })),
      })),
    },
  }
}

/** The bound log: plan, guarded decisions, then sessions until the byte target is met. */
export function boundLog(minBytes: number): string {
  const b = new LogBuilder(BOUND_SLUG, EPOCH)
  const goal = 'a bound record sized for the perf baseline, shaped like a real initiative log'
  b.ev('initiative_created', { slug: BOUND_SLUG, goal }, { actor: 'human', ...TICK })
  b.ev('plan_updated', plan(goal, 6, 8), TICK)
  for (let d = 0; d < 10; d++) {
    b.ev(
      'decision_logged',
      {
        chose: `decision ${d}: the approach that won, with enough prose to look like a rationale`,
        over: `alternative ${d}: the shorter option`,
        because: `benchmarks favoured it and the record should carry the reasoning ${d}`,
        ...(d % 2 === 0
          ? { rule: `Rule ${d}: never edit files under src/legacy-${d}/.`, guard: `path:src/legacy-${d}/**` }
          : {}),
      },
      TICK,
    )
  }
  b.ev('memory_promoted', { text: 'Test command: npm test (vitest); build: npm run build.' }, TICK)
  let bytes = 0
  let counted = 0
  const count = (): number => {
    for (; counted < b.lines.length; counted++) bytes += b.lines[counted]!.length + 1
    return bytes
  }
  let s = 0
  while (count() < minBytes) {
    const sid = `${BOUND_SLUG}-sess-${s}`
    b.ev('session_started', { tool: 'claude-code', model: 'claude-fable-5' }, { session: sid, ...HOOK, ...TICK })
    for (let i = 0; i < 24; i++) {
      if (i % 4 === 3) {
        b.ev('command_run', { cmd: `npm test -- --run suite-${s}-${i}` }, { session: sid, ...HOOK, ...TICK })
      } else {
        const path = i === 0 ? SHARED_PATH : `src/module-${s % 40}/file-${i}.ts`
        b.ev('file_touched', { path, op: i === 1 ? 'write' : 'edit' }, { session: sid, ...HOOK, ...TICK })
      }
    }
    b.ev('task_status_changed', { id: `2.${(s % 8) + 1}`, status: s % 2 === 0 ? 'active' : 'done' }, { session: sid, ...TICK })
    if (s % 3 === 0) b.ev('note_added', { text: `session ${s} left this observation for the next resume` }, { session: sid, ...TICK })
    b.ev(
      'session_ended',
      {
        summary: `session ${s} completed its batch of work on ${BOUND_SLUG}, touching module-${s % 40}`,
        next_action: `pick up task 2.${(s % 8) + 1} where session ${s} left off`,
      },
      { session: sid, ...TICK },
    )
    s++
  }
  // Post-write-back drift so the digest's staleness and notes sections render.
  b.ev('note_added', { text: 'an un-absorbed note so the notes section renders' }, TICK)
  return b.text()
}

/** A small sibling; every tenth leaves a session open on the shared path. */
export function siblingLog(n: number): string {
  const slug = siblingSlug(n)
  const b = new LogBuilder(slug, EPOCH - 86_400_000 + n * 60_000)
  const goal = `sibling record ${n} of the scale cell`
  b.ev('initiative_created', { slug, goal }, TICK)
  b.ev('plan_updated', plan(goal, 1, 3), TICK)
  const sid = `${slug}-sess`
  b.ev('session_started', { tool: 'claude-code' }, { session: sid, ...HOOK, ...TICK })
  b.ev('file_touched', { path: `src/sibling-${n}/a.ts`, op: 'edit' }, { session: sid, ...HOOK, ...TICK })
  b.ev('file_touched', { path: n % 10 === 0 ? SHARED_PATH : `src/sibling-${n}/b.ts`, op: 'edit' }, { session: sid, ...HOOK, ...TICK })
  b.ev('command_run', { cmd: 'npm test' }, { session: sid, ...HOOK, ...TICK })
  b.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: sid, ...TICK })
  if (n % 10 !== 0) {
    b.ev('session_ended', { summary: `sibling ${n} finished 1.1`, next_action: 'start 1.2' }, { session: sid, ...TICK })
  }
  return b.text()
}

export function siblingSlug(n: number): string {
  return `perf-sib-${String(n).padStart(4, '0')}`
}

export function scaleFiles(cell: ScaleCell): FixtureFiles {
  const files: FixtureFiles = {
    'bindings.json': `${JSON.stringify({ main: BOUND_SLUG }, null, 2)}\n`,
    'repo.md': `# Repo memory\n\n${Array.from({ length: 12 }, (_, i) => `- convention ${i}: a realistically sized repo memory line`).join('\n')}\n`,
    [`initiatives/${BOUND_SLUG}/events.jsonl`]: boundLog(cell.boundBytes),
  }
  for (let n = 1; n < cell.initiatives; n++) files[`initiatives/${siblingSlug(n)}/events.jsonl`] = siblingLog(n)
  return files
}

/** Write a cell's `.sofar/` under `root`; returns bytes and lines of the bound log. */
export function writeScale(root: string, cell: ScaleCell): { boundBytes: number; boundLines: number; totalBytes: number } {
  const files = scaleFiles(cell)
  let totalBytes = 0
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, '.sofar', rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    totalBytes += Buffer.byteLength(content)
  }
  const bound = files[`initiatives/${BOUND_SLUG}/events.jsonl`]!
  return { boundBytes: Buffer.byteLength(bound), boundLines: bound.split('\n').length - 1, totalBytes }
}
