/**
 * Browser stand-in for identity.ts (see build.mjs browser-identity-stub).
 * Identity is best-effort by contract: no git binary in a browser, so the
 * envelope's optional `user` field is simply omitted. Same exports, same
 * signatures — only the resolution differs by platform.
 */

export function gitUserEmail(): string | undefined {
  return undefined
}

export function resetGitUserEmailCache(): void {}
