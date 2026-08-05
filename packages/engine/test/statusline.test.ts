import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { makeEvent } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import {
  CACHE_JUDGE_MIN_TOKENS,
  runStatusline,
  STATUSLINE_FORCED_CAPS,
} from '../src/cli/statusline'
import { installStatusline, STATUSLINE_SETTINGS_ENTRY } from '../src/cli/init'
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
  it('bound record + full JSON → every segment, in order (D13: no cost, ctx before cache)', () => {
    const fixture = planned()
    const line = runStatusline(fixture.root, statusJson())
    expect(line).toBe(`${fixture.slug} 1/3 · ctx 41% · cache 72% ✓`)
  })

  it('D13: the cost segment is gone even when stdin carries total_cost_usd', () => {
    const fixture = planned()
    expect(runStatusline(fixture.root, statusJson())).not.toContain('$')
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
    expect(line).toBe('ctx 41% · cache 72% ✓')
  })

  it('falls back to workspace.current_dir when the invocation root has no record', () => {
    const fixture = planned()
    const line = runStatusline('/nonexistent', statusJson({ workspace: { current_dir: fixture.root } }))
    expect(line).toContain(`${fixture.slug} 1/3`)
  })

  it('harness-identity segments (D6): model · dir:branch lead the line, all five in order', () => {
    const fixture = planned()
    const line = runStatusline(
      fixture.root,
      statusJson({
        model: { display_name: 'Fable 5' },
        workspace: { current_dir: fixture.root },
      }),
    )
    expect(line).toBe(
      `Fable 5 · ${basename(fixture.root)}:main · ${fixture.slug} 1/3 · ctx 41% · cache 72% ✓`,
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
    expect(line).toBe('Fable 5 · ctx 41% · cache 72% ✓')
  })

  it.each([
    ['Opus 5 (1M context)', 'Opus 5 (1M)'],
    ['Opus 5 (1M  context)', 'Opus 5 (1M)'], // collapses the run of spaces
    ['Sonnet 5 (200K context)', 'Sonnet 5 (200K)'],
    ['Opus 5', 'Opus 5'], // nothing parenthesised to trim
    ['Contextual 5', 'Contextual 5'], // only the standalone word, at the paren
    ['context', 'context'], // never trims the name down to nothing
  ])('D14: drops "context" from the model label: %s', (given, expected) => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, statusJson({ model: { display_name: given } }))
    expect(line.startsWith(`${expected} · `)).toBe(true)
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
          used_percentage: 41.2,
          current_usage: { input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }),
    )
    expect(line).toBe('ctx 41%')
  })

  it('styled (D7/D8/D12/D13/D14): toned model, Claude-palette dir/branch, task pie, dim ctx label + toned value, banded cache, separators', () => {
    const fixture = planned()
    const line = runStatusline(
      fixture.root,
      statusJson({ model: { display_name: 'Fable 5' }, workspace: { current_dir: fixture.root } }),
      STATUSLINE_FORCED_CAPS,
    )
    const sep = ' \x1b[2m·\x1b[22m '
    expect(line).toBe(
      [
        '\x1b[1m\x1b[35mFable 5\x1b[39m\x1b[22m', // Fable family: bold accent (D11)
        // D12: no ▸, branch is its own segment. D14: both quote Claude
        // Code's default palette — dir yellow, branch blue, NOT semantic.
        `\x1b[33m${basename(fixture.root)}\x1b[39m`,
        '\x1b[34mmain\x1b[39m',
        `\x1b[33m◔\x1b[39m \x1b[35m${fixture.slug}\x1b[39m 1/3`, // task pie: in progress → warn (D9)
        '\x1b[2mctx\x1b[22m \x1b[32m41%\x1b[39m', // D13: constant label dim, value toned
        '\x1b[32mcache 72% ✓\x1b[39m',
      ].join(sep),
    )
  })

  it.each([
    ['Fable 5', '\x1b[1m\x1b[35mFable 5\x1b[39m\x1b[22m'],
    ['Opus 4.8', '\x1b[35mOpus 4.8\x1b[39m'],
    ['Sonnet 5', '\x1b[36mSonnet 5\x1b[39m'],
    ['Haiku 4.5', '\x1b[32mHaiku 4.5\x1b[39m'],
    ['GPT-6', '\x1b[1mGPT-6\x1b[22m'], // unknown family keeps the D6 bold
  ])('styled: model family tones (D11): %s', (name, styled) => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({ model: { display_name: name } }),
      STATUSLINE_FORCED_CAPS,
    )
    expect(line.startsWith(styled)).toBe(true)
  })

  it('styled: ctx warn band (≥70) goes yellow', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(
      fixture.root,
      statusJson({ context_window: { used_percentage: 75 } }),
      STATUSLINE_FORCED_CAPS,
    )
    expect(line).toContain('\x1b[2mctx\x1b[22m \x1b[33m75%\x1b[39m')
  })

  it('styled: completed record → success-green full pie (D9)', () => {
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
                name: 'Ship',
                status: 'done',
                tasks: [
                  { id: '1.1', title: 'a', status: 'done' },
                  { id: '1.2', title: 'b', status: 'done' },
                ],
              },
            ],
          },
        },
      }),
    ])
    const line = runStatusline(fixture.root, statusJson(), STATUSLINE_FORCED_CAPS)
    expect(line).toContain(`\x1b[32m●\x1b[39m \x1b[35m${fixture.slug}\x1b[39m 2/2`)
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
    expect(line).toContain('\x1b[31mcache 20% ⚠\x1b[39m')
    expect(line).toContain('\x1b[2mctx\x1b[22m \x1b[31m91%\x1b[39m')
  })

  it('styled: default lib caps stay plain — the command opts into styling, not the library', () => {
    const fixture = fx({ bind: false })
    const line = runStatusline(fixture.root, statusJson({ model: { display_name: 'Fable 5' } }))
    expect(line).toBe('Fable 5 · ctx 41% · cache 72% ✓')
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

describe('sofar statusline --install (felt-cost D14)', () => {
  const settingsOf = (root: string) => join(root, '.claude', 'settings.json')
  const readSettings = (root: string) =>
    JSON.parse(readFileSync(settingsOf(root), 'utf8')) as Record<string, unknown>

  it('wires the statusLine into a repo with no .claude/settings.json', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    const result = installStatusline(fixture.root)
    expect(result.status).toBe('wired')
    expect(readSettings(fixture.root).statusLine).toEqual(STATUSLINE_SETTINGS_ENTRY)
  })

  it('installs the LINE only — no hooks, no .sofar/, nothing else in settings', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    rmSync(join(fixture.root, '.sofar'), { recursive: true, force: true })
    installStatusline(fixture.root)
    expect(Object.keys(readSettings(fixture.root))).toEqual(['statusLine'])
    expect(existsSync(join(fixture.root, '.claude', 'hooks'))).toBe(false)
    expect(existsSync(join(fixture.root, '.sofar'))).toBe(false)
  })

  it('is idempotent: a second run reports already-wired and rewrites nothing', () => {
    const fixture = fx({ bind: false })
    rmSync(join(fixture.root, '.claude'), { recursive: true, force: true })
    installStatusline(fixture.root)
    const after = readFileSync(settingsOf(fixture.root), 'utf8')
    expect(installStatusline(fixture.root).status).toBe('already')
    expect(readFileSync(settingsOf(fixture.root), 'utf8')).toBe(after)
  })

  it("never overwrites someone else's statusLine", () => {
    const fixture = fx({ bind: false })
    const custom = { type: 'command', command: 'bash ~/.claude/mine.sh' }
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ statusLine: custom }, null, 2)}\n`)
    const result = installStatusline(fixture.root)
    expect(result.status).toBe('kept')
    expect(readSettings(fixture.root).statusLine).toEqual(custom)
  })

  it('preserves unrelated keys already in settings.json', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), `${JSON.stringify({ model: 'opus' }, null, 2)}\n`)
    installStatusline(fixture.root)
    const settings = readSettings(fixture.root)
    expect(settings.model).toBe('opus')
    expect(settings.statusLine).toEqual(STATUSLINE_SETTINGS_ENTRY)
  })

  it('refuses to touch unparseable settings.json rather than clobbering it', () => {
    const fixture = fx({ bind: false })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(settingsOf(fixture.root), '{ not json')
    expect(() => installStatusline(fixture.root)).toThrow(/not valid JSON/)
    expect(readFileSync(settingsOf(fixture.root), 'utf8')).toBe('{ not json')
  })
})
