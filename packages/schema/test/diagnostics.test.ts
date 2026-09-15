import { describe, expect, it } from 'vitest'
import {
  clipDiagnosticText,
  DIAGNOSTIC_ERROR_CLIP,
  DIAGNOSTIC_KINDS,
  diagnosticKindsDisjointFromEvents,
  isDiagnosticKind,
  validateDiagnosticRow,
  type DiagnosticRow,
} from '../src/diagnostics'
import { EVENT_TYPES } from '../src/events'

/**
 * Private diagnostics row shape (self-improve D2). The engine-side store,
 * the envelope disjointness proof and the export-boundary sentinel live in
 * packages/engine/test/diagnostics.test.ts; this file pins the schema alone.
 */

function row(overrides: Partial<DiagnosticRow> = {}): Record<string, unknown> {
  return {
    d: 1,
    ts: '2026-09-15T10:00:00.000Z',
    engine: '0.33.0',
    host: { tool: 'claude-code' },
    clone: 'abc123',
    initiative: 'self-improve',
    session: 'sess-1',
    kind: 'tool_outcome',
    data: { tool: 'Bash', ok: true, exit: 0, head: 'npm' },
    ...overrides,
  }
}

describe('diagnostics row schema', () => {
  it('accepts one well-formed row per kind', () => {
    expect(validateDiagnosticRow(row())).toEqual({ ok: true })
    expect(
      validateDiagnosticRow(
        row({ kind: 'tool_failure', data: { tool: 'Bash', head: 'npm', error: 'exit 1', interrupt: null } }),
      ),
    ).toEqual({ ok: true })
    expect(
      validateDiagnosticRow(
        row({ kind: 'mcp_call', data: { tool: 'sofar_get_state', ok: false, code: 'invalid_input', ms: 3 } }),
      ),
    ).toEqual({ ok: true })
    expect(
      validateDiagnosticRow(
        row({ kind: 'injection', data: { hook: 'SessionStart', bytes: 8192, memory_bytes: 1200 } }),
      ),
    ).toEqual({ ok: true })
  })

  it('kinds share no member with EVENT_TYPES — a row can never name an event type', () => {
    expect(diagnosticKindsDisjointFromEvents()).toBe(true)
    for (const kind of DIAGNOSTIC_KINDS) expect((EVENT_TYPES as readonly string[]).includes(kind)).toBe(false)
    expect(isDiagnosticKind('command_run')).toBe(false)
    expect(isDiagnosticKind('tool_outcome')).toBe(true)
  })

  it('rejects envelope fields at the top level so a row cannot drift toward an event', () => {
    for (const field of ['v', 'id', 'type', 'payload', 'source', 'actor']) {
      const check = validateDiagnosticRow({ ...row(), [field]: 'x' })
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.errors.join('\n')).toContain(`${field}: envelope field`)
    }
  })

  it('rejects the wrong version, a bad timestamp, an unknown kind and malformed data', () => {
    expect(validateDiagnosticRow(row({ d: 2 as never })).ok).toBe(false)
    expect(validateDiagnosticRow(row({ ts: 'yesterday' })).ok).toBe(false)
    expect(validateDiagnosticRow(row({ kind: 'note_added' as never })).ok).toBe(false)
    expect(validateDiagnosticRow(row({ data: { tool: '', ok: 'yes', exit: '0' } as never })).ok).toBe(false)
    expect(validateDiagnosticRow(row({ kind: 'mcp_call', data: { tool: 'x' } as never })).ok).toBe(false)
    expect(validateDiagnosticRow(row({ kind: 'injection', data: { hook: 'S', bytes: -1 } as never })).ok).toBe(false)
    expect(validateDiagnosticRow('not an object').ok).toBe(false)
  })

  it('bounds stored error text and refuses an unclipped one', () => {
    const long = 'x'.repeat(DIAGNOSTIC_ERROR_CLIP + 100)
    const clipped = clipDiagnosticText(long)
    expect(clipped.length).toBe(DIAGNOSTIC_ERROR_CLIP)
    expect(clipped.endsWith('…[clipped]')).toBe(true)
    expect(clipDiagnosticText('short')).toBe('short')
    expect(
      validateDiagnosticRow(row({ kind: 'tool_failure', data: { tool: 'Bash', error: long, interrupt: null } })).ok,
    ).toBe(false)
    expect(
      validateDiagnosticRow(row({ kind: 'tool_failure', data: { tool: 'Bash', error: clipped, interrupt: null } })).ok,
    ).toBe(true)
  })

  it('tolerates unknown extra keys inside data — rows are private and forward-compatible', () => {
    expect(validateDiagnosticRow(row({ data: { tool: 'Bash', ok: true, exit: 0, future_field: 1 } as never })).ok).toBe(true)
  })
})
