import { createHash } from 'node:crypto'
import type { JudgementAnswer } from '@sofar/schema'
import { JUDGE_TEXT_CHARS, JUDGE_WARN_P } from '../core/decision-judge'
import { CLOUD_PRODUCER, judge, redactState, THRESHOLDS, type Answer, type JudgeOptions, type JudgeState, type Question } from '../core/judge'

/**
 * Driver pre-flight (typed-judge 4.2 and 4.3, catalogue B3/B4, D12).
 *
 * Before each launch, and only with a `cloud` provider configured, the driver
 * asks three questions about the task it is about to run, over the task alone:
 *
 * - `specified` (B3), a noul: could a session act on it without first asking
 *   the operator?
 * - `complexity` (B4), a score on four described levels, mapped to an effort.
 * - `model` (B4), a choice of model tier: fast, standard, strongest, or no
 *   preference (the no-match option).
 *
 * ADVISORY (D1, and the user's ruling D12). The launch goes ahead exactly as
 * routed: an underspecified task is not stopped as needs_user, and a hint is
 * never applied. The model's answers are stored as judgement_recorded (subject
 * = the task id) and printed. A warning renders when the task reads as
 * underspecified. A route hint renders only for an effort or model the run and
 * route left open, and only where the adapter honours that field, because a
 * hint on something already pinned says nothing the operator can use.
 */

export interface PreflightInput {
  task: { id: string; title: string; phase: string }
  /** The last acceptance check's line when the task was reopened (r1-fixes D19). */
  failure?: string
}

/** What the route left open, and whether the adapter would honour a value there. */
export interface OpenRoute {
  effort: boolean
  model: boolean
}

export const COMPLEXITY_LEVELS = [
  'A small local change: one file or a few lines, with an obvious approach',
  'A contained change across a few files in one area, with a known approach',
  'A change across several modules or a contract, needing design choices and new tests',
  'An open-ended or cross-cutting change: architecture, a migration, or an unclear approach',
]

/** Complexity level → the effort vocabulary every adapter that honours effort accepts. */
export const EFFORT_FOR_LEVEL = ['low', 'medium', 'high', 'high'] as const

export const MODEL_TIERS = {
  fast: { what: 'A fast, low-cost model is enough: mechanical or fully specified work.' },
  standard: { what: 'A standard model: ordinary implementation with some judgement.' },
  strongest: { what: 'The strongest model available: hard reasoning, design or debugging.' },
  no_preference: { what: 'Nothing in the task suggests a tier.' },
}

function clip(text: string, max = JUDGE_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

type Request = { state: JudgeState; questions: Record<string, Question> }

export function preflightRequest(input: PreflightInput): Request {
  return {
    state: {
      task: clip(`${input.task.id} ${input.task.title}`, JUDGE_TEXT_CHARS * 3),
      phase: clip(input.task.phase),
      ...(input.failure !== undefined ? { last_check: clip(input.failure) } : {}),
    },
    questions: {
      specified: {
        type: 'noul',
        instructions:
          'Could a session act on `task` without first asking the operator anything: does it say what to build or change, and how to tell when it is done? `last_check`, when present, is why the previous attempt was rejected.',
        criteria: {
          true: '`task` names what to build or change and what done looks like, or both follow directly from its words',
          false: '`task` is a placeholder, names only a topic, or leaves a choice only the operator can make',
        },
      },
      complexity: { type: 'score', instructions: 'How large and uncertain is the work `task` asks for?', criteria: [...COMPLEXITY_LEVELS] },
      model: { type: 'choice', instructions: 'Which model tier does the work in `task` call for?', criteria: MODEL_TIERS },
    },
  }
}

export interface PreflightVerdict {
  judgements: Array<{ producer: string; model: string; question: string; subject: string; answer: JudgementAnswer; state_hash: string }>
  lines: string[]
}

function stored(a: Answer): JudgementAnswer {
  if (a.type === 'noul') return { type: 'noul', noul: a.noul }
  if (a.type === 'choice') return { type: 'choice', choice: a.choice, probabilities: a.probabilities, confidence: a.confidence }
  return { type: 'score', score: a.score, probabilities: a.probabilities, confidence: a.confidence }
}

/** Judge one task before its launch. Never throws: a failed provider yields no verdict and the launch proceeds. */
export async function judgePreflight(input: PreflightInput, open: OpenRoute, opts: JudgeOptions): Promise<PreflightVerdict> {
  const request = preflightRequest(input)
  let answers: Record<string, Answer>
  try {
    answers = (await judge(request, opts)).answers
  } catch {
    return { judgements: [], lines: [] }
  }
  const stateHash = createHash('sha256').update(JSON.stringify(redactState(request.state))).digest('hex')
  const judgements: PreflightVerdict['judgements'] = []
  for (const question of ['specified', 'complexity', 'model']) {
    const a = answers[question]
    if (a === undefined || a.origin !== 'model' || a.model === undefined) continue
    judgements.push({ producer: CLOUD_PRODUCER, model: a.model, question, subject: input.task.id, answer: stored(a), state_hash: stateHash })
  }
  if (judgements.length === 0) return { judgements, lines: [] }

  const id = input.task.id
  const model = judgements[0]!.model
  const specified = answers.specified?.type === 'noul' && answers.specified.origin === 'model' ? answers.specified : undefined
  const complexity = answers.complexity?.type === 'score' && answers.complexity.origin === 'model' ? answers.complexity : undefined
  const tier = answers.model?.type === 'choice' && answers.model.origin === 'model' ? answers.model : undefined

  const parts: string[] = []
  if (specified !== undefined) parts.push(`specified p ${specified.noul.toFixed(2)}`)
  if (complexity !== undefined) parts.push(`complexity ${complexity.score.toFixed(1)} of ${COMPLEXITY_LEVELS.length - 1}`)
  if (tier !== undefined) parts.push(`model ${tier.choice} (P ${(tier.probabilities[tier.choice] ?? 0).toFixed(2)})`)
  const lines = [`  pre-flight by ${model}: ${parts.join(' · ')}`]

  if (specified !== undefined && specified.noul <= 1 - JUDGE_WARN_P) {
    lines.push(`  warning: ${id} may not be specified well enough to act on (p ${specified.noul.toFixed(2)}): the session may stop to ask; launching anyway`)
  }
  const hints: string[] = []
  if (open.effort && complexity !== undefined && complexity.confidence >= THRESHOLDS.min_confidence) {
    hints.push(`effort ${EFFORT_FOR_LEVEL[Math.min(EFFORT_FOR_LEVEL.length - 1, Math.round(complexity.score))]}`)
  }
  if (open.model && tier !== undefined && tier.choice !== 'no_preference' && tier.confidence >= THRESHOLDS.min_confidence) {
    hints.push(`a ${tier.choice} model`)
  }
  if (hints.length > 0) {
    lines.push(`  route hint for ${id}: ${hints.join(', ')}. Not applied; set route {effort, model} on the task, or --effort/--model, to use it`)
  }
  return { judgements, lines }
}
