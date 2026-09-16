import type { InitiativeState } from './fold'
import { lexicalCounts, rankLexical, type LexicalDoc } from './lexicon'
import { retiredOrdinals } from './retire'

/**
 * Relevant lessons at the prompt (r1-fixes 3.3, D16) — what this record has
 * already ruled out, surfaced at the moment a prompt proposes it again.
 *
 * The digest shows every rejected approach once, at SessionStart, and by the
 * prompt that re-proposes one they are tens of thousands of tokens back. C3
 * (bench-refresh) measures exactly that re-violation rate. The mechanism that
 * closed the same gap for guards (record-index 3.2) is point-of-use: say it
 * where the agent is about to act. This is the same move for decisions, and
 * for the failures a driver run recorded.
 *
 * No model (SPEC §Architectural invariants): the prompt is tokenized and
 * BM25-ranked against the lessons by the ranker `sofar find` already uses
 * (core/lexicon.ts), so a match can show the words that carried it, and a
 * reader can argue with it. The claim stays weak and the surface says so:
 * "ruled out before", never "you are wrong".
 *
 * Bounded on the hot path (D6): the docs are THIS initiative's decisions and
 * handoffs, tokenized in-process from the fold the prompt hook already has —
 * no file beyond the log is read, and a record of 100 decisions costs a few
 * milliseconds. Two lines at most, and none unless a lesson shares at least
 * two of the prompt's terms with a score past the floor, so one common word
 * is never a match and 'continue' matches nothing.
 */

export interface Lesson {
  /** `D<n>` for a decision, `session <id>` for a failure. */
  handle: string
  /** What to render: the decision's `over`, or the handoff's detail. */
  text: string
  /** The prompt's own words that carried the match, strongest first. */
  terms: string[]
  /** BM25 score — kept so a caller can see why one lesson outranked another. */
  score: number
}

/** Fewest distinct prompt terms a lesson must share — one word is coincidence. */
export const LESSON_MIN_TERMS = 2
/** BM25 floor — roughly one rare term plus one more, once the record is big enough to have rare terms. */
export const LESSON_MIN_SCORE = 1.5
/**
 * Below this many lessons BM25's IDF cannot separate rare from common — with
 * one document every term is in every document and scores near zero — so the
 * floor is replaced by a stricter term count: three shared words instead of
 * two. A young record gets its lessons back on the words alone.
 */
export const LESSON_SMALL_RECORD = 5
export const LESSON_MIN_TERMS_SMALL = 3
/** Lines rendered per prompt. */
export const LESSON_MAX = 2
/**
 * A second lesson renders only when it scores at least this fraction of the
 * first: the top hit is the re-proposal, and a runner-up that shares two
 * common words with the prompt is the coincidence the floor alone lets in.
 */
export const LESSON_RUNNER_UP_RATIO = 0.6
/** Prompt text considered — the intent is in the first lines, and the rest is paste. */
export const LESSON_PROMPT_CHARS = 2_000
/**
 * Most recent decisions indexed — bounds the tokenizing on a heavy record.
 * The per-prompt cost is proportional to the prose tokenized: 17 decisions
 * cost ~1.5 ms in-process (D18); 200 would have cost ~20 ms on every
 * prompt, a tax the read-path budget forbids. Sixty recent decisions is
 * more than the digest ever shows, and older lessons are still one
 * `sofar find` away.
 */
export const LESSON_DOC_CAP = 60
/** Prose per lesson tokenized — the subject and the rejection are in the first lines. */
export const LESSON_DOC_CHARS = 1_200
/** Env switch: `SOFAR_LESSONS=off` disables the line — round 2's ablation arm (D18). */
export const LESSONS_ENV = 'SOFAR_LESSONS'

/** Whether the lessons line is enabled in this environment. */
export function lessonsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[LESSONS_ENV]?.trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

interface LessonDoc extends LexicalDoc {
  handle: string
  text: string
}

/** Handoffs that record a failure worth remembering: a stall carries what the agent last wrote (r1-fixes D9). */
function isFailure(reason: string): boolean {
  return reason === 'stall'
}

function lessonDocs(state: InitiativeState, retire: boolean): LessonDoc[] {
  const docs: LessonDoc[] = []
  // Retired decisions (r1-fixes 3.2, D25) are not lessons: "ruled out before"
  // citing a decision a later one reversed would be the record contradicting
  // itself at the point of use. Ordinals are kept — the cap counts in-force
  // decisions, so a heavy record's oldest live lesson is still reachable.
  const retired = retire ? retiredOrdinals(state) : new Set<number>()
  const live = state.decisions.map((d, i) => ({ d, ordinal: i + 1 })).filter((x) => !retired.has(x.ordinal))
  for (const { d, ordinal } of live.slice(-LESSON_DOC_CAP)) {
    // The prompt names the SUBJECT, which lives in `chose`; the `over` is
    // what gets rendered. Indexing the whole decision is what lets a
    // re-proposal phrased in the subject's words reach its rejection.
    const prose = `${d.chose} ${d.over} ${d.because}`.slice(0, LESSON_DOC_CHARS)
    const terms = lexicalCounts(prose)
    docs.push({
      id: `decision:${ordinal}`,
      ts: d.ts,
      terms,
      tokens: Object.values(terms).reduce((a, b) => a + b, 0),
      handle: `D${ordinal}`,
      text: d.over,
    })
  }
  for (const s of state.sessions) {
    const h = s.handoff
    if (h === undefined || h.detail === undefined || h.detail.trim().length === 0 || !isFailure(h.reason)) continue
    const terms = lexicalCounts(h.detail.slice(0, LESSON_DOC_CHARS))
    docs.push({
      id: `failure:${s.id}`,
      ts: h.ts,
      terms,
      tokens: Object.values(terms).reduce((a, b) => a + b, 0),
      handle: `session ${s.id} (${h.reason})`,
      text: h.detail,
    })
  }
  return docs
}

/** The lessons a prompt re-proposes, strongest first; empty for a prompt that names nothing. */
export function relevantLessons(state: InitiativeState, prompt: string, retire = true): Lesson[] {
  const query = prompt.slice(0, LESSON_PROMPT_CHARS)
  if (query.trim().length === 0) return []
  const docs = lessonDocs(state, retire)
  if (docs.length === 0) return []
  const byId = new Map(docs.map((d) => [d.id, d]))
  const ranked = rankLexical(docs, query, docs.length)
  const small = docs.length < LESSON_SMALL_RECORD
  const minTerms = small ? LESSON_MIN_TERMS_SMALL : LESSON_MIN_TERMS
  const minScore = small ? 0 : LESSON_MIN_SCORE
  const out: Lesson[] = []
  for (const m of ranked.matches) {
    if (m.terms.length < minTerms || m.score < minScore) continue
    if (out.length > 0 && m.score < out[0]!.score * LESSON_RUNNER_UP_RATIO) break
    const doc = byId.get(m.id)
    if (doc === undefined) continue
    out.push({ handle: doc.handle, text: doc.text, terms: m.terms, score: m.score })
    if (out.length >= LESSON_MAX) break
  }
  return out
}
