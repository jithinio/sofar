import { existsSync, readFileSync } from 'node:fs'
import { readCredential, readRemote, resolveApiUrl, userConfigPath, type Env } from './config'
import { ApiError, apiRequest, readJsonCapped, toApiError, type FetchLike } from './http'
import { assertSafeWebUrl } from './url'
import {
  redactState,
  type JudgeProvider,
  type ProviderResponse,
  type WireAnswer,
  type WireRequest,
} from '../core/judge'

/**
 * Cloud judge provider (typed-judge 2.3, SPEC §Judge, Providers).
 *
 * The client half of sofar-cloud's judge endpoint, and the ONLY
 * non-deterministic provider the engine ships (typed-judge D2): no model key
 * is read here, no model host is named here. The server enforces the plan and
 * calls the model; this file only asks and hears the answer or a "no".
 *
 * Everything is best-effort by construction. The seam (core/judge.ts) turns any
 * throw from `judge()` into abstentions plus a `fell_back` reason, so this
 * file's job on failure is just to throw with a clear message — never to retry
 * (no retry loop inside a tool call) and never to interpret 402/403 (the engine
 * holds no entitlement logic, drive-visibility D6).
 *
 * Imported by MCP tools, the driver, pull and offline commands only. Nothing on
 * the hot path may reach it, since it reaches core/judge.ts (typed-judge D1, pinned
 * in test/judge.test.ts).
 */

export const CLOUD_PROVIDER = 'cloud'

/** Repo-scoped so the server can tell which org's plan pays for the call (typed-judge D3). */
export function judgePath(repoId: string): string {
  return `/v1/repos/${encodeURIComponent(repoId)}/judge`
}

/** Longest model string accepted; it is stamped on every answer and every stored judgement. */
const MAX_MODEL_CHARS = 128
/** fell_back lands in tool results; a server's error text is clipped to this. */
const MAX_REASON_CHARS = 200

export interface CloudJudgeOptions {
  apiUrl: string
  repoId: string
  /** The sync client's sfr_ bearer credential. */
  token: string
  fetchImpl?: FetchLike
}

export function cloudJudgeProvider(opts: CloudJudgeOptions): JudgeProvider {
  assertSafeWebUrl(opts.apiUrl, 'api_url')
  return {
    name: CLOUD_PROVIDER,
    async judge(request: WireRequest, signal?: AbortSignal): Promise<ProviderResponse> {
      const res = await apiRequest({
        apiUrl: opts.apiUrl,
        path: judgePath(opts.repoId),
        token: opts.token,
        // The seam has already redacted. Redact again here because this function
        // can be called without the seam, and redacting twice changes nothing.
        json: { state: redactState(request.state), questions: request.questions },
        accept: 'application/json',
        ...(signal !== undefined ? { signal } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      })
      if (!res.ok) {
        const err = await toApiError(res)
        throw new ApiError(err.status, err.code, describe(err), err.retryAfterMs)
      }
      return toProviderResponse(await readJsonCapped(res))
    },
  }
}

/** "HTTP 402 plan_required: …" — status always, code and message only when they add something. */
function describe(err: ApiError): string {
  const head = `HTTP ${err.status}`
  const code = err.code === `http_${err.status}` ? '' : ` ${err.code}`
  const message = err.message === err.code || err.message === head ? '' : `: ${err.message}`
  const text = `${head}${code}${message}`
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text
}

/**
 * Accept the body only if it has the envelope: a pinned model string and an
 * answers object. Each answer is then checked by the seam's `normalize`, which
 * throws out any answer that does not fit its question.
 */
function toProviderResponse(body: unknown): ProviderResponse {
  if (typeof body !== 'object' || body === null) throw new Error('malformed response')
  const b = body as Record<string, unknown>
  const answers = b.answers
  if (
    typeof b.model !== 'string' || b.model.length === 0 || b.model.length > MAX_MODEL_CHARS ||
    typeof answers !== 'object' || answers === null || Array.isArray(answers)
  ) {
    throw new Error('malformed response')
  }
  const usage = usageOf(b.usage)
  return { model: b.model, answers: answers as Record<string, WireAnswer>, ...(usage ? { usage } : {}) }
}

function usageOf(raw: unknown): ProviderResponse['usage'] {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { input_tokens, output_tokens } = raw as Record<string, unknown>
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const usage = {
    ...(count(input_tokens) ? { input_tokens } : {}),
    ...(count(output_tokens) ? { output_tokens } : {}),
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

// ---------------------------------------------------------------------------
// Which provider a call gets — `judge.provider` in ~/.config/sofar/config.json.
// ---------------------------------------------------------------------------

export type JudgeSetting = 'deterministic' | 'cloud'

/**
 * Only `{"judge": {"provider": "cloud"}}` opts in. A missing, unreadable or
 * misspelled setting means deterministic: an unreadable config is not consent.
 */
export function readJudgeSetting(env: Env = process.env): JudgeSetting {
  const path = userConfigPath(env)
  if (!existsSync(path)) return 'deterministic'
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as { judge?: { provider?: unknown } } | null
    return typeof decoded === 'object' && decoded !== null && decoded.judge?.provider === CLOUD_PROVIDER
      ? 'cloud'
      : 'deterministic'
  } catch {
    return 'deterministic'
  }
}

export interface JudgeProviderResolution {
  /** Hand this to the seam; undefined means deterministic only. */
  provider?: JudgeProvider
  /**
   * Set only when the operator opted in and the cloud provider still cannot
   * run: why, and the command that fixes it. Callers may show it; the judge
   * runs deterministic either way.
   */
  unavailable?: string
}

/**
 * The provider for a judge call from this repo: `cloud` only when the operator
 * chose it AND the repo is linked AND they are logged in to its api_url
 * (same resolution and https rule as push/pull). Never throws.
 */
export function resolveJudgeProvider(
  rootDir: string,
  opts: { env?: Env; fetchImpl?: FetchLike } = {},
): JudgeProviderResolution {
  const env = opts.env ?? process.env
  if (readJudgeSetting(env) !== 'cloud') return {}
  const why = (reason: string): JudgeProviderResolution => ({
    unavailable: `judge.provider is "cloud" but ${reason}; judging deterministically`,
  })
  try {
    const remote = readRemote(rootDir)
    if (remote === null) return why('this repo is not linked — run `sofar link --org <org>`')
    const apiUrl = resolveApiUrl({ remote, env })
    const credential = readCredential(apiUrl, env)
    if (credential === null) return why(`you are not logged in to ${apiUrl} — run \`sofar login\``)
    return {
      provider: cloudJudgeProvider({
        apiUrl,
        repoId: remote.repo_id,
        token: credential.token,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      }),
    }
  } catch (err) {
    return why(err instanceof Error ? err.message : String(err))
  }
}
