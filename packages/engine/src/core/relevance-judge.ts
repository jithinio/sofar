import { createHash } from 'node:crypto'
import type { JudgementRecordedPayload } from '@sofar/schema'
import { JUDGE_CANDIDATES, JUDGE_TEXT_CHARS } from './decision-judge'
import type { InitiativeState } from './fold'
import { CLOUD_PRODUCER, judge, redactState, type JudgeOptions, type JudgeState, type Question } from './judge'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { retiredOrdinals } from './retire'
import { nextTask } from './writeback-judge'

/**
 * Write-back relevance pass (typed-judge 5.1, catalogue C1, the D10 contract).
 *
 * At write-back the next task is known, so it is the moment to ask which of
 * this record's decisions, memories and notes a session doing that task needs.
 * The answer is STORED, as judgement_recorded {question: "relevance", about:
 * "task:<id>"}, because its readers run on hooks (the SessionStart digest in
 * 5.3, memory-lead B1), where no judge may run (D1). core/index-relevance.ts is
 * how they read it.
 *
 * Only a MODEL answer is stored, and only with a `cloud` provider configured:
 * the deterministic order (lexical, structural) is already what every reader
 * falls back to, so the free path has nothing to add and writes nothing (D4).
 * One request per write-back: one noul per candidate, over {task, candidates},
 * the question 1.1 measured at 86% agreement at p >= 0.8. Code selects the
 * candidates first: 8 per kind, BM25-ranked against the task, topped up with
 * the newest. Retired decisions are never candidates.
 *
 * Adjacent initiatives (C2) are not candidates in this pass (typed-judge D11).
 */

export interface NoteCandidate {
  /** The note_added event id: a note's subject (D10). */
  id: string
  ts: string
  text: string
}

interface Candidate {
  /** State key and question suffix: `D12`, `M3`, `N1`. */
  key: string
  /** What the row stores as `subject` (D10): bare `D12` in its own record, `<slug> M3`, a note's event id. */
  subject: string
  ts: string
  text: string
}

function clip(text: string, max = JUDGE_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The best JUDGE_CANDIDATES by BM25 against `query`, topped up with the newest, in their original order. */
function pick(items: readonly Candidate[], query: string): Candidate[] {
  if (items.length <= JUDGE_CANDIDATES) return [...items]
  const docs: LexicalDoc[] = items.map((c, i) => {
    const terms = lexicalCounts(c.text.slice(0, JUDGE_TEXT_CHARS * 2))
    return { id: String(i), ts: c.ts, terms, tokens: Object.values(terms).reduce((a, b) => a + b, 0) }
  })
  const picked = new Set(rankLexical(docs, query, JUDGE_CANDIDATES).matches.map((m) => Number(m.id)))
  for (let i = items.length - 1; i >= 0 && picked.size < JUDGE_CANDIDATES; i--) picked.add(i)
  return items.filter((_, i) => picked.has(i))
}

/** The request for one write-back, or null when there is no next task or nothing to rank. */
export function relevanceRequest(
  state: InitiativeState,
  notes: readonly NoteCandidate[],
): { task: { id: string; title: string }; request: { state: JudgeState; questions: Record<string, Question> }; asked: Candidate[] } | null {
  const task = nextTask(state)
  if (task === undefined) return null
  const query = `${task.id} ${task.title}`
  const retired = retiredOrdinals(state)
  const decisions = pick(
    state.decisions
      .map((d, i) => ({ d, n: i + 1 }))
      .filter(({ n }) => !retired.has(n))
      .map(({ d, n }) => ({ key: `D${n}`, subject: `D${n}`, ts: d.ts, text: `${d.chose} — over: ${d.over}${d.rule !== undefined ? ` — rule: ${d.rule}` : ''}` })),
    query,
  )
  const memories = pick(
    state.memories
      .map((m, i) => ({ m, n: i + 1 }))
      .filter(({ m }) => m.superseded_by === undefined)
      .map(({ m, n }) => ({ key: `M${n}`, subject: `${state.slug} M${n}`, ts: m.ts, text: m.text })),
    query,
  )
  const noted = pick(
    notes.map((note) => ({ key: '', subject: note.id, ts: note.ts, text: note.text })),
    query,
  ).map((c, i) => ({ ...c, key: `N${i + 1}` }))
  const asked = [...decisions, ...memories, ...noted]
  if (asked.length === 0) return null

  const candidates: Record<string, string> = {}
  const questions: Record<string, Question> = {}
  for (const c of asked) {
    candidates[c.key] = clip(c.text)
    questions[`rel_${c.key}`] = {
      type: 'noul',
      instructions: `Would a session doing \`task\` need to know \`candidates.${c.key}\`: does it constrain, explain or change how \`task\` should be done?`,
      criteria: {
        true: `\`candidates.${c.key}\` is a choice, rule, fact or finding a session doing \`task\` must follow or would otherwise rediscover`,
        false: `\`candidates.${c.key}\` is about other work, or only shares words with \`task\``,
      },
    }
  }
  return { task, request: { state: { task: clip(query, JUDGE_TEXT_CHARS * 2), candidates }, questions }, asked }
}

/**
 * The judgement_recorded payloads for one write-back: the model's answers only.
 * Empty without a provider, without a next task, or when the provider fails;
 * never throws.
 */
export async function relevanceJudgements(
  state: InitiativeState,
  notes: readonly NoteCandidate[],
  opts: JudgeOptions,
): Promise<JudgementRecordedPayload[]> {
  if (opts.provider === undefined) return []
  let built: ReturnType<typeof relevanceRequest>
  try {
    built = relevanceRequest(state, notes)
  } catch {
    return []
  }
  if (built === null) return []
  let answers: Awaited<ReturnType<typeof judge>>['answers']
  try {
    answers = (await judge(built.request, opts)).answers
  } catch {
    return []
  }
  const stateHash = createHash('sha256').update(JSON.stringify(redactState(built.request.state))).digest('hex')
  const out: JudgementRecordedPayload[] = []
  for (const c of built.asked) {
    const a = answers[`rel_${c.key}`]
    if (a === undefined || a.origin !== 'model' || a.type !== 'noul' || a.model === undefined) continue
    out.push({
      producer: CLOUD_PRODUCER,
      model: a.model,
      question: 'relevance',
      subject: c.subject,
      about: `task:${built.task.id}`,
      answer: { type: 'noul', noul: a.noul },
      state_hash: stateHash,
    })
  }
  return out
}
