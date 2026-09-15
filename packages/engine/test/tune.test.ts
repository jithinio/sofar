import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTune } from '../src/cli/tune'
import { diagnosticsDir, recordDiagnostic } from '../src/core/diagnostics'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { SIGNALS } from '../src/core/signals'
import { detect, renderTuneReport, TUNE_DETECTOR_SIGNALS, TUNE_EVIDENCE_SHOWN, type TuneReport } from '../src/core/tune'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * `sofar tune --dry-run` (self-improve 2.1): detection only, read-only,
 * deterministic, evidence-cited, UNKNOWN for whatever the map does not allow.
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

function fx(slug = 'alpha'): Fixture {
  const fixture = makeRepoFixture({ slug })
  roots.push(fixture.root)
  return fixture
}

/** Wire every shim the map asks about, the way `sofar init` would. */
function wireHooks(root: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  const cmd = (f: string): string => `$CLAUDE_PROJECT_DIR/.claude/hooks/${f}`
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start.sh') }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: cmd('post-tool-use.sh') }] }],
        PostToolUseFailure: [{ hooks: [{ type: 'command', command: cmd('post-tool-use-failure.sh') }] }],
      },
    }),
  )
}

function ev(fixture: Fixture, type: string, payload: Record<string, unknown>, session = 'cli'): EventEnvelope {
  const input: MakeEventInput = { initiative: fixture.slug, session, source: 'hook', actor: 'agent', type, payload }
  const event = makeEvent(input)
  appendEvent(fixture.eventsPath, event)
  return event
}

function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(`${p}:${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out.join('\n')
}

function json(fixture: Fixture, extra: { all?: boolean } = {}): TuneReport {
  const result = runTune(fixture.root, { dryRun: true, json: true, ...extra })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout) as TuneReport
}

const detector = (report: TuneReport, id: string) => report.detectors.find((d) => d.signal === id)!

describe('the contract', () => {
  it('refuses without --dry-run and touches nothing', () => {
    const fixture = fx()
    ev(fixture, 'initiative_created', { slug: fixture.slug, goal: 'g' })
    const before = snapshot(join(fixture.root, '.sofar'))
    const result = runTune(fixture.root, {})
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('only `--dry-run` exists')
    expect(snapshot(join(fixture.root, '.sofar'))).toBe(before)
  })

  it('reports every signal in the map, one detector block or UNKNOWN each; detectors exist only for map signals', () => {
    const fixture = fx()
    const report = json(fixture)
    expect(report.version).toBe(1)
    expect(report.detectors.map((d) => d.signal)).toEqual(SIGNALS.map((s) => s.id))
    for (const id of TUNE_DETECTOR_SIGNALS) expect(SIGNALS.some((s) => s.id === id)).toBe(true)
    for (const d of report.detectors) {
      if (d.status === 'unknown') {
        expect(d.count).toBeUndefined()
        expect(d.blind_spot.length).toBeGreaterThan(0)
      }
    }
    // Nothing observes these: UNKNOWN whatever the clone.
    for (const id of ['read_only_tool_calls', 'memory_use', 'historical_digest_bytes', 'hook_latency', 'session_cost']) {
      expect(detector(report, id).status).toBe('unknown')
    }
  })

  it('is read-only and deterministic: two runs change nothing and print identical bytes with no clock in them', () => {
    const fixture = fx()
    wireHooks(fixture.root)
    ev(fixture, 'initiative_created', { slug: fixture.slug, goal: 'g' })
    ev(fixture, 'session_started', { tool: 'claude-code' }, 's1')
    ev(fixture, 'session_started', { tool: 'claude-code' }, 's1')
    recordDiagnostic(fixture.root, { kind: 'injection', initiative: fixture.slug, data: { hook: 'SessionStart', bytes: 5000 } })
    const sofarBefore = snapshot(join(fixture.root, '.sofar'))
    const storeBefore = snapshot(diagnosticsDir(fixture.root)!)
    const first = runTune(fixture.root, { dryRun: true })
    const second = runTune(fixture.root, { dryRun: true })
    expect(first.exitCode).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(runTune(fixture.root, { dryRun: true, json: true }).stdout).toBe(runTune(fixture.root, { dryRun: true, json: true }).stdout)
    expect(first.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(snapshot(join(fixture.root, '.sofar'))).toBe(sofarBefore)
    expect(snapshot(diagnosticsDir(fixture.root)!)).toBe(storeBefore)
    expect(first.stdout).toContain('nothing is proposed, applied or written')
  })

  it('a signal the clone cannot observe is UNKNOWN naming what is missing — never a zero', () => {
    const fixture = fx()
    ev(fixture, 'command_run', { cmd: 'npm test', ok: false, exit: 1 }, 's1')
    const bare = json(fixture)
    expect(detector(bare, 'tool_failure').status).toBe('unknown')
    expect(detector(bare, 'tool_failure').coverage).toContain('missing post_tool_failure_hook')
    expect(detector(bare, 'tool_failure').count).toBeUndefined()
    expect(detector(bare, 'duplicate_session_starts').status).toBe('capturable')
    wireHooks(fixture.root)
    const wired = json(fixture)
    expect(detector(wired, 'tool_failure').status).toBe('capturable')
    expect(detector(wired, 'tool_failure').count).toBe(1)
  })
})

describe('record detectors', () => {
  it('duplicate_session_starts counts raw registrations per session, citing every start', () => {
    const fixture = fx()
    const a = ev(fixture, 'session_started', { tool: 'claude-code' }, 's1')
    const b = ev(fixture, 'session_started', { tool: 'claude-code' }, 's1')
    ev(fixture, 'session_started', { tool: 'claude-code' }, 's2')
    ev(fixture, 'session_started', { tool: 'cli' }, 'cli')
    ev(fixture, 'session_started', { tool: 'cli' }, 'cli')
    const d = detector(json(fixture), 'duplicate_session_starts')
    expect(d.status).toBe('capturable')
    expect(d.count).toBe(1)
    expect(d.findings).toEqual([{ initiative: 'alpha', what: 'session s1 registered 2 times', evidence: [a.id, b.id].sort() }])
  })

  it('corrections cite the correction and its target, name the target type, and never a cause', () => {
    const fixture = fx()
    const target = ev(fixture, 'note_added', { text: 'oops' }, 's1')
    const corr = ev(fixture, 'correction', { ref: target.id, reason: 'shell mangled it' }, 's1')
    const orphan = ev(fixture, 'correction', { ref: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, 's1')
    const d = detector(json(fixture), 'corrections')
    expect(d.status).toBe('partial')
    expect(d.count).toBe(2)
    expect(d.findings).toContainEqual({ initiative: 'alpha', what: 'correction of note_added', evidence: [corr.id, target.id].sort() })
    expect(d.findings).toContainEqual({ initiative: 'alpha', what: 'correction of an event not in this log', evidence: [orphan.id] })
    expect(JSON.stringify(d.findings)).not.toContain('mangled')
  })

  it('stalls come from handoff and run_stopped reasons only', () => {
    const fixture = fx()
    const h = ev(fixture, 'handoff', { run: 'r1', session_id: 's1', reason: 'stall' })
    ev(fixture, 'handoff', { run: 'r1', session_id: 's2', reason: 'task_done' })
    const r = ev(fixture, 'run_stopped', { run: 'r1', reason: 'stall' })
    ev(fixture, 'run_stopped', { run: 'r2', reason: 'closed' })
    const d = detector(json(fixture), 'stalls')
    expect(d.count).toBe(2)
    expect(d.findings!.map((f) => f.evidence[0]).sort()).toEqual([h.id, r.id].sort())
    expect(d.findings!.map((f) => f.what).sort()).toEqual(['handoff stall in run r1', 'run r1 stopped on a stall streak'])
  })

  it('formatter_friction counts edits to formatter/MCP config files by path, ignores everything else', () => {
    const fixture = fx()
    wireHooks(fixture.root)
    const a = ev(fixture, 'file_touched', { path: '/repo/biome.json', op: 'edit', ok: true }, 's1')
    const b = ev(fixture, 'file_touched', { path: '/repo/biome.json', op: 'edit', ok: true }, 's1')
    const c = ev(fixture, 'file_touched', { path: '/repo/.mcp.json', op: 'write' }, 's1')
    ev(fixture, 'file_touched', { path: '/repo/src/biome-utils.ts', op: 'edit' }, 's1')
    const d = detector(json(fixture), 'formatter_friction')
    expect(d.status).toBe('partial')
    expect(d.count).toBe(3)
    // Ordered by first evidence id: biome.json's edits landed before .mcp.json's.
    expect(d.findings).toEqual([
      { initiative: 'alpha', what: '/repo/biome.json edited 2 time(s)', evidence: [a.id, b.id].sort() },
      { initiative: 'alpha', what: '/repo/.mcp.json edited 1 time(s)', evidence: [c.id] },
    ])
    // The findings describe edits; only the signal's NAME carries the word.
    expect(JSON.stringify(d.findings)).not.toContain('friction')
  })

  it('tool_failure groups ok:false by leading token or path; events without ok are counted neither way', () => {
    const fixture = fx()
    wireHooks(fixture.root)
    const a = ev(fixture, 'command_run', { cmd: 'npm test', ok: false, exit: 1 }, 's1')
    const b = ev(fixture, 'command_run', { cmd: 'npm run build', ok: false }, 's1')
    ev(fixture, 'command_run', { cmd: 'npm test', ok: true }, 's1')
    ev(fixture, 'command_run', { cmd: 'npm test' }, 's1')
    const w = ev(fixture, 'file_touched', { path: 'src/x.ts', op: 'write', ok: false }, 's1')
    const d = detector(json(fixture), 'tool_failure')
    expect(d.count).toBe(3)
    expect(d.findings).toContainEqual({ initiative: 'alpha', what: 'command `npm` failed 2 time(s)', evidence: [a.id, b.id].sort() })
    expect(d.findings).toContainEqual({ initiative: 'alpha', what: 'write of src/x.ts failed 1 time(s)', evidence: [w.id] })
    expect(d.coverage).toContain('without an ok field are UNKNOWN')
  })
})

describe('diagnostics detectors', () => {
  it('mcp_rejections groups by tool and code with row hashes as evidence; bookkeeping_share is an upper bound; injection_bytes summarises SessionStart', () => {
    const fixture = fx()
    wireHooks(fixture.root)
    const slug = fixture.slug
    recordDiagnostic(fixture.root, { kind: 'mcp_call', initiative: slug, data: { tool: 'sofar_get_state', ok: false, code: 'invalid_input', ms: 1 } })
    recordDiagnostic(fixture.root, { kind: 'mcp_call', initiative: slug, data: { tool: 'sofar_get_state', ok: false, code: 'invalid_input', ms: 2 } })
    recordDiagnostic(fixture.root, { kind: 'mcp_call', initiative: slug, data: { tool: 'sofar_add_note', ok: true, ms: 1 } })
    recordDiagnostic(fixture.root, { kind: 'tool_outcome', initiative: slug, data: { tool: 'Bash', ok: true, exit: null, head: 'git', exempt: true } })
    recordDiagnostic(fixture.root, { kind: 'tool_outcome', initiative: slug, data: { tool: 'Bash', ok: true, exit: null, head: 'npm' } })
    recordDiagnostic(fixture.root, { kind: 'tool_outcome', initiative: slug, data: { tool: 'Edit', ok: true, exit: null } })
    recordDiagnostic(fixture.root, { kind: 'injection', initiative: slug, data: { hook: 'SessionStart', bytes: 4000, memory_bytes: 900 } })
    recordDiagnostic(fixture.root, { kind: 'injection', initiative: slug, data: { hook: 'SessionStart', bytes: 8000, memory_bytes: 1200 } })
    recordDiagnostic(fixture.root, { kind: 'injection', initiative: slug, data: { hook: 'SessionStart', bytes: 6000 } })
    recordDiagnostic(fixture.root, { kind: 'injection', initiative: 'other', data: { hook: 'SessionStart', bytes: 1 } })

    const report = json(fixture)
    expect(report.rows_read).toBe(9) // the `other` initiative's row is out of scope

    const mcp = detector(report, 'mcp_rejections')
    expect(mcp.status).toBe('partial')
    expect(mcp.count).toBe(2)
    expect(mcp.findings).toHaveLength(1)
    expect(mcp.findings![0]!.what).toBe('sofar_get_state rejected 2 time(s) with invalid_input')
    expect(mcp.findings![0]!.evidence.every((e) => /^row:[0-9a-f]{16}$/.test(e))).toBe(true)
    expect(mcp.coverage).toContain('over 3 sofar MCP call row(s)')

    const share = detector(report, 'bookkeeping_share')
    expect(share.count).toBe(1)
    expect(share.findings![0]!.what).toBe('1 exempt command(s) + 3 sofar MCP call(s) over 6 observed call(s) — at most 67%')
    expect(share.findings![0]!.evidence).toHaveLength(4)

    const inj = detector(report, 'injection_bytes')
    expect(inj.status).toBe('capturable')
    expect(inj.count).toBe(3)
    expect(inj.findings![0]!.what).toBe('3 SessionStart injection(s): median 6000 chars, max 8000, repo memory up to 1200')
  })

  it('with the store refused, every diagnostics detector is UNKNOWN', () => {
    const fixture = fx()
    wireHooks(fixture.root)
    vi.stubEnv('XDG_STATE_HOME', join(fixture.root, 'inside'))
    const report = json(fixture)
    for (const id of ['mcp_rejections', 'bookkeeping_share', 'injection_bytes']) {
      expect(detector(report, id).status).toBe('unknown')
      expect(detector(report, id).coverage).toContain('diagnostics_store')
    }
    expect(report.rows_read).toBe(0)
  })
})

describe('scope and rendering', () => {
  it('--all spans every initiative; a bare run resolves the bound one; an unbound branch fails with usage', () => {
    const fixture = fx()
    const other = join(fixture.root, '.sofar', 'initiatives', 'beta')
    mkdirSync(other, { recursive: true })
    const betaStart = makeEvent({ initiative: 'beta', session: 's9', source: 'hook', actor: 'agent', type: 'session_started', payload: { tool: 'x' } })
    appendEvent(join(other, 'events.jsonl'), betaStart)
    appendEvent(join(other, 'events.jsonl'), makeEvent({ initiative: 'beta', session: 's9', source: 'hook', actor: 'agent', type: 'session_started', payload: { tool: 'x' } }))
    ev(fixture, 'initiative_created', { slug: 'alpha', goal: 'g' })

    const one = json(fixture)
    expect(one.initiatives).toEqual(['alpha'])
    const all = json(fixture, { all: true })
    expect(all.initiatives).toEqual(['alpha', 'beta'])
    expect(all.events_read).toEqual({ alpha: 1, beta: 2 })
    expect(detector(all, 'duplicate_session_starts').findings![0]!.initiative).toBe('beta')
    expect(all.cutoff).toBe([...Object.values(all.events_read)].length > 0 ? all.cutoff : null)
    expect(typeof all.cutoff).toBe('string')

    const unbound = makeRepoFixture({ bind: false })
    roots.push(unbound.root)
    const result = runTune(unbound.root, { dryRun: true })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('usage: sofar tune [slug|--all] --dry-run')
  })

  it('renders byte-plain: a block per detector that ran, evidence capped with +N more, and an UNKNOWN list', () => {
    const fixture = fx()
    const ids: string[] = []
    for (let i = 0; i < TUNE_EVIDENCE_SHOWN + 3; i++) ids.push(ev(fixture, 'session_started', { tool: 'claude-code' }, 'dup').id)
    const result = runTune(fixture.root, { dryRun: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toMatch(/\x1b\[/)
    expect(result.stdout).toContain(`duplicate_session_starts [capturable] — 1`)
    expect(result.stdout).toContain(`session dup registered ${TUNE_EVIDENCE_SHOWN + 3} times`)
    expect(result.stdout).toContain('+3 more')
    expect(result.stdout).toContain('UNKNOWN — not observed here, never zero:')
    expect(result.stdout).toContain('read_only_tool_calls: no detector')
    expect(result.stdout).toContain('tool_failure: not observable on this clone: missing post_tool_failure_hook')
    // A partial detector carries its blind spot on the same block.
    expect(result.stdout).toContain('corrections [partial] — 0')
    expect(result.stdout).toContain('blind spot: correction events and their targets are observable. WHY is not')
    // The pure renderer agrees with the CLI.
    const report = JSON.parse(runTune(fixture.root, { dryRun: true, json: true }).stdout) as TuneReport
    expect(renderTuneReport(report)).toBe(result.stdout)
    expect(detect({ events: new Map(), rows: [], signals: [] }).detectors).toEqual([])
  })
})
