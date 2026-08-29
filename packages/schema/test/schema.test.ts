import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, isKnownEventType, validatePayload } from '../src/events'

const validPayloads: Record<string, Record<string, unknown>> = {
  initiative_created: { slug: 'sofar-build', goal: 'Build the v1 engine' },
  initiative_status_changed: { status: 'done', note: 'v1 engine shipped' },
  plan_updated: {
    plan: {
      goal: 'Build it',
      phases: [
        {
          name: 'Phase 1',
          status: 'active',
          tasks: [{ id: '1.1', title: 'Scaffold', status: 'done' }],
        },
        { name: 'Phase 2', tasks: [] },
      ],
    },
  },
  phase_status_changed: { phase: 'Phase 1', status: 'active' },
  task_added: { phase: 'Phase 1', id: '1.7', title: 'Extra task' },
  task_status_changed: { id: '1.1', status: 'done' },
  decision_logged: { chose: 'TypeScript', over: 'Rust', because: 'MCP SDK maturity' },
  session_started: { tool: 'claude-code', model: 'claude-fable-5' },
  session_ended: { summary: 'Built the log core', next_action: 'Start MCP server' },
  session_closed: { reason: 'exit' },
  file_touched: { path: 'src/core/log.ts', op: 'edit' },
  command_run: { cmd: 'npm test' },
  note_added: { text: 'esbuild banner needed for CJS interop' },
  memory_promoted: { text: 'Release: `npm publish -w sofar.sh` from the root, run by the user' },
  review_recorded: {
    scope: 'phase',
    verdict: 'findings',
    watermark: '0415062a1b2c3d4e5f60718293a4b5c6d7e8f900',
    phase: 'Phase 1',
    findings: ['4.2 emitted a two-dot range that dropped the oldest commit'],
  },
  run_started: {
    run: '01JZ8B3V0N5B4W8XK2M9QF7TSE',
    adapter: 'claude-code',
    policy: 'threshold',
    threshold_pct: 70,
    context_window: 200_000,
  },
  handoff: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSE', session_id: 's1', reason: 'task_done', task: '1.2', tokens: 84_000 },
  run_stopped: { run: '01JZ8B3V0N5B4W8XK2M9QF7TSE', reason: 'needs_user', note: 'next action names a release' },
  correction: { ref: '01JZ8B3V0N5B4W8XK2M9QF7TSD' },
}

describe('event type registry', () => {
  it('covers exactly the SPEC §Event types', () => {
    expect([...EVENT_TYPES].sort()).toEqual(Object.keys(validPayloads).sort())
  })

  it('isKnownEventType rejects unknown types', () => {
    expect(isKnownEventType('note_added')).toBe(true)
    expect(isKnownEventType('telemetry_emitted')).toBe(false)
  })
})

describe('validatePayload', () => {
  for (const [type, payload] of Object.entries(validPayloads)) {
    it(`accepts a valid ${type} payload`, () => {
      expect(validatePayload(type, payload)).toEqual({ ok: true })
    })
  }

  it('rejects unknown event types', () => {
    const result = validatePayload('telemetry_emitted', {})
    expect(result.ok).toBe(false)
  })

  it('rejects non-object payloads', () => {
    expect(validatePayload('note_added', 'text').ok).toBe(false)
    expect(validatePayload('note_added', null).ok).toBe(false)
  })

  const invalidCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['initiative_created', { slug: 'x' }, /goal/],
    ['plan_updated', { plan: { phases: 'nope' } }, /phases/],
    ['plan_updated', { plan: { phases: [{ name: '', tasks: [] }] } }, /name/],
    ['plan_updated', { plan: { phases: [{ name: 'P', tasks: [{ id: '1', title: 'T', status: 'wip' }] }] } }, /status/],
    ['phase_status_changed', { phase: 'P', status: 'started' }, /status/],
    ['task_added', { phase: 'P', id: '', title: 'T' }, /id/],
    ['task_status_changed', { id: '1.1', status: 'finished' }, /status/],
    ['decision_logged', { chose: 'a', over: 'b' }, /because/],
    ['decision_logged', { chose: 'a', over: 'b', because: 'c', rule: '' }, /rule/],
    ['session_started', { model: 'm' }, /tool/],
    ['session_ended', { summary: 'did things' }, /next_action/],
    ['session_closed', {}, /reason/],
    ['session_closed', { reason: '' }, /reason/],
    ['file_touched', { path: 'a.ts' }, /op/],
    ['command_run', {}, /cmd/],
    ['note_added', { text: '' }, /text/],
    ['run_started', { adapter: 'claude-code', policy: 'task' }, /run/],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'vibes' }, /policy/],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'threshold' }, /threshold_pct: required/],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'threshold', threshold_pct: 130 }, /threshold_pct/],
    [
      'run_started',
      { run: 'r', adapter: 'claude-code', policy: 'threshold', threshold_pct: 70 },
      /context_window: required/,
    ],
    ['run_started', { run: 'r', adapter: 'claude-code', policy: 'task', max_sessions: 0 }, /max_sessions/],
    ['handoff', { run: 'r', reason: 'task_done' }, /session_id/],
    ['handoff', { run: 'r', session_id: 's', reason: 'bored' }, /reason/],
    ['handoff', { run: 'r', session_id: 's', reason: 'threshold', tokens: -1 }, /tokens/],
    ['run_stopped', { run: 'r', reason: 'crashed' }, /reason/],
    ['run_stopped', { run: 'r', reason: 'error' }, /note: required/],
    ['correction', {}, /ref/],
  ]

  for (const [type, payload, pattern] of invalidCases) {
    it(`rejects invalid ${type} payload (${pattern})`, () => {
      const result = validatePayload(type, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join('; ')).toMatch(pattern)
    })
  }

  it('accepts decision_logged carrying a standing-constraint rule (drift-hardening D1)', () => {
    expect(
      validatePayload('decision_logged', {
        chose: 'version gate',
        over: 'unconditional emit',
        because: 'field breakage',
        rule: 'Never emit `@source not` when the installed tailwindcss is below 4.1.',
      }),
    ).toEqual({ ok: true })
  })
})
