import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { TRAILER_KEY, parseAttribution } from '../src/core/attribution'
import {
  applyTrailer,
  resolveForCommit,
  runCommitTrailer,
} from '../src/cli/commit-trailer'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'

/**
 * The prepare-commit-msg worker (D5).
 *
 * The contract under test is mostly about what it REFUSES to do: never guess an
 * initiative, never write twice, never fail a commit.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-trailer-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const savedSession = process.env.CLAUDE_CODE_SESSION_ID

afterEach(() => {
  if (savedSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = savedSession
})

/** A record whose `slug` log has registered `sessionId`. */
function makeRecord(name: string, slug: string, sessionId: string | null): string {
  const root = join(scratch, name)
  mkdirSync(join(root, '.sofar', 'initiatives', slug), { recursive: true })
  writeFileSync(join(root, '.sofar', 'bindings.json'), '{}\n')
  const log = join(root, '.sofar', 'initiatives', slug, 'events.jsonl')
  writeFileSync(log, '')
  if (sessionId !== null) {
    appendEvent(
      log,
      makeEvent({
        initiative: slug,
        session: sessionId,
        type: 'session_started',
        payload: { tool: 'claude-code' },
        source: 'claude-code',
        actor: 'agent',
      }),
    )
  }
  return root
}

describe('applyTrailer', () => {
  it('appends the trailer with a blank line before it', () => {
    // Without the blank line git reads it as prose and %(trailers) sees nothing.
    const out = applyTrailer('a subject\n', 'alpha')
    expect(out).toBe(`a subject\n\n${TRAILER_KEY}: alpha\n`)
  })

  it('is a real trailer as far as git is concerned', () => {
    // Assert against the parser that will actually read it, not against a regex.
    const out = applyTrailer('subject\n\nbody text\n', 'record-index')!
    const shaLine = `${'a'.repeat(40)}\x1f${/Sofar-Initiative: (.+)/.exec(out)![1]}`
    expect(parseAttribution(`\x1e${shaLine}`)[0]!.initiatives).toEqual(['record-index'])
  })

  it('returns null when the slug is already there — idempotent for amend', () => {
    // prepare-commit-msg fires again on --amend; accumulating trailers would
    // forge a multi-initiative squash out of one commit.
    expect(applyTrailer(`subject\n\n${TRAILER_KEY}: alpha\n`, 'alpha')).toBeNull()
  })

  it('still adds a DIFFERENT slug to an already-attributed message', () => {
    const out = applyTrailer(`subject\n\n${TRAILER_KEY}: alpha\n`, 'beta')
    expect(out).toContain(`${TRAILER_KEY}: alpha`)
    expect(out).toContain(`${TRAILER_KEY}: beta`)
  })

  it('lands above git comment lines, not below them', () => {
    // Anything after the comment block is discarded by git.
    const out = applyTrailer('subject\n\n# Please enter a commit message.\n# with comments\n', 'alpha')!
    const lines = out.split('\n')
    const trailerAt = lines.findIndex((l) => l.startsWith(TRAILER_KEY))
    const commentAt = lines.findIndex((l) => l.startsWith('#'))
    expect(trailerAt).toBeGreaterThanOrEqual(0)
    expect(trailerAt).toBeLessThan(commentAt)
  })

  it('ignores a commented-out trailer when checking for presence', () => {
    const out = applyTrailer(`subject\n\n# ${TRAILER_KEY}: alpha\n`, 'alpha')
    expect(out).not.toBeNull()
  })
})

describe('resolveForCommit — the no-guess contract', () => {
  it('resolves a session registered in a log', () => {
    const root = makeRecord('resolves', 'alpha', 'sess-1')
    expect(resolveForCommit(root, 'sess-1')).toBe('alpha')
  })

  it('returns null for a session registered nowhere, even with a bound branch', () => {
    // The heart of D5: the branch binding may seed a tie-break, never invent an
    // answer. In this repo main is bound to a DIFFERENT initiative than the one
    // being worked, so a binding fallback would attribute the wrong slug.
    const root = makeRecord('unregistered', 'alpha', null)
    writeFileSync(join(root, '.sofar', 'bindings.json'), JSON.stringify({ main: 'alpha' }))
    expect(resolveForCommit(root, 'sess-nobody')).toBeNull()
  })

  it('returns null with no session id at all', () => {
    const root = makeRecord('nosession', 'alpha', 'sess-1')
    expect(resolveForCommit(root, undefined)).toBeNull()
    expect(resolveForCommit(root, '')).toBeNull()
  })

  it('returns null rather than throwing when there is no record', () => {
    expect(resolveForCommit(join(scratch, 'no-record-here'), 'sess-1')).toBeNull()
  })
})

describe('runCommitTrailer', () => {
  it('stamps the message of a registered session', () => {
    const root = makeRecord('stamps', 'alpha', 'sess-2')
    const msg = join(root, 'MSG')
    writeFileSync(msg, 'do a thing\n')
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-2'
    expect(runCommitTrailer(root, msg)).toEqual({ outcome: 'added', slug: 'alpha' })
    expect(readFileSync(msg, 'utf8')).toContain(`${TRAILER_KEY}: alpha`)
  })

  it('leaves the message untouched with no session in the environment', () => {
    const root = makeRecord('nosessionenv', 'alpha', 'sess-3')
    const msg = join(root, 'MSG')
    writeFileSync(msg, 'terminal commit\n')
    delete process.env.CLAUDE_CODE_SESSION_ID
    expect(runCommitTrailer(root, msg).outcome).toBe('no-session')
    expect(readFileSync(msg, 'utf8')).toBe('terminal commit\n')
  })

  it('leaves the message untouched when the session resolves to nothing', () => {
    const root = makeRecord('unresolvable', 'alpha', null)
    const msg = join(root, 'MSG')
    writeFileSync(msg, 'orphan commit\n')
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-unknown'
    expect(runCommitTrailer(root, msg).outcome).toBe('unresolved')
    expect(readFileSync(msg, 'utf8')).toBe('orphan commit\n')
  })

  it('reports an unreadable message file instead of throwing', () => {
    const root = makeRecord('unreadable', 'alpha', 'sess-4')
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-4'
    expect(runCommitTrailer(root, join(root, 'NOPE')).outcome).toBe('unreadable')
  })

  it('is idempotent across repeated runs (the amend path)', () => {
    const root = makeRecord('amend', 'alpha', 'sess-5')
    const msg = join(root, 'MSG')
    writeFileSync(msg, 'amend me\n')
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-5'
    expect(runCommitTrailer(root, msg).outcome).toBe('added')
    const once = readFileSync(msg, 'utf8')
    expect(runCommitTrailer(root, msg).outcome).toBe('already-present')
    expect(readFileSync(msg, 'utf8')).toBe(once)
  })
})
