#!/usr/bin/env node
/**
 * Read-path latency budget (r1-fixes D18) — the acceptance check for a
 * release candidate. Times the four read hooks end to end (node spawn
 * included, as the host pays it) on a REAL record, baseline and candidate
 * CLIs interleaved ABAB so machine drift cancels, and fails when any
 * candidate p50 exceeds the baseline's by more than the budget.
 *
 *   npm run bench:read-paths -- --baseline ~/.bench/sofar-0.32.0/node_modules/sofar.sh/dist/cli.js \
 *       --candidate packages/engine/dist/cli.js [--root <repo>] [--session <id>] [--n 25] [--budget 0.10]
 *
 * Not a vitest test on purpose: a timing assertion flakes under load and
 * would gate every commit on a number. Run it by hand on a quiet machine,
 * and paste the table into the RC's task note.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// `npm run` moves cwd to the workspace; INIT_CWD is where the operator typed
// the command, and that is what a relative path in their argument means.
const from = process.env.INIT_CWD ?? process.cwd()
const at = (p) => (p === undefined ? undefined : resolve(from, p))

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]])
    return acc
  }, []),
)
const baseline = at(args.baseline)
const candidate = at(args.candidate)
if (!baseline || !candidate) {
  console.error('usage: read-paths.mjs --baseline <cli.js> --candidate <cli.js> [--root <repo>] [--session <id>] [--n 25] [--budget 0.10]')
  process.exit(2)
}
for (const [label, bin] of [['baseline', baseline], ['candidate', candidate]]) {
  if (!existsSync(bin)) {
    console.error(`${label} not found: ${bin}`)
    process.exit(2)
  }
}
const root = at(args.root) ?? from
const session = args.session ?? 'bench-read-paths'
const n = Number(args.n ?? 25)
const budget = Number(args.budget ?? 0.1)
const prompt = 'let us widen the source enum for cursor and rewrite the committed log'

const cases = {
  'session-start': ['event', 'session-start', { session_id: session, cwd: root, source: 'resume' }],
  'user-prompt': ['event', 'user-prompt', { session_id: session, cwd: root, prompt }],
  stop: ['event', 'stop', { session_id: session, cwd: root, stop_hook_active: false }],
  statusline: ['statusline', null, { session_id: session, cwd: root, workspace: { current_dir: root }, model: { display_name: 'Opus 5' } }],
}
const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

let over = 0
console.log(`read paths on ${root} — n=${n} interleaved, budget +${Math.round(budget * 100)}%`)
console.log(`baseline  ${baseline}\ncandidate ${candidate}`)
for (const [name, [cmd, sub, input]] of Object.entries(cases)) {
  const t = { baseline: [], candidate: [] }
  for (let i = 0; i < n + 2; i++) {
    for (const which of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const bin = which === 'baseline' ? baseline : candidate
      const t0 = performance.now()
      const r = spawnSync('node', sub ? [bin, cmd, sub] : [bin, cmd], { cwd: root, input: JSON.stringify(input), encoding: 'utf8' })
      const ms = performance.now() - t0
      // A hook exits 0, or 2 for a Stop block; anything else is a broken
      // binary timing its own crash, which would read as a win.
      if (r.status !== 0 && r.status !== 2) {
        console.error(`${which} ${name}: exit ${r.status} — ${r.stderr.trim().split('\n')[0] ?? ''}`)
        process.exit(2)
      }
      if (i >= 2) t[which].push(ms) // two warm-ups per case
    }
  }
  const b = p50(t.baseline)
  const c = p50(t.candidate)
  const delta = c - b
  const ok = c <= b * (1 + budget)
  if (!ok) over++
  console.log(
    `${name.padEnd(14)} baseline p50 ${b.toFixed(1)} ms   candidate p50 ${c.toFixed(1)} ms   Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ms (${((delta / b) * 100).toFixed(1)}%)  ${ok ? 'ok' : 'OVER BUDGET'}`,
  )
}
process.exit(over > 0 ? 1 : 0)
