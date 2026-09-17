import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CodexAdapter } from '../src/driver/codex'
import { checkSchema as check, CONTRACT, isObj, type Json, type Obj, PAYLOADS, SCHEMAS } from './helpers/codex'

/**
 * The Codex contract capture (agents-parity 1.1). The fixtures under
 * fixtures/codex/ were read from codex-cli 0.154.0's binary and the saved
 * Codex hooks docs, never from a live run (D3). README.md there marks each
 * claim read-from-binary, read-from-docs or unverified; the prose is SPEC
 * (§Codex host).
 *
 * What this suite pins is that the fixtures agree with EACH OTHER. Every
 * payload satisfies the schema Codex embeds, the contract's event list is the
 * schemas' event list, and the exec vocabulary still covers what the 0.136.0
 * adapter reads. Later tasks build on the fixtures, so a hand edit that drifts
 * one away from the binary fails here first.
 */

describe('the hook schemas embedded in codex 0.154.0', () => {
  const titles = Object.keys(SCHEMAS)
  const inputs = titles.filter((t) => t.endsWith('.command.input'))
  const outputs = titles.filter((t) => t.endsWith('.command.output'))

  it('are one input per event and one output per event except SessionEnd', () => {
    expect(inputs).toHaveLength(12)
    expect(outputs).toHaveLength(11)
    expect(titles.sort()).toEqual([...inputs, ...outputs].sort())
    expect(outputs).not.toContain('session-end.command.output')
    for (const title of titles) expect(SCHEMAS[title]?.title).toBe(title)
  })

  it('name exactly the events the contract lists', () => {
    const events = inputs.map((t) => {
      const props = SCHEMAS[t]?.properties
      const name = isObj(props) && isObj(props.hook_event_name) ? props.hook_event_name.const : undefined
      return name
    })
    const hooks = CONTRACT.hooks as Obj
    expect(events.sort()).toEqual([...((hooks.events as Obj).names as string[])].sort())
  })

  it('send the Claude Code field names sofar reads, and turn_id only on turn-scoped events', () => {
    const required = (t: string): Json[] => (SCHEMAS[t]?.required as Json[] | undefined) ?? []
    for (const t of inputs) {
      expect(required(t)).toEqual(expect.arrayContaining(['session_id', 'transcript_path', 'cwd', 'hook_event_name']))
    }
    expect(required('stop.command.input')).toContain('stop_hook_active')
    expect(required('post-tool-use.command.input')).toEqual(expect.arrayContaining(['tool_name', 'tool_input', 'tool_response']))
    // Session-scoped events carry no turn; SessionEnd carries no model either,
    // although the docs' common-fields table lists model for every event.
    expect(required('session-start.command.input')).not.toContain('turn_id')
    expect(required('session-end.command.input')).not.toContain('turn_id')
    expect(required('session-end.command.input')).not.toContain('model')
    expect(required('post-tool-use.command.input')).toContain('turn_id')
  })

  it('have no field that names the host or its version — unlike Cursor’s cursor_version', () => {
    for (const t of inputs) {
      const props = SCHEMAS[t]?.properties
      const names = isObj(props) ? Object.keys(props) : []
      expect(names.filter((n) => /codex|version/i.test(n))).toEqual([])
    }
  })
})

describe('the payload fixtures', () => {
  it('each satisfy the schema they name', () => {
    for (const [name, { schema, payload }] of Object.entries(PAYLOADS)) {
      expect({ name, errors: check(schema, payload) }).toEqual({ name, errors: [] })
    }
  })

  it('cover every hook sofar installs, with a failing Bash in place of PostToolUseFailure', () => {
    const events = new Set(Object.values(PAYLOADS).map((p) => p.payload.hook_event_name))
    expect([...events].sort()).toEqual(['PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'])
    expect(SCHEMAS['post-tool-use-failure.command.input']).toBeUndefined()
  })

  it('are held to the schema, not merely parsed — an extra or missing field fails', () => {
    const base = PAYLOADS['stop.first']!.payload
    expect(check('stop.command.input', { ...base, loop_count: 0 })).toEqual(['$: unexpected loop_count'])
    const { stop_hook_active: _dropped, ...missing } = base
    expect(check('stop.command.input', missing)).toEqual(['$: missing stop_hook_active'])
    expect(check('stop.command.input', { ...base, permission_mode: 'auto' })).toEqual([
      '$.permission_mode: "auto" not in enum',
    ])
  })
})

describe('outputs Codex accepts', () => {
  it('include the Claude Code carriers sofar already emits for post-tool context and the stop hold', () => {
    // event.ts postToolContext and the Stop gate's JSON twin: Codex reads the
    // same hookSpecificOutput and decision/reason Claude Code does.
    expect(
      check('post-tool-use.command.output', {
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'guard notice' },
      }),
    ).toEqual([])
    expect(check('stop.command.output', { decision: 'block', reason: 'write back first' })).toEqual([])
    expect(
      check('session-start.command.output', {
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'digest' },
      }),
    ).toEqual([])
  })

  it('reject Cursor’s carriers, so a Codex session never gets toCursor’s output', () => {
    expect(check('stop.command.output', { followup_message: 'x' })).toEqual(['$: unexpected followup_message'])
    expect(check('session-start.command.output', { additional_context: 'x' })).toEqual([
      '$: unexpected additional_context',
    ])
  })
})

describe('the contract file', () => {
  const hooks = CONTRACT.hooks as Obj
  const events = (hooks.events as Obj).names as string[]

  it('marks every section with where it was read', () => {
    const sections: Obj[] = [
      ...Object.values(hooks).filter(isObj),
      CONTRACT.mcp as Obj,
      CONTRACT.agents_md as Obj,
      CONTRACT.exec_json as Obj,
    ]
    for (const section of sections) {
      expect(['read-from-binary', 'read-from-docs', 'unverified']).toContain(section.provenance)
    }
  })

  it('keys its per-event tables by real event names only', () => {
    for (const table of ['timeouts_seconds', 'matcher_target', 'plain_stdout', 'exit_2_stderr']) {
      const keys = Object.keys(hooks[table] as Obj).filter((k) => k !== 'provenance' && k !== 'default')
      for (const key of keys) expect({ table, key, known: events.includes(key) }).toEqual({ table, key, known: true })
    }
  })
})

describe('codex exec --json, 0.136.0 adapter against the 0.154.0 vocabulary', () => {
  const exec = CONTRACT.exec_json as Obj
  const types = exec.types as string[]
  const examples = exec.examples as Obj[]

  it('still has every line type the adapter reads', () => {
    const source = readFileSync(new URL('../src/driver/codex.ts', import.meta.url), 'utf8')
    const handled = [...source.matchAll(/case '([a-z.]+)':/g)].map((m) => m[1])
    expect(handled.sort()).toEqual(['error', 'thread.started', 'turn.completed', 'turn.failed'])
    for (const type of handled) expect(types).toContain(type)
    for (const line of examples) expect(types).toContain(line.type)
  })

  const roots: string[] = []
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  it('parses thread id, usage and failure from lines in the 0.154.0 field names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-cx-contract-'))
    roots.push(root)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex'), '#!/bin/sh\ncat "$STUB_STREAM"\n', { mode: 0o755 })
    const stream = join(root, 'stream.jsonl')
    writeFileSync(stream, examples.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const session = new CodexAdapter().launch({
      cwd: root,
      initiative: 'demo',
      prompt: 'p',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, STUB_STREAM: stream },
    })
    const exit = await session.wait()
    const started = examples.find((l) => l.type === 'thread.started')!
    expect(session.threadId).toBe(started.thread_id)
    // cache_write_input_tokens is new beside the 0.136.0 names and is not
    // counted; whether input_tokens already includes cached tokens is
    // unverified (README), so this pins today's arithmetic, not its truth.
    expect(exit.usage).toEqual({ context_tokens: 21_780 + 11_008, output_tokens: 131 + 46 })
    expect(session.failure).toContain('stream disconnected')
  })
})
