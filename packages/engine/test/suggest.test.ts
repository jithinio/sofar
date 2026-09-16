import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSuggest, runSuggestVerb } from '../src/cli/suggest'
import { makeEvent, type EventEnvelope, type MakeEventInput } from '../src/core/envelope'
import { appendEvent } from '../src/core/log'
import { foldLines } from '../src/core/fold'
import { candidateHash, deriveCandidates, MIN_EVIDENCE, TRUSTED_SIGNALS } from '../src/core/suggest'
import { detect, type TuneReport } from '../src/core/tune'
import { readSignalEnvironment, signalAvailability } from '../src/core/signals'
import { makeRepoFixture, type Fixture } from './helpers/mcp'

/**
 * Suggestions (self-improve 2.3): loss rows from TRUSTED detectors only, each
 * carrying the 2.2 measurement, approval bound to the exact candidate hash,
 * append-only rejection and reversal history, nothing applied.
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

function ev(fixture: Fixture, type: string, payload: Record<string, unknown>, session = 'cli'): EventEnvelope {
  const input: MakeEventInput = { initiative: fixture.slug, session, source: 'hook', actor: 'agent', type, payload }
  const event = makeEvent(input)
  appendEvent(fixture.eventsPath, event)
  return event
}

/** N corrections, the one signal the 2.2 protocol trusts. */
function corrections(fixture: Fixture, n: number): EventEnvelope[] {
  const out: EventEnvelope[] = []
  for (let i = 0; i < n; i++) {
    const target = ev(fixture, 'note_added', { text: `n${i}` }, 's1')
    out.push(ev(fixture, 'correction', { ref: target.id }, 's1'))
  }
  return out
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

function derived(fixture: Fixture): { candidate: string; count: number } {
  const json = JSON.parse(runSuggest(fixture.root, { dryRun: true, json: true }).stdout) as {
    suggestions: { candidate: string; derived: { count: number } }[]
  }
  const first = json.suggestions[0]!
  return { candidate: first.candidate, count: first.derived.count }
}

describe('what may become a suggestion', () => {
  it('derives a loss row from a trusted detector, carrying its 2.2 measurement and no cause', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const result = runSuggest(fixture.root, { dryRun: true })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('corrections in alpha: 3 instance(s)')
    expect(result.stdout).toContain('precision 97%, recall 53%')
    expect(result.stdout).toContain('protocol 01M2K5DXFHDV642E8008D5CGWN')
    expect(result.stdout).toContain('no cause is named, no change is proposed, nothing is written')
    // The row describes; it never prescribes.
    expect(result.stdout).not.toMatch(/fix|should|recommend/i)
  })

  it('only trusted signals emit: an untrusted detector with findings proposes nothing', () => {
    const fixture = fx()
    // Duplicate session starts are UNTRUSTED by the 2.2 verdicts (recall 3/31).
    ev(fixture, 'session_started', { tool: 'claude-code' }, 's1')
    ev(fixture, 'session_started', { tool: 'claude-code' }, 's1')
    ev(fixture, 'session_started', { tool: 'claude-code' }, 's1')
    const report = JSON.parse(runSuggest(fixture.root, { dryRun: true, json: true }).stdout) as { suggestions: unknown[] }
    expect(report.suggestions).toEqual([])
    expect(Object.keys(TRUSTED_SIGNALS)).toEqual(['corrections'])
  })

  it('needs MIN_EVIDENCE instances: one correction is ordinary work', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE - 1)
    expect(runSuggest(fixture.root, { dryRun: true }).stdout).toContain('no candidate')
    corrections(fixture, 1)
    expect(runSuggest(fixture.root, { dryRun: true }).stdout).toContain('3 instance(s)')
  })

  it('a detector the corpus gate left UNKNOWN proposes nothing', () => {
    const fixture = fx()
    // formatter_friction is not trusted anyway; prove the gate composes: with
    // no file_touched in the corpus the detector is UNKNOWN, so even if it
    // were trusted it could not emit.
    const report = detect({
      events: new Map(),
      rows: [],
      signals: signalAvailability(readSignalEnvironment(fixture.root)),
    }) as TuneReport
    expect(deriveCandidates(report)).toEqual([])
  })

  it('the hash covers the evidence, not the cutoff: new evidence is a new candidate', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const first = derived(fixture)
    // An unrelated event moves the cutoff but not the evidence.
    ev(fixture, 'note_added', { text: 'unrelated' }, 's1')
    expect(derived(fixture).candidate).toBe(first.candidate)
    corrections(fixture, 1)
    const second = derived(fixture)
    expect(second.candidate).not.toBe(first.candidate)
    expect(second.count).toBe(4)
    expect(candidateHash('corrections', 'alpha', ['b', 'a'])).toBe(candidateHash('corrections', 'alpha', ['a', 'b']))
  })
})

describe('the lifecycle', () => {
  it('--dry-run and --list write nothing; record/approve are explicit verbs that each append one event', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const before = snapshot(join(fixture.root, '.sofar'))
    runSuggest(fixture.root, { dryRun: true })
    runSuggest(fixture.root, { list: true })
    expect(snapshot(join(fixture.root, '.sofar'))).toBe(before)
    expect(runSuggest(fixture.root, {}).exitCode).toBe(1)
    expect(runSuggest(fixture.root, {}).stderr).toContain('requires `--dry-run`')

    const { candidate } = derived(fixture)
    const recorded = runSuggestVerb(fixture.root, 'record', candidate)
    expect(recorded.exitCode).toBe(0)
    expect(recorded.stdout).toContain('a loss row, not a fix')
    const lines = readFileSync(fixture.eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as EventEnvelope)
    const proposed = lines.filter((e) => e.type === 'suggestion_proposed')
    expect(proposed).toHaveLength(1)
    expect((proposed[0]!.payload as { trust: { precision: number } }).trust.precision).toBe(0.97)
    expect((proposed[0]!.payload as { evidence: string[] }).evidence).toHaveLength(MIN_EVIDENCE * 2)

    expect(runSuggestVerb(fixture.root, 'approve', candidate).exitCode).toBe(0)
    expect(runSuggest(fixture.root, { list: true }).stdout).toContain('[approved]')
  })

  it('approval binds to the exact candidate: once the evidence moves it is refused, naming its replacement', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const { candidate } = derived(fixture)
    expect(runSuggestVerb(fixture.root, 'record', candidate).exitCode).toBe(0)
    corrections(fixture, 1)
    const refused = runSuggestVerb(fixture.root, 'approve', candidate)
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('is stale')
    expect(refused.stderr).toContain(derived(fixture).candidate)
    // The stale row keeps its place in the history rather than vanishing.
    const listed = runSuggest(fixture.root, { list: true }).stdout
    expect(listed).toContain(`${candidate} [recorded, stale]`)
    expect(listed).toContain('replaced by:')
  })

  it('a rejected row stays suppressed until its evidence changes, and the rejection keeps its reason', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const { candidate } = derived(fixture)
    runSuggestVerb(fixture.root, 'record', candidate)
    expect(runSuggestVerb(fixture.root, 'reject', candidate).exitCode).toBe(1)
    expect(runSuggestVerb(fixture.root, 'reject', candidate).stderr).toContain('--reason is required')
    const rejected = runSuggestVerb(fixture.root, 'reject', candidate, { reason: 'known, already fixed upstream' })
    expect(rejected.exitCode).toBe(0)
    expect(rejected.stdout).toMatch(new RegExp(`^rejected ${candidate} — corrections in alpha`))
    const again = runSuggestVerb(fixture.root, 'record', candidate)
    expect(again.exitCode).toBe(1)
    expect(again.stderr).toContain('evidence has not changed')
    expect(runSuggest(fixture.root, { list: true }).stdout).toContain('known, already fixed upstream')
    // A new instance mints a new candidate, which is proposable again.
    corrections(fixture, 1)
    expect(runSuggestVerb(fixture.root, 'record', derived(fixture).candidate).exitCode).toBe(0)
  })

  it('revert ends an approval with a new event and erases nothing — stale or not', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const { candidate } = derived(fixture)
    runSuggestVerb(fixture.root, 'record', candidate)
    expect(runSuggestVerb(fixture.root, 'revert', candidate, { reason: 'too early' }).exitCode).toBe(1)
    runSuggestVerb(fixture.root, 'approve', candidate)
    corrections(fixture, 1) // the approved row is now stale
    const reverted = runSuggestVerb(fixture.root, 'revert', candidate, { reason: 'fix did not hold' })
    expect(reverted.exitCode).toBe(0)
    expect(reverted.stderr).toContain('stale')
    const listed = runSuggest(fixture.root, { list: true }).stdout
    expect(listed).toContain('approved ')
    expect(listed).toContain('reverted ')
    expect(listed).toContain('fix did not hold')
    const types = readFileSync(fixture.eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as EventEnvelope).type)
      .filter((t) => t.startsWith('suggestion_'))
    expect(types).toEqual(['suggestion_proposed', 'suggestion_approved', 'suggestion_reverted'])
  })

  it('an unknown candidate, and a verb before record, are refused with what to do instead', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const unknown = runSuggestVerb(fixture.root, 'approve', 'deadbeefdeadbeef')
    expect(unknown.exitCode).toBe(1)
    expect(unknown.stderr).toContain('sofar suggest --dry-run')
    const { candidate } = derived(fixture)
    const early = runSuggestVerb(fixture.root, 'approve', candidate)
    expect(early.exitCode).toBe(1)
    expect(early.stderr).toContain(`suggest record ${candidate}`)
  })

  it('scopes to one initiative by default and spans the repo with --all', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const other = join(fixture.root, '.sofar', 'initiatives', 'beta')
    mkdirSync(other, { recursive: true })
    for (let i = 0; i < MIN_EVIDENCE; i++) {
      const target = makeEvent({ initiative: 'beta', session: 's9', source: 'hook', actor: 'agent', type: 'note_added', payload: { text: 'x' } })
      appendEvent(join(other, 'events.jsonl'), target)
      appendEvent(
        join(other, 'events.jsonl'),
        makeEvent({ initiative: 'beta', session: 's9', source: 'hook', actor: 'agent', type: 'correction', payload: { ref: target.id } }),
      )
    }
    type Row = { scope: string; candidate: string }
    const one = JSON.parse(runSuggest(fixture.root, { dryRun: true, json: true }).stdout) as { suggestions: Row[] }
    expect(one.suggestions.map((s) => s.scope)).toEqual(['alpha'])
    const all = JSON.parse(runSuggest(fixture.root, { dryRun: true, all: true, json: true }).stdout) as { suggestions: Row[] }
    expect(all.suggestions.map((s) => s.scope)).toEqual(['alpha', 'beta'])
    // A verb finds its candidate by hash and writes to that candidate's own record.
    const betaCandidate = all.suggestions.find((s) => s.scope === 'beta')!
    expect(runSuggestVerb(fixture.root, 'record', betaCandidate.candidate).stdout).toContain('in beta')
    expect(readFileSync(join(other, 'events.jsonl'), 'utf8')).toContain('suggestion_proposed')
  })
})

describe('through the built CLI', () => {
  // The handler tests above call runSuggest directly; this one proves the
  // commander wiring spells the surface the 2.3 contract names — reading is
  // the bare command, and every writing path is a VERB under it.
  const here = fileURLToPath(new URL('.', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'sofar-suggest-cli-'))
  const bundle = join(scratch, 'cli.mjs')
  roots.push(scratch)

  beforeAll(() => {
    buildSync({
      entryPoints: [join(here, '..', 'src', 'cli', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      outfile: bundle,
      banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
      loader: { '.sh': 'text' },
    })
  })

  const cli = (root: string, args: string[]): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [bundle, ...args, '--root', root], { encoding: 'utf8', timeout: 30_000 })

  it('reads with `suggest --dry-run` and writes only through `suggest record|approve`', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    const read = cli(fixture.root, ['suggest', '--dry-run'])
    expect(read.status).toBe(0)
    const candidate = /^([0-9a-f]{16}) \[open\]/m.exec(read.stdout)?.[1]
    expect(candidate).toBeDefined()

    expect(cli(fixture.root, ['suggest']).status).toBe(1)
    expect(cli(fixture.root, ['suggest', 'approve', candidate!]).status).toBe(1)
    const rec = cli(fixture.root, ['suggest', 'record', candidate!])
    expect(`${rec.stdout}${rec.stderr}`).toContain('a loss row, not a fix')
    expect(rec.status).toBe(0)
    expect(cli(fixture.root, ['suggest', 'approve', candidate!]).status).toBe(0)
    expect(cli(fixture.root, ['suggest', 'revert', candidate!]).stderr).toContain('--reason is required')
    expect(cli(fixture.root, ['suggest', '--list']).stdout).toContain('[approved]')
  })
})

describe('the protected floor', () => {
  it('the whole lifecycle leaves the next action fresh — the drift class decided in fold.ts (commit-attribution D18)', () => {
    const fixture = fx()
    corrections(fixture, MIN_EVIDENCE)
    ev(fixture, 'session_ended', { summary: 's', next_action: 'n' }, 's1')
    const fold = (): ReturnType<typeof foldLines>['state'] =>
      foldLines(readFileSync(fixture.eventsPath, 'utf8').trim().split('\n'), fixture.slug).state
    const settled = fold().freshness
    const { candidate } = derived(fixture)
    runSuggestVerb(fixture.root, 'record', candidate)
    runSuggestVerb(fixture.root, 'approve', candidate)
    runSuggestVerb(fixture.root, 'revert', candidate, { reason: 'not yet' })
    const after = fold().freshness
    // Asking for suggestions, and settling them, cannot stale a next_action
    // they never touched: Phase 3 turns an approved row into tasks, and THOSE
    // events are the drift.
    expect(after.events_since_writeback).toEqual(settled.events_since_writeback)
    expect(after.unattributed_mutations).toBe(settled.unattributed_mutations)
  })
})
