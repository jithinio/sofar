import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { makeEvent, validateEnvelope, type EventEnvelope } from '../src/core/envelope'
import { foldLog } from '../src/core/fold'
import { gitUserEmail, resetGitUserEmailCache } from '../src/core/identity'
import { appendEvent } from '../src/core/log'

/**
 * Envelope `user` field (team-readiness T1). Identity comes from
 * `git config user.email`; git resolves GIT_CONFIG_COUNT/KEY_n/VALUE_n env
 * overrides ABOVE local and global config, so these tests are hermetic on
 * any machine regardless of its git setup (an empty override value reads
 * back as unset).
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-identity-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const savedEnv = new Map<string, string | undefined>()

function overrideEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

function setGitEmail(value: string): void {
  overrideEnv('GIT_CONFIG_COUNT', '1')
  overrideEnv('GIT_CONFIG_KEY_0', 'user.email')
  overrideEnv('GIT_CONFIG_VALUE_0', value)
  resetGitUserEmailCache()
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  resetGitUserEmailCache()
})

function sample(type = 'note_added', payload: Record<string, unknown> = { text: 'x' }): EventEnvelope {
  return makeEvent({
    initiative: 'team',
    session: 'cli',
    source: 'cli',
    actor: 'agent',
    type,
    payload,
  })
}

describe('gitUserEmail', () => {
  it('returns the configured email', () => {
    setGitEmail('teammate@example.com')
    expect(gitUserEmail()).toBe('teammate@example.com')
  })

  it('returns undefined when user.email is unset', () => {
    setGitEmail('')
    expect(gitUserEmail()).toBeUndefined()
  })

  it('returns undefined when git itself cannot be spawned', () => {
    overrideEnv('PATH', '')
    resetGitUserEmailCache()
    expect(gitUserEmail()).toBeUndefined()
  })

  it('is cached per process until reset', () => {
    setGitEmail('first@example.com')
    expect(gitUserEmail()).toBe('first@example.com')
    process.env.GIT_CONFIG_VALUE_0 = 'second@example.com'
    expect(gitUserEmail()).toBe('first@example.com') // cached — no re-spawn
    resetGitUserEmailCache()
    expect(gitUserEmail()).toBe('second@example.com')
  })
})

describe('envelope user field (T1 — additive, envelope stays v1)', () => {
  it('append stamps user when git config exists', () => {
    setGitEmail('teammate@example.com')
    const logPath = join(scratch, 'stamped', 'events.jsonl')
    appendEvent(logPath, sample())

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(line.user).toBe('teammate@example.com')
    expect(line.v).toBe(1) // additive — no envelope version bump
    expect(validateEnvelope(line).ok).toBe(true)
  })

  it('append succeeds and omits the field when identity is unavailable', () => {
    setGitEmail('')
    const logPath = join(scratch, 'absent', 'events.jsonl')
    const event = sample()
    expect('user' in event).toBe(false) // omitted, never null/empty
    appendEvent(logPath, event)

    const line = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect('user' in line).toBe(false)
    expect(validateEnvelope(line).ok).toBe(true)
  })

  it('old events without user stay valid; a present user must be a non-empty string', () => {
    setGitEmail('')
    const old = sample() // the pre-T1 envelope shape
    expect(validateEnvelope(old).ok).toBe(true)
    expect(validateEnvelope({ ...old, user: 'a@b.c' }).ok).toBe(true)
    expect(validateEnvelope({ ...old, user: '' }).ok).toBe(false)
    expect(validateEnvelope({ ...old, user: 42 }).ok).toBe(false)
  })

  it('fold over a mixed old/new log is deterministic and warning-free', () => {
    const logPath = join(scratch, 'mixed', 'events.jsonl')
    setGitEmail('') // old-shape events, no user
    appendEvent(logPath, sample('session_started', { tool: 'cli' }))
    appendEvent(logPath, sample())
    setGitEmail('teammate@example.com') // new-shape events, stamped
    appendEvent(logPath, sample())
    appendEvent(logPath, sample('session_ended', { summary: 's', next_action: 'n' }))

    const first = foldLog(logPath)
    const second = foldLog(logPath)
    expect(first.warnings).toEqual([])
    expect(second).toEqual(first) // deep-equal state AND warnings
    expect(first.state.sessions).toHaveLength(1)
    expect(first.state.sessions[0]?.summary).toBe('s')
  })
})
