import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  credentialsPath,
  DEFAULT_API_URL,
  normalizeApiUrl,
  readCredential,
  readRemote,
  readSyncState,
  resolveApiUrl,
  syncStatePath,
  writeCredential,
  writeRemote,
  writeSyncState,
  type Env,
  type RemoteConfig,
} from '../src/client/config'
import { ApiError, errorParts, isRetryable, parseRetryAfter, withRetries } from '../src/client/http'

/** Config + stores (sync-client 1.1) and HTTP retry core (1.2). */

const scratch = mkdtempSync(join(tmpdir(), 'sofar-client-core-'))
let n = 0
const freshDir = (name: string): string => {
  const dir = join(scratch, `${n++}-${name}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
/** Isolated env: config/state under scratch, no ambient SOFAR_API_URL. */
const envFor = (dir: string): Env => ({
  XDG_CONFIG_HOME: join(dir, 'config'),
  XDG_STATE_HOME: join(dir, 'state'),
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

const REMOTE: RemoteConfig = {
  version: 1,
  api_url: 'https://api.sofar.sh',
  org: 'align',
  name: 'sofar',
  repo_id: 'repo_1',
}

describe('api_url resolution', () => {
  it('normalizes trailing slashes', () => {
    expect(normalizeApiUrl('https://api.sofar.sh///')).toBe('https://api.sofar.sh')
  })

  it('resolves flag > env > remote > default', () => {
    const remote = { ...REMOTE, api_url: 'https://remote.example' }
    expect(resolveApiUrl({ env: {} })).toBe(DEFAULT_API_URL)
    expect(resolveApiUrl({ remote, env: {} })).toBe('https://remote.example')
    expect(resolveApiUrl({ remote, env: { SOFAR_API_URL: 'http://localhost:8787' } })).toBe('http://localhost:8787')
    expect(
      resolveApiUrl({ flag: 'http://flag.example/', remote, env: { SOFAR_API_URL: 'http://localhost:8787' } }),
    ).toBe('http://flag.example')
  })

  it('ignores an empty env override', () => {
    expect(resolveApiUrl({ env: { SOFAR_API_URL: '  ' } })).toBe(DEFAULT_API_URL)
  })
})

describe('remote.json', () => {
  it('round-trips and reports missing as null', () => {
    const root = freshDir('remote')
    expect(readRemote(root)).toBeNull()
    writeRemote(root, REMOTE)
    expect(readRemote(root)).toEqual(REMOTE)
  })

  it('throws an actionable message on a corrupt file', () => {
    const root = freshDir('remote-corrupt')
    mkdirSync(join(root, '.sofar'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'remote.json'), '{nope', 'utf8')
    expect(() => readRemote(root)).toThrow(/remote\.json.*sofar link/s)
  })

  it('rejects an incomplete binding', () => {
    const root = freshDir('remote-incomplete')
    mkdirSync(join(root, '.sofar'), { recursive: true })
    writeFileSync(join(root, '.sofar', 'remote.json'), JSON.stringify({ org: 'align' }), 'utf8')
    expect(() => readRemote(root)).toThrow(/api_url\/org\/name\/repo_id/)
  })
})

describe('credentials store', () => {
  it('stores per api_url with user-only permissions', () => {
    const env = envFor(freshDir('creds'))
    expect(readCredential('https://api.sofar.sh', env)).toBeNull()
    writeCredential('https://api.sofar.sh/', { token: 'sfr_abc', scopes: ['sync'] }, env)
    writeCredential('http://localhost:8787', { token: 'sfr_dev' }, env)
    // trailing slash normalized away on write AND read
    expect(readCredential('https://api.sofar.sh', env)?.token).toBe('sfr_abc')
    expect(readCredential('https://api.sofar.sh/', env)?.token).toBe('sfr_abc')
    expect(readCredential('http://localhost:8787', env)?.token).toBe('sfr_dev')
    const mode = statSync(credentialsPath(env)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('merge-writes without dropping other endpoints', () => {
    const env = envFor(freshDir('creds-merge'))
    writeCredential('https://a.example', { token: 'sfr_a' }, env)
    writeCredential('https://b.example', { token: 'sfr_b' }, env)
    writeCredential('https://a.example', { token: 'sfr_a2' }, env)
    expect(readCredential('https://a.example', env)?.token).toBe('sfr_a2')
    expect(readCredential('https://b.example', env)?.token).toBe('sfr_b')
  })

  it('throws with the path when the file is corrupt', () => {
    const env = envFor(freshDir('creds-corrupt'))
    mkdirSync(join(credentialsPath(env), '..'), { recursive: true })
    writeFileSync(credentialsPath(env), 'not json', 'utf8')
    expect(() => readCredential('https://api.sofar.sh', env)).toThrow(/credentials\.json.*sofar login/s)
  })
})

describe('per-clone sync state', () => {
  const target = { api_url: 'https://api.sofar.sh', repo_id: 'repo_1' }

  it('starts fresh, round-trips, and is keyed per clone', () => {
    const rootA = freshDir('clone-a')
    const rootB = freshDir('clone-b')
    const env = envFor(freshDir('state-home'))
    expect(syncStatePath(rootA, env)).not.toBe(syncStatePath(rootB, env))

    const state = readSyncState(rootA, target, env)
    expect(state.streams).toEqual({})
    state.streams['sync-client'] = { pushed: '01A', pulled: '01B' }
    writeSyncState(rootA, state, env)
    expect(readSyncState(rootA, target, env).streams['sync-client']).toEqual({ pushed: '01A', pulled: '01B' })
    expect(readSyncState(rootB, target, env).streams).toEqual({})
  })

  it('invalidates on api_url or repo_id change (relink safety)', () => {
    const root = freshDir('relink')
    const env = envFor(freshDir('state-home-2'))
    const state = readSyncState(root, target, env)
    state.streams.a = { pushed: '01A' }
    writeSyncState(root, state, env)
    expect(readSyncState(root, { ...target, repo_id: 'repo_2' }, env).streams).toEqual({})
    expect(readSyncState(root, { ...target, api_url: 'http://localhost:8787' }, env).streams).toEqual({})
    expect(readSyncState(root, target, env).streams.a).toEqual({ pushed: '01A' })
  })

  it('discards a corrupt state file silently — cursors are an optimization', () => {
    const root = freshDir('corrupt-state')
    const env = envFor(freshDir('state-home-3'))
    writeSyncState(root, { version: 1, ...target, streams: { a: { pushed: '01A' } } }, env)
    writeFileSync(syncStatePath(root, env), '{torn', 'utf8')
    expect(readSyncState(root, target, env).streams).toEqual({})
  })
})

describe('error normalization', () => {
  it('parses both the /v1 envelope and the OAuth flat string', () => {
    expect(errorParts({ error: { code: 'not_found', message: 'unknown repo' } })).toEqual({
      code: 'not_found',
      message: 'unknown repo',
    })
    expect(errorParts({ error: 'authorization_pending', error_description: 'Authorization pending' })).toEqual({
      code: 'authorization_pending',
      message: 'Authorization pending',
    })
    expect(errorParts({})).toEqual({})
    expect(errorParts('garbage')).toEqual({})
  })

  it('parses Retry-After as delta-seconds or HTTP-date', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('garbage')).toBeUndefined()
    const soon = parseRetryAfter(new Date(Date.now() + 5000).toUTCString())
    expect(soon).toBeGreaterThan(0)
    expect(soon).toBeLessThanOrEqual(5000)
  })
})

describe('withRetries', () => {
  const sleeps: number[] = []
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms)
  }

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    sleeps.length = 0
    let calls = 0
    const result = await withRetries(
      async () => {
        calls += 1
        if (calls < 3) throw new ApiError(429, 'rate_limited', 'slow down', 3000)
        return 'ok'
      },
      { sleep },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(sleeps).toEqual([3000, 3000])
  })

  it('retries 5xx and network errors with exponential backoff', async () => {
    sleeps.length = 0
    let calls = 0
    await withRetries(
      async () => {
        calls += 1
        if (calls === 1) throw new ApiError(503, 'unavailable', 'down')
        if (calls === 2) throw new TypeError('fetch failed')
        return 'ok'
      },
      { sleep, baseDelayMs: 100 },
    )
    expect(calls).toBe(3)
    expect(sleeps).toEqual([100, 200])
  })

  it('never retries a plain 4xx', async () => {
    let calls = 0
    await expect(
      withRetries(async () => {
        calls += 1
        throw new ApiError(404, 'not_found', 'not found')
      }, { sleep }),
    ).rejects.toMatchObject({ status: 404 })
    expect(calls).toBe(1)
    expect(isRetryable(new ApiError(401, 'unauthorized', 'no'))).toBe(false)
    expect(isRetryable(new ApiError(422, 'bad_request', 'no'))).toBe(false)
  })

  it('gives up after the attempt budget with the last error', async () => {
    let calls = 0
    await expect(
      withRetries(async () => {
        calls += 1
        throw new ApiError(500, 'internal', 'still down')
      }, { sleep, attempts: 3 }),
    ).rejects.toMatchObject({ code: 'internal' })
    expect(calls).toBe(3)
  })
})
