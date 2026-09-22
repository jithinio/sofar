import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { userConfigPath, writeCredential, writeRemote, type Env } from '../src/client/config'
import {
  CLOUD_PROVIDER,
  cloudJudgeProvider,
  judgePath,
  readJudgeSetting,
  resolveJudgeProvider,
} from '../src/client/judge'
import type { FetchLike } from '../src/client/http'
import { judge, type JudgeRequest } from '../src/core/judge'

/**
 * typed-judge 2.3 — the `cloud` judge provider (SPEC §Judge, Providers).
 *
 * Two halves. Resolution: cloud only when the operator opted in AND the repo
 * is linked AND they are logged in; anything else is deterministic, with a
 * reason only when they opted in. The wire: one POST to the repo-scoped
 * endpoint with the bearer token, redacted state and rule-stripped questions;
 * every failure, 402/403 included, leaves the questions abstained and never
 * throws, and nothing is retried.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-client-judge-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let n = 0

interface Seen {
  method: string
  url: string
  auth: string | undefined
  contentType: string | undefined
  body: unknown
}
type Reply = (res: ServerResponse) => void

/** A judge endpoint that records every request and answers with the scripted reply. */
async function fakeJudge(): Promise<{ url: string; seen: Seen[]; reply: { next: Reply }; closed: () => number; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const reply = { next: ((res) => json(res, 200, { model: 'jev-1.13.0', answers: {} })) as Reply }
  let closedEarly = 0
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')))
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      })
      res.on('close', () => {
        if (!res.writableFinished) closedEarly++
      })
      reply.next(res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    reply,
    closed: () => closedEarly,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A clone with its own XDG dirs; each piece of setup is opt-in. */
function clone(opts: { optIn?: boolean | string; apiUrl?: string; linked?: boolean; loggedIn?: boolean } = {}) {
  const root = join(scratch, `${n++}-repo`)
  mkdirSync(root, { recursive: true })
  const env: Env = { XDG_CONFIG_HOME: join(root, '.xdg-config'), XDG_STATE_HOME: join(root, '.xdg-state') }
  const apiUrl = opts.apiUrl ?? 'https://api.sofar.sh'
  if (opts.optIn !== undefined && opts.optIn !== false) {
    const path = userConfigPath(env)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      typeof opts.optIn === 'string' ? opts.optIn : JSON.stringify({ version: 1, auto_upgrade: false, judge: { provider: 'cloud' } }),
    )
  }
  if (opts.linked !== false) writeRemote(root, { version: 1, api_url: apiUrl, org: 'acme', name: 'app', repo_id: 'repo_01' })
  if (opts.loggedIn !== false) writeCredential(apiUrl, { token: 'sfr_test_token' }, env)
  return { root, env }
}

const request = (): JudgeRequest => ({
  state: { cmd: 'export API_KEY=sk-live-abc123', task: 'wire the judge' },
  questions: {
    ruled: { type: 'noul', instructions: 'Is `task` non-empty?', decide: () => ({ type: 'noul', noul: 1 }) },
    open_noul: { type: 'noul', instructions: 'Is `task` a re-proposal?' },
    open_choice: { type: 'choice', instructions: 'Which kind?', criteria: { fix: null, feature: null, none: null } },
  },
})

describe('readJudgeSetting — only an explicit "cloud" opts in', () => {
  it('absent, misspelled, flat-keyed or unreadable config is deterministic', () => {
    expect(readJudgeSetting(clone().env)).toBe('deterministic')
    expect(readJudgeSetting(clone({ optIn: '{"judge":{"provider":"Cloud"}}' }).env)).toBe('deterministic')
    expect(readJudgeSetting(clone({ optIn: '{"judge.provider":"cloud"}' }).env)).toBe('deterministic')
    expect(readJudgeSetting(clone({ optIn: '{not json' }).env)).toBe('deterministic')
    expect(readJudgeSetting(clone({ optIn: true }).env)).toBe('cloud')
  })
})

describe('resolveJudgeProvider — cloud only when opted in, linked and logged in', () => {
  it('not opted in: deterministic and silent, even for a linked, logged-in repo', () => {
    const { root, env } = clone()
    expect(resolveJudgeProvider(root, { env })).toEqual({})
  })

  it('opted in but unlinked, logged out, or on a plain-http api_url: deterministic, with the reason', () => {
    const unlinked = clone({ optIn: true, linked: false })
    const r1 = resolveJudgeProvider(unlinked.root, { env: unlinked.env })
    expect(r1.provider).toBeUndefined()
    expect(r1.unavailable).toContain('sofar link')

    const loggedOut = clone({ optIn: true, loggedIn: false })
    const r2 = resolveJudgeProvider(loggedOut.root, { env: loggedOut.env })
    expect(r2.provider).toBeUndefined()
    expect(r2.unavailable).toContain('sofar login')

    const cleartext = clone({ optIn: true, apiUrl: 'http://judge.example.com' })
    const r3 = resolveJudgeProvider(cleartext.root, { env: cleartext.env })
    expect(r3.provider).toBeUndefined()
    expect(r3.unavailable).toContain('https')
  })

  it('opted in, linked and logged in: the cloud provider', () => {
    const { root, env } = clone({ optIn: true })
    const r = resolveJudgeProvider(root, { env })
    expect(r.provider?.name).toBe(CLOUD_PROVIDER)
    expect(r.unavailable).toBeUndefined()
  })

  it('a corrupt remote.json never throws; it is a reason', () => {
    const { root, env } = clone({ optIn: true })
    writeFileSync(join(root, '.sofar', 'remote.json'), '{broken')
    expect(() => resolveJudgeProvider(root, { env })).not.toThrow()
    expect(resolveJudgeProvider(root, { env }).unavailable).toContain('remote.json')
  })
})

describe('the wire — one request, redacted, rule-stripped, repo-scoped', () => {
  let server: Awaited<ReturnType<typeof fakeJudge>>
  beforeEach(async () => {
    server = await fakeJudge()
  })
  afterEach(async () => {
    await server.close()
  })
  const provider = () => {
    const { root, env } = clone({ optIn: true, apiUrl: server.url })
    const p = resolveJudgeProvider(root, { env }).provider
    expect(p).toBeDefined()
    return p!
  }

  it('posts only the abstentions, once, with the bearer token and redacted state; answers carry the pinned model', async () => {
    server.reply.next = (res) =>
      json(res, 200, {
        model: 'jev-1.13.0',
        answers: {
          open_noul: { type: 'noul', noul: 0.9 },
          open_choice: { type: 'choice', choice: 'fix', probabilities: { fix: 0.7, feature: 0.2, none: 0.1 }, confidence: 0.99 },
        },
        usage: { input_tokens: 120, output_tokens: 4, secret: 'dropped' },
      })
    const out = await judge(request(), { provider: provider() })

    expect(server.seen).toHaveLength(1)
    const [seen] = server.seen
    expect(seen!.method).toBe('POST')
    expect(seen!.url).toBe(judgePath('repo_01'))
    expect(seen!.auth).toBe('Bearer sfr_test_token')
    expect(seen!.contentType).toBe('application/json')
    const body = seen!.body as { state: { cmd: string; task: string }; questions: Record<string, Record<string, unknown>> }
    expect(Object.keys(body.questions).sort()).toEqual(['open_choice', 'open_noul'])
    expect(JSON.stringify(body)).not.toContain('sk-live-abc123')
    expect(body.state.cmd).toContain('[redacted]')
    expect(body.state.task).toBe('wire the judge')

    expect(out.provider).toBe(CLOUD_PROVIDER)
    expect(out.model).toBe('jev-1.13.0')
    expect(out.fell_back).toBeUndefined()
    expect(out.answers.ruled).toMatchObject({ origin: 'rule', noul: 1 })
    expect(out.answers.open_noul).toMatchObject({ origin: 'model', model: 'jev-1.13.0', noul: 0.9 })
    // The seam recomputes confidence; the server's 0.99 is ignored.
    expect(out.answers.open_choice).toMatchObject({ origin: 'model', choice: 'fix' })
    expect((out.answers.open_choice as { confidence: number }).confidence).toBeCloseTo((3 * 0.7 - 1) / 2, 10)
    expect(out.usage).toEqual({ input_tokens: 120, output_tokens: 4 })
  })

  it('a request every rule decides never touches the network', async () => {
    const out = await judge(
      { state: 's', questions: { ruled: { type: 'noul', instructions: 'x', decide: () => ({ type: 'noul', noul: 0 }) } } },
      { provider: provider() },
    )
    expect(server.seen).toHaveLength(0)
    expect(out.provider).toBe('deterministic')
  })

  it.each([
    [402, { error: { code: 'plan_required', message: 'Judging needs a paid plan' } }, 'HTTP 402 plan_required: Judging needs a paid plan'],
    [403, { error: { code: 'forbidden', message: 'forbidden' } }, 'HTTP 403 forbidden'],
    [500, undefined, 'HTTP 500'],
    [429, { error: { code: 'rate_limited', message: 'slow down' } }, 'HTTP 429 rate_limited: slow down'],
  ])('HTTP %i: abstained, named in fell_back, never thrown, never retried', async (status, body, reason) => {
    server.reply.next = (res) => (body === undefined ? (res.writeHead(status), res.end()) : json(res, status, body))
    const out = await judge(request(), { provider: provider() })
    expect(server.seen).toHaveLength(1)
    expect(out.fell_back).toBe(`cloud: ${reason}`)
    expect(out.answers.ruled).toMatchObject({ origin: 'rule' })
    expect(out.answers.open_noul).toMatchObject({ origin: 'abstain', noul: 0.5 })
    expect(out.answers.open_choice).toMatchObject({ origin: 'abstain', confidence: 0 })
  })

  it.each([
    ['no model', { answers: {} }],
    ['an alias-length model string', { model: 'x'.repeat(129), answers: {} }],
    ['answers as an array', { model: 'jev-1.13.0', answers: [] }],
    ['not JSON', 'plain text'],
  ])('a malformed body (%s) is abstained with "malformed response"', async (_label, body) => {
    server.reply.next = (res) =>
      typeof body === 'string' ? (res.writeHead(200, { 'content-type': 'text/plain' }), res.end(body)) : json(res, 200, body)
    const out = await judge(request(), { provider: provider() })
    expect(out.fell_back).toBe('cloud: malformed response')
    expect(out.answers.open_noul).toMatchObject({ origin: 'abstain' })
  })

  it('a server that never answers is abstained at the timeout and its request is aborted', async () => {
    server.reply.next = () => {} // hold the socket open
    const out = await judge(request(), { provider: provider(), timeoutMs: 100 })
    expect(out.fell_back).toBe('cloud: timed out after 100ms')
    expect(out.answers.open_noul).toMatchObject({ origin: 'abstain' })
    await expect.poll(() => server.closed(), { timeout: 2000 }).toBe(1)
  })

  it('a refused connection is abstained, not thrown', async () => {
    const dead = server.url
    await server.close()
    const p = cloudJudgeProvider({ apiUrl: dead, repoId: 'repo_01', token: 'sfr_test_token' })
    const out = await judge(request(), { provider: p })
    expect(out.fell_back).toMatch(/^cloud: /)
    expect(out.answers.open_choice).toMatchObject({ origin: 'abstain' })
    server = await fakeJudge() // afterEach closes whichever server is current
  })
})

describe('the provider on its own', () => {
  it('redacts state even when called without the seam, and refuses a cleartext api_url', async () => {
    let sent = ''
    const fetchImpl: FetchLike = async (_url, init) => {
      sent = String(init?.body)
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {} }), { status: 200 })
    }
    const p = cloudJudgeProvider({ apiUrl: 'https://api.sofar.sh', repoId: 'repo_01', token: 't', fetchImpl })
    await p.judge({ state: 'TOKEN=hunter2', questions: { q: { type: 'noul', instructions: 'x' } } })
    expect(sent).not.toContain('hunter2')
    expect(sent).toContain('[redacted]')
    expect(() => cloudJudgeProvider({ apiUrl: 'http://evil.example', repoId: 'r', token: 't' })).toThrow(/https/)
  })

  it('escapes the repo id into the path', () => {
    expect(judgePath('a/b c')).toBe('/v1/repos/a%2Fb%20c/judge')
  })
})
