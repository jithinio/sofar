import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runList } from '../src/cli/list'
import { runNext } from '../src/cli/next'
import { createStatusWatchModel, runStatus } from '../src/cli/status'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { listAcrossCopies, listInitiatives } from '../src/core/listing'
import { serializeEvent } from '../src/core/log'
import { copyWatch, lineId, scanRecordCopies, unionFold, worktreeLeads } from '../src/core/record-copies'
import { handleSessionStart, runAppend } from '../src/cli/event'
import { callTool, connectServer } from './helpers/mcp'
import { WORKTREE_LEADS_BUDGET, worktreeLeadsNotice } from '../src/projections/templates/copies'
import { watch } from 'chokidar'
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

describe('status --watch across copies (branch-visibility 3.2)', () => {
  it('watches the common git dir and every other checkout\'s record, never this one', () => {
    const root = repo('watch-paths')
    const feat = worktree(root, 'feat')
    expect(copyWatch(root, SLUG).paths).toEqual([join(root, '.git'), join(feat, '.sofar', 'initiatives')])
    expect(copyWatch(feat, SLUG).paths).toEqual([join(root, '.git'), join(root, '.sofar', 'initiatives')])
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-copies-nogit-')))
    roots.push(outside)
    expect(copyWatch(outside, SLUG).paths).toEqual([])
  })

  it('lets through only what can change this initiative\'s copies', () => {
    const root = repo('watch-filter')
    const feat = worktree(root, 'feat')
    const common = join(root, '.git')
    const record = join(feat, '.sofar', 'initiatives')
    const { ignored } = copyWatch(root, SLUG)
    const kept = [
      common,
      join(common, 'HEAD'),
      join(common, 'packed-refs'),
      join(common, 'refs'),
      join(common, 'refs', 'heads', 'feat'),
      join(common, 'refs', 'heads', 'team', 'x'),
      join(common, 'worktrees'),
      join(common, 'worktrees', 'feat'),
      join(common, 'worktrees', 'feat', 'HEAD'),
      record,
      join(record, SLUG),
      join(record, SLUG, 'events.jsonl'),
    ]
    const noise = [
      join(common, 'objects'),
      join(common, 'objects', 'ab', 'cdef'),
      join(common, 'index'),
      join(common, 'refs', 'heads', 'feat.lock'),
      join(common, 'refs', 'tags', 'v1'),
      join(common, 'refs', 'remotes', 'origin', 'main'),
      join(common, 'worktrees', 'feat', 'index'),
      join(common, 'worktrees', 'feat', 'logs', 'HEAD'),
      join(record, SLUG, 'plan.md'),
      join(record, SLUG, 'sessions', 's.md'),
      join(record, 'other'),
      join(record, 'other', 'events.jsonl'),
    ]
    expect(kept.filter(ignored)).toEqual([])
    expect(noise.filter((p) => !ignored(p))).toEqual([])
    expect(copyWatch(root, SLUG, { remotes: true }).ignored(join(common, 'refs', 'remotes', 'origin', 'main'))).toBe(false)
  })

  it('a pulse never rescans; a local change re-folds without a rescan; a copy change rescans once', () => {
    const { root, feat } = (() => {
      const r = repo('watch-model')
      return { root: r, feat: worktree(r, 'feat') }
    })()
    const model = createStatusWatchModel(createToolContext(root), SLUG)
    expect(model.scans).toBe(1)
    expect(tasksDone(model.view.state)).toBe(0)
    for (let i = 0; i < 20; i++) expect(model.pollLocal()).toBe(false)
    expect(model.scans).toBe(1)

    append(root, [done('1.2')])
    expect(model.pollLocal()).toBe(true) // the backstop sees the local append
    expect(tasksDone(model.view.state)).toBe(1)
    expect(model.scans).toBe(1)

    append(feat, [done('1.1')])
    model.copiesChanged()
    expect(model.scans).toBe(2)
    expect(tasksDone(model.view.state)).toBe(2)
    expect(model.view.provenance?.copies.map((c) => c.copy.ref)).toEqual(['feat'])
  })

  it('--here never scans', () => {
    const root = repo('watch-here')
    append(worktree(root, 'feat'), [done('1.1')])
    const model = createStatusWatchModel(createToolContext(root), SLUG, { here: true })
    model.copiesChanged()
    expect(model.scans).toBe(0)
    expect(tasksDone(model.view.state)).toBe(0)
    expect(model.view.provenance).toBeNull()
  })

  it('a real watcher on those targets hears another worktree\'s append and a new branch', async () => {
    const root = repo('watch-live')
    const feat = worktree(root, 'feat')
    const { paths, ignored } = copyWatch(root, SLUG)
    const heard: string[] = []
    const watcher = watch(paths, { ignoreInitial: true, ignored })
    try {
      await new Promise<void>((resolve) => watcher.on('ready', () => resolve()))
      watcher.on('all', (_event, path) => heard.push(path))
      const until = async (match: (p: string) => boolean): Promise<void> => {
        const deadline = Date.now() + 3000
        while (!heard.some(match) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
        expect(heard.some(match), `heard: ${heard.join(', ')}`).toBe(true)
      }
      append(feat, [done('1.1')])
      await until((p) => p === logPath(feat))
      git(root, 'branch', 'side')
      await until((p) => p.startsWith(join(root, '.git', 'refs', 'heads')) || p === join(root, '.git', 'packed-refs'))
      expect(heard.filter(ignored)).toEqual([])
    } finally {
      await watcher.close()
    }
  })
})

describe('SessionStart: events of this record on other worktrees (branch-visibility 3.3)', () => {
  const leadsOf = (root: string): string[] =>
    worktreeLeads(root, SLUG, logPath(root)).map((lead) => `${lead.copy.ref}+${lead.unseen}`)

  it('an idle fork, and one this checkout has moved past, hold nothing new', () => {
    const root = repo('leads-prefix')
    worktree(root, 'idle')
    expect(leadsOf(root)).toEqual([])
    append(root, [done('1.1'), done('1.2')]) // main moves on: the fork is now an older prefix
    expect(leadsOf(root)).toEqual([])
  })

  it('counts a worktree\'s uncommitted appends, most first, never this checkout', () => {
    const root = repo('leads-count')
    append(worktree(root, 'feat'), [done('1.1')])
    append(worktree(root, 'wide'), [done('1.1'), done('1.2')])
    expect(leadsOf(root)).toEqual(['wide+2', 'feat+1'])
  })

  it('a diverged copy smaller than this log is still read, not taken for a prefix', () => {
    const root = repo('leads-diverged')
    const feat = worktree(root, 'feat')
    append(feat, [done('1.1')])
    append(root, [done('1.2'), done('1.2'), done('1.2')]) // this log is now the larger
    expect(leadsOf(root)).toEqual(['feat+1'])
    // Seen from the worktree, main holds three events it lacks.
    expect(worktreeLeads(feat, SLUG, logPath(feat)).map((l) => `${l.copy.ref}+${l.unseen}`)).toEqual(['main+3'])
  })

  it('with no copy here, every event another worktree holds is unseen; outside git there are none', () => {
    const root = repo('leads-absent')
    const feat = worktree(root, 'feat')
    append(feat, [ev('solo', 'initiative_created', { slug: 'solo', goal: 'only on feat' })], 'solo')
    expect(worktreeLeads(root, 'solo', logPath(root, 'solo')).map((l) => l.unseen)).toEqual([1])
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sofar-copies-nogit-')))
    roots.push(outside)
    expect(worktreeLeads(outside, SLUG, logPath(outside))).toEqual([])
  })

  it('the SessionStart block names the worktree, and stays as it was without one', () => {
    const input = (id: string): string => JSON.stringify({ session_id: id, hook_event_name: 'SessionStart', source: 'startup' })
    const root = repo('leads-hook')
    const lone = handleSessionStart(root, input('s-lone')).stdout
    expect(lone).toContain('# Sofar status: demo')
    expect(lone).not.toContain('live on other worktrees')

    append(worktree(root, 'feat'), [done('1.1')])
    const out = handleSessionStart(root, input('s-feat')).stdout
    expect(out).toMatch(
      /⚠ 1 event\(s\) of this record live on other worktrees, not on this checkout: \+1 on feat \(worktree .*feat\)\. This block folds this checkout's copy alone; `sofar status` folds them in\./,
    )
  })

  it('the notice names two worktrees, counts the rest, and holds its budget', () => {
    expect(worktreeLeadsNotice([])).toBeNull()
    const lead = (ref: string, unseen: number) => ({ copy: { kind: 'worktree' as const, ref, path: `/w/${ref}` }, unseen })
    const three = worktreeLeadsNotice([lead('a', 5), lead('b', 2), lead('c', 1)])!
    expect(three).toContain('⚠ 8 event(s) of this record live on other worktrees, not on this checkout: +5 on a (worktree /w/a), +2 on b (worktree /w/b), +1 more.')
    const long = worktreeLeadsNotice([lead('x'.repeat(300), 1), lead('y'.repeat(300), 1)])!
    expect(long.length).toBeLessThanOrEqual(WORKTREE_LEADS_BUDGET)
  })
})

describe('write guard: a write into a copy another worktree has moved past (branch-visibility 3.4)', () => {
  const LAG = /^this checkout's copy of demo is behind another worktree's: 1 event\(s\) are not here \(\+1 on feat \(worktree .*feat\)\)\. The write landed in this copy only \(branch-visibility D1\)\./

  it('an MCP write warns once per lagging worktree, and again after the lag clears and returns', async () => {
    const root = repo('guard-mcp')
    const feat = worktree(root, 'feat')
    append(feat, [done('1.1')])
    const { client } = await connectServer(root)

    const first = await callTool<{ ok: boolean; warnings?: string[] }>(client, 'sofar_add_note', { text: 'one' })
    expect(first.isError).toBe(false)
    expect(first.body.warnings).toHaveLength(1)
    expect(first.body.warnings![0]).toMatch(LAG)
    const second = await callTool(client, 'sofar_add_note', { text: 'two' })
    expect(second.body).not.toHaveProperty('warnings') // same lag, already named

    // The copies meet (what a merge does to this log), then feat moves on again.
    appendFileSync(logPath(root), readFileSync(logPath(feat), 'utf8').split('\n').slice(-2).join('\n'))
    expect((await callTool(client, 'sofar_add_note', { text: 'three' })).body).not.toHaveProperty('warnings')
    append(feat, [done('1.2')])
    const again = await callTool<{ warnings?: string[] }>(client, 'sofar_update_task', { task_id: '1.2', status: 'active' })
    expect(again.body.warnings?.[0]).toMatch(/copy of demo is behind another worktree's: 1 event\(s\)/)
  })

  it('start_session warns for the record it starts in; a copy nobody moved past gets the bare result', async () => {
    const root = repo('guard-start')
    append(worktree(root, 'feat'), [done('1.1')])
    const { client } = await connectServer(root)
    const started = await callTool<{ session_id: string; warnings?: string[] }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      initiative: SLUG,
    })
    expect(started.body.session_id).toBeTruthy()
    expect(started.body.warnings?.[0]).toMatch(LAG)

    const lone = repo('guard-lone')
    worktree(lone, 'idle')
    const bare = await callTool(( await connectServer(lone)).client, 'sofar_add_note', { text: 'x' })
    expect(Object.keys(bare.body).sort()).toEqual(['event_id', 'ok'])
  })

  it('the CLI dialect speaks on a session start, a decision and a write-back, not on every append', () => {
    const root = repo('guard-cli')
    append(worktree(root, 'feat'), [done('1.1')])
    const run = (type: string, payload: Record<string, unknown>) =>
      JSON.parse(runAppend(root, { type, payload: JSON.stringify(payload), session: 'sess-cli', source: 'codex', actor: 'agent' }).stdout) as {
        ok: boolean
        warnings?: string[]
      }
    expect(run('session_started', { tool: 'codex' }).warnings?.[0]).toMatch(LAG)
    expect(run('note_added', { text: 'n' })).not.toHaveProperty('warnings')
    expect(run('task_status_changed', { id: '1.2', status: 'active' })).not.toHaveProperty('warnings')
    expect(run('decision_logged', { chose: 'a', over: 'b', because: 'c' }).warnings?.[0]).toMatch(LAG)
    expect(run('session_ended', { summary: 's', next_action: 'n' }).warnings?.[0]).toMatch(LAG)
  })

  it('never writes to the copy it warns about', async () => {
    const root = repo('guard-readonly')
    const feat = worktree(root, 'feat')
    append(feat, [done('1.1')])
    const before = readFileSync(logPath(feat), 'utf8')
    const status = git(feat, 'status', '--porcelain')
    const { client } = await connectServer(root)
    await callTool(client, 'sofar_add_note', { text: 'here only' })
    runAppend(root, { type: 'session_started', payload: '{"tool":"codex"}', session: 's2', source: 'codex', actor: 'agent' })
    expect(readFileSync(logPath(feat), 'utf8')).toBe(before)
    expect(git(feat, 'status', '--porcelain')).toBe(status)
    expect(readFileSync(logPath(root), 'utf8')).toContain('here only')
  })
})

describe('final review (branch-visibility)', () => {
  it('unbound `sofar status` names the record the union listing puts first', () => {
    const root = repo('unbound-pick')
    append(root, [ev('alpha', 'initiative_created', { slug: 'alpha', goal: 'newest on every copy but one' })], 'alpha')
    commitAll(root, 'alpha')
    const loose = worktree(root, 'loose') // bindings name only main: this branch is unbound
    append(worktree(root, 'feat'), [done('1.1')]) // demo's newest event, on feat alone

    const union = runStatus(loose, undefined, plain, 100).stdout
    expect(union).toContain('showing the most recently active initiative, demo.')
    expect(union.indexOf('- demo [main]')).toBeLessThan(union.indexOf('- alpha [unbound]'))
    const here = runStatus(loose, undefined, plain, 100, { here: true }).stdout
    expect(here).toContain('showing the most recently active initiative, alpha.')
  })
})

