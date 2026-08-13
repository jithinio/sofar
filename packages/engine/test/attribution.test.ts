import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_COUNT,
  TRAILER_KEY,
  bySlug,
  parseAttribution,
  readAttribution,
  unattributed,
  type CommitAttribution,
} from '../src/core/attribution'

/**
 * Commit → initiative attribution from git trailers (D4, D6).
 *
 * The parse half is exercised directly so malformed input does not need a
 * repo per case; the read half runs against a real throwaway repo, because
 * the whole point of D4 is that git — not the record — is the authority, and
 * a mocked git would prove nothing about that.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-attribution-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const RS = '\x1e'
const US = '\x1f'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function record(sha: string, trailer: string): string {
  return `${RS}${sha}${US}${trailer}`
}

/** A repo with the given commit messages, oldest first. Returns its path. */
function makeRepo(name: string, messages: string[]): string {
  const dir = join(scratch, name)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  mkdirSync(dir, { recursive: true })
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  messages.forEach((message, i) => {
    writeFileSync(join(dir, `f${i}`), `${i}\n`)
    git('add', '-A')
    const msgFile = join(dir, `.msg${i}`)
    writeFileSync(msgFile, message)
    git('commit', '--quiet', '-F', msgFile)
  })
  return dir
}

describe('parseAttribution', () => {
  it('reads a slug from a trailered commit', () => {
    expect(parseAttribution(record(SHA_A, 'record-index'))).toEqual([
      { sha: SHA_A, initiatives: ['record-index'] },
    ])
  })

  it('treats an untrailered commit as unattributed, never as a guess', () => {
    // The 1.3 contract: absent attribution is a first-class answer.
    expect(parseAttribution(record(SHA_A, ''))).toEqual([{ sha: SHA_A, initiatives: [] }])
  })

  it('keeps every slug on a multi-trailer commit (the squash case)', () => {
    expect(parseAttribution(record(SHA_A, 'alpha,beta'))[0]!.initiatives).toEqual(['alpha', 'beta'])
  })

  it('collapses a slug repeated on one commit', () => {
    expect(parseAttribution(record(SHA_A, 'alpha,alpha'))[0]!.initiatives).toEqual(['alpha'])
  })

  it('drops values that are not slug-shaped rather than inventing an initiative', () => {
    // D5's rule: a wrong attribution is worse than a missing one, and the
    // trailer is free text a human can mistype.
    const parsed = parseAttribution(record(SHA_A, 'Record Index, ../etc, UPPER, ok-slug'))
    expect(parsed[0]!.initiatives).toEqual(['ok-slug'])
  })

  it('skips records whose sha is not a full sha', () => {
    expect(parseAttribution(record('abc123', 'alpha'))).toEqual([])
  })

  it('skips a record with no unit separator', () => {
    expect(parseAttribution(`${RS}garbage-with-no-separator`)).toEqual([])
  })

  it('returns nothing for empty output', () => {
    expect(parseAttribution('')).toEqual([])
  })

  it('survives a trailer value folded across lines', () => {
    // Why the format uses record/unit separators instead of newlines: a
    // line-oriented parse would tear this one commit into two records.
    const parsed = parseAttribution(`${record(SHA_A, 'alpha')}\n${record(SHA_B, 'beta')}`)
    expect(parsed.map((c) => c.sha)).toEqual([SHA_A, SHA_B])
  })
})

describe('bySlug / unattributed', () => {
  const commits: CommitAttribution[] = [
    { sha: SHA_A, initiatives: ['alpha', 'beta'] },
    { sha: SHA_B, initiatives: [] },
  ]

  it('files a multi-slug commit under every slug it claims', () => {
    const grouped = bySlug(commits)
    expect(grouped.get('alpha')).toEqual([SHA_A])
    expect(grouped.get('beta')).toEqual([SHA_A])
  })

  it('lists commits carrying no attribution', () => {
    expect(unattributed(commits)).toEqual([SHA_B])
  })
})

describe('readAttribution', () => {
  it('reads trailers back out of a real repo, newest first', () => {
    const dir = makeRepo('basic', [
      `first\n\n${TRAILER_KEY}: alpha\n`,
      'second, no trailer\n',
      `third\n\n${TRAILER_KEY}: beta\n`,
    ])
    const commits = readAttribution(dir)
    expect(commits).not.toBeNull()
    expect(commits!.map((c) => c.initiatives)).toEqual([['beta'], [], ['alpha']])
  })

  it('bounds the walk to maxCount', () => {
    // D6: an unbounded walk is O(history). The ceiling is the guarantee.
    const dir = makeRepo('bounded', [
      `one\n\n${TRAILER_KEY}: alpha\n`,
      `two\n\n${TRAILER_KEY}: alpha\n`,
      `three\n\n${TRAILER_KEY}: alpha\n`,
    ])
    expect(readAttribution(dir, { maxCount: 2 })!.length).toBe(2)
  })

  it('returns null rather than throwing outside a repo', () => {
    // Best-effort by contract: a missing signal must never break a caller.
    expect(readAttribution(join(scratch, 'definitely-not-a-repo'))).toBeNull()
  })

  it('refuses a range that could read as a flag', () => {
    const dir = makeRepo('flaggy', [`one\n\n${TRAILER_KEY}: alpha\n`])
    expect(readAttribution(dir, { range: '--all' })).toBeNull()
    expect(readAttribution(dir, { range: '' })).toBeNull()
  })

  it('refuses a nonsensical maxCount instead of walking everything', () => {
    const dir = makeRepo('badcount', [`one\n\n${TRAILER_KEY}: alpha\n`])
    expect(readAttribution(dir, { maxCount: 0 })).toBeNull()
    expect(readAttribution(dir, { maxCount: -5 })).toBeNull()
    expect(readAttribution(dir, { maxCount: 1.5 })).toBeNull()
  })

  it('honours a rev range', () => {
    const dir = makeRepo('ranged', [
      `base\n\n${TRAILER_KEY}: alpha\n`,
      `tip\n\n${TRAILER_KEY}: beta\n`,
    ])
    const commits = readAttribution(dir, { range: 'HEAD~1..HEAD' })
    expect(commits!.map((c) => c.initiatives)).toEqual([['beta']])
  })

  it('defaults to a sane ceiling', () => {
    expect(DEFAULT_MAX_COUNT).toBeGreaterThan(0)
    expect(Number.isInteger(DEFAULT_MAX_COUNT)).toBe(true)
  })
})

describe('the squash-merge caveat (2.3, not yet handled)', () => {
  it('documents that a squash loses the trailer — a FALSE NEGATIVE', () => {
    // Pinned as a characterisation test so 2.3 has a failing-shape to fix and
    // nobody rediscovers this the hard way. git merge --squash writes
    // SQUASH_MSG with each original message INDENTED FOUR SPACES, so the
    // trailer parser sees nothing and shipped work reads as un-shipped.
    const dir = makeRepo('squash-base', ['base\n'])
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    git('checkout', '--quiet', '-b', 'topic')
    writeFileSync(join(dir, 'topic-file'), 'x\n')
    git('add', '-A')
    writeFileSync(join(dir, '.tmsg'), `topic work\n\n${TRAILER_KEY}: gamma\n`)
    git('commit', '--quiet', '-F', join(dir, '.tmsg'))
    const onTopic = readAttribution(dir, { maxCount: 1 })
    expect(onTopic![0]!.initiatives).toEqual(['gamma'])

    git('checkout', '--quiet', '-')
    git('merge', '--squash', 'topic')
    git('commit', '--quiet', '--no-edit')
    const squashed = readAttribution(dir, { maxCount: 1 })
    expect(squashed![0]!.initiatives).toEqual([]) // the loss, pinned
  })
})
