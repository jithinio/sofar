import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { handleSessionStart } from '../src/cli/event'
import { runStatusline } from '../src/cli/statusline'
import { createToolContext } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { startSession } from '../src/mcp/start-session'

/**
 * binding-follows-session 1.3 — the branch binding maintains itself.
 *
 * The case that opened it: brillo's main stayed bound to
 * baseui-toast-migration across 8 project-tax-architecture commits, because
 * only a human `sofar switch` ever moved a binding. Every fresh session there
 * opened on the wrong record and had to be re-homed by hand.
 *
 * The fix writes, it does not infer (D1): a write-back binds the branch to the
 * initiative it landed in, so `bindings.json` states "last session to finish
 * here" as a durable fact. Resolution itself is untouched — session-orientation
 * D2 still stands, and nothing below asserts a new resolution RULE, only that
 * the fact the existing rule reads has stopped decaying.
 *
 * The guards get a test each because every one of them is a case where doing
 * the obvious thing is wrong: an unbound branch was unbound on purpose, a
 * closed record must not collect new sessions, and a routing convenience must
 * never be able to fail a wrap-up.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const T = {
  created: '2026-08-13T08:00:00.000Z',
  peerStart: '2026-08-13T09:00:00.000Z',
  mineStart: '2026-08-13T10:00:00.000Z',
  closed: '2026-08-13T11:00:00.000Z',
}

function emit(
  sofar: string,
  slug: string,
  session: string,
  type: string,
  payload: Record<string, unknown>,
  ts: string,
): void {
  const dir = join(sofar, 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  const e = makeEvent({ initiative: slug, session, source: 'claude-code', actor: 'agent', type, payload })
  appendEvent(join(dir, 'events.jsonl'), { ...e, ts })
}

/**
 * main → alpha, a peer registered in alpha, and MINE registered in beta — the
 * shape after a re-home, which is exactly when the binding is stale.
 * `bindings` is written verbatim so a test can hand in an absent or malformed
 * file without a second helper.
 */
function repo(bindings: string | null = `${JSON.stringify({ main: 'alpha' }, null, 2)}\n`): {
  root: string
  sofar: string
} {
  const root = mkdtempSync(join(tmpdir(), 'sofar-rebind-'))
  roots.push(root)
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const sofar = join(root, '.sofar')
  mkdirSync(sofar, { recursive: true })
  if (bindings !== null) writeFileSync(join(sofar, 'bindings.json'), bindings)

  emit(sofar, 'alpha', 'cli', 'initiative_created', { slug: 'alpha', goal: 'the bound one' }, T.created)
  emit(sofar, 'beta', 'cli', 'initiative_created', { slug: 'beta', goal: 'the worked one' }, T.created)
  emit(sofar, 'alpha', 'PEER', 'session_started', { tool: 'claude-code' }, T.peerStart)
  emit(sofar, 'beta', 'MINE', 'session_started', { tool: 'claude-code' }, T.mineStart)
  return { root, sofar }
}

const readBindings = (sofar: string): unknown =>
  JSON.parse(readFileSync(join(sofar, 'bindings.json'), 'utf8'))

const wrapUp = (root: string, session: string) =>
  endSession(createToolContext(root), {
    session_id: session,
    summary: 'did the work',
    next_action: 'next thing',
  })

const record = (root: string, session: string): string =>
  runStatusline(root, JSON.stringify({ session_id: session, workspace: { current_dir: root } }))
    .split(' · ')
    .pop()!

describe('the branch binding follows the write-back (binding-follows-session 1.3)', () => {
  it('moves the branch to where the session actually lived', () => {
    const { root, sofar } = repo()
    const result = wrapUp(root, 'MINE')

    expect(readBindings(sofar)).toEqual({ main: 'beta' })
    // Reported, because an inspectable mechanism must be legible at the moment
    // it acts — that is the whole reason a binding beat an inference (D1).
    expect(result.rebound).toEqual({ branch: 'main', from: 'alpha', to: 'beta' })

    // The point of the whole change: the NEXT fresh session lands on the
    // finished work, through unchanged branch resolution.
    expect(record(root, 'SOMEONE-ELSE')).toContain('beta')
    const block = handleSessionStart(
      root,
      JSON.stringify({ session_id: 'SOMEONE-ELSE', cwd: root, source: 'startup' }),
    ).stdout
    expect(block).toContain('# Sofar status: beta')
    // And the recent-work notice goes QUIET, because the branch no longer
    // disagrees with where the work happened. That is the second gain: the
    // line stops firing on chronic staleness and is left to speak only when
    // the branch is genuinely wrong — the "learned to skip it" failure
    // record-integrity D3 named.
    expect(block).not.toContain('More recent work is in ANOTHER record')
  })

  it('stays quiet when the session lived where the branch already pointed', () => {
    const { root, sofar } = repo()
    const result = wrapUp(root, 'PEER') // PEER's home IS alpha

    expect(readBindings(sofar)).toEqual({ main: 'alpha' })
    // Omitted rather than reported as a no-op: presence is the signal, the
    // same shape parallel_writebacks uses.
    expect(result.rebound).toBeUndefined()
  })

  it('MOVES a binding but never CREATES one', () => {
    // `sofar new --no-bind` is a deliberate "do not route this branch", and a
    // fresh session on an unbound branch already gets a block telling it to
    // switch. Inventing a binding here would overrule a choice.
    const { root, sofar } = repo(null)
    const result = wrapUp(root, 'MINE')

    expect(() => readBindings(sofar)).toThrow() // still no file at all
    expect(result.rebound).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('never points a branch at a CLOSED record', () => {
    const { root, sofar } = repo()
    emit(sofar, 'beta', 'cli', 'initiative_status_changed', { status: 'done' }, T.closed)

    const result = wrapUp(root, 'MINE')

    // The write-back still lands in beta — a closed record is where this
    // session lived, and its wrap-up belongs there. Only the ROUTING of future
    // sessions is withheld.
    expect(readBindings(sofar)).toEqual({ main: 'alpha' })
    expect(result.rebound).toBeUndefined()
    expect(result.ok).toBe(true)
  })

  it('survives a malformed bindings.json without failing the wrap-back', () => {
    const { root, sofar } = repo('{ this is not json')
    const result = wrapUp(root, 'MINE')

    // Best-effort (BD22): the write-back is the caller's obligation and the
    // Stop gate's release — a routing convenience must never be able to break
    // it, and readBindingsFile's refusal to overwrite a bad file is preserved.
    expect(result.ok).toBe(true)
    expect(result.rebound).toBeUndefined()
    expect(readFileSync(join(sofar, 'bindings.json'), 'utf8')).toBe('{ this is not json')
  })

  it('cannot pull a live peer off its own record', () => {
    const { root, sofar } = repo()
    wrapUp(root, 'MINE')
    expect(readBindings(sofar)).toEqual({ main: 'beta' })

    // The peer resolves through its own home, which the moved binding only
    // ever SEEDS (mcp/context.ts:194) — so a rebind under a running session is
    // invisible to it, on every surface.
    expect(record(root, 'PEER')).toContain('alpha')
    expect(handleSessionStart(
      root,
      JSON.stringify({ session_id: 'PEER', cwd: root, source: 'startup' }),
    ).stdout).toContain('# Sofar status: alpha')

    // Including its own write-back, which still lands in alpha and moves the
    // branch back — last to finish wins, the accepted limitation in D1.
    const peer = wrapUp(root, 'PEER')
    expect(peer.rebound).toEqual({ branch: 'main', from: 'beta', to: 'alpha' })
  })

  it('follows a re-home through one call, without re-homing being what binds', () => {
    const { root, sofar } = repo()
    // A session mis-homed onto the branch's record by lazy registration.
    emit(sofar, 'alpha', 'STRAY', 'session_started', { tool: 'claude-code' }, T.mineStart)
    const ctx = createToolContext(root)

    startSession(ctx, { tool: 'claude-code', session_id: 'STRAY', initiative: 'beta' })
    // Re-homing alone still touches nothing — the property rehome.test.ts pins.
    expect(readBindings(sofar)).toEqual({ main: 'alpha' })

    // It is the WRITE-BACK that makes the move durable, which is why the bind
    // lives here and not in start_session: a re-home is not always a statement
    // of intent (D1 was taken by a session that re-homed into a closed record
    // purely to read it).
    expect(endSession(ctx, { session_id: 'STRAY', summary: 's', next_action: 'n' }).rebound).toEqual({
      branch: 'main',
      from: 'alpha',
      to: 'beta',
    })
  })
})
