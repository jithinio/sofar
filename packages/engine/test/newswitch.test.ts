import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { DEFAULT_GOAL, runNew, runSwitch } from '../src/cli/new'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Task 4.2 — `harness new` / `harness switch`: initiative_created append +
 * branch binding, slug validation, duplicate/unknown-slug errors, and the
 * detached-HEAD error path with the --no-bind escape hatch.
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

function events(root: string, slug: string): EventEnvelope[] {
  const path = join(root, '.harness', 'initiatives', slug, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope)
}

function bindings(root: string): Record<string, string> {
  return JSON.parse(readFileSync(join(root, '.harness', 'bindings.json'), 'utf8')) as Record<
    string,
    string
  >
}

describe('harness new', () => {
  it('creates the initiative, appends initiative_created (cli/human), binds the branch', () => {
    const fixture = fx() // main → demo already bound
    const result = runNew(fixture.root, 'rocket', { goal: 'ship the rocket' })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('created .harness/initiatives/rocket/')
    expect(result.stdout).toContain('bound branch "main" → rocket')

    const log = events(fixture.root, 'rocket')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      type: 'initiative_created',
      source: 'cli',
      actor: 'human',
      session: 'cli',
      initiative: 'rocket',
      payload: { slug: 'rocket', goal: 'ship the rocket' },
    })

    // branch rebound to the new initiative; projections regenerated
    expect(bindings(fixture.root).main).toBe('rocket')
    expect(existsSync(join(fixture.root, '.harness', 'initiatives', 'rocket', 'plan.md'))).toBe(true)
  })

  it('preserves other branches in bindings.json and uses the default goal', () => {
    const fixture = fx()
    writeFileSync(
      join(fixture.root, '.harness', 'bindings.json'),
      `${JSON.stringify({ main: 'demo', dev: 'sidecar' }, null, 2)}\n`,
    )
    expect(runNew(fixture.root, 'fresh').exitCode).toBe(0)
    expect(bindings(fixture.root)).toEqual({ main: 'fresh', dev: 'sidecar' })
    expect(events(fixture.root, 'fresh')[0]!.payload.goal).toBe(DEFAULT_GOAL)
  })

  it.each(['Upper-Case', 'has space', 'under_score', 'dots.too', ''])(
    'rejects invalid slug %j without creating anything',
    (slug) => {
      const fixture = fx()
      const result = runNew(fixture.root, slug)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('[a-z0-9-]+')
      if (slug.length > 0) {
        expect(existsSync(join(fixture.root, '.harness', 'initiatives', slug))).toBe(false)
      }
    },
  )

  it('errors on an existing slug and points at harness switch', () => {
    const fixture = fx() // demo exists
    const result = runNew(fixture.root, 'demo')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('already exists')
    expect(result.stderr).toContain('harness switch demo')
    expect(events(fixture.root, 'demo')).toHaveLength(0) // no event appended
  })

  it('errors clearly on detached HEAD, and --no-bind is the escape hatch', () => {
    const fixture = fx({ branch: null, bind: false }) // detached HEAD
    const blocked = runNew(fixture.root, 'headless', { goal: 'g' })
    expect(blocked.exitCode).toBe(1)
    expect(blocked.stderr).toContain('detached')
    expect(blocked.stderr).toContain('--no-bind')
    expect(existsSync(join(fixture.root, '.harness', 'initiatives', 'headless'))).toBe(false)

    const escaped = runNew(fixture.root, 'headless', { goal: 'g', bind: false })
    expect(escaped.exitCode).toBe(0)
    expect(events(fixture.root, 'headless')).toHaveLength(1)
    expect(existsSync(join(fixture.root, '.harness', 'bindings.json'))).toBe(false) // untouched
  })
})

describe('harness switch', () => {
  it('rebinds the current branch to an existing initiative', () => {
    const fixture = fx({ slug: 'first' })
    expect(runNew(fixture.root, 'second', { bind: false }).exitCode).toBe(0)

    const result = runSwitch(fixture.root, 'second')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('bound branch "main" → second')
    expect(bindings(fixture.root).main).toBe('second')

    // switching back-and-forth keeps working; re-switch is a no-op
    expect(runSwitch(fixture.root, 'first').exitCode).toBe(0)
    expect(bindings(fixture.root).main).toBe('first')
    expect(runSwitch(fixture.root, 'first').stdout).toContain('already bound')
  })

  it('refuses unknown slugs and points at harness new', () => {
    const fixture = fx()
    const result = runSwitch(fixture.root, 'ghost')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not found')
    expect(result.stderr).toContain('harness new ghost')
  })

  it('errors on detached HEAD', () => {
    const fixture = fx({ branch: null, bind: false })
    const result = runSwitch(fixture.root, 'demo')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('detached')
  })
})
