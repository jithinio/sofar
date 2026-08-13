import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TRAILER_KEY } from '../src/core/attribution'
import { handleSessionStart, handleUserPrompt } from '../src/cli/event'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { noteUpstream, SHIPWATCH_MAX_MARKS } from '../src/core/shipwatch'

/**
 * The LIVE shipping signal (commit-attribution 3.4, D11) — a session already
 * running when a sibling pushes learns its work shipped on its next prompt.
 *
 * Two properties carry the design and both are pinned here: the line is
 * EDGE-triggered (it announces a transition once, never a standing condition),
 * and the trailer walk is GATED on ref movement, so a quiet prompt spawns no
 * git at all. The second is checked by making git unusable and asserting the
 * prompt path still succeeds.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const SLUG = 'demo'
const SESSION = 'sess-landed'

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/** A repo with `SLUG` bound to the branch, a bare remote, and a live session. */
function repo(name: string): { root: string } {
  const root = mkdtempSync(join(tmpdir(), `sofar-landed-${name}-`))
  roots.push(root)
  git(root, 'init', '--quiet', '.')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')

  mkdirSync(join(root, '.sofar', 'initiatives', SLUG), { recursive: true })
  const branch = git(root, 'symbolic-ref', '--short', 'HEAD').trim()
  writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ [branch]: SLUG }))
  const log = join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')
  writeFileSync(log, '')
  for (const event of [
    makeEvent({
      initiative: SLUG,
      session: SESSION,
      type: 'initiative_created',
      payload: { goal: 'landed probe' },
      source: 'cli',
      actor: 'agent',
    }),
    // The prompt path only speaks to sessions it knows — an unregistered id is
    // "not ours to nudge" and returns before any of this runs.
    makeEvent({
      initiative: SLUG,
      session: SESSION,
      type: 'session_started',
      payload: { tool: 'claude-code' },
      source: 'hook',
      actor: 'agent',
    }),
  ]) {
    appendEvent(log, event)
  }

  const bare = `${root}-remote.git`
  roots.push(bare)
  execFileSync('git', ['init', '--quiet', '--bare', bare], { stdio: 'ignore' })
  git(root, 'remote', 'add', 'origin', bare)
  return { root }
}

function commit(root: string, subject: string, slug?: string): void {
  writeFileSync(join(root, `f-${subject}`), `${subject}\n`)
  git(root, 'add', '-A')
  const path = join(root, '.msg')
  writeFileSync(path, slug === undefined ? `${subject}\n` : `${subject}\n\n${TRAILER_KEY}: ${slug}\n`)
  git(root, 'commit', '--quiet', '-F', path)
}

/** Orient the session, which is also what seeds the movement gate. */
function orient(root: string): string {
  return handleSessionStart(root, JSON.stringify({ session_id: SESSION })).stdout
}

function prompt(root: string): string {
  return handleUserPrompt(root, JSON.stringify({ session_id: SESSION })).stdout
}

/**
 * A sibling pushes the shared branch. The pushing session is deliberately not
 * modelled: nothing about this design requires it to know who to tell (D11).
 */
function siblingPush(root: string): void {
  git(root, 'push', '--quiet', '-u', 'origin', 'HEAD')
}

describe('live shipping signal (3.4)', () => {
  it('tells a LIVE session its commits reached origin', () => {
    // The original complaint, in full: the window commits, orients, and is
    // still running when the push happens elsewhere.
    const { root } = repo('live')
    commit(root, 'one', SLUG)
    orient(root)
    siblingPush(root)
    expect(prompt(root)).toContain('1 commit(s) of this record just landed on origin/')
  })

  it('announces the transition ONCE, not on every later prompt', () => {
    // Edge-triggered, unlike the drift nudge beside it: "just landed" repeated
    // ten prompts later is simply false.
    const { root } = repo('once')
    commit(root, 'one', SLUG)
    orient(root)
    siblingPush(root)
    expect(prompt(root)).toContain('just landed')
    expect(prompt(root)).not.toContain('just landed')
    expect(prompt(root)).not.toContain('just landed')
  })

  it('stays silent when origin has not moved', () => {
    const { root } = repo('still')
    commit(root, 'one', SLUG)
    siblingPush(root)
    orient(root)
    expect(prompt(root)).not.toContain('just landed')
  })

  it('ignores a push carrying only OTHER records\' commits', () => {
    // The motivating shape: one branch, several records. A sibling's push is
    // not this record's news.
    const { root } = repo('others')
    commit(root, 'one', 'somebody-else')
    orient(root)
    siblingPush(root)
    expect(prompt(root)).not.toContain('just landed')
  })

  it('counts only this record\'s commits inside a mixed push', () => {
    const { root } = repo('mixed')
    commit(root, 'one', SLUG)
    commit(root, 'two', 'somebody-else')
    commit(root, 'three', SLUG)
    orient(root)
    siblingPush(root)
    expect(prompt(root)).toContain('2 commit(s) of this record just landed')
  })

  it('stays silent on the first look, having nothing to compare against', () => {
    // No orientation ran, so the prompt path has no mark. It records one and
    // says nothing rather than announcing history as news.
    const { root } = repo('firstlook')
    commit(root, 'one', SLUG)
    siblingPush(root)
    expect(prompt(root)).not.toContain('just landed')
  })

  it('counts only what the first push ADDED, never the base branch behind it', () => {
    // The false-alarm this whole initiative exists to remove, found by review
    // after it shipped: a feature branch cut from an already-pushed base has no
    // origin/<branch> to diff against, and walking reachability from the new
    // tip reported the entire base as newly landed — measured at 4 when 1 had
    // arrived. D2 ranks a wrong "your work shipped" as worse than no signal,
    // because it retires a next action nobody performed.
    const { root } = repo('firstpush-base')
    commit(root, 'base-one', SLUG)
    commit(root, 'base-two', SLUG)
    siblingPush(root) // the base is already on origin
    git(root, 'checkout', '--quiet', '-b', 'feature')
    commit(root, 'the-only-new-work', SLUG)
    orient(root) // origin/feature does not exist yet
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD')
    const out = prompt(root)
    expect(out).toContain('1 commit(s) of this record just landed')
    expect(out).not.toContain('3 commit(s)')
  })

  it('reports the branch\'s FIRST push, where no upstream ref existed before', () => {
    // The state that has to be watched rather than skipped: before the first
    // push there is no origin/<branch> at all, and the ref appearing IS the
    // work leaving the machine — the least ambiguous shipping event there is.
    const { root } = repo('firstpush')
    commit(root, 'one', SLUG)
    orient(root) // no upstream ref exists yet
    siblingPush(root)
    expect(prompt(root)).toContain('1 commit(s) of this record just landed on origin/')
  })

  it('recovers rather than sticking when the old sha is gone', () => {
    // A force-push past the mark can make `previous..current` unresolvable.
    // The walk fails and the line is silent — but the mark still advances, so
    // the NEXT push reports normally instead of the session being stuck.
    const { root } = repo('forced')
    commit(root, 'one', SLUG)
    commit(root, 'two', SLUG)
    siblingPush(root)
    orient(root)

    git(root, 'reset', '--hard', '--quiet', 'HEAD~1')
    commit(root, 'rewritten', SLUG)
    git(root, 'push', '--quiet', '--force', 'origin', 'HEAD')
    // Drop the unreachable object so the range genuinely cannot resolve.
    git(root, 'reflog', 'expire', '--expire=now', '--all')
    git(root, 'gc', '--prune=now', '--quiet')
    prompt(root) // absorbs the rewrite, silently or not — either is acceptable

    commit(root, 'after', SLUG)
    siblingPush(root)
    expect(prompt(root)).toContain('just landed')
  })

  it('never spawns git on a quiet prompt — the D6 gate', () => {
    // Proven by removing git from PATH: if the prompt path walked trailers
    // unconditionally it would still return OK (everything is best-effort),
    // so the assertion is on the LINE, which can only exist via a spawn.
    const { root } = repo('gate')
    commit(root, 'one', SLUG)
    siblingPush(root)
    orient(root)
    const path = process.env['PATH']
    process.env['PATH'] = join(root, 'no-such-bin')
    try {
      const out = handleUserPrompt(root, JSON.stringify({ session_id: SESSION }))
      expect(out.exitCode).toBe(0)
      expect(out.stdout).not.toContain('just landed')
    } finally {
      if (path === undefined) delete process.env['PATH']
      else process.env['PATH'] = path
    }
  })

  it('never breaks the prompt path when there is no remote at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-landed-noremote-'))
    roots.push(root)
    git(root, 'init', '--quiet', '.')
    git(root, 'config', 'user.email', 't@t.t')
    git(root, 'config', 'user.name', 't')
    mkdirSync(join(root, '.sofar', 'initiatives', SLUG), { recursive: true })
    const branch = git(root, 'symbolic-ref', '--short', 'HEAD').trim()
    writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ [branch]: SLUG }))
    writeFileSync(join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl'), '')
    commit(root, 'one', SLUG)
    expect(handleUserPrompt(root, JSON.stringify({ session_id: SESSION })).exitCode).toBe(0)
  })
})

describe('the movement mark (core/shipwatch)', () => {
  const SHA_A = 'a'.repeat(40)
  const SHA_B = 'b'.repeat(40)

  function sofarDir(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `sofar-watch-${name}-`))
    roots.push(root)
    const dir = join(root, '.sofar')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('reports a first look as unmoved, then movement against it', () => {
    const dir = sofarDir('basic')
    expect(noteUpstream(dir, 's1', 'main', SHA_A)).toEqual({ previous: null, moved: false })
    expect(noteUpstream(dir, 's1', 'main', SHA_A)).toEqual({ previous: SHA_A, moved: false })
    expect(noteUpstream(dir, 's1', 'main', SHA_B)).toEqual({ previous: SHA_A, moved: true })
    expect(noteUpstream(dir, 's1', 'main', SHA_B)).toEqual({ previous: SHA_B, moved: false })
  })

  it('keeps sessions independent — one session looking does not consume another\'s news', () => {
    // Sessions share the worktree AND this file, so the marks must not.
    const dir = sofarDir('independent')
    noteUpstream(dir, 's1', 'main', SHA_A)
    noteUpstream(dir, 's2', 'main', SHA_A)
    expect(noteUpstream(dir, 's1', 'main', SHA_B).moved).toBe(true)
    expect(noteUpstream(dir, 's2', 'main', SHA_B).moved).toBe(true)
  })

  it('treats a branch switch as a first look, never as movement', () => {
    // A mark taken on another branch describes a different ref entirely, so
    // reading it as movement would announce a push that never happened.
    const dir = sofarDir('branch')
    noteUpstream(dir, 's1', 'main', SHA_A)
    expect(noteUpstream(dir, 's1', 'other', SHA_B)).toEqual({ previous: null, moved: false })
  })

  it('rejects a sha that is not a full one', () => {
    // Short shas are display values; feeding one back as a rev is how the
    // range silently stops resolving.
    const dir = sofarDir('short')
    expect(noteUpstream(dir, 's1', 'main', SHA_A.slice(0, 7))).toEqual({
      previous: null,
      moved: false,
    })
  })

  it('evicts the oldest marks rather than growing forever', () => {
    // Nothing cleans up on session end — a crashed session ends nothing.
    const dir = sofarDir('evict')
    for (let i = 0; i < SHIPWATCH_MAX_MARKS + 5; i += 1) noteUpstream(dir, `s${i}`, 'main', SHA_A)
    // The newest survivor still holds its mark; the very first is long gone.
    expect(noteUpstream(dir, `s${SHIPWATCH_MAX_MARKS + 4}`, 'main', SHA_B).moved).toBe(true)
    expect(noteUpstream(dir, 's0', 'main', SHA_B).moved).toBe(false)
  })

  it('does not evict a QUIET session that keeps looking', () => {
    // Found by review: eviction ordered by last WRITE starves the session that
    // has seen no push — it never rewrites, its seq freezes, and busier
    // sessions evict a window that is still live. The push it was waiting for
    // is then exactly the one it never hears. Looking must count as activity.
    const dir = sofarDir('quiet')
    noteUpstream(dir, 'quiet-one', 'main', SHA_A)
    for (let i = 0; i < SHIPWATCH_MAX_MARKS + 5; i += 1) {
      noteUpstream(dir, `busy${i}`, 'main', SHA_A)
      noteUpstream(dir, 'quiet-one', 'main', SHA_A) // looks, sees nothing, stays
    }
    // Still marked, so a real push still reaches it.
    expect(noteUpstream(dir, 'quiet-one', 'main', SHA_B).moved).toBe(true)
  })

  it('cold-starts on a corrupt file instead of throwing', () => {
    const dir = sofarDir('corrupt')
    mkdirSync(join(dir, '.index'), { recursive: true })
    writeFileSync(join(dir, '.index', 'shipwatch.json'), '{not json')
    expect(noteUpstream(dir, 's1', 'main', SHA_A)).toEqual({ previous: null, moved: false })
  })
})
