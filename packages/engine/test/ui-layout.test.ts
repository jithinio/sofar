import { describe, expect, it } from 'vitest'
import { emptyState, type InitiativeState } from '../src/core/fold'
import { renderInitiative, type LayoutOptions } from '../src/cli/ui/layout'
import { createStyle } from '../src/cli/ui/style'
import { symbolsFor } from '../src/cli/ui/symbols'
import { stripAnsi, visibleWidth } from '../src/cli/ui/text'

/**
 * Layout grammar (cli-ui 2.1). Pure (state, options) → lines, so no TTY
 * faking anywhere: style/symbols/columns are passed explicitly, exactly as
 * the styled command surfaces (2.2/2.3) will pass them.
 */

const plain = (zoom: LayoutOptions['zoom'], columns = 80): LayoutOptions => ({
  zoom,
  style: createStyle(false),
  symbols: symbolsFor(true),
  columns,
})

const styled = (zoom: LayoutOptions['zoom'], columns = 80): LayoutOptions => ({
  zoom,
  style: createStyle(true),
  symbols: symbolsFor(true),
  columns,
})

/** A state exercising every grammar branch at once. */
function richState(): InitiativeState {
  const state = emptyState()
  state.slug = 'cli-ui'
  state.goal = 'Give CLI output structured terminal rendering'
  state.phases = [
    {
      name: 'Phase 1 — kernel',
      status: 'done',
      tasks: [
        { id: '1.1', title: 'decision', status: 'done' },
        { id: '1.2', title: 'caps + style', status: 'done' },
      ],
    },
    {
      name: 'Phase 2 — surfaces',
      status: 'active',
      tasks: [
        { id: '2.1', title: 'layout grammar', status: 'active' },
        { id: '2.2', title: 'status renderer', status: 'pending' },
        { id: '2.3', title: 'list renderer', status: 'blocked' },
      ],
    },
  ]
  state.current.active_phase = 'Phase 2 — surfaces'
  state.current.next_action = 'Apply the grammar to sofar status'
  state.current.blocked_on = 'task 2.3: waiting on initiative-list'
  state.freshness = {
    events_since_writeback: { files: 2, commands: 1, tasks: 0, notes: 1, decisions: 0 },
    notes: [{ ts: '2026-07-11T10:00:00.000Z', text: 'grammar  needs\nwhitespace collapse' }],
    last_writeback_ts: '2026-07-10T09:00:00.000Z',
  }
  state.sessions = [
    {
      id: 'sess-1',
      tool: 'claude-code',
      started: '2026-07-09T08:00:00.000Z',
      ended: '2026-07-10T09:00:00.000Z',
      summary: 'Built the UI kernel',
      next_action: 'Apply the grammar to sofar status',
    },
  ]
  state.files_touched = ['packages/engine/src/cli/ui/layout.ts']
  return state
}

describe('full zoom — plain content', () => {
  const lines = renderInitiative(richState(), plain('full'))
  const text = lines.join('\n')

  it('bold-header slot carries slug, progress fraction/percent, phase count', () => {
    expect(lines[0]).toBe('cli-ui  2/5 tasks (40%) · 2 phases')
  })

  it('goal renders on its own muted line', () => {
    expect(lines[1]).toBe('Give CLI output structured terminal rendering')
  })

  it('phase tree: status glyph + name + per-phase fraction', () => {
    expect(text).toContain('✓ Phase 1 — kernel 2/2')
    expect(text).toContain('● Phase 2 — surfaces 0/3')
  })

  it('task checkboxes: done/active/pending/blocked triplet + red box shape', () => {
    expect(text).toContain('  [✓] 1.1 decision')
    expect(text).toContain('  [•] 2.1 layout grammar')
    expect(text).toContain('  [ ] 2.2 status renderer')
    expect(text).toContain('  [✗] 2.3 list renderer')
  })

  it('next-action callout and blocked line', () => {
    expect(text).toContain('▸ Next: Apply the grammar to sofar status')
    expect(text).toContain('✗ Blocked on: task 2.3: waiting on initiative-list')
  })

  it('staleness warning states drift total, write-back ts, and breakdown', () => {
    expect(text).toContain('⚠ Staleness')
    expect(text).toContain(
      '  └ next action may be stale: 4 events since the last write-back (2026-07-10T09:00:00.000Z) — 2 files, 1 command, 1 note',
    )
  })

  it('notes section: labeled count, ts + whitespace-collapsed text', () => {
    expect(text).toContain('Notes since write-back (1)')
    expect(text).toContain('  2026-07-11T10:00:00.000Z grammar needs whitespace collapse')
  })

  it('last-session line and files touched', () => {
    expect(text).toContain('Last session (claude-code, ended 2026-07-10T09:00:00.000Z)')
    expect(text).toContain('  Built the UI kernel')
    expect(text).toContain('Files touched (1)')
    expect(text).toContain('  packages/engine/src/cli/ui/layout.ts')
  })
})

describe('full zoom — styled', () => {
  const lines = renderInitiative(richState(), styled('full'))
  const text = lines.join('\n')

  it('styled output strips to exactly the plain output (both are one text)', () => {
    expect(lines.map(stripAnsi)).toEqual(renderInitiative(richState(), plain('full')))
  })

  it('header slug is bold; goal is dim', () => {
    expect(lines[0]).toContain('\x1b[1mcli-ui\x1b[22m')
    expect(lines[1]).toBe('\x1b[2mGive CLI output structured terminal rendering\x1b[22m')
  })

  it('checkbox colors follow the law: green done, yellow active, dim pending, red blocked', () => {
    expect(text).toContain('\x1b[32m[✓]\x1b[39m')
    expect(text).toContain('\x1b[33m[•]\x1b[39m')
    expect(text).toContain('\x1b[2m[ ]\x1b[22m')
    expect(text).toContain('\x1b[31m[✗] 2.3 list renderer\x1b[39m')
  })

  it('next action is bold; blocked and staleness carry their severity colors', () => {
    expect(text).toContain('\x1b[1m▸ Next: Apply the grammar to sofar status\x1b[22m')
    expect(text).toContain('\x1b[31m✗ Blocked on: task 2.3: waiting on initiative-list\x1b[39m')
    expect(text).toContain('\x1b[33m⚠ Staleness\x1b[39m')
  })

  it('staleness detail rides a dim └ rail', () => {
    expect(text).toContain('  \x1b[2m└ next action may be stale')
  })
})

describe('full zoom — branch coverage', () => {
  it('empty state: header, placeholder goal, no phase tree, no next action', () => {
    const lines = renderInitiative(emptyState(), plain('full'))
    expect(lines).toEqual([
      '(unnamed initiative)  0/0 tasks (0%) · 0 phases',
      '(none recorded)',
      '',
      '▸ Next: (none recorded)',
    ])
  })

  it('no staleness section when nothing drifted', () => {
    const state = richState()
    state.freshness = {
      events_since_writeback: { files: 0, commands: 0, tasks: 0, notes: 0, decisions: 0 },
      notes: [],
      last_writeback_ts: '2026-07-10T09:00:00.000Z',
    }
    const text = renderInitiative(state, plain('full')).join('\n')
    expect(text).not.toContain('Staleness')
    expect(text).not.toContain('Notes')
  })

  it('drift without a write-back stays silent; notes label drops the phrasing', () => {
    const state = richState()
    state.freshness.last_writeback_ts = null
    const text = renderInitiative(state, plain('full')).join('\n')
    expect(text).not.toContain('may be stale')
    expect(text).toContain('Notes (1)')
    expect(text).not.toContain('Notes since write-back')
  })

  it('stale phase: warn glyph + nudge on the phase line, item under Staleness', () => {
    const state = emptyState()
    state.slug = 'x'
    state.phases = [
      { name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'only', status: 'done' }] },
    ]
    const text = renderInitiative(state, plain('full')).join('\n')
    expect(text).toContain('⚠ Phase 1 1/1 — all tasks done; mark phase done?')
    expect(text).toContain(
      '  └ phase "Phase 1": all 1 tasks done but still active — emit phase_status_changed to mark it done',
    )
  })

  it('clipped write-back summary points at the session file (SessionStart budget)', () => {
    const state = richState()
    state.sessions[0]!.summary = 'x'.repeat(1_300)
    const text = renderInitiative(state, plain('full')).join('\n')
    expect(text).toContain(
      '  └ last write-back summary exceeds the SessionStart budget (1200 chars) and is clipped there — full text in sessions/sess-1.md',
    )
  })

  it('concurrent edits: files shared by open sessions surface as a warning', () => {
    const state = richState()
    state.sessions.push(
      {
        id: 'open-a',
        tool: 'claude-code',
        started: '2026-07-11T10:00:00.000Z',
        activity: { files: ['src/x.ts'], commands: 0, task_changes: [] },
      },
      {
        id: 'open-b',
        tool: 'codex',
        started: '2026-07-11T10:05:00.000Z',
        activity: { files: ['src/x.ts'], commands: 1, task_changes: [] },
      },
    )
    const text = renderInitiative(state, plain('full')).join('\n')
    expect(text).toContain('⚠ Concurrent edits — files touched by multiple open sessions (1)')
    expect(text).toContain('  src/x.ts (sessions open-a, open-b)')
  })

  it('ascii symbols throughout when unicode is off', () => {
    const opts: LayoutOptions = { ...plain('full'), symbols: symbolsFor(false) }
    const text = renderInitiative(richState(), opts).join('\n')
    expect(text).toContain('  [x] 1.1 decision')
    expect(text).toContain('  [*] 2.1 layout grammar')
    expect(text).toContain('  [×] 2.3 list renderer')
    expect(text).toContain('> Next: Apply the grammar to sofar status')
    expect(text).toContain('!! Staleness')
    expect(text).toContain('  `- next action may be stale')
    for (const ch of text) expect(ch.charCodeAt(0)).toBeLessThan(0x2510)
  })
})

describe('portfolio zoom', () => {
  it('full block: header + next-action detail + blocked + staleness (4 lines)', () => {
    const lines = renderInitiative(richState(), plain('portfolio'))
    expect(lines).toEqual([
      'cli-ui  2/5 tasks (40%)  ● Phase 2 — surfaces',
      '  └ next: Apply the grammar to sofar status',
      '  ✗ blocked: task 2.3: waiting on initiative-list',
      '  ⚠ next action may be stale: 4 events since write-back',
    ])
  })

  it('minimal block is two lines: header + detail', () => {
    const state = emptyState()
    state.slug = 'quiet'
    const lines = renderInitiative(state, plain('portfolio'))
    expect(lines).toEqual(['quiet  0/0 tasks (0%)', '  └ next: (none recorded)'])
  })

  it('detail falls back to the goal when no next action is recorded', () => {
    const state = richState()
    state.current.next_action = null
    state.current.blocked_on = undefined
    const lines = renderInitiative(state, plain('portfolio'))
    expect(lines[1]).toBe('  └ goal: Give CLI output structured terminal rendering')
  })

  it('styled output strips to exactly the plain output', () => {
    const got = renderInitiative(richState(), styled('portfolio'))
    expect(got.map(stripAnsi)).toEqual(renderInitiative(richState(), plain('portfolio')))
  })

  it('SGR escapes in record prose are stripped, never fatal (truncatePlain rejects styled input)', () => {
    const state = richState()
    state.current.active_phase = 'Phase \x1b[32mgreen\x1b[39m'
    state.current.next_action = 'paint it \x1b[31mred\x1b[39m next'
    state.current.blocked_on = 'blk \x1b[1mesc\x1b[22m'
    const plainLines = renderInitiative(state, plain('portfolio'))
    expect(plainLines.join('\n')).not.toContain('\x1b[')
    const styledLines = renderInitiative(state, styled('portfolio'))
    const text = styledLines.map(stripAnsi).join('\n')
    expect(text).toContain('● Phase green')
    expect(text).toContain('next: paint it red next')
    expect(text).toContain('blocked: blk esc')
  })

  it('header styling: bold slug, yellow active-phase bullet; detail rides dim └', () => {
    const lines = renderInitiative(richState(), styled('portfolio'))
    expect(lines[0]).toContain('\x1b[1mcli-ui\x1b[22m')
    expect(lines[0]).toContain('\x1b[33m●\x1b[39m')
    expect(lines[1]).toContain('  \x1b[2m└ next:')
    expect(lines[2]).toContain('\x1b[31m✗ blocked:')
    expect(lines[3]).toContain('\x1b[33m⚠ next action may be stale')
  })
})

describe('portfolio zoom — truncation', () => {
  it('every line fits the column budget, plain and styled alike', () => {
    for (const columns of [40, 24]) {
      const plainLines = renderInitiative(richState(), plain('portfolio', columns))
      const styledLines = renderInitiative(richState(), styled('portfolio', columns))
      expect(styledLines.map(stripAnsi)).toEqual(plainLines)
      for (const line of styledLines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(columns)
      }
    }
  })

  it('the variable tail truncates with an ellipsis; structure survives', () => {
    const lines = renderInitiative(richState(), plain('portfolio', 40))
    expect(lines[0]).toBe('cli-ui  2/5 tasks (40%)  ● Phase 2 — su…')
    expect(lines[1]).toBe('  └ next: Apply the grammar to sofar st…')
  })

  it('active phase drops entirely when no width remains for it', () => {
    const lines = renderInitiative(richState(), plain('portfolio', 25))
    expect(lines[0]).toBe('cli-ui  2/5 tasks (40%)')
  })

  it('degenerate width truncates the header itself', () => {
    const lines = renderInitiative(richState(), plain('portfolio', 10))
    expect(lines[0]).toBe('cli-ui  2…')
    expect(visibleWidth(lines[0]!)).toBe(10)
  })

  it('ascii mode truncates with "..." and stays within budget', () => {
    const opts: LayoutOptions = { ...plain('portfolio', 40), symbols: symbolsFor(false) }
    const lines = renderInitiative(richState(), opts)
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40)
    expect(lines[1]).toContain('...')
  })
})
