import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type JudgeProvider,
  type JudgeRequest,
  JudgeError,
  STATE_CHAR_CEILING,
  THRESHOLDS,
  abstain,
  confidenceOf,
  judge,
  normalize,
  noulConfidence,
  redactState,
} from '../src/core/judge'

/**
 * typed-judge 2.1 / 2.2 — the Judge seam (SPEC §Judge, §Acceptance criteria
 * "Judge seam").
 *
 * The seam's whole value is the ORDER: rules first with confidence 1, only
 * abstentions offered to a provider, provider failure leaving abstentions in
 * place. Every test here is one of those clauses, plus the two locks that keep
 * the seam honest — confidence recomputed from probabilities, and the module
 * unreachable from the hot path.
 */

const choiceQ = (decide?: JudgeRequest['questions'][string]['decide']) =>
  ({
    type: 'choice' as const,
    instructions: 'Which kind?',
    criteria: { a: 'first', b: 'second', none: 'neither' },
    decide,
  }) satisfies JudgeRequest['questions'][string]

const noulQ = (decide?: JudgeRequest['questions'][string]['decide']) =>
  ({ type: 'noul' as const, instructions: 'Is it?', decide }) satisfies JudgeRequest['questions'][string]

const scoreQ = () =>
  ({
    type: 'score' as const,
    instructions: 'How far?',
    criteria: ['not started', 'half', 'done'],
  }) satisfies JudgeRequest['questions'][string]

const fakeProvider = (impl: JudgeProvider['judge'], name = 'fake'): JudgeProvider => ({ name, judge: impl })

describe('validation refuses a caller bug before any provider runs', () => {
  it('rejects a bad id, a choice outside 2–255 keys, a score outside 2–10 levels, and an oversized state', async () => {
    await expect(judge({ state: 's', questions: { 'bad id': noulQ() } })).rejects.toMatchObject({ code: 'invalid_id' })
    await expect(
      judge({ state: 's', questions: { q: { type: 'choice', instructions: 'x', criteria: { only: null } } } }),
    ).rejects.toMatchObject({ code: 'invalid_question' })
    await expect(
      judge({ state: 's', questions: { q: { type: 'score', instructions: 'x', criteria: ['one'] } } }),
    ).rejects.toMatchObject({ code: 'invalid_question' })
    const huge = 'x'.repeat(STATE_CHAR_CEILING + 1)
    await expect(judge({ state: huge, questions: { q: noulQ() } })).rejects.toBeInstanceOf(JudgeError)
    await expect(judge({ state: 's', questions: {} })).rejects.toMatchObject({ code: 'invalid_question' })
  })

  it('never lets a provider see an invalid request', async () => {
    let called = false
    const provider = fakeProvider(async () => {
      called = true
      return { model: 'm', answers: {} }
    })
    await expect(judge({ state: 's', questions: { 'x y': noulQ() } }, { provider })).rejects.toBeInstanceOf(JudgeError)
    expect(called).toBe(false)
  })
})

describe('rules decide first, with confidence 1', () => {
  it('a decided noul snaps to 0 or 1 and is reported origin rule', async () => {
    const res = await judge({ state: 'yes', questions: { q: noulQ((s) => ({ type: 'noul', noul: s === 'yes' ? 0.7 : 0.3 })) } })
    expect(res.answers.q).toEqual({ type: 'noul', noul: 1, origin: 'rule' })
    expect(res.provider).toBe('deterministic')
  })

  it('a decided choice is a point mass on the argmax even when the rule gave a spread', async () => {
    const res = await judge({
      state: 's',
      questions: { q: choiceQ(() => ({ type: 'choice', choice: 'a', probabilities: { a: 0.5, b: 0.4, none: 0.1 }, confidence: 0.2 })) },
    })
    expect(res.answers.q).toEqual({
      type: 'choice',
      choice: 'a',
      probabilities: { a: 1, b: 0, none: 0 },
      confidence: 1,
      origin: 'rule',
    })
  })

  it('a rule returning null abstains: noul 0.5, uniform choice with the first key, uniform score at the midpoint', async () => {
    const res = await judge({
      state: 's',
      questions: { n: noulQ(() => null), c: choiceQ(() => null), s: scoreQ() },
    })
    expect(res.answers.n).toEqual({ type: 'noul', noul: 0.5, origin: 'abstain' })
    expect(res.answers.c).toMatchObject({ type: 'choice', choice: 'a', confidence: 0, origin: 'abstain' })
    expect(Object.values((res.answers.c as { probabilities: Record<string, number> }).probabilities)).toEqual([1 / 3, 1 / 3, 1 / 3])
    expect(res.answers.s).toMatchObject({ type: 'score', score: 1, confidence: 0, origin: 'abstain', legend: { '0': 'not started', '1': 'half', '2': 'done' } })
  })

  it('a rule that throws or answers the wrong shape abstains with a warning, never throws to the caller', async () => {
    const res = await judge({
      state: 's',
      questions: {
        t: noulQ(() => {
          throw new Error('boom')
        }),
        w: noulQ(() => ({ type: 'choice', choice: 'a', probabilities: { a: 1 }, confidence: 1 })),
      },
    })
    expect(res.answers.t).toMatchObject({ origin: 'abstain' })
    expect(res.answers.w).toMatchObject({ origin: 'abstain' })
    expect(res.warnings).toHaveLength(2)
  })

  it('is deterministic: the same request judged twice is deep-equal', async () => {
    const req = (): JudgeRequest => ({
      state: { items: ['x', 'y'] },
      questions: { a: noulQ((s) => ((s as { items: string[] }).items.includes('x') ? { type: 'noul', noul: 1 } : null)), b: choiceQ(), c: scoreQ() },
    })
    expect(await judge(req())).toEqual(await judge(req()))
  })
})

describe('only abstentions reach a provider, in one request, over redacted state', () => {
  it('forwards the open questions only, stripped of their rules, and marks answers origin model with the pinned version', async () => {
    const seen: unknown[] = []
    const provider = fakeProvider(async (r) => {
      seen.push(r)
      return {
        model: 'jev-1.13.0',
        answers: {
          open: { type: 'choice', choice: 'b', probabilities: { a: 0.1, b: 0.8, none: 0.1 }, confidence: 0.99 },
        },
        usage: { input_tokens: 12, output_tokens: 3 },
      }
    })
    const res = await judge(
      {
        state: { cmd: 'curl -H "Authorization: Bearer abc123" https://x', text: 'plain prose stays' },
        questions: { decided: noulQ(() => ({ type: 'noul', noul: 1 })), open: choiceQ() },
      },
      { provider },
    )
    expect(seen).toHaveLength(1)
    const wire = seen[0] as { state: { cmd: string; text: string }; questions: Record<string, unknown> }
    expect(Object.keys(wire.questions)).toEqual(['open'])
    expect('decide' in (wire.questions.open as object)).toBe(false)
    expect(wire.state.cmd).toContain('[redacted]')
    expect(wire.state.cmd).not.toContain('abc123')
    expect(wire.state.text).toBe('plain prose stays')
    expect(res.answers.decided).toMatchObject({ origin: 'rule' })
    expect(res.answers.open).toMatchObject({ origin: 'model', model: 'jev-1.13.0', choice: 'b' })
    expect(res.model).toBe('jev-1.13.0')
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 3 })
    expect(res.fell_back).toBeUndefined()
  })

  it('does not call the provider at all when every question was decided by a rule', async () => {
    let called = 0
    const provider = fakeProvider(async () => {
      called += 1
      return { model: 'm', answers: {} }
    })
    const res = await judge({ state: 's', questions: { q: noulQ(() => ({ type: 'noul', noul: 0 })) } }, { provider })
    expect(called).toBe(0)
    expect(res.provider).toBe('deterministic')
  })

  it('recomputes confidence from probabilities — the provider’s own number is ignored', async () => {
    const provider = fakeProvider(async () => ({
      model: 'm',
      answers: { q: { type: 'choice', choice: 'b', probabilities: { a: 0.2, b: 0.6, none: 0.2 }, confidence: 0.01 } },
    }))
    const res = await judge({ state: 's', questions: { q: choiceQ() } }, { provider })
    const a = res.answers.q as { confidence: number; choice: string }
    expect(a.confidence).toBeCloseTo((3 * 0.6 - 1) / 2, 10)
    expect(a.choice).toBe('b')
  })

  it('a provider that throws leaves every forwarded question abstained and names the reason', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('402 no plan')
    }, 'cloud')
    const res = await judge({ state: 's', questions: { q: choiceQ(), n: noulQ() } }, { provider })
    expect(res.answers.q).toMatchObject({ origin: 'abstain', confidence: 0 })
    expect(res.answers.n).toEqual({ type: 'noul', noul: 0.5, origin: 'abstain' })
    expect(res.fell_back).toBe('cloud: 402 no plan')
    expect(res.provider).toBe('cloud')
  })

  it('a provider that hangs is timed out, not waited on', async () => {
    const provider = fakeProvider(() => new Promise(() => {}), 'slow')
    const res = await judge({ state: 's', questions: { q: noulQ() } }, { provider, timeoutMs: 20 })
    expect(res.fell_back).toMatch(/timed out after 20ms/)
    expect(res.answers.q).toMatchObject({ origin: 'abstain' })
  })

  it('a malformed response or an unusable answer leaves that question abstained with a warning', async () => {
    const noModel = fakeProvider(async () => ({ model: '', answers: {} }))
    const r1 = await judge({ state: 's', questions: { q: noulQ() } }, { provider: noModel })
    expect(r1.fell_back).toMatch(/malformed/)

    const partial = fakeProvider(async () => ({
      model: 'm',
      answers: { q: { type: 'noul', noul: 'high' as unknown as number }, r: { type: 'noul', noul: 0.9 } },
    }))
    const r2 = await judge({ state: 's', questions: { q: noulQ(), r: noulQ() } }, { provider: partial })
    expect(r2.answers.q).toMatchObject({ origin: 'abstain' })
    expect(r2.answers.r).toMatchObject({ origin: 'model', noul: 0.9 })
    expect(r2.warnings.some((w) => w.startsWith('q:'))).toBe(true)
  })
})

describe('helpers', () => {
  it('confidenceOf is 0 for uniform and 1 for a point mass; noulConfidence is 0 at 0.5', () => {
    expect(confidenceOf({ a: 0.5, b: 0.5 })).toBe(0)
    expect(confidenceOf({ a: 1, b: 0, c: 0 })).toBe(1)
    expect(noulConfidence(0.5)).toBe(0)
    expect(noulConfidence(0.9)).toBeCloseTo(0.8, 10)
  })

  it('normalize projects onto the question keys, renormalizes and accepts a bare choice', () => {
    const q = { type: 'choice' as const, instructions: 'x', criteria: { a: null, b: null } }
    expect(normalize(q, { probabilities: { a: 2, b: 2, zzz: 9 } })).toMatchObject({ probabilities: { a: 0.5, b: 0.5 }, confidence: 0 })
    expect(normalize(q, { choice: 'b' })).toMatchObject({ choice: 'b', probabilities: { a: 0, b: 1 }, confidence: 1 })
    expect(normalize(q, { choice: 'nope' })).toBeNull()
    expect(normalize(q, { type: 'noul', noul: 1 })).toBeNull()
    const s = { type: 'score' as const, instructions: 'x', criteria: ['lo', 'hi'] }
    expect(normalize(s, { probabilities: { '0': 0.25, '1': 0.75 } })).toMatchObject({ score: 0.75, legend: { '0': 'lo', '1': 'hi' } })
  })

  it('abstain and redactState preserve shape; redaction reaches nested string leaves', () => {
    expect(abstain({ type: 'noul', instructions: 'x' })).toEqual({ type: 'noul', noul: 0.5 })
    const out = redactState({ a: ['TOKEN=abc', { b: 'export API_KEY=zzz' }], n: 1, ok: true }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toMatch(/abc|zzz/)
    expect(JSON.stringify(out)).toContain('[redacted]')
    expect(out.n).toBe(1)
    expect(out.ok).toBe(true)
  })

  it('thresholds are named for the model they were measured against', () => {
    expect(THRESHOLDS.measured_against).toBe('jev-1.13.0')
    expect(THRESHOLDS.relevance_carry).toBeGreaterThan(THRESHOLDS.relevance_drop)
  })
})

/**
 * typed-judge D1: never on the hot path. Walk every module under the
 * protected roots and follow their relative imports transitively; none may
 * reach core/judge.ts. Mirrors test/graph-hotpath.test.ts.
 */
describe('hot-path import pin (typed-judge D1)', () => {
  const SRC = resolve(fileURLToPath(new URL('../src', import.meta.url)))
  const JUDGE = join(SRC, 'core', 'judge.ts')
  const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.ts')) out.push(p)
    }
    return out
  }
  const resolveImport = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(from), spec)
    for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
      try {
        if (statSync(cand).isFile()) return cand
      } catch {
        // try the next spelling
      }
    }
    return null
  }
  const reaches = (start: string, target: string, seen = new Set<string>(), chain: string[] = []): string[] | null => {
    if (start === target) return [...chain, start]
    if (seen.has(start)) return null
    seen.add(start)
    const src = readFileSync(start, 'utf8')
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3]
      if (!spec) continue
      const next = resolveImport(start, spec)
      if (!next) continue
      const hit = reaches(next, target, seen, [...chain, start])
      if (hit) return hit
    }
    return null
  }

  const protectedFiles = [
    ...walk(join(SRC, 'hooks')),
    ...walk(join(SRC, 'projections')),
    join(SRC, 'core', 'fold.ts'),
    join(SRC, 'core', 'atomic.ts'),
    join(SRC, 'core', 'log.ts'),
    ...walk(join(SRC, 'cli')).filter((p) => /^(fast|statusline)/.test(basename(p))),
  ].filter((p) => p.endsWith('.ts'))

  it('no hook, projection, fold, append or fast/statusline module reaches core/judge.ts', () => {
    expect(protectedFiles.length).toBeGreaterThan(0)
    const offenders = protectedFiles
      .map((f) => reaches(f, JUDGE))
      .filter((c): c is string[] => c !== null)
      .map((c) => c.map((p) => relative(SRC, p)).join(' -> '))
    expect(offenders).toEqual([])
  })
})
