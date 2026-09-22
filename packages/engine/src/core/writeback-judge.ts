import type { InitiativeState } from './fold'
import { judge, type Answer, type JudgeOptions, type JudgeState, type Question } from './judge'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { JUDGE_CANDIDATES, JUDGE_TEXT_CHARS, JUDGE_WARN_P } from './decision-judge'

/**
 * Write-back judge (typed-judge 3.2, catalogue A1, SPEC §Judge).
 *
 * The write-back is the event the next session reads first, so its two fields
 * are judged the moment it is appended:
 *
 * - `next_action`: a score on four described levels, from "names nothing a
 *   resumer could act on" to "executable verbatim". Only the bottom level
 *   warns: a next action that names the task but not its first step is how
 *   this record normally writes them, and flagging it would be noise.
 * - the summary: two nouls. Does it describe a decision the record does not
 *   hold? Does it state an operational fact that belongs in repo memory? The
 *   decision / fact / note split is the one agents most often get wrong, and
 *   this is the last moment the writer still holds the reasoning.
 *
 * Two requests, not one: the next action is judged against the plan's next
 * task only, and the summary against the decisions and memories it could be
 * restating. Unrelated state lowers a judge's accuracy (SPEC §Judge, State).
 *
 * Free-path rules decide only the certain cases: a next action made entirely
 * of continuation words is vague, and a summary sentence that says what was
 * chosen over what, cites no decision, in a session that logged none, is an
 * unlogged decision. Neither rule ever answers the reassuring way, because no
 * lexical test proves a next action concrete or a summary decision-free. The
 * memory noul has no rule. What the rules leave open goes to the `cloud`
 * provider when the operator opted in.
 *
 * Advisory only (typed-judge D1): the session has already ended when this
 * runs, and a line only asks the writer to write back again, log, or remember.
 * Scope is this initiative's record, as in 3.1 (typed-judge D5).
 */

export interface WritebackDraft {
  session_id: string
  summary: string
  next_action: string
}

/** Summary prose sent: long enough for a full write-back, far under the state ceiling. */
export const SUMMARY_CHARS = 6000
/** Next-action prose sent; one clipped past this is not vague. */
export const NEXT_ACTION_CHARS = 1000

/** The four levels of the next-action score, lowest first. Each is a concrete situation. */
export const NEXT_ACTION_LEVELS = [
  'Names no task, file, command or outcome, so a fresh session would have to rediscover what to do (e.g. "continue", "keep going", "finish the remaining work")',
  'Names the task or the piece of work to take up, by id or by what it builds, but not where or how to begin it',
  'Names the task and a concrete first step: the file, function, command or check to start with',
  'Is a command or an edit that can be carried out verbatim, naming its exact target, with nothing left to look up',
] as const

/**
 * Words that say "keep working" without saying on what, as the lexicon stems
 * them. A next action made only of these (and function words) names nothing.
 */
const CONTINUATION = new Set(
  Object.keys(
    lexicalCounts(
      'continue continuing keep keeping going go carry proceed resume resuming pick work working task tasks step steps ' +
        'remaining rest finish finishing wrap left thing things stuff whatever plan planned todo tbd later next etc start starting begin',
    ),
  ),
)

/**
 * The rule for the next-action score: level 0 when the text carries no digit
 * (task ids, D-handles, versions), no backtick, no path, and no term outside
 * CONTINUATION. Otherwise abstain: naming something is not the same as naming
 * a first step, and only a judge can tell those apart.
 */
export function lexicallyVague(nextAction: string): boolean {
  if (/[\d`/\\]/.test(nextAction)) return false
  return Object.keys(lexicalCounts(nextAction)).every((t) => CONTINUATION.has(t))
}

/** A verb that reports a choice, not inside an identifier like `decision.chose`. */
const CHOICE_VERB = /(?<![\w.`-])(chose|decided|ruled|opted for|settled on|went with)\b/i
/** …followed, later in the same sentence, by the alternative it was chosen over. */
const ALTERNATIVE = /\b(over|instead of|rather than)\s+\S/i
/** A decision handle, bare or qualified: the sentence is about a logged decision. */
const HANDLE = /\bD\d+\b/

/**
 * The first summary sentence that states a choice against an alternative and
 * cites no decision handle, or null. Code spans are dropped first, so field
 * names such as `chose` never read as prose.
 */
export function choiceSentence(summary: string): string | null {
  const prose = summary.replace(/`[^`]*`/g, ' ')
  for (const sentence of prose.split(/(?<=[.!?;])\s+|\n+/)) {
    const verb = CHOICE_VERB.exec(sentence)
    if (verb === null || HANDLE.test(sentence)) continue
    if (ALTERNATIVE.test(sentence.slice(verb.index + verb[0].length))) return sentence.trim()
  }
  return null
}

function clip(text: string, max = JUDGE_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The task the digest names next: the active phase's active, pending or blocked task, else the first open phase's. */
export function nextTask(state: InitiativeState): { id: string; title: string } | undefined {
  const pick = (phase: InitiativeState['phases'][number]) =>
    phase.tasks.find((t) => t.status === 'active') ?? phase.tasks.find((t) => t.status === 'pending') ?? phase.tasks.find((t) => t.status === 'blocked')
  const active = state.phases.find((p) => p.name === state.current.active_phase)
  const inActive = active !== undefined ? pick(active) : undefined
  if (inActive !== undefined) return inActive
  for (const phase of state.phases) {
    if (phase.status === 'done' || phase.status === 'dropped') continue
    const task = pick(phase)
    if (task !== undefined) return task
  }
  return undefined
}

/**
 * Records the summary could be restating: everything since the session started
 * (this session's own, and any a peer logged meanwhile), then the older ones
 * BM25-ranked against the summary, topped up newest, JUDGE_CANDIDATES in all.
 */
function related<T extends { ts: string }>(items: readonly T[], since: string | undefined, text: (item: T) => string, summary: string): Array<{ n: number; item: T }> {
  const all = items.map((item, i) => ({ n: i + 1, item }))
  const recent = since === undefined ? [] : all.filter(({ item }) => item.ts >= since)
  const older = all.filter((c) => !recent.includes(c))
  const room = Math.max(0, JUDGE_CANDIDATES - recent.length)
  if (older.length <= room) return [...older, ...recent]
  const docs: LexicalDoc[] = older.map(({ n, item }) => {
    const terms = lexicalCounts(text(item).slice(0, JUDGE_TEXT_CHARS * 2))
    return { id: String(n), ts: item.ts, terms, tokens: Object.values(terms).reduce((a, b) => a + b, 0) }
  })
  const picked = new Set(rankLexical(docs, summary, room).matches.map((m) => Number(m.id)))
  for (let i = older.length - 1; i >= 0 && picked.size < room; i--) picked.add(older[i]!.n)
  return [...older.filter((c) => picked.has(c.n)), ...recent]
}

type Request = { state: JudgeState; questions: Record<string, Question> }

/**
 * The two requests for one write-back, against the fold that already holds it.
 * `next` is null when the plan has no open task: "nothing left" is then the
 * right next action, and no level describes it.
 */
export function buildRequests(state: InitiativeState, draft: WritebackDraft): { next: Request | null; summary: Request } {
  const task = nextTask(state)
  const nextAction = clip(draft.next_action, NEXT_ACTION_CHARS)
  const next: Request | null =
    task === undefined
      ? null
      : {
          state: { next_action: nextAction, plan_next_task: clip(`${task.id} ${task.title}`) },
          questions: {
            next_action: {
              type: 'score',
              instructions:
                'How precisely does `next_action` tell a fresh session, with no memory of the one that wrote it, what to do first? `plan_next_task` is the task the plan puts next, for reference only.',
              criteria: [...NEXT_ACTION_LEVELS],
              decide: () =>
                lexicallyVague(draft.next_action)
                  ? { type: 'score', score: 0, probabilities: { '0': 1, '1': 0, '2': 0, '3': 0 }, legend: {}, confidence: 1 }
                  : null,
            },
          },
        }

  const since = state.sessions.find((s) => s.id === draft.session_id)?.started
  const decisions: Record<string, string> = {}
  for (const { n, item } of related(state.decisions, since, (d) => `${d.chose} ${d.over}`, draft.summary)) {
    decisions[`D${n}`] = `${clip(item.chose, 240)} — over: ${clip(item.over, 150)}`
  }
  const live = state.memories.filter((m) => m.superseded_by === undefined)
  const memories: Record<string, string> = {}
  for (const { item } of related(live, since, (m) => m.text, draft.summary)) {
    memories[`M${state.memories.indexOf(item) + 1}`] = clip(item.text)
  }
  // The rule needs to know the session logged nothing; an unknown session start leaves that unknown.
  const loggedNone = since !== undefined && !state.decisions.some((d) => d.ts >= since)
  const summary: Request = {
    state: { summary: clip(draft.summary, SUMMARY_CHARS), decisions, memories },
    questions: {
      unlogged_decision: {
        type: 'noul',
        instructions:
          'Does `summary` report a design decision made in this session (something chosen, ruled or settled over an alternative) that none of `decisions` records?',
        criteria: {
          true: '`summary` says a choice was made between alternatives, and no entry of `decisions` records that choice in any words',
          false:
            '`summary` reports work done, findings or answers; or every choice it reports is already in `decisions` or cited by its D-number; or it only follows an earlier decision',
        },
        decide: () => (loggedNone && choiceSentence(draft.summary) !== null ? { type: 'noul', noul: 1 } : null),
      },
      memory_fact: {
        type: 'noul',
        instructions:
          'Does `summary` state an operational fact that later sessions in this repo will need and that none of `memories` already holds: a build, test or release command, a failure mode and how it is diagnosed, or a convention every session must follow?',
        criteria: {
          true: '`summary` states such a fact in reusable form, and no entry of `memories` holds it',
          false:
            '`summary` reports what was built, decided or answered; or the fact only mattered to this session; or an entry of `memories` already holds it',
        },
      },
    },
  }
  return { next, summary }
}

async function answersOf(request: Request | null, opts: JudgeOptions): Promise<Record<string, Answer>> {
  if (request === null) return {}
  try {
    return (await judge(request, opts)).answers
  } catch {
    return {}
  }
}

/** How a noul came to warn: the rule's reason, or the model's p and exact version. */
function how(a: Answer & { type: 'noul' }, rule: string): string {
  return a.origin === 'rule' ? rule : `judged p ${a.noul.toFixed(2)} by ${a.model ?? 'model'}`
}

/**
 * Warning lines for one write-back, in field order: next action, unlogged
 * decision, repo-memory fact. Never throws: a failed or mis-built request
 * yields no lines rather than a failed tool call.
 */
export async function writebackJudgeWarnings(state: InitiativeState, draft: WritebackDraft, opts: JudgeOptions = {}): Promise<string[]> {
  let built: ReturnType<typeof buildRequests>
  try {
    built = buildRequests(state, draft)
  } catch {
    return []
  }
  const [next, summary] = await Promise.all([answersOf(built.next, opts), answersOf(built.summary, opts)])
  const lines: string[] = []

  const score = next.next_action
  if (score?.type === 'score' && score.origin !== 'abstain') {
    const p = score.probabilities['0'] ?? 0
    if (p >= JUDGE_WARN_P) {
      const task = nextTask(state)
      lines.push(
        `next_action may be too vague to resume from (${score.origin === 'rule' ? 'names no task, file or command' : `judged P(vague) ${p.toFixed(2)} by ${score.model ?? 'model'}`}): "${clip(draft.next_action, 160)}". Write back again with one that names the task${task !== undefined ? ` (next in the plan: ${task.id})` : ''} and its first concrete step.`,
      )
    }
  }

  const decision = summary.unlogged_decision
  if (decision?.type === 'noul' && decision.origin !== 'abstain' && decision.noul >= JUDGE_WARN_P) {
    const sentence = decision.origin === 'rule' ? choiceSentence(draft.summary) : null
    lines.push(
      `The summary may report a decision the record does not hold (${how(decision, 'no decision logged this session')})${sentence !== null ? `: "${clip(sentence, 160)}"` : ''}. Log it with sofar_log_decision (chose, over, because); if it is already recorded, ignore this.`,
    )
  }

  const fact = summary.memory_fact
  if (fact?.type === 'noul' && fact.origin !== 'abstain' && fact.noul >= JUDGE_WARN_P) {
    lines.push(
      `The summary may state an operational fact later sessions need (${how(fact, 'rule')}). Promote it with sofar_remember; if it only mattered to this session, ignore this.`,
    )
  }
  return lines
}
