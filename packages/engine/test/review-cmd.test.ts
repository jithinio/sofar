import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TRAILER_KEY } from '../src/core/attribution'
import { runReview } from '../src/cli/review'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'

/**
 * `sofar review` — the READ half of the review loop (4.6).
 *
 * The behaviour that matters is the RANGE: it must come from the watermark and
 * from trailer attribution, never from timestamps, and it must not quietly
 * include another initiative's commits.
 */

const roots: string[] = []
const SLUG = 'demo'

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

function repo(name: string): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), `sofar-revcmd-${name}-`))
  roots.push(root)
  git(root, 'init', '--quiet', '.')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.sofar', 'initiatives', SLUG), { recursive: true })
  const branch = git(root, 'symbolic-ref', '--short', 'HEAD').trim()
  writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ [branch]: SLUG }))
  const log = join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')
  writeFileSync(log, '')
  append(log, 'initiative_created', { slug: SLUG, goal: 'ship it' })
  append(log, 'plan_updated', {
    plan: {
      goal: 'ship it',
      phases: [
        { name: 'Phase 1', status: 'active', tasks: [{ id: '1.1', title: 'build', status: 'done' }] },
      ],
    },
  })
  return { root, log }
}

function append(log: string, type: string, payload: Record<string, unknown>): void {
  appendEvent(
    log,
    makeEvent({
      initiative: SLUG,
      session: 's1',
      type: type as Parameters<typeof makeEvent>[0]['type'],
      payload,
      source: 'cli',
      actor: 'agent',
    }),
  )
}

function commit(root: string, subject: string, slug?: string): string {
  writeFileSync(join(root, `f-${subject}`), `${subject}\n`)
  git(root, 'add', '-A')
  const path = join(root, '.msg')
  writeFileSync(path, slug === undefined ? `${subject}\n` : `${subject}\n\n${TRAILER_KEY}: ${slug}\n`)
  git(root, 'commit', '--quiet', '-F', path)
  return git(root, 'rev-parse', 'HEAD').trim()
}

describe('sofar review', () => {
  it('renders the active phase with its attributed commits', () => {
    const { root } = repo('basic')
    commit(root, 'one', SLUG)
    const out = runReview({ root })
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('Phase review — demo / Phase 1')
    expect(out.stdout).toContain('1 commit(s)')
  })

  it('EXCLUDES another initiative\'s commits from the range', () => {
    // The motivating case for the whole initiative: one branch carries several
    // records' commits, and a review must not audit someone else's work.
    const { root } = repo('others')
    commit(root, 'mine', SLUG)
    commit(root, 'theirs', 'somebody-else')
    expect(runReview({ root }).stdout).toContain('1 commit(s)')
  })

  it('starts the range at the WATERMARK once a review has run', () => {
    const { root, log } = repo('watermark')
    const first = commit(root, 'one', SLUG)
    commit(root, 'two', SLUG)
    append(log, 'review_recorded', {
      scope: 'phase',
      verdict: 'pass',
      phase: 'Phase 1',
      watermark: first,
    })
    const out = runReview({ root })
    // Only the commit AFTER the watermark is in range — the reviewed one is not
    // re-reviewed, which is the entire point of recording a watermark.
    expect(out.stdout).toContain('1 commit(s)')
    expect(out.stdout).toContain(`${first.slice(0, 12)}..HEAD`)
  })

  it('reports an empty range as a finding rather than looking normal', () => {
    const { root } = repo('empty')
    commit(root, 'untrailered')
    expect(runReview({ root }).stdout).toContain('finding in itself')
  })

  it('--final asks the cross-cutting questions and carries open findings', () => {
    const { root, log } = repo('final')
    commit(root, 'one', SLUG)
    append(log, 'review_recorded', {
      scope: 'phase',
      verdict: 'findings',
      phase: 'Phase 1',
      findings: ['leaks a handle'],
    })
    const out = runReview({ root, final: true })
    expect(out.stdout).toContain('GOAL CONFORMANCE')
    expect(out.stdout).toContain('leaks a handle')
  })

  it('fails clearly when a named phase does not exist', () => {
    const { root } = repo('nophase')
    const out = runReview({ root, phase: 'Phase 99' })
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('no phase named "Phase 99"')
  })
})
