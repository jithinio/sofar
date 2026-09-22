import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { schemaFingerprint, validatePayload } from '@sofar/schema'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { foldLines, standingRules, type InitiativeState } from '../src/core/fold'
import { refreshGuards, refreshLabels } from '../src/core/index-tier1'
import { serializeEvent } from '../src/core/log'
import { createToolContext, ToolError } from '../src/mcp/context'
import { endSession } from '../src/mcp/end-session'
import { logDecision } from '../src/mcp/log-decision'
import { remember } from '../src/mcp/remember'
import { startSession } from '../src/mcp/start-session'
import { makeRepoFixture } from './helpers/mcp'

/**
 * memory-lead 2.8 (D12) — supersession that survives a merge.
 *
 * `D<n>` is a position in id order. Two branches that both log decisions
 * renumber each other when `merge=union` joins their logs, so a `supersedes`
 * written on one branch used to retire whatever the other branch put at that
 * position. In the memory-lead 4.1 repro (handoff-bench MOAT.md, precondition
 * P0) a teammate's standing rule vanished and the intended target stayed in
 * force beside its replacement. The writer now stamps the target's event id
 * (`supersedes_id`) and the fold resolves by it.
 */

const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function ev(type: string, payload: Record<string, unknown>, overrides: Partial<Omit<MakeEventInput, 'type' | 'payload'>> = {}): EventEnvelope {
  return makeEvent({ initiative: 'demo', session: 'sess-1', source: 'claude-code', actor: 'agent', type, payload, ...overrides })
}

/** Ids that sort as written, one second apart (the fold applies in id order). */
function stamped(events: EventEnvelope[]): EventEnvelope[] {
  return events.map((e, i) => ({
    ...e,
    id: `0000000000${String(i + 1).padStart(16, '0')}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)).toISOString(),
  }))
}

const fold = (events: EventEnvelope[]): InitiativeState => foldLines(events.map(serializeEvent), 'demo').state

const rule = (text: string, extra: Record<string, unknown> = {}) =>
  ev('decision_logged', { chose: text, over: `not ${text}`, because: 'the operator said so', rule: text, ...extra })

/**
 * The merged log, in id order: teammate B's refund rule landed first (B's D1),
 * then A's calendar-year rule (A's D1) and A's replacement for it, written on
 * A's branch as `supersedes: "D1"`. After the merge B's rule is D1 and A's
 * target is D2.
 */
function merged(stampId: boolean): EventEnvelope[] {
  const [created, refund, calendar] = stamped([
    ev('initiative_created', { slug: 'demo', goal: 'g' }),
    rule('Pro-rate refunds to the day.'),
    rule('Number invoices per calendar year.'),
  ])
  const [, , , entity] = stamped([
    created!,
    refund!,
    calendar!,
    rule('Number invoices per tax entity per year.', { supersedes: 'D1', ...(stampId ? { supersedes_id: calendar!.id } : {}) }),
  ])
  return [created!, refund!, calendar!, entity!]
}

describe('payload (memory-lead 2.8, D12)', () => {
  const base = { chose: 'c', over: 'o', because: 'b' }
  it('supersedes_id rides beside supersedes, never alone or empty', () => {
    expect(validatePayload('decision_logged', { ...base, supersedes: 'D1', supersedes_id: '01M34QG1Z7TJ39XCZX079SZQDS' }).ok).toBe(true)
    expect(validatePayload('decision_logged', { ...base, supersedes_id: '01M34QG1Z7TJ39XCZX079SZQDS' }).ok).toBe(false)
    expect(validatePayload('decision_logged', { ...base, supersedes: 'D1', supersedes_id: '' }).ok).toBe(false)
    expect(validatePayload('memory_promoted', { text: 't', supersedes: 'demo M1', supersedes_id: 'x' }).ok).toBe(true)
    expect(validatePayload('memory_promoted', { text: 't', supersedes_id: 'x' }).ok).toBe(false)
  })
  it('the schema fingerprint names it, so a second implementation must too', () => {
    expect(schemaFingerprint()).toMatch(/decision_logged: .*supersedes_id\?/)
    expect(schemaFingerprint()).toMatch(/memory_promoted: .*supersedes_id\?/)
  })
})

describe('fold', () => {
  it('a stamped supersession retires the decision it named, whatever a merge renumbered', () => {
    const d = fold(merged(true)).decisions
    expect(d[0]!.superseded_by).toBeUndefined() // B's refund rule stays in force
    expect(d[1]!.superseded_by).toBe(3) // A's calendar-year rule is the one replaced
    expect(d[2]!.supersedes).toBe('D2') // state names the decision actually replaced
    expect(standingRules(d).map((r) => r.rule)).toEqual(['Pro-rate refunds to the day.', 'Number invoices per tax entity per year.'])
  })
  it('an unstamped (pre-2.8) payload still resolves by the ordinal, which is what the merge moved', () => {
    const d = fold(merged(false)).decisions
    expect(d[0]!.superseded_by).toBe(3)
    expect(d[1]!.superseded_by).toBeUndefined()
    expect(d[2]!.supersedes).toBe('D1')
  })
  it('an id that names nothing folded is inert — never the ordinal', () => {
    const events = merged(true)
    const entity = { ...events[3]!, payload: { ...events[3]!.payload, supersedes_id: '0000000000ZZZZZZZZZZZZZZZZ' } }
    const d = fold([...events.slice(0, 3), entity]).decisions
    expect(d.map((x) => x.superseded_by)).toEqual([undefined, undefined, undefined])
    expect(d[2]!.supersedes).toBe('D1') // unresolved: kept as recorded
  })
  it('a voided target leaves the superseder inert rather than retiring its neighbour', () => {
    const events = merged(true)
    const [voiding] = stamped([...events, ev('correction', { ref: events[2]!.id, reason: 'retracted' })]).slice(-1)
    const d = fold([...events, voiding!]).decisions
    expect(d).toHaveLength(2)
    expect(d.map((x) => x.superseded_by)).toEqual([undefined, undefined])
  })
  it('folds to the same state from shuffled lines', () => {
    const events = merged(true)
    const shuffled = [events[3]!, events[1]!, events[0]!, events[2]!]
    expect(fold(shuffled).decisions).toEqual(fold(events).decisions)
  })
  it('a stamped memory supersession retires the memory it named', () => {
    const [created, theirs, ours] = stamped([
      ev('initiative_created', { slug: 'demo', goal: 'g' }),
      ev('memory_promoted', { text: 'Release with npm publish -w sofar.sh' }),
      ev('memory_promoted', { text: 'Tests run from the repo root' }),
    ])
    const [, , , replacement] = stamped([
      created!,
      theirs!,
      ours!,
      ev('memory_promoted', { text: 'Tests run from the repo root, after npm ci', supersedes: 'demo M1', supersedes_id: ours!.id }),
    ])
    const m = fold([created!, theirs!, ours!, replacement!]).memories
    expect(m[0]!.superseded_by).toBeUndefined()
    expect(m[1]!.superseded_by).toBe('demo M3')
    expect(m[2]!.supersedes).toBe('demo M2')
    expect(m[2]!.supersedes_id).toBe(ours!.id)
  })
})

describe('the writer stamps it (ToolContext.appendAndProject)', () => {
  function context() {
    const fx = makeRepoFixture()
    roots.push(fx.root)
    const ctx = createToolContext(fx.root)
    ctx.appendAndProject('demo', 'initiative_created', { slug: 'demo', goal: 'g' })
    return { fx, ctx }
  }
  const lastPayload = (path: string): Record<string, unknown> => {
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    return (JSON.parse(lines[lines.length - 1]!) as EventEnvelope).payload
  }

  it('sofar_log_decision: the handle stays as typed and the target id is added', () => {
    const { fx, ctx } = context()
    const first = logDecision(ctx, { initiative: 'demo', chose: 'sqlite', over: 'postgres', because: 'local' })
    logDecision(ctx, { initiative: 'demo', chose: 'postgres after all', over: 'sqlite', because: 'a server', supersedes: 'D1' })
    expect(lastPayload(fx.eventsPath)).toMatchObject({ supersedes: 'D1', supersedes_id: first.event_id })
  })
  it('a handle that resolves to nothing is left unstamped', () => {
    const { fx, ctx } = context()
    logDecision(ctx, { initiative: 'demo', chose: 'a', over: 'b', because: 'c', supersedes: 'D4' })
    expect(lastPayload(fx.eventsPath)).not.toHaveProperty('supersedes_id')
  })
  it('a caller-supplied id must be the one the writer derives', () => {
    const { ctx } = context()
    const first = logDecision(ctx, { initiative: 'demo', chose: 'a', over: 'b', because: 'c' })
    const payload = { chose: 'd', over: 'a', because: 'e', supersedes: 'D1' }
    expect(() => ctx.appendAndProject('demo', 'decision_logged', { ...payload, supersedes_id: 'not-it' })).toThrow(ToolError)
    expect(ctx.appendAndProject('demo', 'decision_logged', { ...payload, supersedes_id: first.event_id }).payload.supersedes_id).toBe(first.event_id)
  })
  it('the batched write-back stamps a decision superseding one filed earlier in the same batch', () => {
    const { fx, ctx } = context()
    logDecision(ctx, { initiative: 'demo', chose: 'a', over: 'b', because: 'c' })
    const { session_id } = startSession(ctx, { tool: 'claude-code', initiative: 'demo' })
    endSession(ctx, {
      session_id,
      summary: 's',
      next_action: 'n',
      decisions: [
        { chose: 'monthly invoices', over: 'weekly invoices', because: 'finance' },
        { chose: 'weekly invoices', over: 'monthly invoices', because: 'the operator changed it', supersedes: 'D2' },
      ],
    })
    const events = readFileSync(fx.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as EventEnvelope)
    const decisions = events.filter((e) => e.type === 'decision_logged')
    expect(decisions).toHaveLength(3)
    expect(decisions[2]!.payload.supersedes_id).toBe(decisions[1]!.id)
  })
  it('sofar_remember stamps the memory it replaces', () => {
    const { fx, ctx } = context()
    const first = remember(ctx, { initiative: 'demo', text: 'Run tests from the root' })
    remember(ctx, { initiative: 'demo', text: 'Run tests from the root after npm ci', supersedes: 'M1' })
    expect(lastPayload(fx.eventsPath)).toMatchObject({ supersedes: 'demo M1', supersedes_id: first.event_id })
  })
})

describe('the decision-scope tier resolves it the same way', () => {
  it('guards.json and labels.json retire the stamped target, not its neighbour', () => {
    const fx = makeRepoFixture()
    roots.push(fx.root)
    writeFileSync(fx.eventsPath, `${merged(true).map(serializeEvent).join('\n')}\n`)
    const sofarDir = join(fx.root, '.sofar')
    const guards = refreshGuards(sofarDir)
    expect([...guards.retired]).toEqual(['demo D2'])
    expect(guards.scoped.find((d) => d.ordinal === 2)!.superseded_by).toBe(3)
    expect(guards.scoped.find((d) => d.ordinal === 1)!.superseded_by).toBeUndefined()
    expect(refreshLabels(sofarDir).map((d) => d.ordinal)).toEqual([1, 3])
  })
})

describe('end to end: two teammates, one merge (the MOAT.md P0 repro)', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  it('after merging both branches, both teammates’ rules stand and only the replaced one is retired', () => {
    const root = mkdtempSync(join(tmpdir(), 'sofar-merge-stable-'))
    roots.push(root)
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.email', 't@t')
    git(root, 'config', 'user.name', 't')
    writeFileSync(join(root, '.gitattributes'), '.sofar/**/events.jsonl merge=union\n')
    const ctx = createToolContext(root)
    ctx.appendAndProject('ledger', 'initiative_created', { slug: 'ledger', goal: 'g' }) // creates the record dir
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'base')

    const log = (text: string, extra: Record<string, unknown> = {}) =>
      logDecision(ctx, { initiative: 'ledger', chose: text, over: `not ${text}`, because: 'operator', rule: text, ...extra })

    git(root, 'checkout', '-qb', 'teammate-b')
    log('Pro-rate refunds to the day.')
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'b')

    git(root, 'checkout', '-q', 'main')
    git(root, 'checkout', '-qb', 'teammate-a')
    log('Number invoices per calendar year.')
    log('Number invoices per tax entity per year.', { supersedes: 'D1' })
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'a')

    git(root, 'checkout', '-q', 'main')
    git(root, 'merge', '-q', '--no-edit', 'teammate-b')
    try {
      git(root, 'merge', '-q', '--no-edit', 'teammate-a')
    } catch {
      // Only the rendered projections conflict; events.jsonl unions cleanly.
      for (const path of git(root, 'diff', '--name-only', '--diff-filter=U').trim().split('\n')) {
        expect(path).toMatch(/\.md$/)
        git(root, 'checkout', '--theirs', '--', path)
      }
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '--no-edit')
    }

    const state = createToolContext(root).foldState('ledger')
    expect(standingRules(state.decisions).map((r) => r.rule)).toEqual([
      'Pro-rate refunds to the day.',
      'Number invoices per tax entity per year.',
    ])
  })
})
