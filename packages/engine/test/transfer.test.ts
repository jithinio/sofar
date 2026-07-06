import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EventEnvelope } from '../src/core/envelope'
import { makeEvent } from '../src/core/envelope'
import { appendEvents } from '../src/core/log'
import { foldLog } from '../src/core/fold'
import { runExport, runImport } from '../src/cli/transfer'
import { makeRepoFixture, type Fixture, type FixtureOptions } from './helpers/mcp'

/**
 * Task 4.4 — `harness export` / `harness import`: CLI round-trip between two
 * temp initiatives (replicas of the same slug), idempotent re-import,
 * --since filtering, and resolution failures.
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

function seed(fixture: Fixture, n = 3): EventEnvelope[] {
  const events: EventEnvelope[] = [
    makeEvent({
      initiative: fixture.slug,
      session: 'cli',
      source: 'cli',
      actor: 'human',
      type: 'initiative_created',
      payload: { slug: fixture.slug, goal: 'replicate me' },
    }),
  ]
  for (let i = 0; i < n; i++) {
    events.push(
      makeEvent({
        initiative: fixture.slug,
        session: 'cli',
        source: 'cli',
        actor: 'agent',
        type: 'note_added',
        payload: { text: `note ${i}` },
      }),
    )
  }
  appendEvents(fixture.eventsPath, events)
  return events
}

describe('harness export / import round-trip', () => {
  it('replicates one initiative into another repo and is idempotent on re-import', () => {
    const source = fx()
    const replica = fx() // same slug "demo", different temp repo
    const seeded = seed(source)

    // export: NDJSON on stdout, one line per event, ulid order
    const exported = runExport(source.root)
    expect(exported.exitCode).toBe(0)
    expect(exported.stderr).toBe('')
    const lines = exported.stdout.trim().split('\n')
    expect(lines).toHaveLength(seeded.length)
    expect(lines.map((l) => (JSON.parse(l) as EventEnvelope).id)).toEqual(seeded.map((e) => e.id))

    // import into the replica (stdout capture → import)
    const imported = runImport(replica.root, exported.stdout)
    expect(imported.exitCode).toBe(0)
    expect(JSON.parse(imported.stdout.trim())).toEqual({ appended: seeded.length, skipped: 0 })

    // replica state deep-equals the source state, projections regenerated
    expect(foldLog(replica.eventsPath).state).toEqual(foldLog(source.eventsPath).state)
    expect(existsSync(join(replica.initiativeDir, 'plan.md'))).toBe(true)

    // idempotent re-import: appended 0, skipped all
    const again = runImport(replica.root, exported.stdout)
    expect(again.exitCode).toBe(0)
    expect(JSON.parse(again.stdout.trim())).toEqual({ appended: 0, skipped: seeded.length })
    expect(foldLog(replica.eventsPath).state).toEqual(foldLog(source.eventsPath).state)
  })

  it('--since exports only events strictly after the cursor', () => {
    const source = fx()
    const seeded = seed(source, 4)
    const since = seeded[2]!.id

    const result = runExport(source.root, { since })
    expect(result.exitCode).toBe(0)
    const ids = result.stdout
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as EventEnvelope).id)
    expect(ids).toEqual(seeded.slice(3).map((e) => e.id))
  })

  it('export of an empty initiative is an empty stream; import of it appends nothing', () => {
    const source = fx()
    const exported = runExport(source.root, { slug: source.slug })
    expect(exported.exitCode).toBe(0)
    expect(exported.stdout).toBe('')

    const imported = runImport(source.root, '')
    expect(imported.exitCode).toBe(0)
    expect(JSON.parse(imported.stdout.trim())).toEqual({ appended: 0, skipped: 0 })
  })

  it('import surfaces bad stream lines as warnings but still lands valid events', () => {
    const source = fx()
    const replica = fx()
    const seeded = seed(source, 1)
    const stream = `not json at all\n${runExport(source.root).stdout}{"v":9}\n`

    const result = runImport(replica.root, stream)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({ appended: seeded.length, skipped: 0 })
    expect(result.stderr).toContain('warning:')
    expect(result.stderr).toContain('unparseable JSON')
    expect(result.stderr).toContain('invalid envelope')
  })

  it('exits 1 with usage hints when the initiative is unresolvable', () => {
    const unbound = fx({ bind: false })
    const exported = runExport(unbound.root)
    expect(exported.exitCode).toBe(1)
    expect(exported.stderr).toContain('usage: harness export [slug] [--since <id>]')

    const imported = runImport(unbound.root, '')
    expect(imported.exitCode).toBe(1)
    expect(imported.stderr).toContain('usage: harness import <file|-> [slug]')

    const unknown = runExport(unbound.root, { slug: 'ghost' })
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain('initiative "ghost" not found')
  })
})
