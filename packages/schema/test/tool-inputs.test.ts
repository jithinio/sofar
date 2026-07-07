import { describe, expect, it } from 'vitest'
import {
  TOOL_DEFS,
  TOOL_INPUT_SCHEMAS,
  TOOL_NAMES,
  isToolName,
  validateToolInput,
  type ToolName,
} from '../src/tool-inputs'

describe('tool contract surface', () => {
  it('declares exactly the seven SPEC §MCP tools', () => {
    expect([...TOOL_NAMES]).toEqual([
      'harness_get_state',
      'harness_start_session',
      'harness_end_session',
      'harness_update_task',
      'harness_log_decision',
      'harness_update_plan',
      'harness_add_note',
    ])
    expect(TOOL_DEFS.map((t) => t.name)).toEqual([...TOOL_NAMES])
  })

  it('isToolName accepts every declared name and rejects others', () => {
    for (const name of TOOL_NAMES) expect(isToolName(name)).toBe(true)
    expect(isToolName('harness_nuke_log')).toBe(false)
    expect(isToolName('')).toBe(false)
  })

  it('every inputSchema is a closed object schema with described properties', () => {
    for (const name of TOOL_NAMES) {
      const schema = TOOL_INPUT_SCHEMAS[name]
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0)
      for (const required of schema.required ?? []) {
        expect(Object.keys(schema.properties)).toContain(required)
      }
    }
  })
})

describe('validateToolInput', () => {
  const valid: Record<ToolName, Record<string, unknown>> = {
    harness_get_state: {},
    harness_start_session: { tool: 'claude-code', model: 'fable-5' },
    harness_end_session: { session_id: 's1', summary: 'did things', next_action: 'do more' },
    harness_update_task: { task_id: '2.1', status: 'done', note: 'green' },
    harness_log_decision: { chose: 'a', over: 'b', because: 'c' },
    harness_update_plan: {
      plan: {
        goal: 'ship',
        phases: [
          { name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 't', status: 'pending' }] },
        ],
      },
    },
    harness_add_note: { text: 'hello' },
  }

  it('accepts a valid argument object for every tool', () => {
    for (const name of TOOL_NAMES) {
      expect(validateToolInput(name, valid[name])).toEqual({ ok: true })
    }
  })

  it('accepts explicit initiative on tools that take one', () => {
    expect(validateToolInput('harness_get_state', { initiative: 'demo' })).toEqual({ ok: true })
    expect(validateToolInput('harness_add_note', { initiative: 'demo', text: 'x' })).toEqual({
      ok: true,
    })
  })

  it('rejects non-object arguments', () => {
    const res = validateToolInput('harness_add_note', 'text')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['arguments: must be a JSON object'])
  })

  it('rejects missing required fields with field-level errors', () => {
    const res = validateToolInput('harness_end_session', { summary: 'x' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors).toContain('session_id: must be a non-empty string')
      expect(res.errors).toContain('next_action: must be a non-empty string')
    }
  })

  it('rejects unknown arguments (additionalProperties: false, enforced)', () => {
    const res = validateToolInput('harness_add_note', { text: 'x', urgency: 'high' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors[0]).toMatch(/^urgency: unknown argument/)
  })

  it('start_session session_id is optional but must be non-empty when given (7.1, BD43)', () => {
    expect(
      validateToolInput('harness_start_session', { tool: 'claude-code', session_id: 'sess-1' }),
    ).toEqual({ ok: true })
    const res = validateToolInput('harness_start_session', { tool: 'claude-code', session_id: '' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['session_id: must be a non-empty string'])
  })

  it('rejects a bad task status with the allowed set in the message', () => {
    const res = validateToolInput('harness_update_task', { task_id: '1', status: 'finished' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['status: must be one of pending|active|done|blocked'])
  })

  it('update_plan reuses the PlanStructure validator (field paths preserved)', () => {
    const res = validateToolInput('harness_update_plan', {
      plan: { phases: [{ name: '', tasks: [{ id: '1', title: '' }] }] },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.errors).toContain('plan.phases[0].name: must be a non-empty string')
      expect(res.errors).toContain('plan.phases[0].tasks[0].title: must be a non-empty string')
    }
  })

  it('update_plan rejects a missing plan entirely', () => {
    const res = validateToolInput('harness_update_plan', {})
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors).toEqual(['plan: must be an object'])
  })
})
