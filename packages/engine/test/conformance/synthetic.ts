import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serializeEvent } from '../../src/core/log'
import type { EventEnvelope } from '../../src/core/envelope'
import { FIXTURES } from './harness'

/**
 * Synthetic fixture records (rust-core 1.2): small, hand-shaped logs that
 * hit the branches the real records never do — corrupt and unknown lines,
 * UTF-16 clip edges, budget overflow, guarded decisions, closed and
 * superseded records. Every id and timestamp is FIXED (a deterministic ulid
 * from a 2026-09-01 clock), so the files are reproducible and the goldens
 * recorded against them are stable.
 *
 * The builders are the source of truth; the files under
 * fixtures/synthetic/<name>/dot-sofar/ are what an implementation is run
 * against, checked in so a port can read its inputs without running
 * anything. `staleSynthetic` fails the suite when the two disagree, which
 * is the cue to re-record (README).
 *
 * `serializeEvent` from the engine is the ONE engine import in the suite,
 * and it only shapes INPUTS: the fixture lines are canonical bytes an
 * implementation reads, never bytes it is judged on.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulidAt(ms: number, seq: number): string {
  let time = ''
  let t = ms
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time
    t = Math.floor(t / 32)
  }
  let rand = ''
  let s = seq
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[s % 32]! + rand
    s = Math.floor(s / 32)
  }
  return time + rand
}

export const EPOCH = Date.parse('2026-09-01T10:00:00.000Z')
export const FIXTURE_USER = 'fixture@example.invalid'

interface EvOptions {
  session?: string
  source?: EventEnvelope['source']
  actor?: EventEnvelope['actor']
  user?: string | null
  /** Milliseconds after the previous event; default 60 s. */
  after?: number
  /** Extra envelope keys (preserved-unknown-field coverage). */
  extra?: Record<string, unknown>
}

/** A log builder with a monotonic clock. Lines can also be raw strings (corrupt cases). */
export class LogBuilder {
  readonly lines: string[] = []
  private ms: number
  private seq = 0

  constructor(
    readonly slug: string,
    startMs: number = EPOCH,
  ) {
    this.ms = startMs
  }

  /** Mint the next envelope without appending it (for duplicates and reordering). */
  mint(type: string, payload: Record<string, unknown>, o: EvOptions = {}): EventEnvelope {
    this.ms += o.after ?? 60_000
    this.seq += 1
    const id = ulidAt(this.ms, this.seq)
    const user = o.user === null ? undefined : (o.user ?? FIXTURE_USER)
    const event = {
      v: 1 as const,
      id,
      ts: new Date(this.ms).toISOString(),
      initiative: this.slug,
      session: o.session ?? 'cli',
      source: o.source ?? 'cli',
      actor: o.actor ?? 'agent',
      ...(user !== undefined ? { user } : {}),
      type,
      payload,
      ...(o.extra ?? {}),
    }
    return event as EventEnvelope
  }

  ev(type: string, payload: Record<string, unknown>, o: EvOptions = {}): EventEnvelope {
    const event = this.mint(type, payload, o)
    this.lines.push(serializeEvent(event))
    return event
  }

  raw(line: string): void {
    this.lines.push(line)
  }

  text(): string {
    return `${this.lines.join('\n')}\n`
  }
}

export type FixtureFiles = Record<string, string>

function bindings(map: Record<string, string>): string {
  return `${JSON.stringify(map, null, 2)}\n`
}

function plan(
  goal: string,
  phases: Array<{ name: string; status?: string; tasks: Array<Record<string, unknown>> }>,
): Record<string, unknown> {
  return { plan: { goal, phases } }
}

const HOOK = { source: 'hook' } as const

// ---------------------------------------------------------------------------
// Builders.
// ---------------------------------------------------------------------------

/** A healthy small record with a registered, drifted session (5 unwritten mutations). */
function baseline(): FixtureFiles {
  const b = new LogBuilder('baseline')
  const goal = 'a small healthy record for the hook lifecycle'
  b.ev('initiative_created', { slug: 'baseline', goal }, { actor: 'human' })
  b.ev(
    'plan_updated',
    plan(goal, [
      {
        name: 'Build',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'first task', status: 'done' },
          { id: '1.2', title: 'second task', status: 'active' },
          { id: '1.3', title: 'third task' },
        ],
      },
      { name: 'Ship', tasks: [{ id: '2.1', title: 'release' }] },
    ]),
  )
  b.ev('decision_logged', { chose: 'vitest', over: 'jest', because: 'already in the workspace' })
  b.ev('decision_logged', {
    chose: 'append-only log',
    over: 'a mutable state file',
    because: 'history is the product',
    rule: 'Never rewrite events.jsonl; unknown lines are skipped with a warning.',
  })
  b.ev('note_added', { text: 'a note that the digest may surface' })
  b.ev('memory_promoted', { text: 'Test command: npm test (vitest).' })
  b.ev('session_started', { tool: 'claude-code', model: 'claude-fable-5' }, { session: 'sess-done', ...HOOK })
  b.ev('task_status_changed', { id: '1.1', status: 'done' }, { session: 'sess-done' })
  b.ev(
    'session_ended',
    { summary: 'finished 1.1 and set 1.2 active', next_action: 'implement 1.2 against the fixture' },
    { session: 'sess-done' },
  )
  // A registered session that has drifted: five mutations, no write-back.
  b.ev('session_started', { tool: 'claude-code' }, { session: 'sess-open', ...HOOK })
  for (let i = 0; i < 5; i++) {
    b.ev('file_touched', { path: `src/module/file-${i}.ts`, op: i === 0 ? 'write' : 'edit' }, { session: 'sess-open', ...HOOK })
  }
  b.ev('command_run', { cmd: 'npm test' }, { session: 'sess-open', ...HOOK })
  return {
    'bindings.json': bindings({ main: 'baseline' }),
    'repo.md': '# Repo memory\n\n- Test command: npm test\n- Build: npm run build\n',
    'initiatives/baseline/events.jsonl': b.text(),
  }
}

/** Every tolerated defect the fold must skip with the right warning, in one log. */
function corrupt(): FixtureFiles {
  const b = new LogBuilder('corrupt')
  const goal = 'survive every defect the fold tolerates'
  const created = b.ev('initiative_created', { slug: 'corrupt', goal })
  b.ev(
    'plan_updated',
    plan(goal, [
      {
        name: 'Build',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'known status', status: 'done' },
          { id: '1.2', title: 'unknown status', status: 'wip' },
        ],
      },
      { name: 'Later', status: 'someday', tasks: [{ id: '2.1', title: 'later' }] },
    ]),
  )
  b.raw('')
  b.raw('   ')
  b.raw('{"v":1,"id":"01K4C0000000000000000TORN","ts":"2026-09-01T10:05:00.000Z","initiative":"corrupt","ses')
  b.raw('[1,2,3]')
  b.raw('"just a string"')
  b.raw(
    '{"v":1,"id":"01K4C00000000000000000BAD","ts":"2026-13-45T99:00:00Z","initiative":"corrupt","session":"cli","source":"cli","actor":"agent","type":"note_added","payload":{"text":"bad ts"}}',
  )
  b.raw(
    '{"v":1,"id":"01K4C0000000000000000NOTS","initiative":"corrupt","session":"cli","source":"cli","actor":"agent","type":"note_added","payload":{"text":"missing ts"}}',
  )
  b.raw(
    '{"v":1,"id":"01K4C0000000000000000NOPL","ts":"2026-09-01T10:06:00.000Z","initiative":"corrupt","session":"cli","source":"cli","actor":"agent","type":"note_added","payload":"not an object"}',
  )
  b.ev('future_event', { anything: true })
  b.ev('task_status_changed', { status: 'done' })
  b.ev('task_status_changed', { id: '9.9', status: 'done' })
  const voided = b.ev('note_added', { text: 'this note is voided by a correction' })
  b.ev('correction', { ref: voided.id, reason: 'wrong record' })
  b.raw(serializeEvent(created)) // exact duplicate line (same id)
  // Out of order: minted now but carrying an older clock than the lines above.
  const early = b.mint('note_added', { text: 'minted late, sorts early' }) as { id: string; ts: string }
  early.id = ulidAt(EPOCH + 90_000, 999)
  early.ts = new Date(EPOCH + 90_000).toISOString()
  b.raw(serializeEvent(early as unknown as EventEnvelope))
  b.ev('session_ended', { summary: 'ghost summary', next_action: 'ghost next' }, { session: 'ghost' })
  b.ev('session_closed', { reason: 'exit' }, { session: 'ghost2', ...HOOK })
  b.ev('phase_status_changed', { phase: 'Nowhere', status: 'active' })
  b.ev('task_added', { phase: 'Build', id: '1.1', title: 'duplicate id' })
  b.ev('task_added', { phase: 'Build', id: '1.3', title: 'added later', status: 'pending' })
  b.ev('run_stopped', { run: 'r-never', reason: 'interrupted' })
  b.ev('handoff', { run: 'r-never', session_id: 'x', reason: 'task_done' })
  b.ev('run_stop_requested', { run: 'r-never' })
  b.ev('note_added', { text: 'extra envelope keys are preserved' }, { extra: { zeta: 1, alpha: { b: 2, a: 1 } } })
  b.raw(`   ${serializeEvent(b.mint('note_added', { text: 'padded with spaces' }))}   `)
  b.ev('session_started', { tool: 'claude-code' }, { session: 'sess-a', ...HOOK })
  b.ev('session_started', { tool: 'codex' }, { session: 'sess-a', ...HOOK })
  b.ev('file_touched', { path: 'src/a.ts', op: 'edit' }, { session: 'sess-a', ...HOOK })
  b.raw(
    '{"v":1,"id":"01K4C0000000000000000LAST","ts":"2026-09-01T11:00:00.000Z","initiative":"corrupt","session":"cli","source":"cli","actor":"agent","type":"note_added","payload":{"text":"torn tail with no newline"',
  )
  return {
    'bindings.json': bindings({ main: 'corrupt' }),
    // Deliberately no trailing newline: a torn tail mid-write.
    'initiatives/corrupt/events.jsonl': b.lines.join('\n'),
  }
}

/** UTF-16 and JSON edges: every P1–P5 pin in docs/HOTPATH.md has a byte here. */
function unicode(): FixtureFiles {
  const b = new LogBuilder('unicode')
  const goal = `${'g'.repeat(590)}${'\u{1F600}'.repeat(20)} tail after the emoji run`
  b.ev('initiative_created', { slug: 'unicode', goal })
  b.ev(
    'plan_updated',
    plan(goal, [
      {
        name: 'Phase with line separator',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'tab\tand nbsp　ideographic﻿bom', status: 'active' },
          { id: '1.2', title: '\u{1F600}'.repeat(120), status: 'pending' },
          { id: '1.3', title: 'quotes " and backslash \\ and slash / and control ', status: 'pending' },
        ],
      },
    ]),
  )
  b.ev('note_added', {
    text: 'a b　c﻿d  e f g h i j k l   m',
    meta: { 'é': 1, Z: 2, a: 3, 'ﬁ': 4, '\u{1F600}': 5, ' ': 6, '10': 7, '9': 8 },
    numbers: [1e21, 1e-7, -0, 1.0, 12345678901234567890, 0.1 + 0.2, 1e300, 5e-324, 100, 1.5e10],
    nulls: [null, undefined, 'x'],
  })
  b.ev('decision_logged', {
    chose: 'naïve — “curly quotes” and — em dashes — plus 日本語',
    over: 'ASCII only',
    because: 'the clip budget counts UTF-16 units: \u{1F600} is two, é is one, 日 is one',
    rule: 'Keep every user-facing string in NFC, never NFD, so 日本語 and é render as single units.',
  })
  b.ev('session_started', { tool: 'claude-code', model: 'claude-fable-5' }, { session: 'sess-u', ...HOOK })
  b.ev('file_touched', { path: 'src/\u{1F600}/naïve.ts', op: 'edit' }, { session: 'sess-u', ...HOOK })
  b.ev('file_touched', { path: 'src/"quoted"\\back.ts', op: 'write' }, { session: 'sess-u', ...HOOK })
  b.ev('command_run', { cmd: 'echo  — done' }, { session: 'sess-u', ...HOOK })
  b.ev(
    'task_status_changed',
    { id: '1.1', status: 'blocked', note: `${'b'.repeat(495)}${'\u{1F600}'.repeat(3)} end` },
    { session: 'sess-u' },
  )
  b.ev(
    'session_ended',
    {
      summary: `${'s'.repeat(1195)}${'\u{1F600}'.repeat(4)} beyond`,
      next_action: `${'n'.repeat(497)}${'\u{1F600}'.repeat(2)} beyond`,
    },
    { session: 'sess-u' },
  )
  return {
    'bindings.json': bindings({ 'feature/ünïcode': 'unicode' }),
    'repo.md': '# Repo memory\n\n- 日本語 line with emoji \u{1F600} and nbsp inside\n',
    'initiatives/unicode/events.jsonl': b.text(),
  }
}

/** Enough plan, decisions and sessions to overflow every render budget. */
function budget(): FixtureFiles {
  const b = new LogBuilder('budget')
  const goal = `${'a goal long enough to be clipped at the six hundred unit budget '.repeat(12)}END`
  b.ev('initiative_created', { slug: 'budget', goal })
  const phases = Array.from({ length: 40 }, (_, p) => ({
    name: `Phase ${p + 1}: ${'a descriptive phase name that runs long '.repeat(3)}`,
    status: p < 20 ? 'done' : p === 20 ? 'active' : 'pending',
    tasks: Array.from({ length: 25 }, (_, t) => ({
      id: `${p + 1}.${t + 1}`,
      title: `task ${p + 1}.${t + 1}: ${'a realistically sized task title that keeps going '.repeat(3)}`,
      status: p < 20 ? 'done' : p === 20 && t === 0 ? 'active' : p === 20 && t === 1 ? 'blocked' : 'pending',
    })),
  }))
  b.ev('plan_updated', plan(goal, phases))
  b.ev('task_status_changed', { id: '21.2', status: 'blocked', note: 'waiting on the run owner' })
  for (let d = 0; d < 20; d++) {
    b.ev('decision_logged', {
      chose: `decision ${d}: ${'chosen text that is long enough to be clipped in the line budget '.repeat(4)}`,
      over: `alternative ${d}: ${'rejected approach prose '.repeat(6)}`,
      because: `because ${d}: ${'rationale prose '.repeat(8)}`,
      ...(d % 2 === 0 ? { rule: `Rule ${d}: ${'standing constraint text '.repeat(6)}` } : {}),
    })
  }
  for (let n = 0; n < 12; n++) b.ev('note_added', { text: `note ${n}: ${'note prose '.repeat(30)}` })
  for (let mem = 0; mem < 6; mem++) b.ev('memory_promoted', { text: `memory ${mem}: ${'operational fact '.repeat(20)}` })
  for (let s = 0; s < 12; s++) {
    const sid = `budget-sess-${s}`
    b.ev('session_started', { tool: 'claude-code', model: 'claude-fable-5' }, { session: sid, ...HOOK })
    for (let f = 0; f < 30; f++) {
      b.ev('file_touched', { path: `src/area-${s}/file-${f}.ts`, op: 'edit' }, { session: sid, ...HOOK })
    }
    b.ev('task_status_changed', { id: `21.${(s % 20) + 3}`, status: 'active' }, { session: sid })
    if (s < 10) {
      b.ev(
        'session_ended',
        {
          summary: `session ${s}: ${'summary prose that is long enough to hit the session summary budget '.repeat(20)}`,
          next_action: `next ${s}: ${'next action prose '.repeat(40)}`,
        },
        { session: sid },
      )
    }
  }
  const repoMd = `# Repo memory\n\n${Array.from({ length: 60 }, (_, i) => `- convention ${i}: ${'a line of repo memory '.repeat(3)}`).join('\n')}\n`
  return {
    'bindings.json': bindings({ main: 'budget' }),
    'repo.md': repoMd,
    'initiatives/budget/events.jsonl': b.text(),
  }
}

/** Guarded decisions and the sessions that cross them. */
function guards(): FixtureFiles {
  const b = new LogBuilder('guards')
  const goal = 'exercise guard matching on the hot path'
  b.ev('initiative_created', { slug: 'guards', goal })
  b.ev('plan_updated', plan(goal, [{ name: 'Build', status: 'active', tasks: [{ id: '1.1', title: 'work', status: 'active' }] }]))
  b.ev('decision_logged', {
    chose: 'freeze the legacy tree',
    over: 'editing it in place',
    because: 'it is being replaced',
    rule: 'Never edit files under src/legacy/.',
    guard: 'path:src/legacy/**,!src/legacy/README.md',
  })
  b.ev('decision_logged', {
    chose: 'publish only from CI',
    over: 'local publishes',
    because: 'provenance',
    rule: 'Never run npm publish from a workstation.',
    guard: 'cmd:*npm publish*,*npm run release*',
  })
  b.ev('decision_logged', {
    chose: 'schema lives in packages/schema',
    over: 'inline types',
    because: 'one source of truth',
    rule: 'Schema changes go through packages/schema/src only.',
    guard: 'path:**/*.ts,!packages/schema/src/**,!src/**',
  })
  b.ev('session_started', { tool: 'claude-code' }, { session: 'sess-g', ...HOOK })
  b.ev('file_touched', { path: 'src/legacy/old.ts', op: 'edit' }, { session: 'sess-g', ...HOOK })
  b.ev('session_started', { tool: 'claude-code' }, { session: 'sess-clean', ...HOOK })
  return {
    'bindings.json': bindings({ main: 'guards' }),
    'initiatives/guards/events.jsonl': b.text(),
  }
}

/** Closed, superseded, dropped and never-written records side by side. */
function lifecycle(): FixtureFiles {
  const done = new LogBuilder('finished')
  const doneGoal = 'a record that was closed with overrides'
  done.ev('initiative_created', { slug: 'finished', goal: doneGoal })
  done.ev(
    'plan_updated',
    plan(doneGoal, [
      {
        name: 'Only',
        status: 'active',
        tasks: [
          { id: '1.1', title: 'left open', status: 'active' },
          { id: '1.2', title: 'dropped', status: 'dropped' },
        ],
      },
    ]),
  )
  done.ev('initiative_status_changed', {
    status: 'done',
    note: 'shipped anyway',
    overrides: ['task 1.1 still active', 'phase Only never marked done', 'no final review recorded', 'a fourth finding'],
  })

  const old = new LogBuilder('old-name', EPOCH + 3_600_000)
  old.ev('initiative_created', { slug: 'old-name', goal: 'a record that continues elsewhere' })
  old.ev(
    'plan_updated',
    plan('a record that continues elsewhere', [
      { name: 'Only', status: 'active', tasks: [{ id: '1.1', title: 'moved', status: 'active' }] },
    ]),
  )
  old.ev('session_started', { tool: 'claude-code' }, { session: 'sess-moved', ...HOOK })
  old.ev('initiative_status_changed', { status: 'superseded', successor: 'new-name', note: 'renamed' })

  const fresh = new LogBuilder('new-name', EPOCH + 7_200_000)
  fresh.ev('initiative_created', { slug: 'new-name', goal: 'the successor record' })
  fresh.ev(
    'plan_updated',
    plan('the successor record', [
      { name: 'Only', status: 'active', tasks: [{ id: '1.1', title: 'continue here', status: 'active' }] },
    ]),
  )
  fresh.ev('session_started', { tool: 'claude-code' }, { session: 'sess-home', ...HOOK })
  fresh.ev('file_touched', { path: 'src/x.ts', op: 'edit' }, { session: 'sess-home', ...HOOK })

  const dropped = new LogBuilder('abandoned', EPOCH + 10_000)
  dropped.ev('initiative_created', { slug: 'abandoned', goal: 'dropped without ceremony' })
  dropped.ev('initiative_status_changed', { status: 'dropped' })

  return {
    'bindings.json': bindings({
      main: 'finished',
      renamed: 'old-name',
      successor: 'new-name',
      dropped: 'abandoned',
      ghost: 'does-not-exist',
      escape: '../../etc',
      blank: 'never-written',
    }),
    'initiatives/finished/events.jsonl': done.text(),
    'initiatives/old-name/events.jsonl': old.text(),
    'initiatives/new-name/events.jsonl': fresh.text(),
    'initiatives/abandoned/events.jsonl': dropped.text(),
    'initiatives/never-written/.keep': '',
  }
}

/** Fourteen records so the unbound notice and listings hit their caps; one has a session working elsewhere. */
function many(): FixtureFiles {
  const files: FixtureFiles = { 'bindings.json': bindings({ main: 'rec-03' }) }
  const names = [
    'rec-01', 'rec-02', 'rec-03', 'rec-04', 'rec-05', 'rec-06', 'rec-07',
    'rec-08', 'rec-09', 'rec-10', 'rec-11', 'Rec-12', 'rec-13', 'rec_14',
  ]
  names.forEach((slug, i) => {
    const b = new LogBuilder(slug, EPOCH + i * 600_000)
    b.ev('initiative_created', { slug, goal: `record ${i + 1} of many` })
    b.ev(
      'plan_updated',
      plan(`record ${i + 1} of many`, [
        { name: 'Only', status: 'active', tasks: [{ id: '1.1', title: 'task', status: i % 2 ? 'active' : 'done' }] },
      ]),
    )
    if (slug === 'rec-13') b.ev('initiative_status_changed', { status: 'done' })
    if (slug === 'rec-10') {
      b.ev('session_started', { tool: 'claude-code' }, { session: 'sess-elsewhere', ...HOOK })
      b.ev('file_touched', { path: 'src/shared.ts', op: 'edit' }, { session: 'sess-elsewhere', ...HOOK })
    }
    files[`initiatives/${slug}/events.jsonl`] = b.text()
  })
  return files
}

export const SYNTHETIC: Record<string, () => FixtureFiles> = {
  baseline,
  corrupt,
  unicode,
  budget,
  guards,
  lifecycle,
  many,
}

export function syntheticDir(name: string): string {
  return join(FIXTURES, 'synthetic', name, 'dot-sofar')
}

/** Write every synthetic fixture to disk (record mode). */
export function writeSynthetic(): void {
  for (const [name, build] of Object.entries(SYNTHETIC)) {
    const base = syntheticDir(name)
    for (const [rel, content] of Object.entries(build())) {
      const path = join(base, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  }
}

/** Builder output that is NOT on disk byte-for-byte: empty when the fixtures are current. */
export function staleSynthetic(): string[] {
  const stale: string[] = []
  for (const [name, build] of Object.entries(SYNTHETIC)) {
    const base = syntheticDir(name)
    const expected = build()
    for (const [rel, content] of Object.entries(expected)) {
      const path = join(base, rel)
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) stale.push(`${name}/${rel}`)
    }
    if (existsSync(base)) {
      for (const rel of walk(base)) if (!(rel in expected)) stale.push(`${name}/${rel} (unexpected)`)
    }
  }
  return stale
}

function walk(base: string, sub = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(base, sub), { withFileTypes: true })) {
    const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(base, rel))
    else out.push(rel)
  }
  return out
}
