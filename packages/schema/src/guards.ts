/**
 * Decision guards (drift-hardening D3) — the MECHANICAL tier of a standing
 * constraint.
 *
 * A `rule` states the law in prose; a `guard` is the half of that same law a
 * machine can check. It lives on the same event as the rule it enforces
 * (never a side file, which drifts from the clause it claims to guard), and
 * it only ever WARNS: a guard violation must never change an exit code.
 *
 * Grammar — one line, no dependencies:
 *
 *   guard := "path:" patterns | "cmd:" patterns
 *   patterns := pattern ("," pattern)*
 *   pattern := "!"? glob            (a leading "!" EXEMPTS)
 *
 * A guard fires when at least one positive pattern matches the subject and no
 * exemption does. The two domains match different things, and anchor
 * differently because their subjects are shaped differently:
 *
 *   path: — matched against a file_touched path, anchored at a `/` boundary on
 *           the left and at end-of-string on the right. Hooks log ABSOLUTE
 *           paths, so segment-tail matching is what makes `packages/schema/**`
 *           mean the same thing on every machine that ever reads the log.
 *   cmd:  — matched against a command_run command as a SUBSTRING. `cmd:npm
 *           publish` silently never firing would be a guard that reads as
 *           compliance, which is worse than no guard at all.
 *
 * Glob vocabulary: `*` (a run of characters, not crossing `/` in the path
 * domain), `**` (crosses `/`, and as a leading segment matches zero
 * directories too, so a doubled star before a slash still matches a
 * root-level file), `?` (one
 * character). Everything else is literal. Deliberately NOT regex: these
 * patterns are agent-authored and compiled inside a 100ms hook budget, so
 * they must be safe to compile and cheap to run, and every ambiguity has to
 * resolve toward a non-match.
 */

export const GUARD_DOMAINS = ['path', 'cmd'] as const
export type GuardDomain = (typeof GUARD_DOMAINS)[number]

/** Spec length ceiling — a guard is one clause, not a policy file. */
export const GUARD_MAX_LENGTH = 400
/** Pattern-count ceiling, for the same reason. */
export const GUARD_MAX_PATTERNS = 12

export interface GuardPattern {
  /** A leading `!` — this pattern exempts rather than fires. */
  negated: boolean
  /** The glob as written, kept for error text and tests. */
  source: string
  re: RegExp
}

export interface CompiledGuard {
  domain: GuardDomain
  patterns: GuardPattern[]
}

function isGuardDomain(v: string): v is GuardDomain {
  return (GUARD_DOMAINS as readonly string[]).includes(v)
}

/** Escape one character for literal use inside a RegExp. */
function escapeChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
}

/**
 * Glob → regex body (no anchors — the caller adds those, because the two
 * domains anchor differently). Only the three wildcard forms are recognised;
 * every other character is literal.
 */
function globBody(glob: string, domain: GuardDomain): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        // A doubled star before a slash matches zero or more leading
        // directories, so it still matches a root-level file — the standard
        // glob reading.
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += domain === 'path' ? '[^/]*' : '.*'
      }
    } else if (ch === '?') {
      out += domain === 'path' ? '[^/]' : '.'
    } else {
      out += escapeChar(ch)
    }
  }
  return out
}

function compilePattern(glob: string, domain: GuardDomain): RegExp {
  // A trailing `/` is the directory form people write by habit; treat it as
  // `/**` so `path:packages/schema/` is not a guard that can never fire.
  const normalized = domain === 'path' && glob.endsWith('/') ? `${glob}**` : glob
  const body = globBody(normalized, domain)
  return domain === 'path' ? new RegExp(`(?:^|/)${body}$`) : new RegExp(body)
}

/**
 * Everything wrong with a guard spec, in one pass — the single grammar
 * definition, shared by payload validation and by the compiler below so a
 * guard that validates can always be compiled.
 */
export function guardSpecErrors(spec: unknown): string[] {
  if (typeof spec !== 'string' || spec.length === 0) {
    return ['guard: must be a non-empty string']
  }
  if (spec.length > GUARD_MAX_LENGTH) {
    return [`guard: must be at most ${GUARD_MAX_LENGTH} characters`]
  }
  const colon = spec.indexOf(':')
  if (colon === -1) {
    return [`guard: must start with a domain — ${GUARD_DOMAINS.map((d) => `"${d}:"`).join(' or ')}`]
  }
  const domain = spec.slice(0, colon)
  if (!isGuardDomain(domain)) {
    return [`guard: unknown domain "${domain}" — must be ${GUARD_DOMAINS.join(' or ')}`]
  }

  const errors: string[] = []
  const raw = spec.slice(colon + 1).split(',')
  if (raw.length > GUARD_MAX_PATTERNS) {
    errors.push(`guard: at most ${GUARD_MAX_PATTERNS} patterns`)
  }
  let positives = 0
  for (const entry of raw) {
    const trimmed = entry.trim()
    const glob = trimmed.startsWith('!') ? trimmed.slice(1).trim() : trimmed
    if (glob.length === 0) {
      errors.push('guard: empty pattern')
      continue
    }
    if (!trimmed.startsWith('!')) positives++
  }
  // An all-exemption guard can never fire, which is indistinguishable from
  // compliance — the exact failure mode this tier exists to remove.
  if (positives === 0 && !errors.includes('guard: empty pattern')) {
    errors.push('guard: needs at least one pattern that is not an exemption (`!`)')
  }
  return errors
}

/** True iff `spec` is a well-formed guard. */
export function isValidGuard(spec: unknown): spec is string {
  return guardSpecErrors(spec).length === 0
}

/** Compile a guard spec; null when it is malformed (never throws). */
export function parseGuard(spec: string): CompiledGuard | null {
  if (guardSpecErrors(spec).length > 0) return null
  const colon = spec.indexOf(':')
  const domain = spec.slice(0, colon) as GuardDomain
  const patterns: GuardPattern[] = []
  for (const entry of spec.slice(colon + 1).split(',')) {
    const trimmed = entry.trim()
    const negated = trimmed.startsWith('!')
    const glob = negated ? trimmed.slice(1).trim() : trimmed
    try {
      patterns.push({ negated, source: glob, re: compilePattern(glob, domain) })
    } catch {
      return null // a pattern that will not compile invalidates the whole guard
    }
  }
  return { domain, patterns }
}

/**
 * Does this subject violate the guard? At least one positive pattern matches
 * and no exemption does — exemptions win, which is what lets a guard say
 * "any TypeScript file EXCEPT the ones under packages/schema/src".
 */
export function guardMatches(guard: CompiledGuard, subject: string): boolean {
  let hit = false
  for (const pattern of guard.patterns) {
    if (!pattern.re.test(subject)) continue
    if (pattern.negated) return false
    hit = true
  }
  return hit
}

/** The event type a guard domain watches. */
export function guardEventType(domain: GuardDomain): 'file_touched' | 'command_run' {
  return domain === 'path' ? 'file_touched' : 'command_run'
}
