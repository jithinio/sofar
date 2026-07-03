import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TOOL_INPUT_SCHEMAS, TOOL_NAMES, type ToolName } from '@harness/schema/tool-inputs'
import { createHarnessServer, SERVER_NAME } from '../src/mcp/server'
import { foldLog, type InitiativeState } from '../src/core/fold'
import { GENERATED_HEADER } from '../src/projections/templates/shared'
import { callTool, connectServer, makeRepoFixture } from './helpers/mcp'

describe('MCP server skeleton (2.1)', () => {
  it('identifies as "harness" and lists all seven typed tools', async () => {
    const { client } = await connectServer(makeRepoFixture().root)
    expect(SERVER_NAME).toBe('harness')

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      // schemas served verbatim from @harness/schema — the only schema home
      expect(tool.inputSchema).toEqual(TOOL_INPUT_SCHEMAS[tool.name as ToolName])
    }
    await client.close()
  })

  it('resolves rootDir to an absolute path with cwd as default', () => {
    expect(createHarnessServer({ rootDir: '.' }).rootDir).toBe(process.cwd())
    expect(createHarnessServer().rootDir).toBe(process.cwd())
  })
})

describe('MCP tools round-trip (2.2)', () => {
  it('start → plan → work → decide → note → end: every append lands, sessions attach, projections regenerate', async () => {
    const fixture = makeRepoFixture()
    const { client, handle } = await connectServer(fixture.root)

    // start_session — becomes the active session
    const started = await callTool<{ session_id: string }>(client, 'harness_start_session', {
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
    expect((await callTool(client, 'harness_update_plan', { plan })).isError).toBe(false)
    expect(
      (await callTool(client, 'harness_update_task', { task_id: '1.1', status: 'done' })).isError,
    ).toBe(false)
    expect(
      (
        await callTool(client, 'harness_log_decision', {
          chose: 'sqlite',
          over: 'postgres',
          because: 'zero ops',
        })
      ).isError,
    ).toBe(false)
    expect((await callTool(client, 'harness_add_note', { text: 'remember the docs' })).isError).toBe(
      false,
    )

    // end_session — session_id arg wins, active session cleared
    const ended = await callTool<{ ok: boolean }>(client, 'harness_end_session', {
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

    // get_state over MCP matches the direct fold (slug filled in from the
    // resolved initiative — no initiative_created event exists in this log)
    const viaTool = await callTool<InitiativeState>(client, 'harness_get_state', {})
    expect(viaTool.isError).toBe(false)
    expect(viaTool.body).toEqual(JSON.parse(JSON.stringify({ ...state, slug: fixture.slug })))

    await client.close()
  })

  it('appends outside a session fall back to session "cli" and source "cli"', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    await callTool(client, 'harness_add_note', { text: 'no session here' })
    const line = JSON.parse(readFileSync(fixture.eventsPath, 'utf8').trim())
    expect(line.session).toBe('cli')
    expect(line.source).toBe('cli')
    await client.close()
  })

  it('a non-source tool name maps envelope.source to "cli" but keeps the session id', async () => {
    const fixture = makeRepoFixture()
    const { client } = await connectServer(fixture.root)

    const started = await callTool<{ session_id: string }>(client, 'harness_start_session', {
      tool: 'aider',
    })
    await callTool(client, 'harness_add_note', { text: 'from an unknown tool' })

    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const event of lines) {
      expect(event.source).toBe('cli')
      expect(event.session).toBe(started.body.session_id)
    }
    await client.close()
  })
})
