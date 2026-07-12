import { execFileSync } from 'node:child_process'

/**
 * Author identity for the envelope's optional `user` field (team-readiness
 * T1): `git config user.email`, resolved via the git binary so the full
 * config precedence (env overrides > local > global > system) is git's own.
 * Cached per process — the MCP server and hook shims must not pay a spawn
 * per append. Identity is best-effort by contract: no git, no repo, no
 * configured email → undefined, and the caller omits the field. An append
 * must NEVER fail because identity is unavailable.
 */

let cache: { value: string | undefined } | null = null

export function gitUserEmail(): string | undefined {
  if (cache !== null) return cache.value
  let value: string | undefined
  try {
    const out = execFileSync('git', ['config', 'user.email'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim()
    value = out.length > 0 ? out : undefined
  } catch {
    value = undefined
  }
  cache = { value }
  return value
}

/** Test seam: tests flip git config via GIT_CONFIG_* env, then reset here. */
export function resetGitUserEmailCache(): void {
  cache = null
}
