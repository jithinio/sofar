import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createToolContext } from '../src/mcp/context'
import { hostAllowed, originAllowed } from '../src/cli/serve'
import { isSafeWebUrl } from '../src/client/url'
import { redactCommand, REDACTED } from '../src/core/redact'
import { validateToolInput } from '../../schema/src/tool-inputs'

/**
 * security-hardening acceptance — the audit's findings, each pinned by the
 * behaviour that was wrong before it was fixed.
 *
 * These are regression tests in the strict sense: every one of them FAILED on
 * 0.19.0. They are written against the boundary that is actually load-bearing
 * (the validator, the resolver, the guard) rather than against a whole command,
 * so a refactor that moves the command around cannot quietly drop the check.
 */

const dirs: string[] = []
function freshRepo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `sofar-sec-${name}-`))
  dirs.push(root)
  mkdirSync(join(root, '.sofar', 'initiatives', 'real'), { recursive: true })
  return root
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1.1 — a slug becomes a path, so it must never be able to name one.
// ---------------------------------------------------------------------------

describe('slug containment', () => {
  const TRAVERSALS = [
    '../../../escape',
    '..',
    'a/b',
    '/etc',
    './real',
    'real/../../escape',
    'UPPER',
    'has space',
    'dot.dot',
  ]

  it('rejects every path-shaped initiative at the tool boundary', () => {
    for (const slug of TRAVERSALS) {
      const check = validateToolInput('sofar_add_note', { initiative: slug, text: 'x' })
      expect(check.ok, `expected "${slug}" to be rejected`).toBe(false)
    }
    expect(validateToolInput('sofar_add_note', { initiative: 'real-one', text: 'x' }).ok).toBe(true)
  })

  // The tool boundary is not the only way in: bindings.json is a committed
  // file and CLI flags pass slugs straight through, so the resolver refuses
  // independently of the schema.
  it('rejects a traversal reaching the resolver directly', () => {
    const root = freshRepo('resolve')
    const ctx = createToolContext(root)
    expect(() => ctx.resolveInitiative('../../../escape')).toThrow(/never a path/)
    expect(ctx.resolveInitiative('real')).toBe('real')
  })

  it('rejects a traversal smuggled in through bindings.json', () => {
    const root = freshRepo('bindings')
    const escape = join(root, 'ESCAPED')
    mkdirSync(escape, { recursive: true })
    // A slug that resolves to a real directory outside the record — the case
    // an existsSync check alone would have waved through.
    const rel = '../../../ESCAPED'
    const ctx = createToolContext(root)
    expect(() => ctx.resolveInitiative(rel)).toThrow(/never a path/)
    expect(readdirSync(escape)).toEqual([])
  })

  it('does not write outside the record when a write tool is handed a traversal', () => {
    const root = freshRepo('write')
    const escape = join(root, 'ESCAPED')
    mkdirSync(escape, { recursive: true })
    const ctx = createToolContext(root)
    expect(() => ctx.resolveWriteInitiative('../../../ESCAPED')).toThrow()
    expect(existsSync(join(escape, 'events.jsonl'))).toBe(false)
    expect(existsSync(join(escape, 'plan.md'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 1.2 — binding to loopback does not keep the local browser out; Host does.
// ---------------------------------------------------------------------------

describe('serve loopback guard', () => {
  it('accepts the authorities a real local client sends', () => {
    expect(hostAllowed('127.0.0.1:4173', 4173)).toBe(true)
    expect(hostAllowed('localhost:4173', 4173)).toBe(true)
    expect(hostAllowed('LOCALHOST:4173', 4173)).toBe(true)
    expect(hostAllowed('[::1]:4173', 4173)).toBe(true)
    expect(hostAllowed('127.0.0.1', 4173)).toBe(true) // default-port form
  })

  it('rejects a rebound hostname even though it resolves to 127.0.0.1', () => {
    expect(hostAllowed('evil.example.com:4173', 4173)).toBe(false)
    expect(hostAllowed('evil.example.com', 4173)).toBe(false)
    // A hostname that merely CONTAINS a loopback name is still not one.
    expect(hostAllowed('localhost.evil.example.com:4173', 4173)).toBe(false)
    expect(hostAllowed('127.0.0.1.evil.example.com:4173', 4173)).toBe(false)
    expect(hostAllowed(undefined, 4173)).toBe(false)
  })

  it('rejects a Host naming a port we are not listening on', () => {
    expect(hostAllowed('127.0.0.1:9999', 4173)).toBe(false)
  })

  it('allows a missing Origin (non-browser) and loopback pages only', () => {
    expect(originAllowed(undefined)).toBe(true)
    expect(originAllowed('http://localhost:3000')).toBe(true)
    expect(originAllowed('http://127.0.0.1:5173')).toBe(true)
    expect(originAllowed('https://evil.example.com')).toBe(false)
    expect(originAllowed('null')).toBe(false)
    expect(originAllowed('not a url')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 2.1 / 2.2 — what the client will send a token to, and hand to the OS opener.
// ---------------------------------------------------------------------------

describe('URL trust', () => {
  it('accepts https anywhere and http only on loopback', () => {
    expect(isSafeWebUrl('https://api.sofar.sh')).toBe(true)
    expect(isSafeWebUrl('http://localhost:8787')).toBe(true)
    expect(isSafeWebUrl('http://127.0.0.1:8787')).toBe(true)
    expect(isSafeWebUrl('http://api.sofar.sh')).toBe(false)
  })

  it('rejects the schemes that make an OS opener dangerous', () => {
    // `open(1)` launches applications and files, not just web pages.
    expect(isSafeWebUrl('file:///Applications/Calculator.app')).toBe(false)
    expect(isSafeWebUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeWebUrl('/Applications/Calculator.app')).toBe(false)
    expect(isSafeWebUrl('data:text/html,<script>')).toBe(false)
    expect(isSafeWebUrl('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3.1 — the log is append-only and committed, so secrets stop before it.
// ---------------------------------------------------------------------------

describe('command redaction', () => {
  const leaks: Array<[string, string]> = [
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG terraform apply', 'wJalrXUtnFEMI/K7MDENG'],
    ['export GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['npm publish --otp=123456', '123456'],
    ['npm publish --otp 123456', '123456'],
    ['curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwx" https://x', 'sk-abcdefghijklmnopqrstuvwx'],
    ['git clone https://user:hunter2@github.com/x/y', 'hunter2'],
    ['deploy --api-key=abc123xyz789', 'abc123xyz789'],
    ['echo AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ]

  it.each(leaks)('redacts the value in %j', (cmd, secret) => {
    const out = redactCommand(cmd)
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTED)
  })

  // The record is still meant to be readable — redaction removes the value,
  // not the fact that the command ran or what it was doing.
  it('preserves the structure that explains the command', () => {
    expect(redactCommand('AWS_SECRET_ACCESS_KEY=abc123def456 terraform apply')).toBe(
      `AWS_SECRET_ACCESS_KEY=${REDACTED} terraform apply`,
    )
    expect(redactCommand('npm publish --otp=123456')).toBe(`npm publish --otp=${REDACTED}`)
  })

  it('leaves ordinary commands byte-identical', () => {
    for (const cmd of [
      'npm test 2>&1 | tail -4',
      'git add README.md && git commit -m "docs: fix typo"',
      'grep -rn "keyboard" src/ | head -20',
      'node --version',
    ]) {
      expect(redactCommand(cmd)).toBe(cmd)
    }
  })
})
