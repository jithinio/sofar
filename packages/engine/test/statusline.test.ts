import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { makeEvent } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import {
  CACHE_JUDGE_MIN_TOKENS,
  runStatusline,
  STATUSLINE_FORCED_CAPS,
} from '../src/cli/statusline'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * felt-cost 3.2/3.3 — the rent-meter (D4). One plain line from statusline
 * JSON; every segment independent and best-effort; read-side only (the
 * record is never appended to); cache health bands per the Jul-12 research.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(options?: FixtureOptions): Fixture {
  const fixture = makeRepoFixture(options)
  roots.push(fixture.root)
  return fixture
}

/** Bound fixture with a 1-of-3-done plan. */
function planned(): Fixture {
  const fixture = fx()
  appendEvents(fixture.eventsPath, [
    makeEvent({
      initiative: fixture.slug,
      session: 'cli',
      source: 'cli',
      actor: 'agent',
      type: 'plan_updated',
      payload: {
        plan: {
          phases: [
            {
              name: 'Build',
              status: 'active',
              tasks: [
                { id: '1.1', title: 'a', status: 'done' },
                { id: '1.2', title: 'b', status: 'active' },
                { id: '1.3', title: 'c', status: 'pending' },
              ],
            },
          ],
        },
      },
    }),
  ])
  return fixture
}

/** Statusline JSON with a given warm/write/fresh token split. */
function statusJson(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'Status',
    session_id: 'sess-1',
    cost: { total_cost_usd: 1.234 },
    context_window: {
      used_percentage: 41.2,
      current_usage: {
        input_tokens: 2_000,
        cache_creation_input_tokens: 3_600,
        cache_read_input_tokens: 14_400, // 72% of 20k
      },
    },
    ...fields,
  })
}

describe('sofar statusline — rent-meter (felt-cost 3.2, D4)', () => {
  it('bound record + full JSON → all four segments, in order', () => {
    const fixture = planned()
    const line = runStatusline(fixture.root, statusJson())
    expect(line).toBe(`${fixture.slug} 1/3 · $1.23 · cache 72% ✓ · ctx 41%`)
  })

  it('is read-side only: rendering appends nothing to the record', () => {
    const fixture = planned()
    const before = readFileSync(fixture.eventsPath, 'utf8')
    runStatusline(fixture.root, statusJson())
    expect(readFileSync(fixture.eventsPath, 'utf8')).toBe(before)
  })

  it('unbound repo → record segment omitted, the rest still renders', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, statusJson({ workspace: {}, cwd: undefined }))
    expect(line).toBe('$1.23 · cache 72% ✓ · ctx 41%')
  })

  it('falls back to workspace.current_dir when the invocation root has no record', () => {
    const fixture = planned()
    const line = runStatusline('/nonexistent', statusJson({ workspace: { current_dir: fixture.root } }))
    expect(line).toContain(`${fixture.slug} 1/3`)
  })

  it('harness-identity segments (D6): model · dir:branch lead the line, all six in order', () => {
    const fixture = planned()
    const line = runStatusline(
      fixture.root,
      statusJson({
        model: { display_name: 'Fable 5' },
        workspace: { current_dir: fixture.root },
      }),
    )
    expect(line).toBe(
      `Fable 5 · ${basename(fixture.root)}:main · ${fixture.slug} 1/3 · $1.23 · cache 72% ✓ · ctx 41%`,
    )
  })

  it('worktree-style .git file (gitdir pointer) still resolves the branch', () => {
    const fixture = fx({ bind: false, worktree: true })
    const line = runStatusline('/nonexistent', statusJson({ workspace: { current_dir: fixture.root } }))
    expect(line.startsWith(`${basename(fixture.root)}:main · `)).toBe(true)
  })

  it('detached HEAD → dir segment without a branch suffix', () => {
    const fixture = fx({ bind: false, branch: null })
    const line = runStatusline('/nonexistent', statusJson({ workspace: { current_dir: fixture.root } }))
    expect(line.startsWith(`${basename(fixture.root)} · `)).toBe(true)
    expect(line).not.toContain(':')
  })

  it('model only (no workspace/cwd) → model leads, dir omitted', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline('/nonexistent', statusJson({ model: { display_name: 'Fable 5' } }))
    expect(line).toBe('Fable 5 · $1.23 · cache 72% ✓ · ctx 41%')
  })

  it('garbage or empty stdin → empty line, no throw', () => {
    const fixture = fx({ bind: false })
    expect(runStatusline(fixture.root, 'not json{{{')).toBe('')
    expect(runStatusline(fixture.root, '')).toBe('')
  })

  it.each([
    ['cold prefix warns', 0.2, '⚠'],
    ['mid band is bare', 0.4, null],
    ['healthy band checks', 0.72, '✓'],
  ])('cache bands after 10k tokens: %s', (_name, share, marker) => {
    const fixture = fx({ bind: false })
    const total = CACHE_JUDGE_MIN_TOKENS
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          current_usage: {
            input_tokens: total * (1 - share),
            cache_read_input_tokens: total * share,
          },
        },
      }),
    )
    const expected = `cache ${Math.round(share * 100)}%${marker === null ? '' : ` ${marker}`}`
    expect(line).toContain(expected)
  })

  it('young session (<10k tokens) shows the % but withholds health judgment', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          current_usage: { input_tokens: 900, cache_read_input_tokens: 100 },
        },
      }),
    )
    expect(line).toContain('cache 10%')
    expect(line).not.toContain('⚠')
    expect(line).not.toContain('✓')
  })

  it('zero token flow → cache segment omitted entirely', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          current_usage: { input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    )
    expect(line).toBe('$1.23')
  })

  it('styled (D7): bold model, 📁/🌿 icons, accent slug, banded cache, dim ctx + separators', () => {
    const fixture = planned()
    const line = runStatusline(
      fixture.root,
      statusJson({ model: { display_name: 'Fable 5' }, workspace: { current_dir: fixture.root } }),
      STATUSLINE_FORCED_CAPS,
    )
    const sep = ' \x1b[2m·\x1b[22m '
    expect(line).toBe(
      [
        '\x1b[1mFable 5\x1b[22m',
        `📁 ${basename(fixture.root)} 🌿 \x1b[32mmain\x1b[39m`,
        `\x1b[35m${fixture.slug}\x1b[39m 1/3`,
        '$1.23',
        '\x1b[32m♻ 72% ✓\x1b[39m',
        '\x1b[2m🧠 41%\x1b[22m',
      ].join(sep),
    )
  })

  it('styled: cold cache goes red, near-compaction context goes warn/error', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {
          used_percentage: 91,
          current_usage: { input_tokens: 16_000, cache_read_input_tokens: 4_000 },
        },
      }),
      STATUSLINE_FORCED_CAPS,
    )
    expect(line).toContain('\x1b[31m♻ 20% ⚠\x1b[39m')
    expect(line).toContain('\x1b[31m🧠 91%\x1b[39m')
  })

  it('styled: default lib caps stay plain — the command opts into styling, not the library', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, statusJson({ model: { display_name: 'Fable 5' } }))
    expect(line).toBe('Fable 5 · $1.23 · cache 72% ✓ · ctx 41%')
    expect(line).not.toContain('\x1b')
  })

  it('usage counters found at top-level current_usage too', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({
        context_window: {},
        current_usage: { input_tokens: 5_000, cache_read_input_tokens: 15_000 },
      }),
    )
    expect(line).toContain('cache 75% ✓')
  })
})
