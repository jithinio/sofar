/**
 * Judge seam (typed-judge 2.1 / 2.2, SPEC §Judge).
 *
 * A judgement is a typed question — noul (yes/no), choice (one of a set),
 * score (a position on ordered levels) — answered over a bounded state with
 * a probability attached. The shape is TypeSafe's System One wire, adopted as
 * sofar's own interface so a question answered by a RULE today can be
 * answered by a MODEL tomorrow without its caller changing.
 *
 * Three properties, each enforced here rather than left to callers:
 *
 * 1. CODE DECIDES, THE MODEL JUDGES THE REST. Every question may carry a
 *    `decide` rule. The seam runs every rule first; a question a rule decides
 *    is answered with confidence 1 and never forwarded. Only abstentions reach
 *    a non-deterministic provider, in one fan-out request. This is what makes
 *    "a judge never removes what a lexical rule put there" structural.
 * 2. ADVISORY, BEST-EFFORT. A provider that throws, times out or answers
 *    malformed leaves its questions ABSTAINED and names the reason in
 *    `fell_back`; nothing here throws for a provider's failure. Validation
 *    errors (a caller's bug: bad ids, wrong key counts, oversized state) DO
 *    throw, typed, before any provider runs.
 * 3. NEVER ON THE HOT PATH. This module is imported by MCP tools, the driver,
 *    pull commands and offline commands only; hooks, projections, the fold
 *    and the fast/statusline CLI never reach it (typed-judge D1, pinned by
 *    test/judge.test.ts). A hook that needs a judgement reads one that was
 *    made earlier at write time.
 *
 * No provider here calls a model. The deterministic provider is the runner of
 * `decide` rules and nothing else; the cloud provider (2.3) is the client half
 * of api.sofar.sh's judge endpoint (typed-judge D2) and lives beside the sync
 * client, not here.
 */

import { redactCommand } from './redact'

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
/** Text only: a string, a JSON object of named fields (preferred), or an array. */
export type JudgeState = string | Json[] | { [key: string]: Json }

export interface NoulQuestion {
  type: 'noul'
  instructions: Json
  criteria?: { true?: Json; false?: Json }
}
export interface ChoiceQuestion {
  type: 'choice'
  instructions: Json
  /** 2–255 keys; a value describes the option (or null). Always include a no-match key. */
  criteria: Record<string, Json | null>
}
export interface ScoreQuestion {
  type: 'score'
  instructions: Json
  /** 2–10 ordered levels, each a concrete situation. */
  criteria: Json[]
}
/** What a provider sees: exactly the wire, nothing engine-only. */
export type WireQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion
/**
 * What a caller builds: the wire question plus the engine-only RULE that
 * answers it without a model, or returns null to abstain. Stripped before any
 * provider is sent the question.
 */
export type Question = WireQuestion & { decide?: (state: JudgeState) => WireAnswer | null }

export interface NoulAnswer {
  type: 'noul'
  /** P(yes) in [0, 1]; 0.5 is UNDECIDED, never "medium". */
  noul: number
}
export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}
export interface ScoreAnswer {
  type: 'score'
  /** Probability-weighted level index; may fall between levels. */
  score: number
  probabilities: Record<string, number>
  legend: Record<string, string>
  confidence: number
}
export type WireAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** rule: a `decide` answered it · abstain: nobody did · model: a provider did. */
export type AnswerOrigin = 'rule' | 'abstain' | 'model'
export type Answer = WireAnswer & { origin: AnswerOrigin; model?: string }

export interface JudgeRequest {
  state: JudgeState
  questions: Record<string, Question>
}
export interface WireRequest {
  state: JudgeState
  questions: Record<string, WireQuestion>
}
export interface ProviderResponse {
  /** The exact model version that answered — never an alias. */
  model: string
  answers: Record<string, WireAnswer>
  usage?: { input_tokens?: number; output_tokens?: number }
}
export interface JudgeProvider {
  readonly name: string
  /** `signal` fires when the seam's timeout does, so a provider holding a socket lets it go. */
  judge(request: WireRequest, signal?: AbortSignal): Promise<ProviderResponse>
}
export interface JudgeResponse {
  answers: Record<string, Answer>
  /** Which provider the abstentions were offered to; `deterministic` when none. */
  provider: string
  model?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  /** Set when a non-deterministic provider was configured and could not answer. */
  fell_back?: string
  /** Non-fatal oddities: a rule that threw, a provider answer that did not parse. */
  warnings: string[]
}

export type JudgeErrorCode = 'invalid_id' | 'invalid_question' | 'state_too_large'
export class JudgeError extends Error {
  constructor(
    readonly code: JudgeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'JudgeError'
  }
}

/** Serialized-state ceiling (SPEC §Judge, State): mis-scoped requests are refused here, not truncated upstream. */
export const STATE_CHAR_CEILING = 100_000
export const CHOICE_KEYS = { min: 2, max: 255 } as const
export const SCORE_LEVELS = { min: 2, max: 10 } as const
/** Default wait on a non-deterministic provider inside a tool call; no retry. */
export const DEFAULT_TIMEOUT_MS = 10_000
const ID_RE = /^[A-Za-z0-9_]+$/

/**
 * Thresholds measured on this repo's record against jev-1.13.0 (typed-judge
 * 1.1 / 1.2). Named for the model version; re-measure on every new one.
 */
export const THRESHOLDS = {
  measured_against: 'jev-1.13.0',
  /** A relevance noul carries a candidate at or above this (86% agreement measured). */
  relevance_carry: 0.8,
  /** …and drops one at or below this; between, the deterministic order decides. */
  relevance_drop: 0.2,
  /** "Reads as a standing rule" hint renders only at or above this, with no rule set. */
  constraint_hint: 0.95,
  /** Nothing acts below this confidence on any question. */
  min_confidence: 0.6,
} as const

/** The wire's own statistic: 0 for uniform, 1 for a point mass. */
export function confidenceOf(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities)
  const n = values.length
  if (n < 2) return 0
  const pmax = Math.max(...values)
  const c = (n * pmax - 1) / (n - 1)
  return c < 0 ? 0 : c > 1 ? 1 : c
}

/** Engine convenience for gating a noul; the wire carries none. */
export function noulConfidence(p: number): number {
  return Math.abs(p - 0.5) * 2
}

/** Apply the command redactor to every string leaf; the shape is preserved. */
export function redactState(state: JudgeState): JudgeState {
  return redactJson(state) as JudgeState
}
function redactJson(value: Json): Json {
  if (typeof value === 'string') return redactCommand(value)
  if (Array.isArray(value)) return value.map(redactJson)
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactJson(v)
    return out
  }
  return value
}

// ---------------------------------------------------------------- validation

export function validateRequest(request: JudgeRequest): void {
  const serialized = JSON.stringify(request.state)
  if (serialized === undefined) throw new JudgeError('invalid_question', 'state is not JSON-serializable')
  if (serialized.length > STATE_CHAR_CEILING)
    throw new JudgeError(
      'state_too_large',
      `state serializes to ${serialized.length} chars; the ceiling is ${STATE_CHAR_CEILING} — select candidates before judging`,
    )
  const ids = Object.keys(request.questions)
  if (ids.length === 0) throw new JudgeError('invalid_question', 'a request carries at least one question')
  for (const id of ids) {
    if (!ID_RE.test(id)) throw new JudgeError('invalid_id', `question id ${JSON.stringify(id)} must match [A-Za-z0-9_]+`)
    validateQuestion(id, request.questions[id]!)
  }
}

function validateQuestion(id: string, q: Question): void {
  if (q.instructions === undefined) throw new JudgeError('invalid_question', `${id}: instructions are required`)
  switch (q.type) {
    case 'noul':
      return
    case 'choice': {
      const keys = Object.keys(q.criteria ?? {})
      if (keys.length < CHOICE_KEYS.min || keys.length > CHOICE_KEYS.max)
        throw new JudgeError('invalid_question', `${id}: a choice needs ${CHOICE_KEYS.min}–${CHOICE_KEYS.max} options, got ${keys.length}`)
      return
    }
    case 'score': {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0
      if (n < SCORE_LEVELS.min || n > SCORE_LEVELS.max)
        throw new JudgeError('invalid_question', `${id}: a score needs ${SCORE_LEVELS.min}–${SCORE_LEVELS.max} levels, got ${n}`)
      return
    }
    default:
      throw new JudgeError('invalid_question', `${id}: unknown question type ${JSON.stringify((q as { type: unknown }).type)}`)
  }
}

// ---------------------------------------------------------------- answers

function legendOf(q: ScoreQuestion): Record<string, string> {
  const legend: Record<string, string> = {}
  q.criteria.forEach((level, i) => {
    legend[String(i)] = typeof level === 'string' ? level : JSON.stringify(level)
  })
  return legend
}

/** noul 0.5; choice/score uniform, confidence 0, `choice` the first key — typed and deterministic. */
export function abstain(q: WireQuestion): WireAnswer {
  if (q.type === 'noul') return { type: 'noul', noul: 0.5 }
  if (q.type === 'choice') {
    const keys = Object.keys(q.criteria)
    const p = 1 / keys.length
    return { type: 'choice', choice: keys[0]!, probabilities: Object.fromEntries(keys.map((k) => [k, p])), confidence: 0 }
  }
  const n = q.criteria.length
  const p = 1 / n
  return {
    type: 'score',
    score: (n - 1) / 2,
    probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), p])),
    legend: legendOf(q),
    confidence: 0,
  }
}

/**
 * Bring a provider's (or a rule's) answer onto the question's key set, with
 * probabilities summing to 1, `choice` the argmax (first key on a tie) and
 * confidence RECOMPUTED — a provider's own number is never trusted. Returns
 * null when the answer is not usable for this question.
 */
export function normalize(q: WireQuestion, raw: unknown): WireAnswer | null {
  if (typeof raw !== 'object' || raw === null) return null
  const a = raw as Record<string, unknown>
  if (a.type !== undefined && a.type !== q.type) return null
  if (q.type === 'noul') {
    const p = typeof a.noul === 'number' ? a.noul : Number.NaN
    if (!Number.isFinite(p)) return null
    return { type: 'noul', noul: p < 0 ? 0 : p > 1 ? 1 : p }
  }
  const keys = q.type === 'choice' ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
  const probabilities = onto(keys, a.probabilities, q.type === 'choice' ? a.choice : undefined)
  if (!probabilities) return null
  const confidence = confidenceOf(probabilities)
  if (q.type === 'choice') {
    let best = keys[0]!
    for (const k of keys) if (probabilities[k]! > probabilities[best]!) best = k
    return { type: 'choice', choice: best, probabilities, confidence }
  }
  let score = 0
  keys.forEach((k, i) => {
    score += i * probabilities[k]!
  })
  return { type: 'score', score, probabilities, legend: legendOf(q), confidence }
}

/** Project `raw` probabilities onto `keys`; a bare `choice` with no distribution is a point mass. */
function onto(keys: string[], raw: unknown, bareChoice: unknown): Record<string, number> | null {
  const out: Record<string, number> = {}
  let sum = 0
  if (typeof raw === 'object' && raw !== null) {
    for (const k of keys) {
      const v = (raw as Record<string, unknown>)[k]
      const p = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
      out[k] = p
      sum += p
    }
  } else if (typeof bareChoice === 'string' && keys.includes(bareChoice)) {
    for (const k of keys) out[k] = k === bareChoice ? 1 : 0
    sum = 1
  } else {
    return null
  }
  if (sum <= 0) return null
  for (const k of keys) out[k] = out[k]! / sum
  return out
}

/** A rule DECIDES: snap to confidence 1 (noul 0|1, choice/score a point mass on the argmax). */
function snap(q: WireQuestion, a: WireAnswer): WireAnswer {
  if (a.type === 'noul') return { type: 'noul', noul: a.noul >= 0.5 ? 1 : 0 }
  const keys = Object.keys(a.probabilities)
  let best = keys[0]!
  for (const k of keys) if (a.probabilities[k]! > a.probabilities[best]!) best = k
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === best ? 1 : 0]))
  if (a.type === 'choice') return { type: 'choice', choice: best, probabilities, confidence: 1 }
  return { type: 'score', score: keys.indexOf(best), probabilities, legend: legendOf(q as ScoreQuestion), confidence: 1 }
}

// ---------------------------------------------------------------- the seam

export interface JudgeOptions {
  /** A non-deterministic provider to offer the abstentions to; omitted = deterministic only. */
  provider?: JudgeProvider
  timeoutMs?: number
}

export const DETERMINISTIC = 'deterministic'

/** The `producer` a stored judgement names when the `cloud` provider answered it (typed-judge D4). */
export const CLOUD_PRODUCER = 'sofar-cloud'

/**
 * Run every rule; offer only the abstentions to `opts.provider` (if any) in
 * one request; never throw for a provider's failure. Same request, same
 * rules, no provider → deep-equal response.
 */
export async function judge(request: JudgeRequest, opts: JudgeOptions = {}): Promise<JudgeResponse> {
  validateRequest(request)
  const warnings: string[] = []
  const answers: Record<string, Answer> = {}
  const open: string[] = []
  for (const [id, q] of Object.entries(request.questions)) {
    const wire = stripRule(q)
    let decided: WireAnswer | null = null
    if (q.decide) {
      try {
        const raw = q.decide(request.state)
        if (raw !== null) {
          decided = normalize(wire, raw)
          if (!decided) warnings.push(`${id}: rule answered with the wrong shape; treated as abstain`)
        }
      } catch (err) {
        warnings.push(`${id}: rule threw (${err instanceof Error ? err.message : String(err)}); treated as abstain`)
      }
    }
    if (decided) answers[id] = { ...snap(wire, decided), origin: 'rule' }
    else {
      answers[id] = { ...abstain(wire), origin: 'abstain' }
      open.push(id)
    }
  }

  const provider = opts.provider
  if (!provider || provider.name === DETERMINISTIC || open.length === 0) {
    return { answers, provider: DETERMINISTIC, warnings }
  }

  const forwarded: Record<string, WireQuestion> = {}
  for (const id of open) forwarded[id] = stripRule(request.questions[id]!)
  const wireRequest: WireRequest = { state: redactState(request.state), questions: forwarded }
  let response: ProviderResponse
  const abort = new AbortController()
  try {
    response = await withTimeout(
      provider.judge(wireRequest, abort.signal),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      provider.name,
      () => abort.abort(),
    )
  } catch (err) {
    return {
      answers,
      provider: provider.name,
      fell_back: `${provider.name}: ${err instanceof Error ? err.message : String(err)}`,
      warnings,
    }
  }
  const model = typeof response?.model === 'string' && response.model.length > 0 ? response.model : undefined
  if (!model || typeof response.answers !== 'object' || response.answers === null) {
    return { answers, provider: provider.name, fell_back: `${provider.name}: malformed response`, warnings }
  }
  for (const id of open) {
    const normalized = normalize(forwarded[id]!, response.answers[id])
    if (normalized) answers[id] = { ...normalized, origin: 'model', model }
    else warnings.push(`${id}: ${provider.name} returned no usable answer; left abstained`)
  }
  return { answers, provider: provider.name, model, usage: response.usage, warnings }
}

function stripRule(q: Question): WireQuestion {
  const { decide: _decide, ...wire } = q
  return wire as WireQuestion
}

function withTimeout<T>(p: Promise<T>, ms: number, who: string, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`timed out after ${ms}ms`))
      onTimeout()
    }, ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new Error(`${who} failed: ${String(e)}`))
      },
    )
  })
}
