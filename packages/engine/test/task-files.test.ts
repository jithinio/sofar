import { describe, expect, it } from 'vitest'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { foldLines, TASK_FILES_CAP } from '../src/core/fold'
import { serializeEvent } from '../src/core/log'
import { renderStatus, STATUS_CHAR_LIMIT } from '../src/projections/templates/status'

/**
 * speed T4 — file-locality hints (SPEC §State task_files, §Hooks
 * SessionStart, §Acceptance speed T4). Derived ONLY from existing
 * file_touched events at replay time: zero new event types, zero new
 * capture, deterministic, byte-stability-safe.
 */

function ev(type: string, payload: Record<string, unknown>, session = 'cli'): EventEnvelope {
  return makeEvent({ initiative: 'locality', session, source: 'cli', actor: 'agent', type, payload })
}

const PLAN = ev('plan_updated', {
  plan: {
    goal: 'derive per-task file locality',
    phases: [
      {
        name: 'Phase 1',
        status: 'active',
        tasks: [
          { id: 'A', title: 'first task', status: 'pending' },
          { id: 'B', title: 'second task', status: 'pending' },
        ],
      },
    ],
  },
})

function activate(id: string): EventEnvelope {
  return ev('task_status_changed', { id, status: 'active' })
}

function finish(id: string): EventEnvelope {
  return ev('task_status_changed', { id, status: 'done' })
}

function touch(path: string): EventEnvelope {
  return ev('file_touched', { path, op: 'edit' })
}

function fold(events: EventEnvelope[]) {
  return foldLines(events.map(serializeEvent))
}

describe('task_files derivation (speed T4)', () => {
  it('attributes touches to the task(s) active at that point in the log — and to nothing else', () => {
    const { state, warnings } = fold([
      ev('initiative_created', { slug: 'locality', goal: 'g' }),
      PLAN,
      touch('src/before.ts'), // nothing active yet
      activate('A'),
      touch('src/a-only.ts'),
      activate('B'), // A and B now both active
      touch('src/shared.ts'),
      finish('A'),
      touch('src/b-only.ts'),
    ])
    expect(warnings).toEqual([])
    expect(state.task_files).toEqual({
      A: ['src/shared.ts', 'src/a-only.ts'],
      B: ['src/b-only.ts', 'src/shared.ts'],
    })
  })

  it('dedupes most-recent-first (a re-touch moves the path to the front) and caps per task', () => {
    // built strictly in order: makeEvent mints ulids at creation time and
    // the fold replays in ulid order
    const events = [
      ev('initiative_created', { slug: 'locality', goal: 'g' }),
      PLAN,
      activate('A'),
      touch('src/first.ts'),
      touch('src/second.ts'),
      touch('src/first.ts'), // re-touch → moves to front, no duplicate
    ]
    for (let i = 0; i < TASK_FILES_CAP + 5; i++) events.push(touch(`src/file-${i}.ts`))
    const { state } = fold(events)
    const files = state.task_files['A']!
    expect(files.length).toBe(TASK_FILES_CAP)
    // most recent first; the oldest entries (first/second) dropped past the cap
    expect(files[0]).toBe(`src/file-${TASK_FILES_CAP + 4}.ts`)
    expect(files).not.toContain('src/second.ts')
    expect(new Set(files).size).toBe(files.length)
  })

  it('a voided file_touched never attributes; replay is deterministic from shuffled file order', () => {
    const touched = touch('src/voided.ts')
    const events = [
      ev('initiative_created', { slug: 'locality', goal: 'g' }),
      PLAN,
      activate('A'),
      touched,
      touch('src/kept.ts'),
      ev('correction', { ref: touched.id }),
    ]
    const { state } = fold(events)
    expect(state.task_files).toEqual({ A: ['src/kept.ts'] })

    // convergent fold: shuffled file order → deep-equal state, task_files included
    const shuffled = [...events].reverse()
    expect(foldLines(shuffled.map(serializeEvent)).state).toEqual(state)
  })
})

describe('renderStatus files: line (speed T4)', () => {
  function stateWith(paths: string[]) {
    return fold([
      ev('initiative_created', { slug: 'locality', goal: 'exercise the files line' }),
      PLAN,
      activate('A'),
      ...paths.map(touch),
    ]).state
  }

  it('renders one budgeted files: line under the current task, most-recent first, capped at 8', () => {
    const rendered = renderStatus(stateWith(['src/one.ts', 'src/two.ts']))
    expect(rendered).toContain('Current task: A first task')
    expect(rendered).toContain('  files: src/two.ts, src/one.ts')

    const many = renderStatus(stateWith(Array.from({ length: 12 }, (_, i) => `src/f-${i}.ts`)))
    const filesLine = many.split('\n').find((l) => l.startsWith('  files: '))!
    expect(filesLine).toContain('src/f-11.ts')
    expect(filesLine.match(/src\//g)!.length).toBe(8) // render cap, fold holds more
    expect(filesLine).not.toContain('src/f-3.ts') // 9th-most-recent — cut
  })

  it('is silently absent when the active task has no touch data, and the 10k cap holds', () => {
    const rendered = renderStatus(stateWith([]))
    expect(rendered).toContain('Current task: A first task')
    expect(rendered).not.toContain('files:')

    // worst case: long paths still land inside the clip and the global cap
    const longPaths = Array.from({ length: 8 }, (_, i) => `packages/engine/src/deeply/nested/dir-${i}/module-with-a-long-name-${i}.ts`)
    const worst = renderStatus(stateWith(longPaths))
    const line = worst.split('\n').find((l) => l.startsWith('  files: '))!
    expect(line.length).toBeLessThanOrEqual(300)
    expect(worst.length).toBeLessThanOrEqual(STATUS_CHAR_LIMIT)
  })
})
