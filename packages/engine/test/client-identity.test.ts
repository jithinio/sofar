import { mkdtempSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { credentialsPath, readCredential, readRemote, writeCredential, type Env } from '../src/client/config'
import { runLink, runLogin } from '../src/cli/cloud'
import { detectCaps } from '../src/cli/ui'
import { startMockCloud, type MockCloud } from './helpers/mock-cloud'

/**
 * `sofar login` (RFC-8628 device flow → sfr_ mint, sync-client 2.1) and
 * `sofar link` (idempotent repo create + committable remote.json, 2.2),
 * driven through the CLI handlers against the mock server.
 */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-client-identity-'))
let n = 0
const freshRoot = (name: string): string => {
  const dir = join(scratch, `${n++}-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
const envFor = (dir: string): Env => ({
  XDG_CONFIG_HOME: join(dir, 'config'),
  XDG_STATE_HOME: join(dir, 'state'),
})

const plain = detectCaps({ env: {}, argv: [], isTTY: false, platform: 'darwin' })
const noSleep = async (): Promise<void> => {}

let mock: MockCloud
beforeEach(async () => {
  if (mock !== undefined) await mock.close()
  mock = await startMockCloud()
})
afterAll(async () => {
  await mock?.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** Approve the pending device code as soon as the CLI prints it. */
function approveOnCode(): { openBrowser: (url: string) => void; opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    openBrowser: (url: string) => {
      opened.push(url)
      const userCode = new URL(url).searchParams.get('user_code')
      if (userCode !== null) mock.approveDevice(userCode)
    },
  }
}

describe('sofar login', () => {
  it('runs the device flow, mints an sfr_ token, stores it 0600, never prints it', async () => {
    const root = freshRoot('login')
    const env = envFor(root)
    const printed: string[] = []
    const { openBrowser, opened } = approveOnCode()

    const result = await runLogin(
      root,
      { api: mock.url },
      { env, sleep: noSleep, openBrowser, out: (t) => printed.push(t), tokenName: 'testbox' },
      plain,
      plain,
    )

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`logged in to ${mock.url}`)
    expect(result.stdout).toContain('token "testbox" (scopes: sync)')
    // The browser got the verification_uri_complete, the human got the code.
    expect(opened).toHaveLength(1)
    expect(printed.join('')).toContain('code:')

    const credential = readCredential(mock.url, env)
    expect(credential?.token).toMatch(/^sfr_/)
    expect(credential?.scopes).toEqual(['sync'])
    expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600)
    // The credential is shown exactly once — by the SERVER. Nothing the CLI
    // wrote (interactive lines, confirmation, stderr) may carry it.
    const everything = printed.join('') + result.stdout + result.stderr
    expect(everything).not.toContain(credential!.token)
    expect(everything).not.toContain('sfr_')
  })

  it('supports --scopes read for read-only consumers', async () => {
    const root = freshRoot('login-read')
    const env = envFor(root)
    const { openBrowser } = approveOnCode()
    const result = await runLogin(
      root,
      { api: mock.url, scopes: 'read' },
      { env, sleep: noSleep, openBrowser, out: () => {}, tokenName: 'ro' },
      plain,
      plain,
    )
    expect(result.exitCode).toBe(0)
    expect(readCredential(mock.url, env)?.scopes).toEqual(['read'])
    expect(mock.tokens.get(readCredential(mock.url, env)!.token)?.scopes).toEqual(['read'])
  })

  it('keeps polling through authorization_pending and honors slow_down (+5s)', async () => {
    const root = freshRoot('login-slow')
    const env = envFor(root)
    const sleeps: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms)
    }
    mock.slowDownOnce = true
    let approved = false
    const openBrowser = (url: string): void => {
      // stay pending for one poll cycle, then approve
      setTimeout(() => {
        if (!approved) {
          approved = true
          const userCode = new URL(url).searchParams.get('user_code')
          if (userCode !== null) mock.approveDevice(userCode)
        }
      }, 0)
    }
    const result = await runLogin(root, { api: mock.url }, { env, sleep, openBrowser, out: () => {}, tokenName: 't' }, plain, plain)
    expect(result.exitCode).toBe(0)
    // first poll answered slow_down → interval bumped 5s → 10s
    expect(sleeps[0]).toBe(10_000)
  })

  it('aborts with a clear message when the browser denies', async () => {
    const root = freshRoot('login-denied')
    const env = envFor(root)
    const openBrowser = (url: string): void => {
      const userCode = new URL(url).searchParams.get('user_code')
      if (userCode !== null) mock.denyDevice(userCode)
    }
    const result = await runLogin(root, { api: mock.url }, { env, sleep: noSleep, openBrowser, out: () => {} }, plain, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('denied')
    expect(readCredential(mock.url, env)).toBeNull()
  })

  it('aborts when the code expires server-side', async () => {
    const root = freshRoot('login-expired')
    const env = envFor(root)
    const openBrowser = (url: string): void => {
      const userCode = new URL(url).searchParams.get('user_code')
      if (userCode !== null) mock.expireDevice(userCode)
    }
    const result = await runLogin(root, { api: mock.url }, { env, sleep: noSleep, openBrowser, out: () => {} }, plain, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('expired')
  })

  it('fails cleanly when the API is unreachable', async () => {
    const root = freshRoot('login-down')
    const env = envFor(root)
    const result = await runLogin(
      root,
      { api: 'http://127.0.0.1:9' },
      { env, sleep: noSleep, out: () => {}, openBrowser: () => {} },
      plain,
      plain,
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('cannot reach http://127.0.0.1:9')
  })
})

describe('sofar link', () => {
  async function loggedIn(root: string): Promise<Env> {
    const env = envFor(root)
    const { openBrowser } = approveOnCode()
    const login = await runLogin(root, { api: mock.url }, { env, sleep: noSleep, openBrowser, out: () => {} }, plain, plain)
    expect(login.exitCode).toBe(0)
    return env
  }

  it('creates the repo and writes the committable remote.json', async () => {
    const root = freshRoot('link')
    const env = await loggedIn(root)
    const result = await runLink(root, { org: 'align', name: 'sofar', api: mock.url }, { env }, plain, plain)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('linked align/sofar')
    expect(result.stdout).toContain('remote.json')
    const remote = readRemote(root)
    expect(remote).toMatchObject({ api_url: mock.url, org: 'align', name: 'sofar' })
    expect(remote?.repo_id).toMatch(/^repo_/)
  })

  it('is idempotent on org+name — relink resolves to the same repo_id', async () => {
    const root = freshRoot('link-idem')
    const env = await loggedIn(root)
    await runLink(root, { org: 'align', name: 'sofar', api: mock.url }, { env }, plain, plain)
    const first = readRemote(root)?.repo_id
    const again = await runLink(root, { org: 'align', name: 'sofar', api: mock.url }, { env }, plain, plain)
    expect(again.exitCode).toBe(0)
    expect(readRemote(root)?.repo_id).toBe(first)
  })

  it('defaults the repo name to the directory basename', async () => {
    const root = freshRoot('basename')
    const env = await loggedIn(root)
    const result = await runLink(root, { org: 'align', api: mock.url }, { env }, plain, plain)
    expect(result.exitCode).toBe(0)
    expect(readRemote(root)?.name).toBe(`${n - 1}-basename`)
  })

  it('renders the honest 404 copy — unknown org and non-member are the same answer', async () => {
    const root = freshRoot('link-404')
    const env = await loggedIn(root)
    const result = await runLink(root, { org: 'strangers', api: mock.url }, { env }, plain, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not found')
    expect(result.stderr).toContain('not a member')
    expect(result.stderr).toContain('does not say which')
    expect(readRemote(root)).toBeNull()
  })

  it('points an unauthenticated user at sofar login', async () => {
    const root = freshRoot('link-anon')
    const result = await runLink(root, { org: 'align', api: mock.url }, { env: envFor(root) }, plain, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('sofar login')
  })

  it('handles a revoked token as 401 → login again', async () => {
    const root = freshRoot('link-revoked')
    const env = envFor(root)
    writeCredential(mock.url, { token: 'sfr_revoked' }, env)
    const result = await runLink(root, { org: 'align', api: mock.url }, { env }, plain, plain)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('sofar login')
  })
})
