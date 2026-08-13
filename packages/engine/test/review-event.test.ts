import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validatePayload } from '@sofar/schema'
import { foldLog, freshnessTotal, openFindings, reviewWatermark, sessionDebt } from '../src/core/fold'
import { describeFreshness } from '../src/projections/templates/shared'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'

/**
 * review_recorded and the watermark (4.4).
 *
 * The watermark — not the verdict — is why a review had to be an event. It
 * bounds the NEXT review's range (D9), so it is load-bearing state rather than
 * a history of opinions.
 */

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function log(name: string, payloads: Record<string, unknown>[]): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-review-${name}-`))
  roots.push(root)
  const path = join(root, 'events.jsonl')
  writeFileSync(path, '')
  appendEvent(
    path,
    makeEvent({
      initiative: 'demo',
      session: 's1',
      type: 'initiative_created',
      payload: { slug: 'demo', goal: 'g' },
      source: 'cli',
      actor: 'agent',
    }),
  )
  for (const payload of payloads) {
    appendEvent(
      path,
      makeEvent({
        initiative: 'demo',
        session: 's1',
        type: 'review_recorded',
        payload,
        source: 'cli',
        actor: 'agent',
      }),
    )
  }
  return path
}

describe('review_recorded payload validation', () => {
  it('accepts a pass with no findings', () => {
    expect(validatePayload('review_recorded', { scope: 'phase', verdict: 'pass' })).toEqual({
      ok: true,
    })
  })

  it('REJECTS a `findings` verdict that lists none', () => {
    // A rubber stamp wearing the wrong hat: it claims something was found while
    // recording nothing actionable, and the next review has nothing to carry.
    const res = validatePayload('review_recorded', { scope: 'phase', verdict: 'findings' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.errors.join(' ')).toContain('findings: required and non-empty')
  })

  it('accepts `blocked`, the honest answer when there was no diff to read', () => {
    expect(validatePayload('review_recorded', { scope: 'final', verdict: 'blocked' })).toEqual({
      ok: true,
    })
  })

  it('rejects an unknown scope or verdict', () => {
    expect(validatePayload('review_recorded', { scope: 'sideways', verdict: 'pass' }).ok).toBe(false)
    expect(validatePayload('review_recorded', { scope: 'phase', verdict: 'lgtm' }).ok).toBe(false)
  })
})

describe('fold: reviewWatermark', () => {
  it('is null before any review has run', () => {
    const { state } = foldLog(log('none', []))
    expect(reviewWatermark(state)).toBeNull()
  })

  it('returns the latest watermark, which bounds the next range', () => {
    const { state } = foldLog(
      log('latest', [
        { scope: 'phase', verdict: 'pass', watermark: SHA_A, phase: 'P1' },
        { scope: 'phase', verdict: 'pass', watermark: SHA_B, phase: 'P2' },
      ]),
    )
    expect(reviewWatermark(state)).toBe(SHA_B)
  })

  it('skips a review that recorded no watermark, rather than resetting to null', () => {
    // A `blocked` review over an empty range advances nothing — the next review
    // must still start from the last sha actually READ, or it would silently
    // re-review work already covered.
    const { state } = foldLog(
      log('skip', [
        { scope: 'phase', verdict: 'pass', watermark: SHA_A, phase: 'P1' },
        { scope: 'phase', verdict: 'blocked', phase: 'P2' },
      ]),
    )
    expect(reviewWatermark(state)).toBe(SHA_A)
  })
})

describe('fold: openFindings', () => {
  it('collects findings the final pass must carry forward (D10)', () => {
    const { state } = foldLog(
      log('open', [
        { scope: 'phase', verdict: 'findings', phase: 'P1', findings: ['leaks a handle'] },
        { scope: 'phase', verdict: 'findings', phase: 'P2', findings: ['off-by-one'] },
      ]),
    )
    expect(openFindings(state).sort()).toEqual(['leaks a handle', 'off-by-one'])
  })

  it('a re-review of the SAME phase supersedes its predecessor', () => {
    // Otherwise a fixed finding would haunt every later review forever, and the
    // close pass would report work that was already done.
    const { state } = foldLog(
      log('supersede', [
        { scope: 'phase', verdict: 'findings', phase: 'P1', findings: ['leaks a handle'] },
        { scope: 'phase', verdict: 'pass', phase: 'P1', watermark: SHA_B },
      ]),
    )
    expect(openFindings(state)).toEqual([])
  })

  it('keeps findings from a DIFFERENT phase when one is re-reviewed', () => {
    const { state } = foldLog(
      log('mixed', [
        { scope: 'phase', verdict: 'findings', phase: 'P1', findings: ['p1 problem'] },
        { scope: 'phase', verdict: 'findings', phase: 'P2', findings: ['p2 problem'] },
        { scope: 'phase', verdict: 'pass', phase: 'P2', watermark: SHA_B },
      ]),
    )
    expect(openFindings(state)).toEqual(['p1 problem'])
  })
})

describe('an older engine degrades safely', () => {
  it('folds a log containing review_recorded without failing', () => {
    // The additive contract every event type here has had: a type an older
    // engine does not know is skipped with a warning, never fatal.
    const { state, warnings } = foldLog(
      log('additive', [{ scope: 'phase', verdict: 'pass', watermark: SHA_A, phase: 'P1' }]),
    )
    expect(warnings).toEqual([])
    expect(state.reviews).toHaveLength(1)
  })
})

describe('a review is DEBT, like every other mutation', () => {
  // Found by the initiative's own first review round: review_recorded fell
  // through recordFreshness's switch, so a session whose whole job was a
  // review owed the record nothing and passed the Stop gate silently — the
  // one session whose conclusions are least recoverable from the diff.
  it('counts toward drift, and toward the reviewing session\'s own debt', () => {
    const path = log('debt', [{ scope: 'phase', verdict: 'pass', watermark: SHA_A, phase: 'P1' }])
    const { state: unregistered } = foldLog(path)
    expect(unregistered.freshness.events_since_writeback.reviews).toBe(1)
    expect(freshnessTotal(unregistered.freshness)).toBe(1)
    // Nothing registered s1 here, so the debt is owed by whoever is still in
    // the building — the same rule every other mutation follows.
    expect(unregistered.freshness.unattributed_mutations).toBe(1)

    const registered = log('debt-registered', [])
    appendEvent(
      registered,
      makeEvent({
        initiative: 'demo',
        session: 's1',
        type: 'session_started',
        payload: { tool: 'claude-code' },
        source: 'cli',
        actor: 'agent',
      }),
    )
    appendEvent(
      registered,
      makeEvent({
        initiative: 'demo',
        session: 's1',
        type: 'review_recorded',
        payload: { scope: 'phase', verdict: 'pass', watermark: SHA_A, phase: 'P1' },
        source: 'cli',
        actor: 'agent',
      }),
    )
    const { state } = foldLog(registered)
    const session = state.sessions.find((s) => s.id === 's1')
    expect(session?.unwritten).toBe(1)
    expect(sessionDebt(state, session!)).toBe(1)
  })

  it('is itemized in the staleness breakdown, never counted silently', () => {
    const { state } = foldLog(
      log('breakdown', [
        { scope: 'phase', verdict: 'findings', phase: 'P1', findings: ['a'] },
        { scope: 'final', verdict: 'pass', watermark: SHA_B },
      ]),
    )
    expect(describeFreshness(state.freshness.events_since_writeback)).toBe('2 reviews')
  })

  it('is settled by a write-back, like any other debt', () => {
    const path = log('settled', [{ scope: 'phase', verdict: 'pass', watermark: SHA_A, phase: 'P1' }])
    appendEvent(
      path,
      makeEvent({
        initiative: 'demo',
        session: 's1',
        type: 'session_ended',
        payload: { summary: 'reviewed P1', next_action: 'fix what it found' },
        source: 'cli',
        actor: 'agent',
      }),
    )
    const { state } = foldLog(path)
    expect(freshnessTotal(state.freshness)).toBe(0)
    expect(state.sessions.find((s) => s.id === 's1')?.unwritten).toBe(0)
  })
})
