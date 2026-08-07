import { describe, expect, it } from 'vitest'
import {
  GUARD_MAX_LENGTH,
  GUARD_MAX_PATTERNS,
  guardMatches,
  guardSpecErrors,
  isValidGuard,
  parseGuard,
  validatePayload,
} from '../src/events'

/**
 * Decision guards (drift-hardening D3, task 5.3) — the grammar half.
 * Engine-side evaluation and the warn-never-block surfaces live in
 * packages/engine/test/decision-guards.test.ts.
 */

/** Compile and match in one step; a malformed spec fails the test loudly. */
function fires(spec: string, subject: string): boolean {
  const guard = parseGuard(spec)
  if (guard === null) throw new Error(`spec did not compile: ${spec}`)
  return guardMatches(guard, subject)
}

describe('guard grammar', () => {
  it('accepts the two domains and rejects anything else', () => {
    expect(isValidGuard('path:src/**')).toBe(true)
    expect(isValidGuard('cmd:*npm publish*')).toBe(true)
    expect(guardSpecErrors('src/**').join('; ')).toMatch(/domain/)
    expect(guardSpecErrors('glob:src/**').join('; ')).toMatch(/unknown domain "glob"/)
    expect(guardSpecErrors('').join('; ')).toMatch(/non-empty/)
    expect(guardSpecErrors(42).join('; ')).toMatch(/non-empty/)
  })

  it('rejects empty patterns and bounds size', () => {
    expect(guardSpecErrors('path:a,,b').join('; ')).toMatch(/empty pattern/)
    expect(guardSpecErrors(`path:${'a'.repeat(GUARD_MAX_LENGTH)}`).join('; ')).toMatch(/at most/)
    const many = Array.from({ length: GUARD_MAX_PATTERNS + 1 }, (_, i) => `a${i}`).join(',')
    expect(guardSpecErrors(`path:${many}`).join('; ')).toMatch(/at most \d+ patterns/)
  })

  it('rejects an all-exemption guard — one that can never fire reads as compliance', () => {
    expect(guardSpecErrors('path:!src/**').join('; ')).toMatch(/at least one pattern/)
    expect(parseGuard('path:!src/**')).toBeNull()
  })
})

describe('path domain — anchored at a segment boundary, so absolute logs match', () => {
  it('matches the tail of the ABSOLUTE path a hook logs', () => {
    expect(fires('path:packages/schema/**', '/Users/x/repo/packages/schema/src/events.ts')).toBe(true)
    expect(fires('path:packages/schema/**', 'packages/schema/src/events.ts')).toBe(true)
    expect(fires('path:packages/schema/**', '/Users/x/repo/packages/engine/src/events.ts')).toBe(false)
  })

  it('does not match a partial segment', () => {
    expect(fires('path:src/**', '/repo/mysrc/a.ts')).toBe(false)
    expect(fires('path:src/**', '/repo/src/a.ts')).toBe(true)
  })

  it('* stops at a separator; ** crosses it and may match zero directories', () => {
    expect(fires('path:src/*.ts', '/repo/src/a.ts')).toBe(true)
    expect(fires('path:src/*.ts', '/repo/src/nested/a.ts')).toBe(false)
    expect(fires('path:src/**/*.ts', '/repo/src/nested/deep/a.ts')).toBe(true)
    expect(fires('path:**/*.ts', '/a.ts')).toBe(true)
  })

  it('anchors the right-hand end — .ts does not match .tsx', () => {
    expect(fires('path:**/*.ts', '/repo/src/a.tsx')).toBe(false)
  })

  it('reads a trailing slash as the directory form', () => {
    expect(fires('path:.sofar/', '/repo/.sofar/initiatives/x/plan.md')).toBe(true)
  })

  it('? matches exactly one non-separator character', () => {
    expect(fires('path:src/a?.ts', '/repo/src/ab.ts')).toBe(true)
    expect(fires('path:src/a?.ts', '/repo/src/abc.ts')).toBe(false)
    expect(fires('path:src/a?.ts', '/repo/src/a/.ts')).toBe(false)
  })

  it('exemptions win over positives', () => {
    const spec = 'path:**/*.ts,!packages/schema/src/**'
    expect(fires(spec, '/repo/packages/engine/src/fold.ts')).toBe(true)
    expect(fires(spec, '/repo/packages/schema/src/events.ts')).toBe(false)
  })
})

describe('cmd domain — substring, because a guard that never fires reads as compliance', () => {
  it('matches anywhere in the command', () => {
    expect(fires('cmd:npm publish', 'npm publish -w sofar.sh --otp 123')).toBe(true)
    expect(fires('cmd:npm publish', 'npm test')).toBe(false)
  })

  it('* crosses separators freely — a command is not a path', () => {
    expect(fires('cmd:git*--force', 'git push origin main --force')).toBe(true)
  })

  it('exempts the safe variant', () => {
    const spec = 'cmd:npm publish,!--dry-run'
    expect(fires(spec, 'npm publish -w sofar.sh')).toBe(true)
    expect(fires(spec, 'npm publish -w sofar.sh --dry-run')).toBe(false)
  })

  it('treats regex metacharacters as literals', () => {
    expect(fires('cmd:rm -rf .', 'rm -rf .')).toBe(true)
    expect(fires('cmd:rm -rf .', 'rm -rf x')).toBe(false)
  })
})

describe('decision_logged payload (D3)', () => {
  const base = { chose: 'a', over: 'b', because: 'c' }

  it('accepts a guard alongside a rule', () => {
    expect(
      validatePayload('decision_logged', {
        ...base,
        rule: 'Never hand-edit a generated projection.',
        guard: 'path:.sofar/**/*.md',
      }),
    ).toEqual({ ok: true })
  })

  it('rejects a guard with no rule — a guard with no clause has nothing to cite', () => {
    const result = validatePayload('decision_logged', { ...base, guard: 'path:src/**' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('; ')).toMatch(/guard: requires `rule`/)
  })

  it('rejects a malformed guard', () => {
    const result = validatePayload('decision_logged', { ...base, rule: 'r', guard: 'nope:src/**' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('; ')).toMatch(/unknown domain/)
  })
})
