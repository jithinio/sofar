#!/usr/bin/env node
// typed-judge 1.1 — calibration of TypeSafe Jev against sofar's own record.
//
// Offline, outside the engine, zero dependencies (Node ≥18 fetch). Reads every
// .sofar/initiatives/*/events.jsonl, builds labelled samples the record already
// knows the answer to, judges them with Jev in fan-out batches, and reports
// agreement, calibration by confidence bucket, tokens, cost and latency.
//
// Questions:
//   A  constraint-vs-one-off  Choice over each decision's chose/over/because
//      (the `rule` field is withheld). Label: rule present → standing_constraint.
//   B  decision-bears-on-task Noul over (decision, task) pairs. Positive: the
//      decision text names the task id in its own initiative. Negative: the same
//      decision paired with a task from another initiative.
//
// Usage:
//   TYPESAFE_API_KEY=... node scripts/judge-calibration.mjs [--limit N] [--out file.json]
//   node scripts/judge-calibration.mjs --dry-run     (no key: counts + one sample request)
//
// Never imported by the engine. Sends record text to api.typesafe.ai — run it
// only on a record you are willing to send (typed-judge D1).

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i === -1 ? dflt : args[i + 1]
}
const DRY = args.includes('--dry-run')
const LIMIT = Number(flag('--limit', '0')) || 0
const OUT = flag('--out', '')
const MODEL = 'jev-1.13.0'
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const KEY = process.env.TYPESAFE_API_KEY
const PRICE_PER_M_INPUT = 0.042
const BATCH_CHARS = 20_000 // ≈5k tokens of state per request; cap is 32k tokens
const CONCURRENCY = 2

// ---------- read the record ----------
const root = join(process.cwd(), '.sofar', 'initiatives')
if (!existsSync(root)) {
  console.error('no .sofar/initiatives here — run from the repo root')
  process.exit(1)
}
const decisions = []
const tasksByInitiative = new Map()
for (const slug of readdirSync(root)) {
  const log = join(root, slug, 'events.jsonl')
  if (!existsSync(log)) continue
  let ordinal = 0
  const tasks = new Map()
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'decision_logged' && ev.payload?.chose) {
      ordinal += 1
      decisions.push({
        key: `${slug} D${ordinal}`,
        initiative: slug,
        chose: String(ev.payload.chose),
        over: String(ev.payload.over ?? ''),
        because: String(ev.payload.because ?? ''),
        hasRule: typeof ev.payload.rule === 'string' && ev.payload.rule.length > 0,
      })
    }
    if (ev.type === 'plan_updated' && Array.isArray(ev.payload?.plan?.phases)) {
      for (const ph of ev.payload.plan.phases)
        for (const t of ph.tasks ?? []) if (t.id && t.title) tasks.set(String(t.id), String(t.title))
    }
    if (ev.type === 'task_added' && ev.payload?.id && ev.payload?.title)
      tasks.set(String(ev.payload.id), String(ev.payload.title))
  }
  tasksByInitiative.set(slug, tasks)
}

// ---------- samples ----------
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

// A: constraint vs one-off
let samplesA = decisions.map((d) => ({
  key: d.key,
  label: d.hasRule ? 'standing_constraint' : 'one_off',
  item: { chose: clip(d.chose, 1200), over: clip(d.over, 800), because: clip(d.because, 1200) },
}))

// B: decision bears on task
const taskIdRe = /\b(\d+\.\d+)\b/g
const samplesB = []
const slugs = [...tasksByInitiative.keys()]
let seed = 42
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
for (const d of decisions) {
  const own = tasksByInitiative.get(d.initiative)
  if (!own || own.size === 0) continue
  const mentioned = new Set()
  for (const m of `${d.chose} ${d.because}`.matchAll(taskIdRe)) if (own.has(m[1])) mentioned.add(m[1])
  if (mentioned.size === 0) continue
  const id = [...mentioned][0]
  samplesB.push({
    key: `${d.key} → ${d.initiative} ${id}`,
    label: true,
    item: {
      decision: { chose: clip(d.chose, 900), because: clip(d.because, 900) },
      task: { id, title: own.get(id) },
    },
  })
  // negative: a task from a different initiative with tasks
  for (let tries = 0; tries < 10; tries++) {
    const other = slugs[Math.floor(rand() * slugs.length)]
    const ot = tasksByInitiative.get(other)
    if (other === d.initiative || !ot || ot.size === 0) continue
    const ids = [...ot.keys()]
    const oid = ids[Math.floor(rand() * ids.length)]
    samplesB.push({
      key: `${d.key} → ${other} ${oid}`,
      label: false,
      item: {
        decision: { chose: clip(d.chose, 900), because: clip(d.because, 900) },
        task: { id: oid, title: ot.get(oid) },
      },
    })
    break
  }
}
if (LIMIT) {
  samplesA = samplesA.slice(0, LIMIT)
  samplesB.length = Math.min(samplesB.length, LIMIT)
}

// ---------- batching ----------
function batches(samples, stateKey) {
  const out = []
  let cur = []
  let size = 0
  for (const s of samples) {
    const len = JSON.stringify(s.item).length
    if (cur.length && size + len > BATCH_CHARS) {
      out.push(cur)
      cur = []
      size = 0
    }
    cur.push(s)
    size += len
  }
  if (cur.length) out.push(cur)
  return out.map((group) => ({
    group,
    body: {
      model: MODEL,
      state: { [stateKey]: group.map((s) => s.item) },
      questions: Object.fromEntries(group.map((s, i) => [`q${i}`, questionFor(stateKey, i)])),
    },
  }))
}

function questionFor(stateKey, i) {
  if (stateKey === 'decisions') {
    return {
      type: 'choice',
      instructions: `Read \`decisions[${i}]\`, a design decision from a software project's record. Is it a STANDING CONSTRAINT that every future work session must keep obeying, or a ONE-OFF choice that was made once and needs no ongoing obedience?`,
      criteria: {
        standing_constraint: {
          what: 'A rule about how future work must or must not be done: a prohibition, an invariant, a convention, a boundary that later sessions could violate.',
          examples: ['Never write a pid into the lock file', 'Schema types live only in packages/schema', 'Always cite the deciding entry'],
        },
        one_off: {
          what: 'A choice about this piece of work only: a scope, an ordering, a name, a fix, a plan step, a measurement. Once done, nothing remains to obey.',
          examples: ['Ship the fix in TypeScript first', 'Cycle scope is these three plays', 'Use the held-out chain for the number'],
        },
      },
    }
  }
  return {
    type: 'noul',
    instructions: `Read \`pairs[${i}]\`. Does \`pairs[${i}].decision\` bear on \`pairs[${i}].task\` — would someone working on that task need to know this decision?`,
    criteria: {
      true: 'The decision constrains, scopes, explains or was made for that task or its subject.',
      false: 'The decision is about different work; knowing it would not change how the task is done.',
    },
  }
}

// ---------- API ----------
async function call(body, attempt = 0) {
  const t0 = performance.now()
  let res
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (err) {
    // Connect timeouts and resets: the host answers in ~3 s from here, so a
    // 10 s connect limit trips on a bad moment. Back off and retry.
    if (attempt < 8) {
      console.error(`  network error (${err.cause?.code ?? err.name}), retry ${attempt + 1}/8`)
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)))
      return call(body, attempt + 1)
    }
    throw err
  }
  const ms = performance.now() - t0
  if ((res.status === 429 || res.status === 529) && attempt < 5) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    return call(body, attempt + 1)
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${clip(await res.text(), 300)}`)
  return { json: await res.json(), ms }
}

async function runAll(list, worker) {
  const results = new Array(list.length)
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < list.length) {
        const i = next++
        results[i] = await worker(list[i], i)
      }
    }),
  )
  return results
}

// ---------- metrics ----------
const confOf = (a) => (a.type === 'noul' ? Math.abs(a.noul - 0.5) * 2 : a.confidence)
function report(name, rows) {
  // rows: {label, pred, conf, p}
  const n = rows.length
  const correct = rows.filter((r) => r.pred === r.label).length
  const buckets = [0.0, 0.2, 0.4, 0.6, 0.8, 1.01]
  const lines = []
  for (let b = 0; b < buckets.length - 1; b++) {
    const inB = rows.filter((r) => r.conf >= buckets[b] && r.conf < buckets[b + 1])
    if (!inB.length) continue
    const acc = inB.filter((r) => r.pred === r.label).length / inB.length
    lines.push(`  conf ${buckets[b].toFixed(1)}–${Math.min(buckets[b + 1], 1).toFixed(1)}: n=${inB.length}  accuracy=${(acc * 100).toFixed(1)}%`)
  }
  const classes = [...new Set(rows.map((r) => r.label))]
  const perClass = classes.map((c) => {
    const tp = rows.filter((r) => r.label === c && r.pred === c).length
    const fp = rows.filter((r) => r.label !== c && r.pred === c).length
    const fn = rows.filter((r) => r.label === c && r.pred !== c).length
    return `  ${String(c)}: precision=${tp + fp ? ((tp / (tp + fp)) * 100).toFixed(1) : 'n/a'}%  recall=${tp + fn ? ((tp / (tp + fn)) * 100).toFixed(1) : 'n/a'}%`
  })
  const brier = rows.reduce((s, r) => s + (r.p - (r.label === true || r.label === 'standing_constraint' ? 1 : 0)) ** 2, 0) / n
  console.log(`\n${name}: n=${n}  accuracy=${((correct / n) * 100).toFixed(1)}%  brier=${brier.toFixed(3)}`)
  console.log(perClass.join('\n'))
  console.log(lines.join('\n'))
  return { n, accuracy: correct / n, brier }
}

// ---------- main ----------
const A = batches(samplesA, 'decisions')
const B = batches(samplesB, 'pairs')
console.log(`record: ${decisions.length} decisions across ${tasksByInitiative.size} initiatives`)
console.log(`A constraint-vs-one-off: ${samplesA.length} samples (${samplesA.filter((s) => s.label === 'standing_constraint').length} with a rule) in ${A.length} requests`)
console.log(`B decision-bears-on-task: ${samplesB.length} samples (${samplesB.filter((s) => s.label).length} positive) in ${B.length} requests`)

if (DRY || !KEY) {
  if (!KEY && !DRY) console.log('\nTYPESAFE_API_KEY not set — dry run.')
  console.log('\nsample request (A, first batch, first 2 items):')
  const b = A[0]?.body
  if (b) console.log(JSON.stringify({ ...b, state: { decisions: b.state.decisions.slice(0, 2) }, questions: { q0: b.questions.q0 } }, null, 2))
  process.exit(0)
}

const usage = { input_tokens: 0, output_tokens: 0, requests: 0, failed_batches: 0, ms: [] }
async function judge(batchList, mapAnswer) {
  const rows = []
  const res = await runAll(batchList, async ({ group, body }, idx) => {
    let out
    try {
      out = await call(body)
    } catch (err) {
      usage.failed_batches += 1
      console.error(`  batch ${idx} lost (${group.length} samples): ${err.cause?.code ?? err.message}`)
      return []
    }
    const { json, ms } = out
    usage.requests += 1
    usage.ms.push(ms)
    usage.input_tokens += json.usage?.input_tokens ?? 0
    usage.output_tokens += json.usage?.output_tokens ?? 0
    return group.map((s, i) => ({ key: s.key, label: s.label, ...mapAnswer(json.answers[`q${i}`]) }))
  })
  for (const r of res) rows.push(...r)
  return rows
}

const rowsA = await judge(A, (a) => ({ pred: a.choice, conf: confOf(a), p: a.probabilities?.standing_constraint ?? 0 }))
const rowsB = await judge(B, (a) => ({ pred: a.noul >= 0.5, conf: confOf(a), p: a.noul }))

const summary = {
  model: MODEL,
  A: report('A constraint-vs-one-off', rowsA),
  B: report('B decision-bears-on-task', rowsB),
  usage: {
    ...usage,
    ms: undefined,
    latency_ms_p50: usage.ms.sort((x, y) => x - y)[Math.floor(usage.ms.length / 2)],
    latency_ms_max: Math.max(...usage.ms),
    cost_usd: (usage.input_tokens / 1e6) * PRICE_PER_M_INPUT,
  },
}
console.log(`\nusage: ${usage.requests} requests, ${usage.input_tokens} input tokens, $${summary.usage.cost_usd.toFixed(4)}, p50 ${Math.round(summary.usage.latency_ms_p50)} ms, max ${Math.round(summary.usage.latency_ms_max)} ms`)

const disagreements = [...rowsA, ...rowsB].filter((r) => r.pred !== r.label).sort((x, y) => y.conf - x.conf).slice(0, 15)
console.log('\nconfident disagreements (label vs jev, top 15 by confidence):')
for (const d of disagreements) console.log(`  ${d.key}: label=${d.label} jev=${d.pred} conf=${d.conf.toFixed(2)}`)

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ summary, rowsA, rowsB }, null, 2))
  console.log(`\nwrote ${OUT}`)
}
