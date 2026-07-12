import { apiJson, apiRequest, errorParts, defaultSleep, type FetchLike, type Sleep } from './http'

/**
 * `sofar login` core — RFC-8628 device authorization against api.sofar.sh's
 * Better Auth device plugin, then minting the real credential (sync-client
 * 2.1, SPEC §Sync client).
 *
 * The access_token the flow yields is a short-lived SESSION credential; the
 * durable, revocable credential is the sfr_ token minted from it via
 * POST /v1/tokens — shown by the server exactly once. Callers store it and
 * discard the access_token; nothing here prints anything.
 */

export const DEVICE_CLIENT_ID = 'sofar-cli'

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  /** Seconds until the code expires (server default when absent: 1800). */
  expires_in: number
  /** Seconds between polls (server default when absent: 5). */
  interval: number
}

/** Login failed in a way polling cannot fix (denied, expired, protocol error). */
export class DeviceFlowError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'DeviceFlowError'
    this.code = code
  }
}

export interface DeviceFlowOptions {
  apiUrl: string
  fetchImpl?: FetchLike
}

export async function requestDeviceCode(opts: DeviceFlowOptions): Promise<DeviceCodeResponse> {
  const raw = await apiJson<Partial<DeviceCodeResponse>>({
    apiUrl: opts.apiUrl,
    path: '/api/auth/device/code',
    json: { client_id: DEVICE_CLIENT_ID },
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })
  if (
    typeof raw.device_code !== 'string' || raw.device_code.length === 0 ||
    typeof raw.user_code !== 'string' || raw.user_code.length === 0
  ) {
    throw new DeviceFlowError('bad_response', `${opts.apiUrl} returned no device/user code — is this a sofar API?`)
  }
  return {
    device_code: raw.device_code,
    user_code: raw.user_code,
    verification_uri: typeof raw.verification_uri === 'string' ? raw.verification_uri : '',
    verification_uri_complete:
      typeof raw.verification_uri_complete === 'string' && raw.verification_uri_complete.length > 0
        ? raw.verification_uri_complete
        : typeof raw.verification_uri === 'string'
          ? raw.verification_uri
          : '',
    expires_in: typeof raw.expires_in === 'number' && raw.expires_in > 0 ? raw.expires_in : 1800,
    interval: typeof raw.interval === 'number' && raw.interval > 0 ? raw.interval : 5,
  }
}

export interface PollOptions extends DeviceFlowOptions {
  deviceCode: string
  /** Seconds between polls (from the code response). */
  intervalSeconds: number
  /** Seconds until the device code expires (from the code response). */
  expiresInSeconds: number
  sleep?: Sleep
}

/**
 * Poll the token endpoint until approval. `authorization_pending` keeps
 * polling; `slow_down` adds 5s to the interval (RFC 8628 §3.5);
 * `access_denied` / `expired_token` abort with a clear message. Returns the
 * short-lived access_token.
 */
export async function pollDeviceToken(opts: PollOptions): Promise<string> {
  const sleep = opts.sleep ?? defaultSleep
  let intervalSeconds = Math.max(1, opts.intervalSeconds)
  let elapsedSeconds = 0
  for (;;) {
    const res = await apiRequest({
      apiUrl: opts.apiUrl,
      path: '/api/auth/device/token',
      json: {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: opts.deviceCode,
        client_id: DEVICE_CLIENT_ID,
      },
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    })
    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    const accessToken = (body as { access_token?: unknown } | undefined)?.access_token
    if (res.ok && typeof accessToken === 'string' && accessToken.length > 0) return accessToken

    const { code, message } = errorParts(body)
    switch (code) {
      case 'authorization_pending':
        break
      case 'slow_down':
        intervalSeconds += 5
        break
      case 'access_denied':
        throw new DeviceFlowError('access_denied', 'sign-in was denied in the browser — nothing stored')
      case 'expired_token':
        throw new DeviceFlowError('expired_token', 'the sign-in code expired — run `sofar login` again')
      default:
        throw new DeviceFlowError(
          code ?? `http_${res.status}`,
          message ?? `unexpected response from the token endpoint (HTTP ${res.status})`,
        )
    }
    if (elapsedSeconds + intervalSeconds > opts.expiresInSeconds) {
      throw new DeviceFlowError('expired_token', 'the sign-in code expired — run `sofar login` again')
    }
    await sleep(intervalSeconds * 1000)
    elapsedSeconds += intervalSeconds
  }
}

export interface MintTokenOptions extends DeviceFlowOptions {
  /** The device flow's short-lived access_token. */
  accessToken: string
  /** Token display name — conventionally the machine's hostname. */
  name: string
  /** ["sync"] for read-write clients, ["read"] for read-only consumers. */
  scopes: string[]
}

export interface MintedToken {
  token_id: string
  /** The sfr_ credential — shown exactly once; store it, never print it. */
  token: string
}

export async function mintToken(opts: MintTokenOptions): Promise<MintedToken> {
  const raw = await apiJson<Partial<MintedToken>>({
    apiUrl: opts.apiUrl,
    path: '/v1/tokens',
    token: opts.accessToken,
    json: { name: opts.name, scopes: opts.scopes },
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })
  if (typeof raw.token !== 'string' || raw.token.length === 0) {
    throw new DeviceFlowError('bad_response', 'the token endpoint returned no token')
  }
  return { token_id: typeof raw.token_id === 'string' ? raw.token_id : '', token: raw.token }
}

export interface DeviceLoginOptions extends DeviceFlowOptions {
  scopes: string[]
  /** Token display name (default: caller passes the hostname). */
  name: string
  sleep?: Sleep
  /** Called once the code exists — print it / open the browser here. */
  onCode?: (code: DeviceCodeResponse) => void
}

/** The whole flow: code → (caller shows it) → poll → mint. */
export async function deviceLogin(opts: DeviceLoginOptions): Promise<MintedToken> {
  const code = await requestDeviceCode(opts)
  opts.onCode?.(code)
  const accessToken = await pollDeviceToken({
    apiUrl: opts.apiUrl,
    deviceCode: code.device_code,
    intervalSeconds: code.interval,
    expiresInSeconds: code.expires_in,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
  })
  return mintToken({
    apiUrl: opts.apiUrl,
    accessToken,
    name: opts.name,
    scopes: opts.scopes,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })
}
