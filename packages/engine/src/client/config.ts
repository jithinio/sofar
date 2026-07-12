import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Sync-client configuration + stores (sync-client 1.1, SPEC §Sync client).
 *
 * Three homes, three lifetimes:
 * - `.sofar/remote.json` — the COMMITTABLE repo↔cloud binding ({api_url, org,
 *   name, repo_id}); repo_id is not a secret, teammates share it.
 * - `~/.config/sofar/credentials.json` — the sfr_ token, per user per api_url,
 *   mode 0600. Credentials never touch the repo.
 * - `~/.local/state/sofar/sync/<hash>.json` — per-CLONE push/pull cursors.
 *   Cursors mutate on every sync; committing them would dirty the repo per
 *   push and invite JSON merge conflicts, so they live outside it. A lost or
 *   stale cursor file is always safe: push/pull are idempotent by event id.
 *
 * Everything here resolves env at CALL time (injectable for tests) — importing
 * this module has no side effects (library-surface law).
 */

export const DEFAULT_API_URL = 'https://api.sofar.sh'

/** Env var that overrides the configured api_url (local dev: http://localhost:8787). */
export const API_URL_ENV = 'SOFAR_API_URL'

export type Env = Record<string, string | undefined>

/** Trailing slashes off — api_url keys credentials and cursor state. */
export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// .sofar/remote.json — committable repo↔cloud binding (sofar link writes it).
// ---------------------------------------------------------------------------

export interface RemoteConfig {
  version: 1
  api_url: string
  org: string
  name: string
  repo_id: string
}

export function remotePath(rootDir: string): string {
  return join(rootDir, '.sofar', 'remote.json')
}

/** null when the repo is not linked; throws on a corrupt/incomplete file. */
export function readRemote(rootDir: string): RemoteConfig | null {
  const path = remotePath(rootDir)
  if (!existsSync(path)) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(
      `.sofar/remote.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it or re-run \`sofar link\``,
    )
  }
  const r = decoded as Partial<RemoteConfig> | null
  if (
    typeof r !== 'object' || r === null ||
    typeof r.api_url !== 'string' || r.api_url.length === 0 ||
    typeof r.org !== 'string' || r.org.length === 0 ||
    typeof r.name !== 'string' || r.name.length === 0 ||
    typeof r.repo_id !== 'string' || r.repo_id.length === 0
  ) {
    throw new Error(
      '.sofar/remote.json is missing api_url/org/name/repo_id — fix it or re-run `sofar link`',
    )
  }
  return { version: 1, api_url: normalizeApiUrl(r.api_url), org: r.org, name: r.name, repo_id: r.repo_id }
}

export function writeRemote(rootDir: string, remote: RemoteConfig): void {
  const path = remotePath(rootDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(remote, null, 2)}\n`, 'utf8')
}

/**
 * Effective api_url: explicit flag > SOFAR_API_URL env > .sofar/remote.json >
 * default. The env override outranks the committed remote so a dev server
 * (http://localhost:8787) can be targeted without editing team-shared files.
 */
export function resolveApiUrl(opts: {
  flag?: string | undefined
  remote?: RemoteConfig | null
  env?: Env
} = {}): string {
  const env = opts.env ?? process.env
  const chosen =
    nonEmpty(opts.flag) ?? nonEmpty(env[API_URL_ENV]) ?? opts.remote?.api_url ?? DEFAULT_API_URL
  return normalizeApiUrl(chosen)
}

// ---------------------------------------------------------------------------
// ~/.config/sofar/credentials.json — sfr_ tokens keyed by api_url, mode 0600.
// ---------------------------------------------------------------------------

export interface StoredCredential {
  token: string
  token_id?: string
  name?: string
  scopes?: string[]
  created_at?: string
}

interface CredentialsFile {
  version: 1
  credentials: Record<string, StoredCredential>
}

export function credentialsPath(env: Env = process.env): string {
  const base = nonEmpty(env.XDG_CONFIG_HOME) ?? join(homedir(), '.config')
  return join(base, 'sofar', 'credentials.json')
}

function readCredentialsFile(env: Env): CredentialsFile {
  const path = credentialsPath(env)
  if (!existsSync(path)) return { version: 1, credentials: {} }
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix or remove it, then \`sofar login\` again`,
    )
  }
  const file = decoded as Partial<CredentialsFile> | null
  if (typeof file !== 'object' || file === null || typeof file.credentials !== 'object' || file.credentials === null) {
    throw new Error(`${path} has an unexpected shape — fix or remove it, then \`sofar login\` again`)
  }
  return { version: 1, credentials: file.credentials as Record<string, StoredCredential> }
}

/** The stored credential for an api_url, or null when not logged in there. */
export function readCredential(apiUrl: string, env: Env = process.env): StoredCredential | null {
  const cred = readCredentialsFile(env).credentials[normalizeApiUrl(apiUrl)]
  return cred !== undefined && typeof cred.token === 'string' && cred.token.length > 0 ? cred : null
}

/** Merge-write one credential; the file and its directory stay user-only (0600/0700). */
export function writeCredential(apiUrl: string, credential: StoredCredential, env: Env = process.env): void {
  const path = credentialsPath(env)
  const file = readCredentialsFile(env)
  file.credentials[normalizeApiUrl(apiUrl)] = credential
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600) // writeFileSync mode applies only on create — enforce on overwrite too
}

// ---------------------------------------------------------------------------
// Per-clone sync cursors — XDG state dir, keyed by the clone's real path.
// ---------------------------------------------------------------------------

export interface StreamCursors {
  /** Last event id the server ACKED for this stream (push side). */
  pushed?: string
  /** Last X-Sofar-Cursor imported from the server (pull side — independent of pushed). */
  pulled?: string
}

export interface SyncState {
  version: 1
  api_url: string
  repo_id: string
  streams: Record<string, StreamCursors>
}

export function syncStatePath(rootDir: string, env: Env = process.env): string {
  const base = nonEmpty(env.XDG_STATE_HOME) ?? join(homedir(), '.local', 'state')
  let real: string
  try {
    real = realpathSync(rootDir)
  } catch {
    real = resolve(rootDir)
  }
  const key = createHash('sha256').update(real).digest('hex').slice(0, 32)
  return join(base, 'sofar', 'sync', `${key}.json`)
}

/**
 * Cursor state for this clone against {api_url, repo_id}. Missing, corrupt,
 * or belonging to a DIFFERENT api_url/repo_id (relink, env override) → a
 * fresh empty state: discarding cursors is always safe, re-push/re-pull
 * dedupe by event id.
 */
export function readSyncState(
  rootDir: string,
  target: { api_url: string; repo_id: string },
  env: Env = process.env,
): SyncState {
  const fresh: SyncState = {
    version: 1,
    api_url: normalizeApiUrl(target.api_url),
    repo_id: target.repo_id,
    streams: {},
  }
  const path = syncStatePath(rootDir, env)
  if (!existsSync(path)) return fresh
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fresh
  }
  const state = decoded as Partial<SyncState> | null
  if (
    typeof state !== 'object' || state === null ||
    state.api_url !== fresh.api_url ||
    state.repo_id !== fresh.repo_id ||
    typeof state.streams !== 'object' || state.streams === null
  ) {
    return fresh
  }
  const streams: Record<string, StreamCursors> = {}
  for (const [slug, cursors] of Object.entries(state.streams as Record<string, unknown>)) {
    if (typeof cursors !== 'object' || cursors === null) continue
    const { pushed, pulled } = cursors as StreamCursors
    streams[slug] = {
      ...(typeof pushed === 'string' && pushed.length > 0 ? { pushed } : {}),
      ...(typeof pulled === 'string' && pulled.length > 0 ? { pulled } : {}),
    }
  }
  return { ...fresh, streams }
}

export function writeSyncState(rootDir: string, state: SyncState, env: Env = process.env): void {
  const path = syncStatePath(rootDir, env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
