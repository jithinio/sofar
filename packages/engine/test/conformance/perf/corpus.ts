import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { EPOCH, LogBuilder } from '../synthetic'

/**
 * team100 — a parameterised synthetic corpus shaped like 100 users on one
 * repository (rust-core 1.5). Every number here is a parameter, exported, so
 * a cell is a spec and a spec is the same bytes on every machine (seeded
 * PRNG, the synthetic builders' fixed clock).
 *
 * Two named WRITER PROFILES, from the round-1 records:
 *   `agent`  14.3 events per session, 593 bytes per event, file_touched-heavy
 *            — a hook-driven coding session; four in five end with a short
 *            write-back, one in five is left open.
 *   `human`  21 events per session, 798 bytes per event, notes and decisions
 *            in the mix, and a 1–4 KB session_ended tail (the operator's
 *            write-back prose).
 * A spec blends them (`humanShare`), spreads `events` over `initiatives`
 * with a heavy tail (Zipf, `tail` exponent — the largest record carries
 * ~1/H(n) of everything), and deals sessions to `writers`. Every writer's
 * LAST session on the bound record (initiative 0) is left open, so the bound
 * digest's live-session list grows with the writer count — the axis 1.5
 * measures the digest and statusline against.
 */

export interface WriterProfile {
  name: string
  /** Mean events per session (session_started and the write-back included). */
  eventsPerSession: number
  /** Mean serialized bytes per event, newline included. */
  bytesPerEvent: number
  /** Share of mechanical events that are file_touched (the rest command_run). */
  fileTouchedShare: number
  /** Share of sessions that end with a session_ended. */
  writeBackShare: number
  /** Bytes of the session_ended summary + next_action, [min, max]. */
  tailBytes: [number, number]
}

export const AGENT: WriterProfile = {
  name: 'agent',
  eventsPerSession: 14.3,
  bytesPerEvent: 593,
  fileTouchedShare: 0.78,
  writeBackShare: 0.8,
  tailBytes: [120, 400],
}

export const HUMAN: WriterProfile = {
  name: 'human',
  eventsPerSession: 21,
  bytesPerEvent: 798,
  fileTouchedShare: 0.55,
  writeBackShare: 0.95,
  tailBytes: [1_000, 4_000],
}

export interface CorpusSpec {
  name: string
  initiatives: number
  writers: number
  /** Total events across every initiative (approximate: sessions are whole). */
  events: number
  /** Share of sessions written by the `human` profile. */
  humanShare: number
  /** Zipf exponent for the initiative size distribution; 1 = the classic heavy tail. */
  tail: number
  seed: number
}

/** The 1.5 cell: ~20 initiatives, ~500k events, the largest log ≥ 50 MB, 100 writers. */
export const TEAM100: CorpusSpec = { name: 'team100', initiatives: 20, writers: 100, events: 500_000, humanShare: 0.3, tail: 1, seed: 100 }

/** The writer axis: the same shape with fewer writers, for the sessions[] curve. */
export const TEAM_CELLS: readonly CorpusSpec[] = [
  { ...TEAM100, name: 'team100-w10', writers: 10, events: 100_000 },
  { ...TEAM100, name: 'team100-w25', writers: 25, events: 100_000 },
  { ...TEAM100, name: 'team100-w50', writers: 50, events: 100_000 },
  { ...TEAM100, name: 'team100-w100', writers: 100, events: 100_000 },
  TEAM100,
]

export const BOUND = 'team-bound'
export const slugOf = (i: number): string => (i === 0 ? BOUND : `team-rec-${String(i).padStart(2, '0')}`)
const writerOf = (w: number): string => `w${String(w).padStart(3, '0')}`

// ---------------------------------------------------------------------------
// Determinism: a small PRNG (mulberry32) seeded per corpus, never Math.random.
// ---------------------------------------------------------------------------

export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!
  }
  /** A heavy-tailed positive draw with the given mean (log-normal, sigma 0.6). */
  lognormal(mean: number): number {
    const sigma = 0.6
    const u = Math.max(1e-9, this.next())
    const v = this.next()
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    return mean * Math.exp(sigma * z - (sigma * sigma) / 2)
  }
}

// ---------------------------------------------------------------------------
// Prose: deterministic filler of a requested byte length, wordy like a record.
// ---------------------------------------------------------------------------

const WORDS = 'the fold index digest session record hook append projection budget decision rule guard branch worktree conflict peer notice cache snapshot cursor sync push pull merge union order id ulid envelope payload schema fingerprint version engine core native typescript rust binary stub shim exec spawn boot compile bundle test golden fixture cell measure baseline gate target ratio load noise claim evidence'.split(' ')

function prose(rng: Rng, bytes: number): string {
  let out = ''
  while (out.length < bytes) out += `${rng.pick(WORDS)} `
  return out.slice(0, Math.max(1, bytes)).trimEnd()
}

const DIRS = ['src/core', 'src/cli', 'src/projections/templates', 'packages/engine/src/mcp', 'crates/sofar-core/src', 'docs', 'packages/schema/src', 'tools/schema-codegen', 'packages/engine/test/conformance', 'apps/web/components/dashboard/widgets']
const FILES = ['fold', 'index-store', 'status', 'session-start', 'append', 'envelope', 'payload', 'digest', 'statusline', 'graph', 'reach', 'guards', 'attribution', 'shipwatch', 'peers', 'nudge', 'lexicon', 'lessons', 'cross-conflicts', 'diagnostics']
const EXT = ['.ts', '.ts', '.ts', '.rs', '.md', '.test.ts']

function path(rng: Rng, writer: number): string {
  // Writers cluster on their own directories with some overlap: conflicts are real but not universal.
  const dir = rng.next() < 0.7 ? DIRS[writer % DIRS.length]! : rng.pick(DIRS)
  // Hooks record the host's absolute path (~330 B per file_touched in the real records).
  return `/Users/${rng.pick(['dev', 'jins', 'maria', 'build'])}/work/${rng.pick(['sofar', 'sofar-rust-core', 'sofar-wave-a'])}/${dir}/${rng.pick(FILES)}-${rng.int(1, 40)}${rng.pick(EXT)}`
}

const COMMANDS = ['npm test -- --run', 'npx vitest run', 'cargo test -p sofar-core', 'npm run build', 'npm run typecheck', 'git status --short', 'git diff --stat', 'cargo clippy --all-targets', 'node packaging/npm/emit.mjs --check', 'SOFAR_CORE=$PWD/target/release/sofar-core npx vitest run conformance']

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

/**
 * One session on `b`: `profile.eventsPerSession` events on average (log-normal
 * around it, never fewer than 3), bytes per event shaped by the profile —
 * calibrated so a large sample's mean lands within a few percent of
 * `bytesPerEvent` (corpus.test.ts pins it).
 */
export function writeSession(b: LogBuilder, rng: Rng, profile: WriterProfile, session: string, writer: number, open: boolean): number {
  const hook = { session, source: 'hook', after: 1_000 } as const
  const cli = { session, source: 'cli', actor: 'human', after: 1_000 } as const
  const total = Math.max(3, Math.round(rng.lognormal(profile.eventsPerSession)))
  const ends = !open && rng.next() < profile.writeBackShare
  let n = 0
  b.ev('session_started', { tool: profile.name === 'human' ? 'claude-code' : rng.pick(['claude-code', 'codex', 'opencode']), model: 'claude-fable-5-1' }, hook)
  n++
  const body = total - 1 - (ends ? 1 : 0)
  // The byte budget of the body: what the mean asks for, minus the envelope
  // (~230 B with the fixture user) and the tail, spread over the body events.
  const envelope = 232
  for (let i = 0; i < body; i++) {
    const r = rng.next()
    if (profile.name === 'human' && r < 0.12) {
      b.ev('note_added', { text: prose(rng, Math.round(rng.lognormal(profile.bytesPerEvent - envelope + 60))) }, cli)
    } else if (profile.name === 'human' && r < 0.16) {
      b.ev('decision_logged', { chose: prose(rng, Math.round(rng.lognormal(220))), over: prose(rng, Math.round(rng.lognormal(90))), because: prose(rng, Math.round(rng.lognormal(220))), ...(rng.next() < 0.3 ? { rule: `Never ${prose(rng, 60)}.` } : {}) }, cli)
    } else if (r < 0.2) {
      b.ev('task_status_changed', { id: `${rng.int(1, 4)}.${rng.int(1, 6)}`, status: rng.pick(['active', 'done', 'active', 'blocked']), ...(rng.next() < 0.5 ? { note: prose(rng, Math.round(rng.lognormal(120))) } : {}) }, cli)
    } else if (rng.next() < profile.fileTouchedShare) {
      // A file_touched is short by nature; its share of the byte budget comes from the path.
      b.ev('file_touched', { path: path(rng, writer), op: rng.pick(['edit', 'edit', 'write']), ok: true }, hook)
    } else {
      // command_run carries the whole command — heredocs, pipelines — and is
      // where a session's bytes live (the real records average ~1.7 KB).
      const cmdBytes = Math.round(rng.lognormal(profile.name === 'human' ? 1_000 : 1_800))
      b.ev('command_run', { cmd: `${rng.pick(COMMANDS)} ${prose(rng, cmdBytes)}`, ok: rng.next() < 0.85, ...(rng.next() < 0.6 ? { exit: rng.next() < 0.85 ? 0 : 1 } : {}) }, hook)
    }
    n++
  }
  if (ends) {
    const tail = rng.int(profile.tailBytes[0], profile.tailBytes[1])
    b.ev('session_ended', { summary: prose(rng, Math.round(tail * 0.7)), next_action: prose(rng, Math.round(tail * 0.3)) }, cli)
    n++
  }
  return n
}

// ---------------------------------------------------------------------------
// The corpus.
// ---------------------------------------------------------------------------

export interface InitiativeShape {
  slug: string
  /** Events this initiative should carry (whole sessions; the realised count is close). */
  events: number
}

/** Zipf shares over `n` initiatives, initiative 0 the largest. */
export function shapes(spec: CorpusSpec): InitiativeShape[] {
  const weights = Array.from({ length: spec.initiatives }, (_, i) => 1 / (i + 1) ** spec.tail)
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map((w, i) => ({ slug: slugOf(i), events: Math.round((spec.events * w) / sum) }))
}

export interface InitiativeText {
  slug: string
  text: string
  lines: number
  bytes: number
  sessions: number
  openSessions: number
}

/** One initiative's log: a plan, then sessions dealt to writers until the event budget is spent. */
export function initiativeText(spec: CorpusSpec, shape: InitiativeShape, index: number): InitiativeText {
  const rng = new Rng(spec.seed * 7919 + index * 104_729)
  // Each initiative's clock starts well before any run: 500k events at one
  // second each span days, and the fixture horizon must stay behind the wall clock.
  const b = new LogBuilder(shape.slug, EPOCH - 30 * 86_400_000 + index * 3_600_000)
  const goal = `${shape.slug}: ${prose(rng, 140)}`
  b.ev('initiative_created', { slug: shape.slug, goal }, { actor: 'human', after: 1_000 })
  b.ev('plan_updated', {
    plan: {
      goal,
      phases: Array.from({ length: 4 }, (_, p) => ({
        name: `Phase ${p + 1} — ${prose(rng, 40)}`,
        status: p === 0 ? 'done' : p === 1 ? 'active' : 'pending',
        tasks: Array.from({ length: 6 }, (_, t) => ({ id: `${p + 1}.${t + 1}`, title: prose(rng, 90), status: p === 0 ? 'done' : p === 1 && t === 0 ? 'active' : 'pending' })),
      })),
    },
  }, { actor: 'human', after: 1_000 })
  for (let d = 0; d < 8; d++) {
    b.ev('decision_logged', { chose: prose(rng, 200), over: prose(rng, 80), because: prose(rng, 200), ...(d % 2 === 0 ? { rule: `Rule ${d}: never ${prose(rng, 50)}.` } : {}) }, { actor: 'human', after: 1_000 })
  }
  let events = b.lines.length
  let sessions = 0
  let openSessions = 0
  const perWriter = new Map<number, number>()
  const isBound = index === 0
  const blended = spec.humanShare * HUMAN.eventsPerSession + (1 - spec.humanShare) * AGENT.eventsPerSession
  const deal = (writer: number, open: boolean): void => {
    const k = (perWriter.get(writer) ?? 0) + 1
    perWriter.set(writer, k)
    const profile = rng.next() < spec.humanShare ? HUMAN : AGENT
    events += writeSession(b, rng, profile, `${writerOf(writer)}-${shape.slug}-${k}`, writer, open)
    sessions++
    if (open) openSessions++
  }
  // Closed sessions, writers dealt round-robin, until what is left of the
  // budget is one final round; on the bound record that round is every
  // writer's OPEN session, so its live-session list holds exactly `writers`.
  const reserve = isBound ? spec.writers * blended : 0
  let writer = 0
  while (events < shape.events - reserve) {
    deal(writer, false)
    writer = (writer + 1) % spec.writers
  }
  if (isBound) for (let w = 0; w < spec.writers; w++) deal(w, true)
  const text = b.text()
  return { slug: shape.slug, text, lines: b.lines.length, bytes: Buffer.byteLength(text), sessions, openSessions }
}

export interface CorpusSummary {
  name: string
  initiatives: number
  writers: number
  totalBytes: number
  totalLines: number
  bound: { bytes: number; lines: number; sessions: number; openSessions: number }
  largestBytes: number
  perInitiative: Array<{ slug: string; bytes: number; lines: number; sessions: number }>
}

/** Write a corpus under `<root>/.sofar`, one initiative at a time (never all of it in memory). */
export function writeCorpus(root: string, spec: CorpusSpec): CorpusSummary {
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  writeFileSync(join(sofar, 'bindings.json'), `${JSON.stringify({ main: BOUND }, null, 2)}\n`)
  writeFileSync(join(sofar, 'repo.md'), `# Repo memory\n\n${Array.from({ length: 12 }, (_, i) => `- convention ${i}: a realistically sized repo memory line for the team corpus`).join('\n')}\n`)
  const summary: CorpusSummary = {
    name: spec.name,
    initiatives: spec.initiatives,
    writers: spec.writers,
    totalBytes: 0,
    totalLines: 0,
    bound: { bytes: 0, lines: 0, sessions: 0, openSessions: 0 },
    largestBytes: 0,
    perInitiative: [],
  }
  shapes(spec).forEach((shape, i) => {
    const it = initiativeText(spec, shape, i)
    const file = join(sofar, 'initiatives', it.slug, 'events.jsonl')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, it.text)
    summary.totalBytes += it.bytes
    summary.totalLines += it.lines
    summary.largestBytes = Math.max(summary.largestBytes, it.bytes)
    summary.perInitiative.push({ slug: it.slug, bytes: it.bytes, lines: it.lines, sessions: it.sessions })
    if (i === 0) summary.bound = { bytes: it.bytes, lines: it.lines, sessions: it.sessions, openSessions: it.openSessions }
  })
  return summary
}

/**
 * The growth budget a spec implies, per user per week, from the profiles
 * alone (rust-core 1.5): `sessionsPerUserPerWeek` sessions at the blended
 * events-per-session and bytes-per-event.
 */
export function growthBudget(spec: CorpusSpec, sessionsPerUserPerWeek: number): { eventsPerUserWeek: number; bytesPerUserWeek: number } {
  const ev = spec.humanShare * HUMAN.eventsPerSession + (1 - spec.humanShare) * AGENT.eventsPerSession
  const bytes = spec.humanShare * HUMAN.eventsPerSession * HUMAN.bytesPerEvent + (1 - spec.humanShare) * AGENT.eventsPerSession * AGENT.bytesPerEvent
  return { eventsPerUserWeek: Math.round(ev * sessionsPerUserPerWeek), bytesPerUserWeek: Math.round(bytes * sessionsPerUserPerWeek) }
}
