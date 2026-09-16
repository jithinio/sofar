import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runDiagnostics } from '../src/cli/diagnostics'
import { runInit } from '../src/cli/init'
import {
  readSignalEnvironment,
  renderSignals,
  SIGNALS,
  signalAvailability,
  signalById,
  type SignalEnvironment,
} from '../src/core/signals'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * Signal availability map (self-improve 1.3). The id set is the contract the
 * Phase 2 detector consumes, so it is pinned here verbatim: adding a signal
 * means adding it to this list with its ceiling and reason, never quietly.
 */

const roots: string[] = []
beforeEach(() => {
  const xdg = mkdtempSync(join(tmpdir(), 'sofar-xdg-'))
  roots.push(xdg)
  vi.stubEnv('XDG_STATE_HOME', xdg)
})
afterEach(() => vi.unstubAllEnvs())
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function fx(): Fixture {
  const fixture = makeRepoFixture({ slug: 'self-improve' })
  roots.push(fixture.root)
  return fixture
}

const ALL_MET: SignalEnvironment = {
  post_tool_hook: true,
  post_tool_failure_hook: true,
  session_start_hook: true,
  diagnostics_store: true,
  driven_run: true,
}

describe('the static contract', () => {
  it('lists every promised signal exactly once, each with a non-empty reason', () => {
    expect(SIGNALS.map((s) => s.id).sort()).toEqual(
      [
        'bookkeeping_share',
        'corrections',
        'duplicate_session_starts',
        'error_text',
        'exit_status_on_success',
        'formatter_friction',
        'historical_digest_bytes',
        'hook_latency',
        'injection_bytes',
        'mcp_rejections',
        'memory_use',
        'read_only_tool_calls',
        'session_cost',
        'stalls',
        'tool_failure',
        'tool_success',
      ].sort(),
    )
    for (const s of SIGNALS) {
      expect(s.reason.length).toBeGreaterThan(40)
      expect(s.question.endsWith('?')).toBe(true)
    }
  })

  it('names the audit\'s unmeasurable signals as unavailable with their reason, not as zero', () => {
    for (const id of ['read_only_tool_calls', 'memory_use', 'historical_digest_bytes', 'hook_latency']) {
      const s = signalById(id, ALL_MET)!
      expect(s.ceiling).toBe('unavailable')
      expect(s.status).toBe('unavailable')
      expect(s.source === 'none' || s.source === 'index').toBe(true)
    }
    expect(signalById('memory_use', ALL_MET)!.reason).toContain('not mean unused')
    expect(signalById('bookkeeping_share', ALL_MET)!.reason).toContain('UPPER bound')
    expect(signalById('exit_status_on_success', ALL_MET)!.reason).toContain('UNKNOWN, not 0')
  })

  it('with every requirement met, the status is the ceiling and nothing is missing', () => {
    for (const s of signalAvailability(ALL_MET)) {
      expect(s.status).toBe(s.ceiling)
      expect(s.missing).toEqual([])
    }
    expect(signalById('nonexistent', ALL_MET)).toBeNull()
  })
})

describe('the live layer degrades against the clone', () => {
  it('without the failure shim, tool_failure and error_text are unavailable and say why', () => {
    const env = { ...ALL_MET, post_tool_failure_hook: false }
    for (const id of ['tool_failure', 'error_text']) {
      const s = signalById(id, env)!
      expect(s.status).toBe('unavailable')
      expect(s.missing).toEqual(['post_tool_failure_hook'])
    }
    expect(signalById('tool_success', env)!.status).toBe('capturable')
  })

  it('with the store refused, every diagnostics-sourced signal is unavailable', () => {
    const env = { ...ALL_MET, diagnostics_store: false }
    for (const s of signalAvailability(env)) {
      if (s.source === 'diagnostics') {
        expect(s.status).toBe('unavailable')
        expect(s.missing).toContain('diagnostics_store')
      }
    }
    expect(signalById('duplicate_session_starts', env)!.status).toBe('capturable')
  })

  it('reads the real environment: a fresh fixture has no hooks; init wires all three; XDG inside the repo refuses the store', () => {
    const fixture = fx()
    const bare = readSignalEnvironment(fixture.root)
    expect(bare).toMatchObject({
      post_tool_hook: false,
      post_tool_failure_hook: false,
      session_start_hook: false,
      diagnostics_store: true,
      driven_run: true,
    })
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(join(fixture.root, 'CLAUDE.md'), '# repo\n')
    expect(runInit(fixture.root).exitCode).toBe(0)
    const wired = readSignalEnvironment(fixture.root)
    expect(wired.post_tool_hook).toBe(true)
    expect(wired.post_tool_failure_hook).toBe(true)
    expect(wired.session_start_hook).toBe(true)

    vi.stubEnv('XDG_STATE_HOME', join(fixture.root, 'state'))
    expect(readSignalEnvironment(fixture.root).diagnostics_store).toBe(false)
  })

  it('an older settings.json — PostToolUse wired, failure shim absent — reports the failure signals unavailable', () => {
    const fixture = fx()
    mkdirSync(join(fixture.root, '.claude'), { recursive: true })
    writeFileSync(
      join(fixture.root, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh' }] }],
          PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|Bash', hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/post-tool-use.sh' }] }],
        },
      }),
    )
    const list = signalAvailability(readSignalEnvironment(fixture.root))
    expect(list.find((s) => s.id === 'tool_failure')!.status).toBe('unavailable')
    expect(list.find((s) => s.id === 'tool_success')!.status).toBe('capturable')
    expect(list.find((s) => s.id === 'injection_bytes')!.status).toBe('capturable')
  })
})

describe('`sofar diagnostics --signals`', () => {
  it('renders every signal with status, ceiling, reason and what is missing here — byte-plain', () => {
    const fixture = fx()
    const result = runDiagnostics(fixture.root, { signals: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('signals: 16 —')
    expect(result.stdout).toContain('prints UNKNOWN')
    for (const s of SIGNALS) expect(result.stdout).toContain(`${s.id} [`)
    expect(result.stdout).toContain('tool_failure [unavailable]')
    expect(result.stdout).toContain('missing here: PostToolUseFailure shim wired')
    expect(result.stdout).toContain('duplicate_session_starts [capturable]')
    expect(result.stdout).not.toMatch(/\x1b\[/)

    const json = JSON.parse(runDiagnostics(fixture.root, { signals: true, json: true }).stdout) as {
      environment: SignalEnvironment
      signals: Array<{ id: string; status: string }>
    }
    expect(json.environment.post_tool_hook).toBe(false)
    expect(json.signals).toHaveLength(16)
    // Even with everything wired, four signals stay unavailable by design.
    expect(renderSignals(signalAvailability(ALL_MET))).toContain('4 capturable, 8 partial, 4 unavailable')
  })
})
