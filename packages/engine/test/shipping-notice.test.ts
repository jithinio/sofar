import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TRAILER_KEY } from '../src/core/attribution'
import { handleSessionStart } from '../src/cli/event'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'

/**
 * The SessionStart shipping notice (3.2) — the line that replaces a human
 * pinging every other window after a push.
 *
 * The behaviour worth pinning is the SILENCE: when everything this record has
 * committed is on the remote there is no line, and a session watching the line
 * vanish has learned its work shipped without being told.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const SLUG = 'demo'
const SESSION = 'sess-ship'

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/** A repo whose record has `SLUG` bound to the current branch, plus a remote. */
function repo(name: string, { withRemote = true }: { withRemote?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-ship-${name}-`))
  roots.push(root)
  git(root, 'init', '--quiet', '.')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 't')

  mkdirSync(join(root, '.sofar', 'initiatives', SLUG), { recursive: true })
  const branch = git(root, 'symbolic-ref', '--short', 'HEAD').trim()
  writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ [branch]: SLUG }))
  const log = join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl')
  writeFileSync(log, '')
  appendEvent(
    log,
    makeEvent({
      initiative: SLUG,
      session: SESSION,
      type: 'initiative_created',
      payload: { goal: 'ship probe' },
      source: 'cli',
      actor: 'agent',
    }),
  )

  if (withRemote) {
    const bare = `${root}-remote.git`
    roots.push(bare)
    execFileSync('git', ['init', '--quiet', '--bare', bare], { stdio: 'ignore' })
    git(root, 'remote', 'add', 'origin', bare)
  }
  return root
}

function commit(root: string, subject: string, slug?: string): void {
  writeFileSync(join(root, `f-${subject}`), `${subject}\n`)
  git(root, 'add', '-A')
  const path = join(root, '.msg')
  writeFileSync(path, slug === undefined ? `${subject}\n` : `${subject}\n\n${TRAILER_KEY}: ${slug}\n`)
  git(root, 'commit', '--quiet', '-F', path)
}

function sessionStart(root: string): string {
  return handleSessionStart(root, JSON.stringify({ session_id: SESSION })).stdout
}

describe('SessionStart shipping notice (3.2)', () => {
  it('warns when this record has commits that are not on the remote', () => {
    const root = repo('local')
    commit(root, 'one', SLUG)
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD')
    commit(root, 'two', SLUG)
    expect(sessionStart(root)).toContain("1 of this record's commit(s) are NOT on origin")
  })

  it('goes SILENT once the work has shipped — the whole point', () => {
    // A session that saw the line, then sees it gone after a sibling pushed,
    // has learned its work landed with nobody announcing it.
    const root = repo('shipped')
    commit(root, 'one', SLUG)
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD')
    expect(sessionStart(root)).not.toContain('NOT on origin')
  })

  it('says unknown, never "not pushed", when there is no upstream to compare', () => {
    // Claiming work has not shipped on no evidence is the false alarm this
    // whole initiative exists to remove.
    const root = repo('noupstream', { withRemote: false })
    commit(root, 'one', SLUG)
    const out = sessionStart(root)
    expect(out).toContain('unverified')
    expect(out).not.toContain('NOT on origin')
  })

  it('ignores commits belonging to OTHER initiatives', () => {
    // The motivating case: one branch carries several records' commits.
    const root = repo('others')
    commit(root, 'one', SLUG)
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD')
    commit(root, 'two', 'somebody-else')
    expect(sessionStart(root)).not.toContain('NOT on origin')
  })

  it('stays silent when nothing is attributed at all', () => {
    const root = repo('unattributed')
    commit(root, 'one')
    git(root, 'push', '--quiet', '-u', 'origin', 'HEAD')
    commit(root, 'two')
    expect(sessionStart(root)).not.toContain('NOT on origin')
  })

  it('never breaks SessionStart when git is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-ship-nogit-'))
    roots.push(root)
    mkdirSync(join(root, '.sofar', 'initiatives', SLUG), { recursive: true })
    writeFileSync(join(root, '.sofar', 'bindings.json'), '{}')
    writeFileSync(join(root, '.sofar', 'initiatives', SLUG, 'events.jsonl'), '')
    expect(handleSessionStart(root, JSON.stringify({ session_id: SESSION })).exitCode).toBe(0)
  })
})
