import { judge, type Answer, type JudgeOptions, type JudgeState, type Question } from './judge'
import { lexicalCounts } from './lexicon'
import { JUDGE_TEXT_CHARS, JUDGE_WARN_P } from './decision-judge'
import { choiceSentence } from './writeback-judge'

/**
 * Filing judge (typed-judge 3.3, catalogue A4/A5, SPEC §Judge).
 *
 * Two questions asked the moment a record entry is written, each over that
 * entry alone:
 *
 * - A4 filing: is this entry a decision, an operational fact or a note? Asked
 *   of every decision, memory and note, whether it came through its own tool
 *   or a write-back's batch. The three kinds reach later sessions differently:
 *   a decision lands in the digest's decisions and ledger, a fact in repo
 *   memory, a note only in the record. So an entry filed as the wrong kind
 *   reaches the wrong readers.
 * - A5 evidence: does a task marked done cite evidence that it is done (a test
 *   run, a commit, a measurement, the acceptance criteria it met)? CLAUDE.md's
 *   "do not mark a task complete without its criteria passing", made checkable.
 *
 * Free-path rules decide only the certain cases, and only in the warning
 * direction, as in 3.1 and 3.2. A note or memory holding a "chose X over Y"
 * sentence that cites no decision is a decision. A done task with no note, or
 * a note of completion words only, cites no evidence. Nothing lexical decides
 * that a decision is really a fact or a note. What the rules leave open goes to
 * the `cloud` provider when the operator opted in.
 *
 * Advisory only (typed-judge D1): the entry is already in the log and stays
 * there. A line names what to file next; it never refuses. update_task, add_note
 * and remember stay bare unless a line renders (typed-judge D7).
 */

/** What an entry was filed as, by the tool that wrote it. */
export type FiledAs = 'decision' | 'memory' | 'note'

export interface FiledEntry {
  kind: FiledAs
  /** How a line names it: `D7`, `demo M3`, `This note`, `notes[1]`. */
  label: string
  /** A decision's three clauses, or a memory's or note's text. */
  text: string | { chose: string; over: string; because: string }
}

export interface DoneTask {
  id: string
  title: string
  note?: string
}

type Kind = 'decision' | 'operational_fact' | 'note'
const KIND_OF: Record<FiledAs, Kind> = { decision: 'decision', memory: 'operational_fact', note: 'note' }

/**
 * The three kinds, described with `what` and `not_for` because the boundaries
 * are subtle. `note` is the catch-all and doubles as the choice's no-match
 * option (SPEC §Judge, Questions).
 */
export const KIND_CRITERIA = {
  decision: {
    what: 'A choice between alternatives: what was chosen, over what, and why. It constrains or explains later work on this initiative.',
    not_for: 'A fact about how to build, test, release or diagnose this repo; context or findings that choose nothing.',
  },
  operational_fact: {
    what: 'Knowledge every later session in this repo needs to operate it: a build, test or release command, a failure mode and how it is diagnosed, a convention to follow.',
    not_for: 'A choice between alternatives; context about one piece of work; what was built.',
  },
  note: {
    what: 'Anything else: context, a finding, a status, analysis, a question, a record of what happened.',
    not_for: 'A choice between alternatives; a fact every later session needs.',
  },
}

/**
 * A done note's p(evidence) at or below this warns: the mirror of
 * JUDGE_WARN_P, since the question asks for evidence and the warning is its
 * absence. PROVISIONAL, graded in 6.1 like the rest.
 */
export const EVIDENCE_WARN_P = 0.1

/** Words that only assert completion, as the lexicon stems them. */
const COMPLETION = new Set(
  Object.keys(lexicalCounts('done finished finish complete completed implemented works working shipped ok okay lgtm good fixed task finally')),
)

/** The evidence rule: no note, or one made only of completion words, cites nothing. */
export function citesNothing(note: string | undefined): boolean {
  if (note === undefined || note.trim().length === 0) return true
  if (/[\d`/\\]/.test(note)) return false
  return Object.keys(lexicalCounts(note)).every((t) => COMPLETION.has(t))
}

function clip(text: string, max = JUDGE_TEXT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

type Request = { state: JudgeState; questions: Record<string, Question> }

/** One request per entry: the state is the entry alone, never what it was filed as. */
export function filingRequest(entry: FiledEntry): Request {
  const text = entry.text
  const state: JudgeState =
    typeof text === 'string'
      ? { entry: clip(text, JUDGE_TEXT_CHARS * 3) }
      : { entry: { chose: clip(text.chose), over: clip(text.over), because: clip(text.because) } }
  const sentence = typeof text === 'string' && entry.kind !== 'decision' ? choiceSentence(text) : null
  return {
    state,
    questions: {
      kind: {
        type: 'choice',
        instructions: 'What kind of record is `entry`?',
        criteria: KIND_CRITERIA,
        decide: () =>
          sentence !== null ? { type: 'choice', choice: 'decision', probabilities: { decision: 1, operational_fact: 0, note: 0 }, confidence: 1 } : null,
      },
    },
  }
}

export function evidenceRequest(task: DoneTask): Request {
  return {
    state: { task: clip(`${task.id} ${task.title}`), note: clip(task.note ?? '', JUDGE_TEXT_CHARS * 3) },
    questions: {
      evidence: {
        type: 'noul',
        instructions: 'Does `note` cite evidence that `task` is done: a test run and its result, a commit, a measured outcome, or the acceptance criteria it met?',
        criteria: {
          true: '`note` names a check that passed or an artifact showing the work landed: tests passing (a count or a name), a commit or PR, a measurement, the criteria met',
          false: '`note` is empty, only asserts completion, or describes what was changed without any check that it works',
        },
        decide: () => (citesNothing(task.note) ? { type: 'noul', noul: 0 } : null),
      },
    },
  }
}

async function answerOf(request: Request, id: string, opts: JudgeOptions): Promise<Answer | undefined> {
  try {
    const a = (await judge(request, opts)).answers[id]
    return a === undefined || a.origin === 'abstain' ? undefined : a
  } catch {
    return undefined
  }
}

/** How a line came to render: the rule's reason, or the model's probability and exact version. */
function how(a: Answer, rule: string, p: number, label: string): string {
  return a.origin === 'rule' ? rule : `judged ${label} ${p.toFixed(2)} by ${a.model ?? 'model'}`
}

const REFILE: Record<Kind, string> = {
  decision: 'Log it with sofar_log_decision (chose, over, because) so it reaches the digest',
  operational_fact: 'Promote it with sofar_remember so later sessions get it from repo memory',
  note: 'File context like this with sofar_add_note',
}
const READS_AS: Record<Kind, string> = {
  decision: 'a decision',
  operational_fact: 'an operational fact later sessions need',
  note: 'a note, not a choice between alternatives or a standing fact',
}

/**
 * Filing lines for entries just written, in the order given. Never throws: a
 * failed or mis-built request yields no line.
 */
export async function filingWarnings(entries: readonly FiledEntry[], opts: JudgeOptions = {}): Promise<string[]> {
  const answers = await Promise.all(entries.map((e) => answerOf(filingRequest(e), 'kind', opts)))
  const lines: string[] = []
  entries.forEach((entry, i) => {
    const a = answers[i]
    if (a?.type !== 'choice' || a.choice === KIND_OF[entry.kind]) return
    const p = a.probabilities[a.choice] ?? 0
    if (p < JUDGE_WARN_P) return
    const kind = a.choice as Kind
    const sentence = a.origin === 'rule' && typeof entry.text === 'string' ? choiceSentence(entry.text) : null
    const noun = entry.kind === 'memory' ? 'memory' : entry.kind
    lines.push(
      `${entry.label} reads as ${READS_AS[kind]} (${how(a, 'a choice over an alternative, citing no decision', p, `P(${kind})`)})${sentence !== null ? `: "${clip(sentence, 160)}"` : ''}. ${REFILE[kind]}; the ${noun} stays as filed.`,
    )
  })
  return lines
}

/**
 * Evidence lines for tasks just marked done, in the order given. Tasks sharing
 * a reason share one line, so a write-back closing three tasks without notes
 * reads one line, not three. Never throws.
 */
export async function evidenceWarnings(tasks: readonly DoneTask[], opts: JudgeOptions = {}): Promise<string[]> {
  const answers = await Promise.all(tasks.map((t) => answerOf(evidenceRequest(t), 'evidence', opts)))
  const byReason = new Map<string, string[]>()
  tasks.forEach((task, i) => {
    const a = answers[i]
    if (a?.type !== 'noul' || a.noul > EVIDENCE_WARN_P) return
    const rule = task.note === undefined || task.note.trim().length === 0 ? 'no note' : 'the note only asserts completion'
    const reason = how(a, rule, a.noul, 'P(evidence)')
    byReason.set(reason, [...(byReason.get(reason) ?? []), task.id])
  })
  return [...byReason].map(
    ([reason, ids]) =>
      `${list(ids)} marked done without cited evidence (${reason}). Name the passing test run, the commit or the acceptance criteria met: sofar_update_task again with a note, or a note on the write-back's tasks entry.`,
  )
}

/** `1.1`, `1.1 and 1.2`, `1.1, 1.2 and 1.3`. */
function list(ids: readonly string[]): string {
  return ids.length === 1 ? ids[0]! : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`
}
