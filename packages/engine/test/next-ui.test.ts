import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runNext } from '../src/cli/next'
import { makeEvent, type EventEnvelope } from '../src/core/envelope'
import { serializeEvent } from '../src/core/log'
import { renderNextActions } from '../src/projections/templates/next'
import { listInitiatives } from '../src/core/listing'
import { stripAnsi } from '../src/cli/ui'
import { makeRepoFixture } from './helpers/mcp'

/**
 * Styled `sofar next` (cli-ui 2.6): capability-gated like list (2.3) —
 * color-off output byte-equals the plain renderer, the styled path keeps
 * the same content (stripAnsi parity) with law-conformant SGR only, and
 * the stale suffix / no-action / empty branches render per the design law.
 */

const PLAIN = { color: false, unicode: true, animate: false }
const STYLED = { color: true, unicode: true, animate: false }
const ASCII = { color: true, unicode: false, animate: false }

const SGR_ALLOWED = new Set([1, 2, 22, 31, 32, 33, 35, 36, 39])

function ev(initiative: string, type: string, payload: Record<string, unknown>): EventEnvelope {
  return makeEvent({
    initiative,
    session: 'sess-1',
    source: 'claude-code',
    actor: 'agent',
    type,
    payload,
  })
}

function writeInitiative(root: string, slug: string, events: EventEnvelope[]): void {
  const dir = join(root, '.sofar', 'initiatives', slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'events.jsonl'), events.map(serializeEvent).join('\n') + '\n')
}

/** Repo with one written-back initiative and one drifted one. */
function seededRepo(): string {
  const root = makeRepoFixture({ slug: 'fresh', bind: false }).root
  writeInitiative(root, 'fresh', [
    ev('fresh', 'initiative_created', { slug: 'fresh', goal: 'g' }),
    ev('fresh', 'plan_updated', {
      plan: {
      goal: 'g',
      phases: [
        {
          name: 'P',
          tasks: [
            { id: '1', title: 'a', status: 'done' },
            { id: '2', title: 'b', status: 'pending' },
          ],
        },
      ],
      },
    }),
    ev('fresh', 'session_started', { tool: 'claude-code' }),
    ev('fresh', 'session_ended', { summary: 's', next_action: 'ship the thing' }),
  ])
  writeInitiative(root, 'drifted', [
    ev('drifted', 'initiative_created', { slug: 'drifted', goal: 'g' }),
    ev('drifted', 'session_started', { tool: 'claude-code' }),
    ev('drifted', 'session_ended', { summary: 's', next_action: 'old plan' }),
    ev('drifted', 'command_run', { cmd: 'echo drift' }),
  ])
  return root
}

describe('runNext styled path (cli-ui 2.6)', () => {
  it('color-off output byte-equals the plain renderer', () => {
    const root = seededRepo()
    const r = runNext(root, PLAIN)
    expect(r.stdout).toBe(renderNextActions(listInitiatives(root)))
    expect(r.stdout).not.toMatch(/\x1b/)
    expect(r.exitCode).toBe(0)
  })

  it('styled output carries only semantic ANSI-16 SGR and same content', () => {
    const root = seededRepo()
    const plain = runNext(root, PLAIN)
    const styled = runNext(root, STYLED)
    expect(styled.stdout).toMatch(/\x1b\[/)
    for (const m of styled.stdout.matchAll(/\x1b\[([0-9;]*)m/g)) {
      for (const code of (m[1] ?? '').split(';').filter(Boolean)) {
        expect(SGR_ALLOWED.has(Number(code)), `SGR ${code} not in the law`).toBe(true)
      }
    }
    // content parity: same slugs, actions, stale counts — layout may differ
    // (gutter/header punctuation), so compare per-entry substance
    const flat = stripAnsi(styled.stdout)
    expect(flat).toContain('Sofar next actions (2)')
    expect(flat).toContain('fresh')
    expect(flat).toContain('ship the thing')
    expect(flat).toContain('old plan')
    expect(flat).toContain('may be stale (1 event since write-back)')
    // exit code styling-independent
    expect(styled.exitCode).toBe(plain.exitCode)
  })

  it('stale suffix renders warn-colored; fresh entry carries none', () => {
    const root = seededRepo()
    const styled = runNext(root, STYLED)
    expect(styled.stdout).toContain('\x1b[33m⚠ may be stale (1 event since write-back)\x1b[39m')
    const freshLine = styled.stdout.split('\n').find((l) => stripAnsi(l).includes('fresh'))
    expect(freshLine).toBeDefined()
    expect(freshLine).not.toContain('may be stale')
  })

  it('no next action recorded renders dim', () => {
    const root = makeRepoFixture({ slug: 'silent', bind: false }).root
    writeInitiative(root, 'silent', [
      ev('silent', 'initiative_created', { slug: 'silent', goal: 'g' }),
    ])
    const styled = runNext(root, STYLED)
    expect(styled.stdout).toContain('\x1b[2m(no next action recorded)\x1b[22m')
  })

  it('ASCII caps carry no unicode symbol glyphs', () => {
    const root = seededRepo()
    const out = runNext(root, ASCII).stdout
    expect(out).not.toContain('⚠')
    expect(out).not.toContain('▸')
    expect(out).toContain('!! may be stale')
  })

  it('hostile escapes in record prose degrade to plain characters', () => {
    const root = makeRepoFixture({ slug: 'hostile', bind: false }).root
    writeInitiative(root, 'hostile', [
      ev('hostile', 'initiative_created', { slug: 'hostile', goal: 'g' }),
      ev('hostile', 'session_started', { tool: 'claude-code' }),
      ev('hostile', 'session_ended', {
        summary: 's',
        next_action: 'run \x1b[41mred-bg\x1b[0m step',
      }),
    ])
    const styled = runNext(root, STYLED)
    for (const m of styled.stdout.matchAll(/\x1b\[([0-9;]*)m/g)) {
      for (const code of (m[1] ?? '').split(';').filter(Boolean)) {
        expect(SGR_ALLOWED.has(Number(code)), `hostile SGR ${code} leaked`).toBe(true)
      }
    }
    expect(stripAnsi(styled.stdout)).toContain('red-bg')
    // plain path passes record bytes through untouched (agent contract)
    expect(runNext(root, PLAIN).stdout).toContain('\x1b[41m')
  })

  it('empty repo renders the dim create hint', () => {
    const fixture = makeRepoFixture({ bind: false })
    rmSync(fixture.initiativeDir, { recursive: true, force: true })
    const styled = runNext(fixture.root, STYLED)
    expect(stripAnsi(styled.stdout)).toContain('create one with `sofar new <slug>`')
  })
})

describe('rebalanced layout (4.1/4.2)', () => {
  it('entries are two-part blocks with hanging indent and a blank line between', () => {
    const root = seededRepo()
    const flat = stripAnsi(runNext(root, STYLED, 80).stdout)
    const lines = flat.split('\n')
    const head = lines.findIndex((l) => l.includes('drifted'))
    expect(head).toBeGreaterThan(-1)
    expect(lines[head + 1]!.startsWith('    ')).toBe(true) // action indented
    const between = lines.findIndex((l, i) => i > head && l === '')
    expect(between).toBeGreaterThan(head) // blank separator exists
  })

  it('long actions wrap inside the indent instead of breaking the gutter', () => {
    const root = makeRepoFixture({ slug: 'wide', bind: false }).root
    writeInitiative(root, 'wide', [
      ev('wide', 'initiative_created', { slug: 'wide', goal: 'g' }),
      ev('wide', 'session_started', { tool: 'claude-code' }),
      ev('wide', 'session_ended', { summary: 's', next_action: 'word '.repeat(30).trim() }),
    ])
    const flat = stripAnsi(runNext(root, STYLED, 60).stdout)
    const body = flat.split('\n').filter((l) => l.startsWith('    word'))
    expect(body.length).toBeGreaterThan(1) // wrapped
    for (const l of body) expect(l.length).toBeLessThanOrEqual(60)
  })

  it('header carries the pie and task fraction', () => {
    const root = seededRepo()
    const flat = stripAnsi(runNext(root, STYLED, 80).stdout)
    expect(flat).toMatch(/◑ fresh \[unbound\]  1\/2/)
    // no-tasks entry renders no pie and no fraction
    expect(flat).toMatch(/ {2}drifted \[unbound\]$/m)
  })
})
