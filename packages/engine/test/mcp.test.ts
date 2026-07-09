import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOOL_INPUT_SCHEMAS, TOOL_NAMES, type ToolName } from '@sofar/schema/tool-inputs'
import { createSofarServer, SERVER_NAME } from '../src/mcp/server'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { GENERATED_HEADER } from '../src/projections/templates/shared'
import { handleSessionStart } from '../src/cli/event'
import { callTool, callToolText, connectServer, makeRepoFixture } from './helpers/mcp'

describe('MCP server skeleton (2.1)', () => {
  it('identifies as "sofar" and lists all seven typed tools', async () => {
    const { client } = await connectServer(makeRepoFixture().root)
    expect(SERVER_NAME).toBe('sofar')

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      // schemas served verbatim from @sofar/schema — the only schema home
      expect(tool.inputSchema).toEqual(TOOL_INPUT_SCHEMAS[tool.name as ToolName])
    }
    await client.close()
  })

  it('resolves rootDir to an absolute path with cwd as default', () => {
    expect(createSofarServer({ rootDir: '.' }).rootDir).toBe(process.cwd())
    expect(createSofarServer().rootDir).toBe(process.cwd())
  })
})

describe('MCP tools round-trip (2.2)', () => {
  it('start → plan → work → decide → note → end: every append lands, sessions attach, projections regenerate', async () => {
    const fixture = makeRepoFixture()
    const { client, handle } = await connectServer(fixture.root)

    // start_session — becomes the active session
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      model: 'fable-5',
    })
    expect(started.isError).toBe(false)
    const sessionId = started.body.session_id
    expect(sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(handle.getActiveSession()).toMatchObject({
      id: sessionId,
      tool: 'claude-code',
      initiative: fixture.slug,
    })

    // write tools — all attributed to the active session
    const plan = {
      goal: 'ship the demo',
      phases: [
        {
          name: 'Phase 1',
          status: 'active',
          tasks: [
            { id: '1.1', title: 'first task', status: 'active' },
            { id: '1.2', title: 'second task' },
          ],
        },
      ],
    }
    expect((await callTool(client, 'sofar_update_plan', { plan })).isError).toBe(false)
    expect(
      (await callTool(client, 'sofar_update_task', { task_id: '1.1', status: 'done' })).isError,
    ).toBe(false)
    expect(
      (
        await callTool(client, 'sofar_log_decision', {
          chose: 'sqlite',
          over: 'postgres',
          because: 'zero ops',
        })
      ).isError,
    ).toBe(false)
    expect((await callTool(client, 'sofar_add_note', { text: 'remember the docs' })).isError).toBe(
      false,
    )

    // end_session — session_id arg wins, active session cleared
    const ended = await callTool<{ ok: boolean }>(client, 'sofar_end_session', {
      session_id: sessionId,
      summary: 'did the round trip',
      next_action: 'review the log',
    })
    expect(ended.isError).toBe(false)
    expect(ended.body.ok).toBe(true)
    expect(handle.getActiveSession()).toBeNull()

    // the log is the truth: six events, all in one session envelope
    const { state, warnings } = foldLog(fixture.eventsPath)
    expect(warnings).toEqual([])
    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).type)).toEqual([
      'session_started',
      'plan_updated',
      'task_status_changed',
      'decision_logged',
      'note_added',
      'session_ended',
    ])
    for (const line of lines) {
      const event = JSON.parse(line)
      expect(event.session).toBe(sessionId)
      expect(event.source).toBe('claude-code')
      expect(event.actor).toBe('agent')
    }

    // folded state reflects every tool call
    expect(state.goal).toBe('ship the demo')
    expect(state.phases[0]!.tasks[0]).toEqual({ id: '1.1', title: 'first task', status: 'done' })
    expect(state.decisions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      id: sessionId,
      tool: 'claude-code',
      summary: 'did the round trip',
    })
    expect(state.current.next_action).toBe('review the log')

    // projections regenerated as generated files
    const planMd = readFileSync(`${fixture.initiativeDir}/plan.md`, 'utf8')
    const decisionsMd = readFileSync(`${fixture.initiativeDir}/decisions.md`, 'utf8')
    expect(planMd.startsWith(GENERATED_HEADER)).toBe(true)
    expect(planMd).toContain('- [x] 1.1 first task')
    expect(decisionsMd.startsWith(GENERATED_HEADER)).toBe(true)
    expect(decisionsMd).toContain('chose **sqlite** over postgres because zero ops')

    // get_state view:full over MCP matches the direct fold (slug filled in
    // from the resolved initiative — no initiative_created event in this log)
    const viaTool = await callTool<InitiativeState>(client, 'sofar_get_state', { view: 'full' })
    expect(viaTool.isError).toBe(false)
    expect(viaTool.body).toEqual(JSON.parse(JSON.stringify({ ...state, slug: fixture.slug })))

    await client.close()
  })

  it('appends outside a session fall back to session "cli" and source "cli"', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    await callTool(client, 'sofar_add_note', { text: 'no session here' })
    const line = JSON.parse(readFileSync(fixture.eventsPath, 'utf8').trim())
    expect(line.session).toBe('cli')
    expect(line.source).toBe('cli')
    await client.close()
  })

  it('start_session with session_id adopts exactly the hook-registered open session (BD43)', async () => {
    const fixture = makeRepoFixture()
    // the SessionStart hook registered Claude Code's session in the log AND
    // injected the id into context — the agent passes it back explicitly
    handleSessionStart(fixture.root, JSON.stringify({ session_id: 'claude-hook-sess' }))

    const { client, handle } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'claude-hook-sess',
    })
    expect(started.isError).toBe(false)
    expect(started.body.session_id).toBe('claude-hook-sess')
    expect(handle.getActiveSession()).toMatchObject({
      id: 'claude-hook-sess',
      tool: 'claude-code',
      initiative: fixture.slug,
    })

    // adoption appends nothing — the session_started from the hook stands alone
    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)

    // end_session closes the adopted (hook-registered) session
    await callTool(client, 'sofar_end_session', {
      session_id: 'claude-hook-sess',
      summary: 'adopted and closed',
      next_action: 'nothing',
    })
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions).toHaveLength(1)
    expect(state.sessions[0]).toMatchObject({
      id: 'claude-hook-sess',
      summary: 'adopted and closed',
    })
    await client.close()
  })

  it('start_session WITHOUT session_id mints fresh even when another session is open (BD20 heuristic removed)', async () => {
    const fixture = makeRepoFixture()
    // a parallel agent's session is open — it must NOT be cross-adopted
    handleSessionStart(fixture.root, JSON.stringify({ session_id: 'parallel-agent-sess' }))

    const { client, handle } = await connectServer(fixture.root)
    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    expect(started.isError).toBe(false)
    expect(started.body.session_id).not.toBe('parallel-agent-sess')
    expect(started.body.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/) // fresh ulid
    expect(handle.getActiveSession()!.id).toBe(started.body.session_id)

    // the mint registered a second session; the parallel one is untouched
    const { state } = foldLog(fixture.eventsPath)
    expect(state.sessions.map((s) => s.id)).toEqual(['parallel-agent-sess', started.body.session_id])
    await client.close()
  })

  it('start_session with an ENDED session_id fails typed (invalid_input), appends nothing', async () => {
    const fixture = makeRepoFixture()
    const { client, handle } = await connectServer(fixture.root)

    const first = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'done-sess',
    })
    expect(first.body.session_id).toBe('done-sess')
    await callTool(client, 'sofar_end_session', {
      session_id: 'done-sess',
      summary: 'finished',
      next_action: 'nothing',
    })

    const linesBefore = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').length
    const retry = await callTool<{ code: string; message: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      session_id: 'done-sess',
    })
    expect(retry.isError).toBe(true)
    expect(retry.body.code).toBe('invalid_input')
    expect(retry.body.message).toContain('already ended')
    expect(readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')).toHaveLength(linesBefore)
    expect(handle.getActiveSession()).toBeNull() // failed adopt never becomes active
    await client.close()
  })

  it('start_session with an UNKNOWN session_id registers it: session_started with that envelope.session', async () => {
    const fixture = makeRepoFixture()
    const { client, handle } = await connectServer(fixture.root)

    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
      model: 'fable-5',
      session_id: 'mcp-only-sess',
    })
    expect(started.isError).toBe(false)
    expect(started.body.session_id).toBe('mcp-only-sess')
    expect(handle.getActiveSession()!.id).toBe('mcp-only-sess')

    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const event = JSON.parse(lines[0]!)
    expect(event).toMatchObject({
      type: 'session_started',
      session: 'mcp-only-sess',
      payload: { tool: 'claude-code', model: 'fable-5' },
    })
    await client.close()
  })

  it('start_session mints a fresh ulid when every logged session is closed', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    const first = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    await callTool(client, 'sofar_end_session', {
      session_id: first.body.session_id,
      summary: 'done',
      next_action: 'next',
    })

    const second = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'claude-code',
    })
    expect(second.body.session_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(second.body.session_id).not.toBe(first.body.session_id)
    await client.close()
  })

  it('a non-source tool name maps envelope.source to "cli" but keeps the session id', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    const started = await callTool<{ session_id: string }>(client, 'sofar_start_session', {
      tool: 'aider',
    })
    await callTool(client, 'sofar_add_note', { text: 'from an unknown tool' })

    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const event of lines) {
      expect(event.source).toBe('cli')
      expect(event.session).toBe(started.body.session_id)
    }
    await client.close()
  })
})

describe('get_state progressive disclosure — digest default vs view:full (token-opt)', () => {
  /** Seed an initiative with a goal, a task, and a decision carrying rationale. */
  async function seeded() {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    await callTool(client, 'sofar_start_session', { tool: 'claude-code' })
    await callTool(client, 'sofar_update_plan', {
      plan: {
        goal: 'ship the widget',
        phases: [{ name: 'Phase 1', tasks: [{ id: '1.1', title: 'first task', status: 'active' }] }],
      },
    })
    await callTool(client, 'sofar_log_decision', {
      chose: 'sqlite',
      over: 'postgres',
      because: 'zero ops overhead',
    })
    return { fixture, client }
  }

  it('default view returns the summary-dense digest with rationale surfaced (not the raw fold)', async () => {
    const { client } = await seeded()
    const { isError, text } = await callToolText(client, 'sofar_get_state', {})
    expect(isError).toBe(false)
    // It is the status projection (text), not a JSON dump of the state.
    expect(text.startsWith('# Sofar status:')).toBe(true)
    expect(text).toContain('Goal: ship the widget')
    // The rationale "muscle" stays first-class: the rejected approach AND why.
    expect(text).toContain('postgres') // what was rejected (M4 dead-end guard)
    expect(text).toContain('zero ops overhead') // why
    // Digest is bounded (SessionStart budget applies to the projection).
    expect(text.length).toBeLessThanOrEqual(10_000)
    await client.close()
  })

  it('digest is smaller than the full fold for the same state', async () => {
    const { client } = await seeded()
    const digest = await callToolText(client, 'sofar_get_state', {})
    const full = await callToolText(client, 'sofar_get_state', { view: 'full' })
    expect(digest.text.length).toBeLessThan(full.text.length)
    await client.close()
  })

  it('view:"full" returns the complete folded InitiativeState object', async () => {
    const { client } = await seeded()
    const { isError, body } = await callTool<InitiativeState>(client, 'sofar_get_state', {
      view: 'full',
    })
    expect(isError).toBe(false)
    expect(body.goal).toBe('ship the widget')
    expect(body.phases[0]!.tasks[0]!.id).toBe('1.1')
    expect(body.decisions).toHaveLength(1)
    expect(body.decisions[0]).toMatchObject({ chose: 'sqlite', over: 'postgres' })
    await client.close()
  })

  it('rejects an unknown view with a typed invalid_input error, appends nothing', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)
    const { isError, body } = await callTool<{ code: string; errors: string[] }>(
      client,
      'sofar_get_state',
      { view: 'summary' },
    )
    expect(isError).toBe(true)
    expect(body.code).toBe('invalid_input')
    expect(body.errors.join('\n')).toContain('view: must be one of')
    expect(existsSync(fixture.eventsPath)).toBe(false)
    await client.close()
  })
})
