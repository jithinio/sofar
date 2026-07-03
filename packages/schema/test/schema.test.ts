import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, isKnownEventType, validatePayload } from '../src/events'

const validPayloads: Record<string, Record<string, unknown>> = {
  initiative_created: { slug: 'harness-build', goal: 'Build the v1 engine' },
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
  file_touched: { path: 'src/core/log.ts', op: 'edit' },
  command_run: { cmd: 'npm test' },
  note_added: { text: 'esbuild banner needed for CJS interop' },
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
    ['session_started', { model: 'm' }, /tool/],
    ['session_ended', { summary: 'did things' }, /next_action/],
    ['file_touched', { path: 'a.ts' }, /op/],
    ['command_run', {}, /cmd/],
    ['note_added', { text: '' }, /text/],
    ['correction', {}, /ref/],
  ]

  for (const [type, payload, pattern] of invalidCases) {
    it(`rejects invalid ${type} payload (${pattern})`, () => {
      const result = validatePayload(type, payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join('; ')).toMatch(pattern)
    })
  }
})
