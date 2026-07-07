import { appendFileSync, rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { makeEvent } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { runStatus } from '../src/cli/status'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Task 4.3 — `sofar status [slug]`: golden-ish assertions on a folded
 * fixture (progress %, per-task tree, blocked_on, last session), fold
 * warnings on stderr, and exit-1 resolution failures.
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

function ev(
  fixture: Fixture,
  type: string,
  payload: Record<string, unknown>,
  session = 'cli',
): EventEnvelope {
  return makeEvent({
    initiative: fixture.slug,
    session,
    source: 'cli',
    actor: 'agent',
    type,
    payload,
  })
}

function seed(fixture: Fixture): void {
  appendEvents(fixture.eventsPath, [
    ev(fixture, 'initiative_created', { slug: fixture.slug, goal: 'ship the demo' }),
    ev(fixture, 'plan_updated', {
      plan: {
        phases: [
          {
            name: 'Build',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'scaffold', status: 'done' },
              { id: '1.2', title: 'wire events', status: 'active' },
              { id: '1.3', title: 'ship types', status: 'pending' },
            ],
          },
          {
            name: 'Polish',
            status: 'pending',
            tasks: [{ id: '2.1', title: 'docs', status: 'pending' }],
          },
        ],
      },
    }),
    ev(fixture, 'task_status_changed', { id: '1.3', status: 'blocked', note: 'waiting on schema review' }),
    ev(fixture, 'file_touched', { path: 'src/core/log.ts', op: 'edit' }),
    ev(fixture, 'session_started', { tool: 'claude-code' }, 'sess-1'),
    ev(
      fixture,
      'session_ended',
      { session_id: 'sess-1', summary: 'built the scaffold end to end', next_action: 'wire events next' },
      'sess-1',
    ),
  ])
}

describe('sofar status', () => {
  it('prints goal, progress %, per-task phase tree, blocked_on, next action, last session', () => {
    const fixture = fx()
    seed(fixture)

    const result = runStatus(fixture.root) // resolved via branch binding, like MCP
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')

    const out = result.stdout
    expect(out).toContain(`# ${fixture.slug}`)
    expect(out).toContain('Goal: ship the demo')
    expect(out).toContain('Progress: 1/4 tasks done (25%) across 2 phase(s)')
    // phase tree with per-task statuses
    expect(out).toContain('- Build [active] 1/3')
    expect(out).toContain('  - [x] 1.1 scaffold')
    expect(out).toContain('  - [~] 1.2 wire events')
    expect(out).toContain('  - [!] 1.3 ship types')
    expect(out).toContain('- Polish [pending] 0/1')
    expect(out).toContain('  - [ ] 2.1 docs')
    // derived current.*
    expect(out).toContain('Next action: wire events next')
    expect(out).toContain('Blocked on: task 1.3: waiting on schema review')
    // last session: tool + summary + ended
    expect(out).toMatch(/Last session \(claude-code, ended \d{4}-/)
    expect(out).toContain('built the scaffold end to end')
    // touched files
    expect(out).toContain('Files touched (1):')
    expect(out).toContain('- src/core/log.ts')
  })

  it('accepts an explicit slug and is NOT capped at 10k chars', () => {
    const fixture = fx({ bind: false }) // no binding — explicit slug must still work
    appendEvents(fixture.eventsPath, [
      ev(fixture, 'initiative_created', { slug: fixture.slug, goal: `big ${'goal '.repeat(3_000)}` }),
    ])
    const result = runStatus(fixture.root, fixture.slug)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBeGreaterThan(10_000) // BD3 cap is SessionStart-only
    expect(result.stdout).toContain('big goal')
  })

  it('prints fold warnings to stderr without failing', () => {
    const fixture = fx()
    seed(fixture)
    appendFileSync(fixture.eventsPath, '{ torn line', 'utf8')

    const result = runStatus(fixture.root)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('warning:')
    expect(result.stderr).toContain('unparseable JSON')
    expect(result.stdout).toContain('Goal: ship the demo')
  })

  it('works on a created-but-empty initiative (no events.jsonl)', () => {
    const fixture = fx()
    const result = runStatus(fixture.root)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`# ${fixture.slug}`)
    expect(result.stdout).toContain('Goal: (none recorded)')
    expect(result.stdout).toContain('Progress: 0/0 tasks done (0%)')
  })

  it('exits 1 with a helpful message when unresolvable', () => {
    const unbound = fx({ bind: false })
    const noBinding = runStatus(unbound.root)
    expect(noBinding.exitCode).toBe(1)
    expect(noBinding.stderr).toContain('no initiative bound to branch "main"')
    expect(noBinding.stderr).toContain('usage: sofar status [slug]')

    const unknown = runStatus(unbound.root, 'ghost')
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain('initiative "ghost" not found')

    const detached = fx({ branch: null, bind: false })
    const noBranch = runStatus(detached.root)
    expect(noBranch.exitCode).toBe(1)
    expect(noBranch.stderr).toContain('no current git branch')
  })
})
