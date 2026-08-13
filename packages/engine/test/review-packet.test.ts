import { describe, expect, it } from 'vitest'
import type { DecisionState, InitiativeState, PhaseState } from '../src/core/fold'
import { renderReviewPacket } from '../src/projections/templates/review'

/**
 * The review evidence packet (4.2).
 *
 * What the packet CONTAINS is what a review is worth. Handed only the record, a
 * reviewer restates the initiative's own claims and agrees with them, so these
 * tests pin the two things the record cannot check about itself: the diff, and
 * the constraints the work owed.
 */

function decision(over: Partial<DecisionState> & { chose: string }): DecisionState {
  return {
    id: 'e1',
    ts: '2026-08-13T00:00:00.000Z',
    over: 'the alternative',
    because: 'reasons',
    ...over,
  } as DecisionState
}

function state(overrides: Partial<InitiativeState> = {}): InitiativeState {
  return {
    slug: 'demo',
    goal: 'Do the thing properly',
    status: 'active',
    status_ts: null,
    status_note: null,
    phases: [],
    decisions: [],
    memories: [],
    sessions: [],
    files_touched: [],
    task_files: {},
    drop_notes: {},
    guard_violations: [],
    current: { active_phase: null, next_action: null },
    ...overrides,
  } as unknown as InitiativeState
}

function phase(tasks: PhaseState['tasks']): PhaseState {
  return { name: 'Phase 1 — Build', status: 'done', tasks } as PhaseState
}

const COMMITS = ['a'.repeat(40), 'b'.repeat(40)]

describe('renderReviewPacket — the diff half', () => {
  it('names the commits and gives a runnable git command', () => {
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: COMMITS,
      watermark: null,
      phase: phase([]),
    })
    expect(out).toContain('2 commit(s)')
    expect(out).toContain('git show')
  })

  it('lists shas explicitly — a two-dot range would drop the oldest commit', () => {
    // `git show oldest..newest` means "reachable from newest but NOT oldest",
    // so it silently excludes the first commit of every phase. Caught by
    // rendering a real phase, not by a unit test — hence this pin.
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: COMMITS,
      watermark: null,
      phase: phase([]),
    })
    expect(out).toContain(`git show ${'a'.repeat(12)} ${'b'.repeat(12)}`)
    expect(out).not.toMatch(/git show \w+\.\.\w+/)
  })

  it('treats an EMPTY range as a finding, not an empty section', () => {
    // The most important case: no attributed commits means either attribution
    // is silently off or nothing was built. Reviewing a diff you cannot see is
    // worth nothing, so the packet must refuse to look normal here.
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: [],
      watermark: null,
      phase: phase([]),
    })
    expect(out).toContain('finding in itself')
    expect(out).toContain('sofar doctor')
  })

  it('shows the watermark range once a prior review exists', () => {
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: COMMITS,
      watermark: 'c'.repeat(40),
      phase: phase([]),
    })
    expect(out).toContain('cccccccccccc..HEAD')
  })

  it('says so plainly when there is no prior review', () => {
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: COMMITS,
      watermark: null,
      phase: phase([]),
    })
    expect(out).toContain('no prior review')
  })
})

describe('renderReviewPacket — the constraint half (no substitute)', () => {
  it('renders standing constraints VERBATIM and never clipped', () => {
    // drift-hardening D1's render contract. Clipping a constraint in the one
    // document whose job is to check conformance against it defeats the packet.
    const rule = `Never ${'x'.repeat(400)} under any circumstances.`
    const out = renderReviewPacket(
      state({ decisions: [decision({ chose: 'a', rule })] }),
      { scope: 'phase', commits: COMMITS, watermark: null, phase: phase([]) },
    )
    expect(out).toContain(rule)
  })

  it('lists rejected approaches, which a diff-only reviewer cannot see', () => {
    const out = renderReviewPacket(
      state({ decisions: [decision({ chose: 'a', over: 'hand-writing plan.md' })] }),
      { scope: 'phase', commits: COMMITS, watermark: null, phase: phase([]) },
    )
    expect(out).toContain('hand-writing plan.md')
    expect(out).toContain('re-entering one is drift')
  })

  it('only counts decisions carrying a rule as standing constraints', () => {
    const out = renderReviewPacket(
      state({ decisions: [decision({ chose: 'one-off choice' })] }),
      { scope: 'phase', commits: COMMITS, watermark: null, phase: phase([]) },
    )
    const section = out.split('## Standing constraints')[1]!.split('##')[0]!
    expect(section).toContain('(none)')
  })

  it('lists tasks claimed done with their files', () => {
    const out = renderReviewPacket(
      state({ task_files: { '1.1': ['src/a.ts'] } }),
      {
        scope: 'phase',
        commits: COMMITS,
        watermark: null,
        phase: phase([
          { id: '1.1', title: 'Build it', status: 'done' },
          { id: '1.2', title: 'Not yet', status: 'pending' },
        ] as PhaseState['tasks']),
      },
    )
    expect(out).toContain('[1.1] Build it')
    expect(out).toContain('src/a.ts')
    expect(out).not.toContain('[1.2]')
  })
})

describe('renderReviewPacket — phase vs final ask DIFFERENT questions', () => {
  // The entire justification for paying for a second pass at close (D10). If
  // the final pass asked the phase questions again it would be a rubber stamp.
  const args = { commits: COMMITS, watermark: null }

  it('a phase review delegates bug-hunting where a skill exists', () => {
    const out = renderReviewPacket(state(), { ...args, scope: 'phase', phase: phase([]) })
    expect(out).toContain('/code-review')
    expect(out).toContain('/simplify')
  })

  it('STANDS ALONE on a host with no such skill (D12)', () => {
    // sofar runs under any agent — the AGENTS.md dialect exists for exactly
    // that (BD31). Naming a Claude Code slash command as though every host had
    // one would render an instruction most readers cannot follow, so the work
    // itself is spelled out and the skill is only ever offered as a shortcut.
    const out = renderReviewPacket(state(), { ...args, scope: 'phase', phase: phase([]) })
    expect(out).toContain('If your host has a dedicated code-review capability')
    expect(out).toContain('If it has')
    expect(out).toContain('correctness bugs')
    expect(out).toContain('edge cases')
    // The write half must be reachable without MCP too.
    expect(out).toContain('sofar event append')
  })

  it('the final pass asks goal conformance, which no phase review can', () => {
    const out = renderReviewPacket(state(), { ...args, scope: 'final' })
    expect(out).toContain('GOAL CONFORMANCE')
    expect(out).toContain('CROSS-PHASE DRIFT')
    expect(out).toContain('INTEGRATION')
  })

  it('the final pass explicitly forbids re-auditing per-phase correctness', () => {
    const out = renderReviewPacket(state(), { ...args, scope: 'final' })
    expect(out).toContain('Do NOT re-audit per-phase correctness')
  })

  it('carries unresolved findings forward into the final pass', () => {
    const out = renderReviewPacket(state(), {
      ...args,
      scope: 'final',
      openFindings: ['4.2 leaks a file handle'],
    })
    expect(out).toContain('4.2 leaks a file handle')
  })

  it('demands a verdict that can be "no"', () => {
    const out = renderReviewPacket(state(), { ...args, scope: 'phase', phase: phase([]) })
    expect(out).toContain('rubber stamp')
  })
})

describe('the packet is honest about what it could not read', () => {
  it('says the walk FAILED rather than showing an empty range', () => {
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: [],
      watermark: 'f'.repeat(40),
      unreadable: true,
    })
    expect(out).toContain('the commit walk FAILED')
    expect(out).toContain('no longer names a commit')
    // The empty-range finding would be a false accusation here.
    expect(out).not.toContain('attribution is silently off')
  })

  it('reports a truncated walk instead of looking complete', () => {
    // `git log --max-count` keeps the NEWEST, so hitting the ceiling drops the
    // OLDEST commits of the range — the same loss this module refuses to accept
    // from a two-dot range, arriving through the count cap instead.
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: ['a'.repeat(40), 'b'.repeat(40)],
      watermark: null,
      truncated: 2,
    })
    expect(out).toContain('TRUNCATED')
    expect(out).toContain('2-commit ceiling')
  })

  it('names the FULL sha to record as the next watermark', () => {
    const head = 'c'.repeat(40)
    const out = renderReviewPacket(state(), {
      scope: 'phase',
      commits: ['a'.repeat(40)],
      watermark: null,
      head,
    })
    expect(out).toContain(`Watermark to record, if you read through HEAD: ${head}`)
  })

  it('omits the watermark line entirely when HEAD could not be read', () => {
    const out = renderReviewPacket(state(), { scope: 'phase', commits: [], watermark: null })
    expect(out).not.toContain('Watermark to record')
  })
})

describe('the question that would have caught D13 (stale-session-signals 3.1)', () => {
  it('asks a PHASE review whether a decision named work nothing implements', () => {
    const out = renderReviewPacket(state(), { scope: 'phase', commits: [], watermark: null })
    expect(out).toContain('PROMISED BUT UNBUILT')
    // Asked, never detected: reading intent out of prose is the inference the
    // record refuses to make, so the packet renders and the reviewer judges.
    expect(out).toContain('cannot ask this mechanically')
  })

  it('asks it again at CLOSE, where it is the last chance', () => {
    const out = renderReviewPacket(state(), { scope: 'final', commits: [], watermark: null })
    expect(out).toContain('PROMISED BUT UNBUILT')
    expect(out).toContain('last moment anyone asks')
  })
})
