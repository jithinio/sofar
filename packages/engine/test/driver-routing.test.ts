import { describe, expect, it } from 'vitest'
import type { AdapterCapabilities } from '../src/driver/adapter'
import { previewRoutes, resolveRoute, RouteError, type RoutingOptions } from '../src/driver/routing'
import { buildSurface } from '../src/driver/permissions'
import { FakeAdapter } from './helpers/fake-adapter'

/**
 * Per-task routing (session-driver 3.2, D10).
 *
 * Two rules are under test and nothing else: the RUN outranks the task, and a
 * route the run cannot honour refuses rather than falling back. Everything
 * else here is the corollary D9 asks for — a hint that lost is a hint the
 * operator hears about before the run starts, never one that vanishes.
 */

const agent = (name: string, capabilities?: Partial<AdapterCapabilities>): FakeAdapter =>
  new FakeAdapter(
    [
      {
        logPath: '/dev/null',
        initiative: 'demo',
        // A gauge unless a test says otherwise, so `policy: 'threshold'` is
        // about the ROUTED adapter's capabilities and not the fake's default.
        usage: [{ context_tokens: 1 }],
        ...(capabilities !== undefined ? { capabilities } : {}),
      },
    ],
    name,
  )

const routing = (over: Partial<RoutingOptions> = {}): RoutingOptions => ({
  adapter: agent('claude-code', { model: true, effort: true }),
  policy: 'task',
  ...over,
})

describe('resolveRoute — the run outranks the task', () => {
  it("runs an unrouted task on the default adapter, with the run's own hints", () => {
    const options = routing({ model: 'opus', effort: 'high' })
    const route = resolveRoute('1.1', undefined, options)
    expect(route.adapter).toBe(options.adapter)
    expect(route.model).toBe('opus')
    expect(route.effort).toBe('high')
    expect(route.inert).toEqual([])
  })

  it('lets a hint fill what the run left open', () => {
    const route = resolveRoute('1.1', { model: 'haiku', effort: 'low' }, routing())
    expect(route.model).toBe('haiku')
    expect(route.effort).toBe('low')
    expect(route.inert).toEqual([])
  })

  it("keeps the run's pin over a hint, and says the hint lost", () => {
    const surface = buildSurface({ model: 'opus' })
    const route = resolveRoute('1.1', { model: 'haiku' }, routing({ surface }))
    expect(route.model).toBe('opus')
    expect(route.inert).toEqual([
      "task 1.1 hints model haiku, but this run pinned model opus — the run's pin wins",
    ])
  })

  it('says nothing when the hint and the pin agree — there is nothing to lose', () => {
    const route = resolveRoute('1.1', { model: 'opus' }, routing({ surface: buildSurface({ model: 'opus' }) }))
    expect(route.model).toBe('opus')
    expect(route.inert).toEqual([])
  })

  it('states a hint the target adapter cannot honour, rather than dropping it silently (D9)', () => {
    const route = resolveRoute('1.1', { effort: 'high' }, routing({ adapter: agent('claude-code') }))
    expect(route.inert).toEqual([
      'task 1.1 hints effort high, but the claude-code adapter honours no effort hint — it does not reach the session',
    ])
  })
})

describe('resolveRoute — route.agent is honoured or refused, never approximated', () => {
  it('launches the named adapter', () => {
    const codex = agent('codex')
    const route = resolveRoute('1.1', { agent: 'codex' }, routing({ agents: new Map([['codex', codex]]) }))
    expect(route.adapter).toBe(codex)
  })

  it("resolves the run's own agent by name to the run's own adapter, not a second copy", () => {
    const options = routing()
    const route = resolveRoute('1.1', { agent: 'claude-code' }, options)
    expect(route.adapter).toBe(options.adapter)
  })

  it('refuses an agent the run cannot reach, naming what it can launch', () => {
    const options = routing({ agents: new Map([['codex', agent('codex')]]) })
    expect(() => resolveRoute('3.2', { agent: 'opencode' }, options)).toThrow(RouteError)
    expect(() => resolveRoute('3.2', { agent: 'opencode' }, options)).toThrow(
      /task 3\.2 routes to agent "opencode".*can launch claude-code, codex/,
    )
  })

  it("refuses a routed adapter that cannot run the run's policy", () => {
    const options = routing({
      policy: 'threshold',
      agents: new Map([['codex', agent('codex', { usage: false, nudge: false })]]),
    })
    expect(() => resolveRoute('3.2', { agent: 'codex' }, options)).toThrow(
      /task 3\.2 routes to codex, which cannot run this run's `threshold` policy: .*does not report usage and cannot nudge/,
    )
  })
})

describe('previewRoutes — the whole queue, before anything is recorded', () => {
  const queue = [
    { id: '1.1' },
    { id: '1.2', route: { agent: 'codex' } },
    { id: '1.3', route: { agent: 'codex' } },
  ]

  it("states a routed adapter's inert options ONCE, naming the tasks it reaches", () => {
    const lines = previewRoutes(
      queue,
      routing({
        agents: new Map([['codex', agent('codex', { permission_rules: false, cost: false })]]),
        surface: buildSurface({ allow: ['Bash(npm test:*)'] }),
        costCapUsd: 5,
      }),
    )
    expect(lines.filter((l) => l.includes('per-tool permission rules'))).toEqual([
      expect.stringContaining('task 1.2, 1.3 routed to codex:'),
    ])
    expect(lines.filter((l) => l.includes('--cost-cap can never fire'))).toHaveLength(1)
  })

  it("says nothing about the default adapter's own gaps — the driver already has (D9)", () => {
    const lines = previewRoutes([{ id: '1.1' }], routing({ costCapUsd: 5 }))
    expect(lines).toEqual([])
  })

  it('refuses on a task five sessions away, not when the loop reaches it', () => {
    expect(() =>
      previewRoutes([{ id: '1.1' }, { id: '1.2' }, { id: '1.3', route: { agent: 'opencode' } }], routing()),
    ).toThrow(/task 1\.3 routes to agent "opencode"/)
  })
})
