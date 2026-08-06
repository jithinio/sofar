/**
 * Which URLs the sync client is willing to trust (sync-client hardening).
 *
 * Two places need the same answer and had neither: the api_url the client
 * sends its credential to, and the verification_uri the login flow hands to
 * the operating system's URL opener. Both arrive from outside — api_url from
 * `.sofar/remote.json`, which is COMMITTED and therefore reviewable by anyone
 * who can open a PR, and verification_uri from whatever server api_url named.
 *
 * The rule is one line: https, or http only when it is talking to this
 * machine. That keeps `SOFAR_API_URL=http://localhost:8787` working for local
 * dev — the reason plain http was ever accepted — while refusing to put a
 * bearer token on the wire in clear, or to hand `open(1)` a string that is not
 * a web page at all.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  return LOOPBACK_HOSTNAMES.has(lower) || lower.endsWith('.localhost')
}

/**
 * A URL safe to send a credential to, and safe to open in a browser.
 *
 * Rejects every non-http(s) scheme, which is the part that matters for the
 * opener: `open(1)` on macOS launches applications and files, not just web
 * pages, so an unchecked `file://`, `javascript:` or bare path from a hostile
 * auth server is a local-code-execution primitive rather than a bad link.
 */
export function isSafeWebUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
}

/** isSafeWebUrl, or an Error naming the URL and the rule it broke. */
export function assertSafeWebUrl(raw: string, what: string): void {
  if (isSafeWebUrl(raw)) return
  throw new Error(
    `${what} must be an https URL (http is allowed only for localhost) — refusing "${raw}"`,
  )
}
