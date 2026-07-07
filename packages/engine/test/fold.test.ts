import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, foldLog, type InitiativeState } from '../src/core/fold'
import { appendEvents, serializeEvent } from '../src/core/log'

const scratch = mkdtempSync(join(tmpdir(), 'harness-fold-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function ev(
  type: string,
  payload: Record<string, unknown>,
  overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {},
): EventEnvelope {
  return makeEvent({
    initiative: 'harness-build',
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
    ...overrides,
  })
}

/** A representative, well-formed event sequence used across tests. */
function storyline(): EventEnvelope[] {
  return [
    ev('initiative_created', { slug: 'harness-build', goal: 'Build the v1 engine' }),
    ev('plan_updated', {
      plan: {
        phases: [
          {
            name: 'Phase 1 — Event log core',
            tasks: [
              { id: '1.1', title: 'Scaffold' },
              { id: '1.2', title: 'Envelope' },
            ],
          },
          { name: 'Phase 2 — MCP server', tasks: [{ id: '2.1', title: 'stdio server' }] },
        ],
      },
    }),
    ev('phase_status_changed', { phase: 'Phase 1 — Event log core', status: 'active' }),
    ev('session_started', { tool: 'claude-code', model: 'claude-fable-5' }),
    ev('task_status_changed', { id: '1.1', status: 'active' }),
    ev('file_touched', { path: 'src/core/log.ts', op: 'write' }),
    ev('file_touched', { path: 'src/core/log.ts', op: 'edit' }), // dup path → dedupe
    ev('file_touched', { path: 'test/log.test.ts', op: 'write' }),
    ev('command_run', { cmd: 'npm test' }),
    ev('decision_logged', { chose: 'O_APPEND', over: 'lockfile', because: 'kernel-atomic, simpler' }),
    ev('note_added', { text: 'lines stay under PIPE_BUF' }),
    ev('task_status_changed', { id: '1.1', status: 'done' }),
    ev('session_ended', { summary: 'Scaffold + log done', next_action: 'Fold next' }),
  ]
}

function lines(events: EventEnvelope[]): string[] {
  return events.map(serializeEvent)
}

describe('foldLines', () => {
  it('folds a well-formed log into the SPEC §State shape', () => {
    const events = storyline()
    const { state, warnings } = foldLines(lines(events))

    expect(warnings).toEqual([])
    expect(state.slug).toBe('harness-build')
    expect(state.goal).toBe('Build the v1 engine')

    expect(state.phases).toHaveLength(2)
    expect(state.phases[0]).toEqual({
      name: 'Phase 1 — Event log core',
      status: 'active',
      tasks: [
        { id: '1.1', title: 'Scaffold', status: 'done' },
        { id: '1.2', title: 'Envelope', status: 'pending' },
      ],
    })

    expect(state.decisions).toHaveLength(1)
    expect(state.decisions[0]).toMatchObject({
      chose: 'O_APPEND',
      over: 'lockfile',
      because: 'kernel-atomic, simpler',
    })

    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      id: 'sess-1',
      tool: 'claude-code',
      summary: 'Scaffold + log done',
    })
    expect(state.sessions[0]?.ended).toBeDefined()

    expect(state.files_touched).toEqual(['src/core/log.ts', 'test/log.test.ts'])

    expect(state.current.active_phase).toBe('Phase 1 — Event log core')
    expect(state.current.next_action).toBe('Fold next')
    expect(state.current.blocked_on).toBeUndefined()

    expect(state.cursor).toBe(events[events.length - 1]?.id)
  })

  it('is deterministic: same log → deep-equal state and warnings (acceptance)', () => {
    const log = [
      ...lines(storyline()),
      'not json at all',
      lines([ev('mystery_event', { x: 1 })])[0]!,
    ]
    const a = foldLines(log)
    const b = foldLines(log)
    expect(a.state).toEqual(b.state)
    expect(a.warnings).toEqual(b.warnings)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
  })

  it('skips a corrupt line with a warning, never fatally (acceptance)', () => {
    const events = storyline()
    const log = lines(events)
    log.splice(4, 0, '{"v":1,"id":"trunca') // injected corrupt line mid-log

    const { state, warnings } = foldLines(log)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/line 5: unparseable JSON/)
    expect(state.slug).toBe('harness-build') // everything else still folded
    expect(state.cursor).toBe(events[events.length - 1]?.id)
  })

  it('tolerates a torn final line (crash mid-append)', () => {
    const events = storyline()
    const full = lines(events)
    const lastLine = full[full.length - 1]!
    const torn = [...full.slice(0, -1), lastLine.slice(0, Math.floor(lastLine.length / 2))]

    const { state, warnings } = foldLines(torn)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/torn or corrupt/)
    // state reflects everything before the torn line
    expect(state.cursor).toBe(events[events.length - 2]?.id)
  })

  it('skips unknown event types with a warning but advances the cursor', () => {
    const future = ev('hologram_rendered', { pixels: 12 })
    const { state, warnings } = foldLines(lines([...storyline(), future]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/unknown event type "hologram_rendered"/)
    expect(state.cursor).toBe(future.id)
  })

  it('skips known-type events with invalid payloads, with a warning', () => {
    const bad = ev('task_status_changed', { id: '1.2', status: 'finished' })
    const { state, warnings } = foldLines(lines([...storyline(), bad]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/invalid task_status_changed payload/)
    const task = state.phases[0]?.tasks.find((t) => t.id === '1.2')
    expect(task?.status).toBe('pending')
  })

  it('ignores blank lines silently', () => {
    const log = ['', ...lines(storyline()), '', '']
    expect(foldLines(log).warnings).toEqual([])
  })

  it('voids the event referenced by a correction (BD8)', () => {
    const events = storyline()
    const wrongDone = events.find(
      (e) => e.type === 'task_status_changed' && (e.payload as { status?: string }).status === 'done',
    )!
    const correction = ev('correction', { ref: wrongDone.id, reason: 'marked done prematurely' })

    const { state, warnings } = foldLines(lines([...events, correction]))
    expect(warnings).toEqual([])
    const task = state.phases[0]?.tasks.find((t) => t.id === '1.1')
    expect(task?.status).toBe('active') // the voided "done" never applied
  })

  it('derives blocked_on from blocked tasks, preferring the blocking note', () => {
    const extra = [
      ev('task_status_changed', { id: '1.2', status: 'blocked', note: 'waiting on SDK release' }),
      ev('task_status_changed', { id: '2.1', status: 'blocked' }),
    ]
    const { state } = foldLines(lines([...storyline(), ...extra]))
    expect(state.current.blocked_on).toBe(
      'task 1.2: waiting on SDK release; task 2.1 (stdio server)',
    )
  })

  it('clears blocked_on when the task unblocks', () => {
    const extra = [
      ev('task_status_changed', { id: '1.2', status: 'blocked', note: 'waiting' }),
      ev('task_status_changed', { id: '1.2', status: 'active' }),
    ]
    const { state } = foldLines(lines([...storyline(), ...extra]))
    expect(state.current.blocked_on).toBeUndefined()
  })

  it('creates a stub session (with warning) for session_ended without session_started', () => {
    const orphan = ev(
      'session_ended',
      { summary: 'ghost session', next_action: 'none' },
      { session: 'sess-ghost' },
    )
    const { state, warnings } = foldLines(lines([...storyline(), orphan]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/ended without session_started/)
    expect(state.sessions.find((s) => s.id === 'sess-ghost')?.tool).toBe('unknown')
  })

  it('session_closed sets ended only — summary and next_action untouched (BD21)', () => {
    const events = [
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-hook', source: 'hook' }),
      ev('session_closed', { reason: 'exit' }, { session: 'sess-hook', source: 'hook' }),
    ]
    const { state, warnings } = foldLines(lines(events))
    expect(warnings).toEqual([])
    const session = state.sessions.find((s) => s.id === 'sess-hook')
    expect(session?.ended).toBeDefined()
    expect(session?.summary).toBeUndefined()
    expect(session?.next_action).toBeUndefined()
    expect(state.current.next_action).toBeNull()
  })

  it('session_closed never overrides an earlier session_ended timestamp or write-back', () => {
    const closed = ev('session_closed', { reason: 'exit' }, { session: 'sess-1', source: 'hook' })
    const { state, warnings } = foldLines(lines([...storyline(), closed]))
    expect(warnings).toEqual([])
    const session = state.sessions.find((s) => s.id === 'sess-1')
    expect(session?.summary).toBe('Scaffold + log done')
    expect(session?.next_action).toBe('Fold next')
    expect(state.current.next_action).toBe('Fold next')
  })

  it('session_closed for an unregistered session warns and creates no stub', () => {
    const orphan = ev('session_closed', { reason: 'exit' }, { session: 'sess-never-started' })
    const { state, warnings } = foldLines(lines([...storyline(), orphan]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/closed without session_started — skipped/)
    expect(state.sessions.some((s) => s.id === 'sess-never-started')).toBe(false)
  })

  it('session_started retains model and session_ended retains per-session next_action', () => {
    const { state } = foldLines(lines(storyline()))
    expect(state.sessions[0]?.model).toBe('claude-fable-5')
    expect(state.sessions[0]?.next_action).toBe('Fold next')
  })

  it('session_closed records its reason when it sets ended; a prior write-back suppresses it (7.2, BD44)', () => {
    const crashed = [
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-crash', source: 'hook' }),
      ev('session_closed', { reason: 'crash' }, { session: 'sess-crash', source: 'hook' }),
    ]
    const { state } = foldLines(lines(crashed))
    expect(state.sessions[0]?.closed_reason).toBe('crash')

    // storyline's sess-1 wrote back first — the later close carries nothing
    const closedAfterEnd = ev('session_closed', { reason: 'exit' }, { session: 'sess-1', source: 'hook' })
    const written = foldLines(lines([...storyline(), closedAfterEnd])).state
    expect(written.sessions[0]?.closed_reason).toBeUndefined()
  })

  it('plan_updated fully replaces the plan structure', () => {
    const replace = ev('plan_updated', {
      plan: {
        goal: 'Revised goal',
        phases: [{ name: 'Only phase', status: 'active', tasks: [] }],
      },
    })
    const { state } = foldLines(lines([...storyline(), replace]))
    expect(state.goal).toBe('Revised goal')
    expect(state.phases).toHaveLength(1)
    expect(state.current.active_phase).toBe('Only phase')
  })

  it('warns and skips duplicate task_added ids', () => {
    const dup = ev('task_added', { phase: 'Phase 2 — MCP server', id: '1.1', title: 'Duplicate' })
    const { state, warnings } = foldLines(lines([...storyline(), dup]))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/already exists/)
    expect(state.phases[1]?.tasks).toHaveLength(1)
  })
})

describe('derived per-session activity (7.2, BD44)', () => {
  it('aggregates files (deduped, first-touch order), command count, and task changes per session', () => {
    const { state, warnings } = foldLines(lines(storyline()))
    expect(warnings).toEqual([])
    expect(state.sessions[0]?.activity).toEqual({
      files: ['src/core/log.ts', 'test/log.test.ts'], // dup touch collapsed
      commands: 1,
      task_changes: ['1.1 → active', '1.1 → done'], // log order, one entry per change
    })
  })

  it('attributes strictly by envelope.session: interleaved sessions never leak into each other', () => {
    const events = [
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-a', source: 'hook' }),
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-b', source: 'hook' }),
      ev('file_touched', { path: 'a1.ts', op: 'edit' }, { session: 'sess-a', source: 'hook' }),
      ev('file_touched', { path: 'b1.ts', op: 'write' }, { session: 'sess-b', source: 'hook' }),
      ev('command_run', { cmd: 'npm test' }, { session: 'sess-a', source: 'hook' }),
      ev('file_touched', { path: 'a2.ts', op: 'edit' }, { session: 'sess-a', source: 'hook' }),
    ]
    const { state } = foldLines(lines(events))
    expect(state.sessions.find((s) => s.id === 'sess-a')?.activity).toEqual({
      files: ['a1.ts', 'a2.ts'],
      commands: 1,
      task_changes: [],
    })
    expect(state.sessions.find((s) => s.id === 'sess-b')?.activity).toEqual({
      files: ['b1.ts'],
      commands: 0,
      task_changes: [],
    })
  })

  it('session "cli" is never aggregated and unregistered session ids stay unattached', () => {
    const events = [
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-quiet', source: 'hook' }),
      ev('file_touched', { path: 'cli.ts', op: 'edit' }, { session: 'cli', source: 'cli' }),
      ev('command_run', { cmd: 'ls' }, { session: 'sess-never-registered', source: 'hook' }),
    ]
    const { state } = foldLines(lines(events))
    // no mechanical events on sess-quiet → no activity key at all
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]?.activity).toBeUndefined()
    expect(state.sessions.some((s) => s.id === 'cli')).toBe(false)
  })

  it('caps lists at 20 entries with a "+N more" sentinel; counts stay exact and deterministic', () => {
    const events = [
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-busy', source: 'hook' }),
      ...Array.from({ length: 25 }, (_, i) =>
        ev('file_touched', { path: `src/f${i}.ts`, op: 'edit' }, { session: 'sess-busy', source: 'hook' }),
      ),
    ]
    const serialized = lines(events)
    const { state } = foldLines(serialized)
    const activity = state.sessions[0]!.activity!
    expect(activity.files).toHaveLength(21)
    expect(activity.files[0]).toBe('src/f0.ts')
    expect(activity.files[19]).toBe('src/f19.ts')
    expect(activity.files[20]).toBe('+5 more')

    // determinism: same log → deep-equal activity
    expect(foldLines(serialized).state).toEqual(state)
  })

  it('a voided (corrected) mechanical event does not count toward activity', () => {
    const touched = ev('file_touched', { path: 'oops.ts', op: 'edit' }, { session: 'sess-fix', source: 'hook' })
    const events = [
      ev('session_started', { tool: 'claude-code' }, { session: 'sess-fix', source: 'hook' }),
      touched,
      ev('command_run', { cmd: 'npm test' }, { session: 'sess-fix', source: 'hook' }),
      ev('correction', { ref: touched.id }, { session: 'sess-fix' }),
    ]
    const { state } = foldLines(lines(events))
    expect(state.sessions[0]?.activity).toEqual({ files: [], commands: 1, task_changes: [] })
  })
})

describe('foldLog', () => {
  it('reads a real appended file and matches foldLines of the same events', () => {
    const logPath = join(scratch, 'events.jsonl')
    const events = storyline()
    appendEvents(logPath, events)

    const fromFile = foldLog(logPath)
    const fromLines = foldLines(lines(events))
    expect(fromFile.state).toEqual(fromLines.state)
    expect(fromFile.warnings).toEqual([])
  })

  it('acceptance: fold of an appended log with an injected corrupt line succeeds with warning', () => {
    const logPath = join(scratch, 'corrupt.jsonl')
    const events = storyline()
    appendEvents(logPath, events.slice(0, 6))
    // simulate a torn write followed by more good appends
    writeFileSync(logPath, '{"v":1,"id":"XYZ', { flag: 'a' })
    writeFileSync(logPath, '\n', { flag: 'a' })
    appendEvents(logPath, events.slice(6))

    const { state, warnings } = foldLog(logPath)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/unparseable JSON/)
    expect(state.slug).toBe('harness-build')
    expect(state.cursor).toBe(events[events.length - 1]?.id)

    const clean = foldLines(lines(events))
    expect(state).toEqual(clean.state)
  })
})

// InitiativeState is JSON-safe by construction; this guards against Dates/Maps sneaking in.
describe('state shape', () => {
  it('survives a JSON round-trip unchanged', () => {
    const { state } = foldLines(lines(storyline()))
    const roundTripped = JSON.parse(JSON.stringify(state)) as InitiativeState
    expect(roundTripped).toEqual(state)
  })
})
