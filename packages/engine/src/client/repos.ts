import { apiJson, type FetchLike } from './http'

/**
 * `sofar link` core (sync-client 2.2, SPEC §Sync client): POST /v1/repos is
 * idempotent on org+name — 201 on create, 200 on the existing repo, either
 * way {repo_id}. A 404 means "no such org OR not a member" — the server
 * deliberately does not distinguish (cross-org probes must learn nothing),
 * so caller copy must not pretend to.
 */

export interface CreateRepoOptions {
  apiUrl: string
  token: string
  org: string
  name: string
  fetchImpl?: FetchLike
}

export async function createRepo(opts: CreateRepoOptions): Promise<{ repo_id: string }> {
  const raw = await apiJson<{ repo_id?: unknown }>({
    apiUrl: opts.apiUrl,
    path: '/v1/repos',
    token: opts.token,
    json: { org: opts.org, name: opts.name },
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  })
  if (typeof raw.repo_id !== 'string' || raw.repo_id.length === 0) {
    throw new Error('the server accepted the link but returned no repo_id')
  }
  return { repo_id: raw.repo_id }
}
