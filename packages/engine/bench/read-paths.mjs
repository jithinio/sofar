#!/usr/bin/env node
/**
 * Read-path latency budget (r1-fixes D18) — the acceptance check for a
 * release candidate. Times the four read hooks end to end (node spawn
 * included, as the host pays it) on a REAL record, baseline and candidate
 * CLIs interleaved ABAB so machine drift cancels, and fails when any
 * candidate p50 exceeds the baseline's by more than the budget.
 *
 *   npm run bench:read-paths -- --baseline ~/.bench/sofar-0.32.0/node_modules/sofar.sh/dist/cli.js \
 *       --candidate packages/engine/dist/cli.js [--fixture repo|i1000-10mb] [--root <repo>] [--session <id>] \
 *       [--n 25] [--budget 0.10] [--record <file.json>]
 *
 * Measurement under load is valid BECAUSE it is interleaved: baseline and
 * candidate alternate spawn by spawn, so whatever the machine is doing hits
 * both equally (rust-core confirmed the D18 numbers at load average 4.9–6.9
 * while round 1 owned the box). What interleaving cannot cancel is load that
 * CHANGES during the run, so the 1-minute load average is recorded at start
 * and end, printed, and a change of more than 50% exits 3: repeat the run.
 * `--record` writes the tables as JSON — the artefact a CI tripwire keeps
 * (run there with a wide `--budget 0.5`: hosted noise cannot hide a 2×
 * regression, and a manual-only gate is one forgotten step from silence).
 *
 * Two fixtures are pinned (D18), named as rust-core's perf cells are:
 * `repo` — a repo's own record, by default the cwd (this repo: 55
 * initiatives, 0.6 MB bound log) — and `i1000-10mb` — 1,000 initiatives
 * sharing the .sofar/ with a 10 MB bound log, generated deterministically
 * under the OS temp dir on every run, so a scale-only regression cannot hide
 * behind a small-record pass.
 *
 * Not a vitest test on purpose: a timing assertion flakes under load and
 * would gate every commit on a number. Run it by hand on a quiet machine,
 * and paste the table into the RC's task note.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, writeSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
const n = Number(args.n ?? 25)
const budget = Number(args.budget ?? 0.1)
const fixture = args.fixture ?? 'repo'

// ---------------------------------------------------------------------------
// The `i1000-10mb` fixture (D18; the shape of rust-core's perf cell of the
// same name): 1,000 initiatives share the .sofar/ — the registration scan,
// the index, the neighbour derivation — and the BOUND log is ≥10 MB of
// sessions shaped like a real one: a plan, ten decisions (five guarded),
// sessions of 24 mechanical events each with a write-back, and every tenth
// sibling leaving a session open on a path the bound record also edits.
// Seeded, so two runs build the same bytes; ids are monotonic ulids so the
// fold's convergent sort is a no-op, as on a real log.
// ---------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulidAt(ms, rand) {
  let time = ''
  let t = ms
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let tail = ''
  for (let i = 0; i < 16; i++) tail += CROCKFORD[Math.floor(rand() * 32)]
  return time + tail
}
function seeded(seed) {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}
const BOUND = 'perf-bound'
const SHARED_PATH = 'src/shared/config.ts'
function buildI1000() {
  const dir = mkdtempSync(join(tmpdir(), 'sofar-read-paths-'))
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(dir, '.sofar', 'initiatives'), { recursive: true })
  writeFileSync(join(dir, '.sofar', 'bindings.json'), JSON.stringify({ main: BOUND }, null, 2) + '\n')
  writeFileSync(join(dir, '.sofar', 'repo.md'), '# Repo memory\n\n' + Array.from({ length: 12 }, (_, i) => `- memory line ${i}: a convention every session needs to know about this repo`).join('\n') + '\n')
  const rand = seeded(20260916)
  let ms = Date.parse('2026-01-01T00:00:00Z')
  const line = (initiative, session, type, payload, source = 'hook', actor = 'agent') => {
    ms += 1000
    return JSON.stringify({ v: 1, id: ulidAt(ms, rand), ts: new Date(ms).toISOString(), initiative, session, source, actor, type, payload }) + '\n'
  }
  const write = (slug, lines) => {
    mkdirSync(join(dir, '.sofar', 'initiatives', slug), { recursive: true })
    writeFileSync(join(dir, '.sofar', 'initiatives', slug, 'events.jsonl'), lines.join(''))
  }
  // The bound log.
  const bound = []
  let bytes = 0
  const put = (text) => {
    bound.push(text)
    bytes += Buffer.byteLength(text)
  }
  put(line(BOUND, 'cli', 'initiative_created', { slug: BOUND, goal: 'a bound record sized for the read-path gate, shaped like a real initiative log' }, 'cli', 'human'))
  put(line(BOUND, 'cli', 'plan_updated', {
    goal: 'a bound record sized for the read-path gate',
    phases: Array.from({ length: 6 }, (_, p) => ({
      name: `Phase ${p + 1} — a phase name of realistic length`,
      status: p === 0 ? 'done' : p === 1 ? 'active' : 'pending',
      tasks: Array.from({ length: 8 }, (_, t) => ({ id: `${p + 1}.${t + 1}`, title: `task ${p + 1}.${t + 1}: a realistically sized task title that keeps going`, status: p === 0 ? 'done' : p === 1 && t === 0 ? 'active' : 'pending' })),
    })),
  }, 'cli', 'human'))
  for (let d = 0; d < 10; d++) {
    put(line(BOUND, 'cli', 'decision_logged', {
      chose: `decision ${d}: the approach that won, with enough prose to look like a rationale`,
      over: `alternative ${d}: the shorter option`,
      because: `benchmarks favoured it and the record should carry the reasoning ${d}`,
      ...(d % 2 === 0 ? { rule: `Rule ${d}: never edit files under src/legacy-${d}/.`, guard: `path:src/legacy-${d}/**` } : {}),
    }, 'cli', 'human'))
  }
  put(line(BOUND, 'cli', 'memory_promoted', { text: 'Test command: npm test (vitest); build: npm run build.' }, 'cli', 'human'))
  let s = 0
  while (bytes < 10 * 1_000_000) {
    const sid = `${BOUND}-sess-${s}`
    put(line(BOUND, sid, 'session_started', { tool: 'claude-code', model: 'claude-fable-5' }))
    for (let i = 0; i < 24; i++) {
      if (i % 4 === 3) put(line(BOUND, sid, 'command_run', { cmd: `npm test -- --run suite-${s}-${i}` }))
      else put(line(BOUND, sid, 'file_touched', { path: i === 0 ? SHARED_PATH : `src/module-${s % 40}/file-${i}.ts`, op: i === 1 ? 'write' : 'edit' }))
    }
    put(line(BOUND, sid, 'task_status_changed', { id: `2.${(s % 8) + 1}`, status: s % 2 === 0 ? 'active' : 'done' }, 'claude-code'))
    if (s % 3 === 0) put(line(BOUND, sid, 'note_added', { text: `session ${s} left this observation for the next resume` }, 'claude-code'))
    put(line(BOUND, sid, 'session_ended', { summary: `session ${s} completed its batch of work on ${BOUND}, touching module-${s % 40}`, next_action: `pick up task 2.${(s % 8) + 1} where session ${s} left off` }, 'claude-code'))
    s++
  }
  put(line(BOUND, 'cli', 'note_added', { text: 'an un-absorbed note so the notes section renders' }, 'cli', 'human'))
  write(BOUND, bound)
  const boundSessions = s
  // 999 siblings: small logs; every tenth leaves a session open on the shared path.
  const SIBLINGS = 999
  for (let n = 0; n < SIBLINGS; n++) {
    const slug = `perf-sib-${String(n).padStart(4, '0')}`
    const sid = `${slug}-sess`
    const l = []
    l.push(line(slug, 'cli', 'initiative_created', { slug, goal: `sibling ${n}: a small record sharing the .sofar/` }, 'cli', 'human'))
    l.push(line(slug, sid, 'session_started', { tool: 'claude-code' }))
    l.push(line(slug, sid, 'file_touched', { path: n % 10 === 0 ? SHARED_PATH : `src/sib-${n}/file.ts`, op: 'edit' }))
    l.push(line(slug, sid, 'decision_logged', { chose: `sibling ${n} choice`, over: `sibling ${n} alternative`, because: `sibling ${n} reason` }, 'claude-code'))
    if (n % 10 !== 0) l.push(line(slug, sid, 'session_ended', { summary: `sibling ${n} done`, next_action: 'nothing' }, 'claude-code'))
    write(slug, l)
  }
  return { root: dir, session: `${BOUND}-sess-${boundSessions - 1}`, size: bytes, events: bound.length, sessions: boundSessions, initiatives: SIBLINGS + 1 }
}

let root
let session
if (fixture === 'i1000-10mb' || fixture === 'synthetic') {
  const built = buildI1000()
  root = built.root
  session = built.session
  console.log(`fixture i1000-10mb: ${built.initiatives} initiatives, bound log ${(built.size / 1e6).toFixed(1)} MB / ${built.events} events / ${built.sessions} sessions, at ${root}`)
} else if (fixture === 'repo' || fixture === 'real') {
  root = at(args.root) ?? from
  session = args.session ?? 'bench-read-paths'
  console.log(`fixture repo: ${root}`)
} else {
  console.error(`unknown --fixture ${fixture} (repo | i1000-10mb)`)
  process.exit(2)
}
const prompt = 'let us widen the source enum for cursor and rewrite the committed log'

const cases = {
  'session-start': ['event', 'session-start', { session_id: session, cwd: root, source: 'resume' }],
  'user-prompt': ['event', 'user-prompt', { session_id: session, cwd: root, prompt }],
  stop: ['event', 'stop', { session_id: session, cwd: root, stop_hook_active: false }],
  statusline: ['statusline', null, { session_id: session, cwd: root, workspace: { current_dir: root }, model: { display_name: 'Opus 5' } }],
}
const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

let over = 0
const loadStart = loadavg()[0]
const results = []
console.log(`read paths on ${root} — n=${n} interleaved, budget +${Math.round(budget * 100)}%, load avg ${loadStart.toFixed(2)} on ${cpus().length} cpus`)
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
  results.push({ hook: name, baseline_p50_ms: Number(b.toFixed(1)), candidate_p50_ms: Number(c.toFixed(1)), delta_ms: Number(delta.toFixed(1)), delta_pct: Number(((delta / b) * 100).toFixed(1)), ok })
  console.log(
    `${name.padEnd(14)} baseline p50 ${b.toFixed(1)} ms   candidate p50 ${c.toFixed(1)} ms   Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ms (${((delta / b) * 100).toFixed(1)}%)  ${ok ? 'ok' : 'OVER BUDGET'}`,
  )
}
const loadEnd = loadavg()[0]
const drift = loadStart > 0 ? Math.abs(loadEnd - loadStart) / loadStart : loadEnd > 0 ? 1 : 0
console.log(`load avg ${loadStart.toFixed(2)} → ${loadEnd.toFixed(2)}${drift > 0.5 ? ' — changed by more than 50% during the run: REPEAT' : ''}`)
if (args.record !== undefined) {
  const out = {
    fixture,
    root,
    session,
    n,
    budget,
    baseline,
    candidate,
    load_avg: { start: Number(loadStart.toFixed(2)), end: Number(loadEnd.toFixed(2)), cpus: cpus().length },
    recorded_at: new Date().toISOString(),
    verdict: drift > 0.5 ? 'repeat' : over > 0 ? 'over-budget' : 'ok',
    results,
  }
  writeFileSync(at(args.record), JSON.stringify(out, null, 2) + '\n')
  console.log(`recorded ${at(args.record)}`)
}
process.exit(drift > 0.5 ? 3 : over > 0 ? 1 : 0)
