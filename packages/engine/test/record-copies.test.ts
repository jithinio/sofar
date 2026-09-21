import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runList } from '../src/cli/list'
import { runNext } from '../src/cli/next'
import { runStatus } from '../src/cli/status'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { listAcrossCopies, listInitiatives } from '../src/core/listing'
import { serializeEvent } from '../src/core/log'
import { lineId, scanRecordCopies, unionFold } from '../src/core/record-copies'
import type { Caps } from '../src/cli/ui/caps'
import { createToolContext } from '../src/mcp/context'
import { getState } from '../src/mcp/get-state'
import { LIST_LINE_BUDGET, PROVENANCE_LINE_BUDGET } from '../src/projections/templates/list'

/**
 * Record copies across branches (branch-visibility D1; SPEC §Record copies across branches).
 * Every fixture is a REAL git repo with real linked worktrees: the discovery
 * reads git's own admin files and refs, so a fake layout would test the fake.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const plain: Caps = { color: false, unicode: true, animate: false }
const styled: Caps = { color: true, unicode: true, animate: false }
const SLUG = 'demo'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function ev(slug: string, type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({ initiative: slug, session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload })
}

function line(event: EventEnvelope): string {
  return `${serializeEvent(event)}\n`
}

function logPath(root: string, slug = SLUG): string {
  return join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
}

function append(root: string, events: EventEnvelope[], slug = SLUG): void {
  mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
  appendFileSync(logPath(root, slug), events.map(line).join(''))
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', message)
}

const done = (id: string): EventEnvelope => ev(SLUG, 'task_status_changed', { id, status: 'done' })

/**
 * main holds `demo` with two tasks, nothing done, committed. The caller then
 * forks whatever copies the case needs.
 */
function repo(name: string): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `sofar-copies-${name}-`)))
  roots.push(base)
  const root = join(base, 'main')
  mkdirSync(root)
  git(root, 'init', '--quiet', '-b', 'main', '.')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')
  mkdirSync(join(root, '.sofar'), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ main: SLUG }))
  append(root, [
    ev(SLUG, 'initiative_created', { slug: SLUG, goal: 'copies probe' }),
    ev(SLUG, 'plan_updated', {
      plan: {
        phases: [
          {
            name: 'Phase 1',
            status: 'active',
            tasks: [
              { id: '1.1', title: 'first' },
              { id: '1.2', title: 'second' },
            ],
          },
        ],
      },
    }),
  ])
  commitAll(root, 'init')
  return root
}

/** A linked worktree on a new branch, as a sibling of main. */
function worktree(root: string, branch: string): string {
  const path = join(root, '..', branch)
  git(root, 'worktree', 'add', '--quiet', '-b', branch, path)
  return realpathSync(path)
}

/** A branch with commits but NO checkout: built in a worktree that is then removed. */
function detachedBranch(root: string, branch: string, build: (path: string) => void): void {
  const path = worktree(root, branch)
  build(path)
  commitAll(path, `${branch} work`)
  git(root, 'worktree', 'remove', '--force', path)
}

function tasksDone(state: { phases: Array<{ tasks: Array<{ status: string }> }> }): number {
  return state.phases.flatMap((p) => p.tasks).filter((t) => t.status === 'done').length
}

describe('scanRecordCopies', () => {
  it('finds other worktrees (uncommitted appends included) and unmerged branches, never this checkout or merged branches', () => {
    const root = repo('scan')
    const feat = worktree(root, 'feat')
    append(feat, [done('1.1')]) // uncommitted: only the working file has it
    detachedBranch(root, 'side', (path) => append(path, [done('1.2')]))
    git(root, 'branch', 'merged') // at main's tip: already in HEAD, nothing to add

    const scan = scanRecordCopies(root)
    expect(scan.copies).toEqual([
      { kind: 'worktree', ref: 'feat', path: feat },
      { kind: 'branch', ref: 'side', path: null },
    ])
    const holders = (scan.logs.get(SLUG) ?? []).map((l) => l.copy.ref)
    expect(holders).toEqual(['feat', 'side'])
    expect(scan.logs.get(SLUG)![0]!.text).toContain('"status":"done"')

    // Seen from the worktree, main is the other copy and feat is "here".
    expect(scanRecordCopies(feat).copies.map((c) => [c.kind, c.ref])).toEqual([
      ['worktree', 'main'],
      ['branch', 'side'],
    ])
  })

  it('reads initiatives that exist only on another copy, and honours a slug filter', () => {
    const root = repo('only')
    detachedBranch(root, 'side', (path) => append(path, [ev('solo', 'initiative_created', { slug: 'solo', goal: 'g' })], 'solo'))
    expect([...scanRecordCopies(root).logs.keys()].sort()).toEqual([SLUG, 'solo'])
    expect([...scanRecordCopies(root, { slugs: ['solo'] }).logs.keys()]).toEqual(['solo'])
  })

  it('reads remote-tracking refs only when asked (D1: opt-in)', () => {
    const root = repo('remotes')
    const bare = `${root}-remote.git`
    roots.push(bare)
    execFileSync('git', ['init', '--quiet', '--bare', bare], { stdio: 'ignore' })
    git(root, 'remote', 'add', 'origin', bare)
    detachedBranch(root, 'pushed', (path) => append(path, [done('1.1')]))
    git(root, 'push', '--quiet', 'origin', 'pushed')
    git(root, 'fetch', '--quiet', 'origin')
    git(root, 'branch', '-D', 'pushed') // only origin/pushed is left

    expect(scanRecordCopies(root).copies).toEqual([])
    expect(scanRecordCopies(root, { remotes: true }).copies).toEqual([
      { kind: 'remote', ref: 'origin/pushed', path: null },
    ])
  })

  it('drops a ref at the same commit as a branch checked out elsewhere', () => {
    const root = repo('alias')
    const feat = worktree(root, 'feat')
    append(feat, [done('1.1')])
    commitAll(feat, 'feat work')
    git(root, 'branch', 'feat-alias', 'feat') // same tip as the worktree's branch
    expect(scanRecordCopies(root).copies.map((c) => c.ref)).toEqual(['feat'])
  })

  it('degrades to no copies outside git', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-copies-nogit-')))
    roots.push(dir)
    append(dir, [ev(SLUG, 'initiative_created', { slug: SLUG, goal: 'g' })])
    expect(scanRecordCopies(dir)).toEqual({ copies: [], logs: new Map() })
  })
})

describe('unionFold', () => {
  it('folds every copy, dedupes by id, and says what each copy adds', () => {
    const root = repo('union')
    const feat = worktree(root, 'feat')
    const shared = ev(SLUG, 'note_added', { text: 'written once, copied twice' })
    append(feat, [done('1.1'), shared])
    commitAll(feat, 'feat work')
    const later = worktree(feat, 'later') // forks feat, so it carries both events too
    append(later, [done('1.2')])

    const scan = scanRecordCopies(root)
    const union = unionFold(SLUG, readFileSync(logPath(root), 'utf8'), scan.logs.get(SLUG)!, 'main')
    expect(tasksDone(union.state)).toBe(2)
    // The shared note sits in two copies and lands once.
    expect(union.state.freshness.notes.map((n) => n.text)).toEqual(['written once, copied twice'])
    expect(union.provenance).toMatchObject({ branch: 'main', exists: true, done: 0, total: 2, unseen: 3 })
    expect(union.provenance!.copies.map((c) => [c.copy.ref, c.unseen])).toEqual([
      ['later', 3],
      ['feat', 2],
    ])
  })

  it('returns no provenance when no copy adds an event — a forked-but-idle branch included', () => {
    const root = repo('idle')
    worktree(root, 'idle') // forked, never wrote: a byte prefix of main's log
    append(root, [done('1.1')]) // main moved on after the fork
    const text = readFileSync(logPath(root), 'utf8')
    const union = unionFold(SLUG, text, scanRecordCopies(root).logs.get(SLUG) ?? [], 'main')
    expect(union.provenance).toBeNull()
    expect(tasksDone(union.state)).toBe(1)
  })

  it('keeps this checkout first, so its warnings are unchanged and foreign ones name their copy', () => {
    const local = [line(ev(SLUG, 'initiative_created', { slug: SLUG, goal: 'g' })), 'not json\n'].join('')
    const foreign = line(ev(SLUG, 'from_a_newer_engine', {}))
    const union = unionFold(SLUG, local, [{ copy: { kind: 'branch', ref: 'next', path: null }, text: foreign }], 'main')
    expect(union.warnings.some((w) => w.startsWith('line 2: '))).toBe(true)
    expect(union.warnings).toContain('next line 1: unknown event type "from_a_newer_engine" — skipped')
  })

  it('reads an id from canonical and non-canonical lines alike, and none from corrupt ones', () => {
    const event = ev(SLUG, 'note_added', { text: 'x' })
    expect(lineId(serializeEvent(event))).toBe(event.id)
    expect(lineId(JSON.stringify({ type: 'note_added', id: event.id }))).toBe(event.id)
    expect(lineId('{"v":1,')).toBeNull()
  })
})

describe('sofar status / sofar list across copies', () => {
  function forked(name: string): { root: string; feat: string } {
    const root = repo(name)
    const feat = worktree(root, 'feat')
    append(feat, [done('1.1')])
    return { root, feat }
  }

  it('status reports the union, what this checkout holds, and which copy holds the rest', () => {
    const { root } = forked('status')
    const out = runStatus(root, undefined, plain, 100)
    expect(out.stdout).toContain('Progress: 1/2 tasks done (50%)')
    expect(out.stdout).toContain('Across branches:')
    expect(out.stdout).toContain('here (main): 0/2 tasks done (0%) — 1 event(s) not on this checkout')
    expect(out.stdout).toMatch(/ {2}feat \(worktree .*feat\): \+1/)
  })

  it('--here is the single-copy view, byte-identical to a repo with no other copy', () => {
    const { root } = forked('here')
    const here = runStatus(root, undefined, plain, 100, { here: true })
    expect(here.stdout).toContain('Progress: 0/2 tasks done (0%)')
    expect(here.stdout).not.toContain('Across branches')

    const lone = repo('lone')
    const byDefault = runStatus(lone, undefined, plain, 100)
    expect(byDefault.stdout).toBe(runStatus(lone, undefined, plain, 100, { here: true }).stdout)
    expect(runList(lone, plain, 100).stdout).toBe(runList(lone, plain, 100, { here: true }).stdout)
  })

  it('status resolves an initiative that exists only on another branch', () => {
    const root = repo('elsewhere')
    detachedBranch(root, 'side', (path) =>
      append(path, [ev('solo', 'initiative_created', { slug: 'solo', goal: 'only on side' })], 'solo'),
    )
    const out = runStatus(root, 'solo', plain, 100)
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('Goal: only on side')
    expect(out.stdout).toContain('here (main): not on this checkout')
    expect(runStatus(root, 'solo', plain, 100, { here: true }).exitCode).not.toBe(0)
  })

  it('list folds every copy and lists initiatives only another copy holds', () => {
    const { root } = forked('list')
    detachedBranch(root, 'side', (path) =>
      append(path, [ev('solo', 'initiative_created', { slug: 'solo', goal: 'only on side' })], 'solo'),
    )
    const out = runList(root, plain, 100).stdout
    expect(out).toContain('- demo [main] — 1/2 tasks (50%) — across branches: here 0/2 tasks done, +1 event(s) on feat')
    expect(out).toContain('- solo [unbound] — 0/0 tasks (0%) — across branches: not on this checkout, +1 event(s) on side')

    const here = runList(root, plain, 100, { here: true }).stdout
    expect(here).toContain('- demo [main] — 0/2 tasks (0%)')
    expect(here).not.toContain('solo')
  })

  it('listInitiatives stays single-copy unless copies are passed in; listAcrossCopies scans for them', () => {
    const { root } = forked('mcp')
    expect(listInitiatives(root).entries[0]!.tasks_done).toBe(0)
    expect(listInitiatives(root, { copies: scanRecordCopies(root) }).entries[0]!.tasks_done).toBe(1)
    expect(listAcrossCopies(root).entries[0]!.tasks_done).toBe(1)
    expect(listAcrossCopies(root, { here: true })).toEqual(listInitiatives(root))
  })

  it('never writes to another copy', () => {
    const { root, feat } = forked('readonly')
    const before = readFileSync(logPath(feat), 'utf8')
    const statusBefore = git(feat, 'status', '--porcelain')
    runStatus(root, undefined, plain, 100)
    runList(root, plain, 100)
    runList(root, styled, 100)
    runNext(root, plain, 100)
    runNext(root, styled, 100)
    getState(createToolContext(root), { view: 'initiatives' })
    expect(readFileSync(logPath(feat), 'utf8')).toBe(before)
    expect(git(feat, 'status', '--porcelain')).toBe(statusBefore)
  })
})

describe('sofar next / get_state view:"initiatives" across copies (branch-visibility 3.1)', () => {
  /** feat writes back a next action main has never seen. */
  function wroteBack(name: string, nextAction = 'ship 1.2 from feat'): { root: string; feat: string } {
    const root = repo(name)
    const feat = worktree(root, 'feat')
    append(feat, [
      ev(SLUG, 'session_started', { tool: 'claude-code' }),
      done('1.1'),
      ev(SLUG, 'session_ended', { summary: 'did 1.1', next_action: nextAction }),
    ])
    return { root, feat }
  }

  it('next shows the last write-back any copy holds, and where its events live', () => {
    const { root } = wroteBack('next')
    expect(runNext(root, plain, 100).stdout).toContain(
      '- demo [main] — ship 1.2 from feat — across branches: here 0/2 tasks done, +3 event(s) on feat',
    )
    const here = runNext(root, plain, 100, { here: true }).stdout
    expect(here).toContain('- demo [main] — (no next action recorded)\n')
    expect(here).not.toContain('across branches')
  })

  it('styled next adds the across-branches line under the action', () => {
    const { root } = wroteBack('next-styled')
    const out = runNext(root, styled, 100).stdout.replace(/\x1b\[[0-9;]*m/g, '')
    expect(out).toContain('    ship 1.2 from feat\n    ⚠ across branches: here 0/2 tasks done, +3 event(s) on feat')
  })

  it('next omits a record another copy closed', () => {
    const root = repo('next-closed')
    const feat = worktree(root, 'feat')
    append(feat, [ev(SLUG, 'initiative_status_changed', { status: 'done' })])
    expect(runNext(root, plain, 100).stdout).toContain('# Sofar next actions (0)')
    expect(runNext(root, plain, 100, { here: true }).stdout).toContain('# Sofar next actions (1)')
  })

  it('with no other copy, next prints byte-identically either way', () => {
    const lone = repo('next-lone')
    expect(runNext(lone, plain, 100).stdout).toBe(runNext(lone, plain, 100, { here: true }).stdout)
    expect(runNext(lone, styled, 100).stdout).toBe(runNext(lone, styled, 100, { here: true }).stdout)
  })

  it('get_state view:"initiatives" folds every copy and keeps the next action inside the widened budget', () => {
    const action = `resume from feat ${'x'.repeat(100)} END`
    const { root } = wroteBack('mcp-view', action)
    const text = getState(createToolContext(root), { view: 'initiatives' }) as string
    const entry = text.split('\n').find((l) => l.startsWith('- demo'))!
    expect(entry).toContain('1/2 tasks (50%) — across branches: here 0/2 tasks done, +3 event(s) on feat')
    expect(entry).toContain(`next: ${action}`) // a 220 budget alone would clip it
    expect(entry.length).toBeGreaterThan(LIST_LINE_BUDGET)
    expect(entry.length).toBeLessThanOrEqual(LIST_LINE_BUDGET + PROVENANCE_LINE_BUDGET)
  })

  it('get_state view:"initiatives" caps a long provenance part at its budget', () => {
    const root = repo('mcp-long')
    const branch = `feat-${'y'.repeat(150)}`
    const feat = worktree(root, branch)
    append(feat, [
      ev(SLUG, 'session_started', { tool: 'claude-code' }),
      ev(SLUG, 'session_ended', { summary: 's', next_action: 'z'.repeat(300) }),
    ])
    const text = getState(createToolContext(root), { view: 'initiatives' }) as string
    const entry = text.split('\n').find((l) => l.startsWith('- demo'))!
    expect(entry.length).toBe(LIST_LINE_BUDGET + PROVENANCE_LINE_BUDGET)
    expect(entry.endsWith('…')).toBe(true)
  })
})
