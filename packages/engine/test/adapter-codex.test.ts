import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CodexAdapter,
  CODEX_CAPABILITIES,
  codexArgs,
  codexPermissionArgs,
  codexPinLine,
  CodexSurfaceError,
  SANDBOX_BY_MODE,
} from '../src/driver/codex'
import { inertOptions, policyUnavailable, resolveLaunchedSession } from '../src/driver/adapter'
import { buildSurface, PERMISSION_MODES } from '../src/driver/permissions'
import { drive } from '../src/driver/drive'
import { makeEvent } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLog, type InitiativeState } from '../src/core/fold'
import type { LaunchRequest } from '../src/driver/adapter'

/**
 * The codex adapter (session-driver 3.1, D9) against a STUBBED `codex` on
 * PATH — never the real one. The line shapes replayed here were captured from
 * codex-cli 0.136.0 (`codex exec --json` pointed at an unreachable provider,
 * so the capture cost nothing); `turn.completed` is the one shape a zero-cost
 * capture could not produce, and the parse is tolerant for exactly that reason.
 *
 * What these pin is the contract holding for an agent it was not designed
 * from: everything codex CANNOT do is declared, and the driver's derivations
 * work on an adapter that shows no record session id of its own.
 */

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
pwd > "$STUB_OUT/cwd"
if [ -n "$STUB_STREAM" ]; then cat "$STUB_STREAM"; fi
if [ -n "$STUB_STDERR" ]; then echo "$STUB_STDERR" >&2; fi
exit \${STUB_EXIT:-0}
`

interface Cell {
  root: string
  out: string
  cwd: string
  request: (extra?: Partial<LaunchRequest>) => LaunchRequest
}

function cell(name: string): Cell {
  const root = mkdtempSync(join(tmpdir(), `sofar-cx-${name}-`))
  roots.push(root)
  const binDir = join(root, 'bin')
  const out = join(root, 'out')
  const cwd = join(root, 'work')
  for (const d of [binDir, out, cwd]) mkdirSync(d)
  writeFileSync(join(binDir, 'codex'), STUB, { mode: 0o755 })
  return {
    root,
    out,
    cwd,
    request: (extra = {}) => ({
      cwd,
      initiative: 'demo',
      prompt: 'do the next task',
      ...extra,
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, STUB_OUT: out, ...extra.env },
    }),
  }
}

/** Line shapes captured from codex-cli 0.136.0. */
const THREAD = { type: 'thread.started', thread_id: '01a050e6-eaee-7e43-acb1-bde6cc7cb755' }
const TURN_STARTED = { type: 'turn.started' }
const ITEM = { type: 'item.completed', item: { id: 'i1', item_type: 'agent_message', text: 'done' } }
const TURN_DONE = {
  type: 'turn.completed',
  usage: {
    input_tokens: 21_780,
    cached_input_tokens: 11_008,
    output_tokens: 131,
    reasoning_output_tokens: 46,
    total_tokens: 21_911,
  },
}
const TURN_FAILED = { type: 'turn.failed', error: { message: 'stream disconnected before completion' } }
const ERROR_LINE = { type: 'error', message: 'stream disconnected before completion' }

function withStream(c: Cell, lines: unknown[]): string {
  const path = join(c.root, 'stream.jsonl')
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return path
}

describe('what codex cannot do, declared', () => {
  it('reports no live gauge and cannot be nudged, so the threshold policy is refused on it', () => {
    expect(CODEX_CAPABILITIES.usage).toBe(false)
    expect(CODEX_CAPABILITIES.nudge).toBe(false)
    expect(policyUnavailable(CODEX_CAPABILITIES, 'task')).toBeNull()
    const why = policyUnavailable(CODEX_CAPABILITIES, 'threshold')
    expect(why).toContain('does not report usage')
    expect(why).toContain('cannot nudge')
  })

  it('has no per-tool rules and no cost, and the driver says what that makes inert', () => {
    expect(CODEX_CAPABILITIES.permission_rules).toBe(false)
    expect(CODEX_CAPABILITIES.cost).toBe(false)
    const lines = inertOptions(CODEX_CAPABILITIES, {
      surface: buildSurface({ allow: ['Bash(npm test:*)'] }),
      costCapUsd: 5,
    })
    expect(lines.join(' ')).toContain('no per-tool permission rules')
    expect(lines.join(' ')).toContain('--cost-cap can never fire')
    // Nothing inert, nothing said.
    expect(inertOptions(CODEX_CAPABILITIES, {})).toEqual([])
    expect(
      inertOptions({ ...CODEX_CAPABILITIES, permission_rules: true, cost: true }, {
        surface: buildSurface(),
        costCapUsd: 5,
      }),
    ).toEqual([])
  })

  it('routes model and effort, which it CAN do', () => {
    expect(CODEX_CAPABILITIES.model).toBe(true)
    expect(CODEX_CAPABILITIES.effort).toBe(true)
  })
})

describe('the surface, in codex vocabulary', () => {
  it('maps the mode to a sandbox and pins approval to never — unattended cannot answer', () => {
    expect(codexPermissionArgs(buildSurface())).toEqual([
      '-s',
      'workspace-write',
      '-c',
      'approval_policy="never"',
    ])
    expect(codexPermissionArgs(buildSurface({ mode: 'bypassPermissions' }))[1]).toBe('danger-full-access')
    expect(codexPermissionArgs(buildSurface({ mode: 'plan' }))[1]).toBe('read-only')
    // Every mode sofar can STATE has a codex meaning; none is left to a guess.
    // Read from PERMISSION_MODES, not from the codex map: iterating the map
    // would only prove the map maps itself, and the drift that matters is a
    // mode the operator can pass which codex then refuses at launch.
    expect(Object.keys(SANDBOX_BY_MODE).sort()).toEqual([...PERMISSION_MODES].sort())
    for (const mode of PERMISSION_MODES) {
      expect(() => codexPermissionArgs({ permission_mode: mode, allow: [] })).not.toThrow()
    }
  })

  it('refuses a mode it cannot map rather than launching under one nobody chose', () => {
    expect(() => codexPermissionArgs({ permission_mode: 'acceptEditsPlus', allow: [] })).toThrow(
      CodexSurfaceError,
    )
  })

  it('carries the mode and NOT the rules — the rules have no codex spelling', () => {
    const args = codexArgs(
      { cwd: '/w', initiative: 'demo', prompt: 'go', surface: buildSurface({ allow: ['Bash(npm test:*)'] }) },
      'S1',
    )
    expect(args).toContain('workspace-write')
    expect(args.join(' ')).not.toContain('Bash(npm test:*)')
  })
})

describe('argv and the pin line', () => {
  it('asks for JSON, skips the git check, routes hints, and puts the prompt last', () => {
    const args = codexArgs(
      { cwd: '/w', initiative: 'demo', prompt: 'go', model: 'gpt-5.6-sol', effort: 'high' },
      'S1',
      { args: ['--add-dir', '/elsewhere'] },
    )
    expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check'])
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol')
    expect(args).toContain('model_reasoning_effort="high"')
    expect(args.slice(-3, -1)).toEqual(['--add-dir', '/elsewhere'])
    expect(args.at(-1)).toContain('\n\ngo')
  })

  it('hands over the assigned session id and the CLI dialect, because codex has no sofar MCP', () => {
    const line = codexPinLine('session-driver', 'S-123')
    expect(line).toContain('Your session id is S-123')
    expect(line).toContain('sofar event append session-driver --session S-123 --source codex --type')
    expect(line).toContain('session_started')
    expect(line).toContain('session_ended')
    // The tool name is load-bearing: the driver finds its session by it.
    expect(line).toContain('{"tool":"codex"}')
    expect(codexPinLine('demo', 'S1', '/usr/local/bin/sofar')).toContain('/usr/local/bin/sofar event append')
  })
})

describe('the stream', () => {
  it('keeps codex’s thread id for diagnostics and reports the ASSIGNED session id', async () => {
    const c = cell('thread')
    const session = new CodexAdapter().launch(
      c.request({ env: { STUB_STREAM: withStream(c, [THREAD, TURN_STARTED, ITEM, TURN_DONE]) } }),
    )
    const exit = await session.wait()
    expect(session.threadId).toBe(THREAD.thread_id)
    // Codex's own id is NOT the record's, and the exit never carries it.
    expect(exit.session_id).toBe(session.sessionId)
    expect(exit.session_id).not.toBe(THREAD.thread_id)
    expect(exit.code).toBe(0)
  })

  it('reads the final usage from turn.completed, and usage() stays undefined throughout', async () => {
    const c = cell('usage')
    const session = new CodexAdapter().launch(
      c.request({ env: { STUB_STREAM: withStream(c, [THREAD, TURN_STARTED, TURN_DONE]) } }),
    )
    expect(session.usage()).toBeUndefined()
    const exit = await session.wait()
    // A post-mortem is not a gauge: it rides the exit, never usage().
    expect(session.usage()).toBeUndefined()
    expect(exit.usage).toEqual({ context_tokens: 21_780 + 11_008, output_tokens: 131 + 46 })
  })

  it('keeps the failure message from turn.failed and from a bare error line', async () => {
    const a = cell('failed')
    const s1 = new CodexAdapter().launch(
      a.request({ env: { STUB_STREAM: withStream(a, [THREAD, TURN_STARTED, TURN_FAILED]) } }),
    )
    await s1.wait()
    expect(s1.failure).toContain('stream disconnected')

    const b = cell('errline')
    const s2 = new CodexAdapter().launch(
      b.request({ env: { STUB_STREAM: withStream(b, [THREAD, ERROR_LINE]) } }),
    )
    await s2.wait()
    expect(s2.failure).toContain('stream disconnected')
  })

  it('skips an unparseable line and a shape it does not know, the fold’s tolerance rule', async () => {
    const c = cell('tolerant')
    const path = join(c.root, 'stream.jsonl')
    writeFileSync(
      path,
      [
        'not json at all',
        JSON.stringify(THREAD),
        '{"type":"turn.completed"}',
        JSON.stringify({ type: 'item.updated', item: {} }),
        JSON.stringify(TURN_DONE),
      ].join('\n') + '\n',
    )
    const session = new CodexAdapter().launch(c.request({ env: { STUB_STREAM: path } }))
    const exit = await session.wait()
    expect(session.threadId).toBe(THREAD.thread_id)
    expect(exit.usage?.context_tokens).toBe(21_780 + 11_008)
  })

  it('keeps the stderr tail on a bad exit, and a missing binary is 127', async () => {
    const c = cell('stderr')
    const session = new CodexAdapter().launch(
      c.request({ env: { STUB_STREAM: withStream(c, [THREAD]), STUB_STDERR: 'ERROR codex_core: boom', STUB_EXIT: '3' } }),
    )
    const exit = await session.wait()
    expect(exit.code).toBe(3)
    expect(session.stderrTail).toContain('boom')

    const missing = new CodexAdapter({ bin: 'codex-that-does-not-exist' }).launch(cell('missing').request())
    const gone = await missing.wait()
    expect(gone.code).toBe(127)
    expect(missing.spawnError).toBeDefined()
  })

  it('runs the child in the request cwd', async () => {
    const c = cell('cwd')
    const session = new CodexAdapter().launch(c.request({ env: { STUB_STREAM: withStream(c, [THREAD]) } }))
    await session.wait()
    expect(readFileSync(join(c.out, 'cwd'), 'utf8').trim()).toContain('work')
  })
})

describe('the driver’s derivations still hold on it (D3)', () => {
  const state = (sessions: { id: string; tool: string; started: string }[]): InitiativeState =>
    ({ sessions }) as unknown as InitiativeState

  it('an ASSIGNED id is believed only because the record registered it', () => {
    const exit = { code: 0, session_id: 'S-assigned' }
    // Registered: taken.
    expect(
      resolveLaunchedSession(
        state([{ id: 'S-assigned', tool: 'codex', started: '2026-08-30T00:00:00.000Z' }]),
        exit,
        '2026-08-30T00:00:00.000Z',
        'codex',
      ),
    ).toMatchObject({ kind: 'found' })
    // Never registered: the assignment counts for nothing and the fold decides.
    expect(
      resolveLaunchedSession(
        state([{ id: 'S-other', tool: 'codex', started: '2026-08-30T00:00:01.000Z' }]),
        exit,
        '2026-08-30T00:00:00.000Z',
        'codex',
      ),
    ).toMatchObject({ kind: 'found', session: { id: 'S-other' } })
    // A session the driven agent registered under another tool is invisible.
    expect(
      resolveLaunchedSession(
        state([{ id: 'S-other', tool: 'claude-code', started: '2026-08-30T00:00:01.000Z' }]),
        exit,
        '2026-08-30T00:00:00.000Z',
        'codex',
      ),
    ).toEqual({ kind: 'none' })
  })
})

describe('sofar drive runs unchanged against it — the proof (3.1)', () => {
  /**
   * A stub `codex` that behaves like a DRIVEN session rather than a process:
   * it reads its own session id and task id out of the prompt it was given —
   * exactly as the pin line instructs a real one to — and writes the record
   * with the CLI dialect's envelope, because codex carries no sofar MCP
   * server. Nothing about the loop is stubbed; only the model is absent.
   */
  const DRIVEN_STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$STUB_OUT/argv"
node "$STUB_SESSION" "$STUB_LOG" "$STUB_OUT/argv" "$STUB_BLOCK"
printf '%s\\n' '{"type":"thread.started","thread_id":"01a050e6-eaee-7e43-acb1-bde6cc7cb755"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":5,"reasoning_output_tokens":0}}'
exit 0
`

  it('records a task_done handoff naming the session codex registered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-cx-drive-'))
    roots.push(root)
    const dir = join(root, '.sofar', 'initiatives', 'demo')
    const binDir = join(root, 'bin')
    const out = join(root, 'out')
    for (const d of [dir, binDir, out]) mkdirSync(d, { recursive: true })
    const log = join(dir, 'events.jsonl')
    writeFileSync(log, '')
    for (const line of [
      { type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } },
      {
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [{ name: 'P1', status: 'active', tasks: [{ id: '1.1', title: 'first', status: 'pending' }] }],
          },
        },
      },
    ]) {
      appendEvent(
        log,
        makeEvent({ initiative: 'demo', session: 'cli', type: line.type, payload: line.payload, source: 'cli', actor: 'agent' }),
      )
    }
    writeFileSync(join(binDir, 'codex'), DRIVEN_STUB, { mode: 0o755 })

    // The loop builds its own LaunchRequest and passes no env, so the stub is
    // reached the way any real agent is: through the process environment.
    const saved = { ...process.env }
    process.env.STUB_OUT = out
    process.env.STUB_LOG = log
    process.env.STUB_SESSION = fileURLToPath(new URL('./helpers/codex-driven-session.cjs', import.meta.url))

    const progress: string[] = []
    let outcome
    try {
      outcome = await drive(root, 'demo', {
        adapter: new CodexAdapter({ bin: join(binDir, 'codex') }),
        surface: buildSurface({ allow: ['Bash(npm test:*)'] }),
        costCapUsd: 5,
        maxSessions: 1,
        onProgress: (l) => progress.push(l),
      })
    } finally {
      process.env = saved
    }

    // The whole loop, on an adapter whose every capability is false: the
    // session codex registered is the one the handoff names, the reason is
    // read from the fold, and the run ran the plan out.
    expect(foldLog(log).warnings).toEqual([])
    expect(outcome.handoffs).toHaveLength(1)
    expect(outcome.handoffs[0]?.reason).toBe('task_done')
    expect(outcome.handoffs[0]?.session_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(outcome.stop.reason).toBe('closed')
    expect(outcome.stop.note).toContain('no task left to run')
    // Usage reached the record from turn.completed even though usage() never did.
    expect(outcome.handoffs[0]?.tokens).toBe(120)
    // And the run said what codex cannot honour, before it launched anything.
    expect(progress.some((l) => l.includes('no per-tool permission rules'))).toBe(true)
    expect(progress.some((l) => l.includes('--cost-cap can never fire'))).toBe(true)
  })

  it('the blocked lever reaches the driver through the CLI dialect too (D5)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-cx-block-'))
    roots.push(root)
    const dir = join(root, '.sofar', 'initiatives', 'demo')
    const binDir = join(root, 'bin')
    const out = join(root, 'out')
    for (const d of [dir, binDir, out]) mkdirSync(d, { recursive: true })
    const log = join(dir, 'events.jsonl')
    writeFileSync(log, '')
    for (const line of [
      { type: 'initiative_created', payload: { slug: 'demo', goal: 'g' } },
      {
        type: 'plan_updated',
        payload: {
          plan: {
            goal: 'g',
            phases: [
              {
                name: 'P1',
                status: 'active',
                tasks: [
                  { id: '1.1', title: 'first', status: 'pending' },
                  { id: '1.2', title: 'second', status: 'pending' },
                ],
              },
            ],
          },
        },
      },
    ]) {
      appendEvent(
        log,
        makeEvent({ initiative: 'demo', session: 'cli', type: line.type, payload: line.payload, source: 'cli', actor: 'agent' }),
      )
    }
    writeFileSync(join(binDir, 'codex'), DRIVEN_STUB, { mode: 0o755 })

    const saved = { ...process.env }
    process.env.STUB_OUT = out
    process.env.STUB_LOG = log
    process.env.STUB_SESSION = fileURLToPath(new URL('./helpers/codex-driven-session.cjs', import.meta.url))
    process.env.STUB_BLOCK = 'which registry should this publish to?'
    let outcome
    try {
      outcome = await drive(root, 'demo', { adapter: new CodexAdapter({ bin: join(binDir, 'codex') }) })
    } finally {
      process.env = saved
    }

    expect(outcome.handoffs.map((h) => h.reason)).toEqual(['needs_user'])
    expect(outcome.stop.reason).toBe('needs_user')
    // The run stopped on the SECOND task remaining, not on an exit code.
    expect(outcome.stop.note).toContain('1.1 is blocked')
  })
})
