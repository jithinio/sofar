import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DecisionLoggedPayload, HandoffPayload, NoteAddedPayload } from '@sofar/schema'
import { fdlibmLog } from './fdlibm'
import { passOverRecord } from './index-pass'
import { INDEX_SCHEMA_VERSION, indexDir, readIndexFile, writeIndexFile } from './index-store'
import { type IndexedEvent } from './index-tail'
import { supersededOrdinal } from './index-tier1'
import { lexicalCounts, queryTerms } from './lexicon'
import { byCodeUnit } from './order'

/**
 * The lexicon tier (memory-lead 3.1, D15): every decision, note and stall
 * handoff in the repo as BM25 postings, so the prompt hook can rank the whole
 * record without tokenizing any of it.
 *
 * r1-fixes 3.3's lessons line tokenized THIS record's last 60 decisions on
 * every prompt. The cost is proportional to prose (≈90 ms at this repo's
 * ~1,000 decisions and notes), which is why it was capped, and the cap is why
 * a rejection older than 60 decisions, or in another record, or written as a
 * note, never came back. Terms are computed once, when the event is indexed,
 * and a query touches only the postings of the words it asks.
 *
 * THREE PARTS, because the prompt hook reads this on every prompt and a
 * repo's postings are a megabyte (this repo, 2026-09: 94k postings, 1.1 MB):
 *
 * - `lexicon.json` — the doc table the incremental pass maintains: per
 *   initiative, one line per doc and the counts BM25 needs. Read every prompt.
 * - `lexicon-p<nn>.json` — the postings, sharded into LEXICON_BUCKETS files by
 *   a hash of the term. A query reads only its own terms' buckets.
 * - `lexicon-h.json` — what each doc renders. Read only when a line renders.
 *
 * All three carry the same `gen`, stamped at each write, shards first and the
 * doc table last. A shard whose gen differs from the table's is stale: the
 * reader treats the tier as unreadable (the prompt hook falls back to the
 * fold) and drops the table, so the next refresh rebuilds all three.
 *
 * Postings are APPEND-ONLY, like the log they derive from. A superseded
 * decision keeps its postings and its share of IDF — it is still prose in the
 * record — and is dropped only when a match renders. That is what lets a
 * resume extend the tier instead of rewriting it.
 *
 * Derived, local, disposable (record-index D1): a missing or stale file costs
 * a rebuild, never a wrong answer.
 */

const LEXICON_FILE = 'lexicon.json'
const LEXICON_META = 'meta-lexicon.json'
const HEADS_FILE = 'lexicon-h.json'

/** Postings shards. A power of two, so the hash's low bits pick one. */
export const LEXICON_BUCKETS = 32

/** Prose per doc tokenized — r1-fixes 3.3's LESSON_DOC_CHARS, kept so both paths score the same text. */
export const LEXICON_DOC_CHARS = 1_200
/**
 * What a doc keeps to render. A lesson line is 320 chars, and its handle,
 * wording and matched words take ≥100 of them, so a longer head never shows.
 */
export const LEXICON_HEAD_CHARS = 200

/** d = decision, n = note, f = a stall handoff's detail (r1-fixes D9). */
export type LexiconKind = 'd' | 'n' | 'f'

/** One doc, as a caller sees it — decoded from its line on demand. */
export interface LexiconDoc {
  k: LexiconKind
  /** Envelope id — the told key, stable across merges where `D<n>` is not (D12). */
  id: string
  ts: string
  /** Total tokens, for BM25's length normalization. */
  len: number
  /** Decision ordinal — the `D<n>` handle. */
  n?: number
  /** Set when the decision is scoped by `until`. */
  until?: true
}

/** What a doc renders: a decision's heads, a note's text, a handoff's detail and session. */
export interface LexiconHeads {
  chose?: string
  over?: string
  text?: string
  session?: string
}

/**
 * One initiative's doc table. `docs` is a string, one line per doc,
 * tab-separated — `k \t id \t ts \t len \t n \t until('1'|'')` — because
 * JSON.parse pays per token and this is parsed on every prompt. No field can
 * hold a tab or a newline (ids are ULIDs, ts is ISO), so nothing is escaped.
 */
interface SlugLexiconState {
  /** decision_logged events applied — the `D<n>` base. */
  decisions: number
  /** Decision event ids by ordinal − 1, for a stamped supersession (D12). */
  ids: string[]
  /** '1' per ruled decision, '0' otherwise, by ordinal − 1. */
  ruled: string
  /** Superseded ordinals, ascending. */
  superseded: number[]
  /** Docs indexed — the next doc's number. */
  count: number
  /** Sum of every doc's token count. */
  tokens: number
  docs: string
}

/** A doc indexed in this refresh, waiting to be written to the shards. */
interface Pending {
  at: number
  counts: Record<string, number>
  over: ReadonlySet<string>
  /** `chose \t over` for a decision, `text \t session` otherwise. */
  heads: string
}

/**
 * Per-refresh bookkeeping, held beside the states rather than in them so it
 * is never serialized: what each state indexed in this pass, and which states
 * were rebuilt from empty (their old postings must go).
 */
const pending = new WeakMap<SlugLexiconState, Pending[]>()
const fresh = new WeakSet<SlugLexiconState>()

function empty(): SlugLexiconState {
  const state = { decisions: 0, ids: [], ruled: '', superseded: [], count: 0, tokens: 0, docs: '' }
  fresh.add(state)
  return state
}

function clone(state: SlugLexiconState): SlugLexiconState {
  return { ...state, ids: [...state.ids], superseded: [...state.superseded] }
}

function head(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= LEXICON_HEAD_CHARS ? line : line.slice(0, LEXICON_HEAD_CHARS)
}

function isStall(p: HandoffPayload): boolean {
  return p.reason === 'stall' && typeof p.detail === 'string' && p.detail.trim().length > 0
}

function relevant(event: IndexedEvent): boolean {
  if (event.type === 'decision_logged' || event.type === 'note_added') return true
  return event.type === 'handoff' && isStall(event.payload as unknown as HandoffPayload)
}

function index(
  state: SlugLexiconState,
  event: IndexedEvent,
  kind: LexiconKind,
  heads: [string, string],
  prose: string,
  decision?: { n: number; until: boolean; over: ReadonlySet<string> },
): void {
  const counts = lexicalCounts(prose)
  let len = 0
  for (const tf of Object.values(counts)) len += tf
  const list = pending.get(state) ?? []
  list.push({ at: state.count, counts, over: decision?.over ?? new Set(), heads: `${heads[0]}\t${heads[1]}` })
  pending.set(state, list)
  state.docs += `${kind}\t${event.id}\t${event.ts}\t${len}\t${decision?.n ?? ''}\t${decision?.until === true ? '1' : ''}\n`
  state.count += 1
  state.tokens += len
}

function apply(state: SlugLexiconState, event: IndexedEvent): void {
  switch (event.type) {
    case 'decision_logged': {
      const p = event.payload as unknown as DecisionLoggedPayload
      // Counted before anything can skip: `D<n>` is a position among ALL decisions.
      state.decisions += 1
      const ordinal = state.decisions
      const ruled = typeof p.rule === 'string'
      state.ruled += ruled ? '1' : '0'
      state.ids.push(event.id)
      // The fold's rule (core/fold.ts): backward only, and a ruled target
      // falls only to a ruled superseder — the same test index-tier1 applies.
      if (typeof p.supersedes === 'string') {
        const n = supersededOrdinal(p, ordinal, state.ids)
        if (Number.isInteger(n) && n >= 1 && n < ordinal && (state.ruled[n - 1] !== '1' || ruled) && !state.superseded.includes(n)) {
          state.superseded.push(n)
          state.superseded.sort((a, b) => a - b)
        }
      }
      if (typeof p.chose !== 'string' || typeof p.over !== 'string') return
      // Whole-decision prose, joined as r1-fixes 3.3 joined it: the prompt names
      // the SUBJECT, which lives in `chose`, and the rejection it re-proposes is
      // reached through it.
      const prose = `${p.chose} ${p.over} ${p.because ?? ''}`.slice(0, LEXICON_DOC_CHARS)
      const over = new Set(Object.keys(lexicalCounts(p.over.slice(0, LEXICON_DOC_CHARS))))
      index(state, event, 'd', [head(p.chose), head(p.over)], prose, { n: ordinal, until: typeof p.until === 'string', over })
      return
    }
    case 'note_added': {
      const p = event.payload as unknown as NoteAddedPayload
      if (typeof p.text !== 'string' || p.text.trim().length === 0) return
      index(state, event, 'n', [head(p.text), ''], p.text.slice(0, LEXICON_DOC_CHARS))
      return
    }
    case 'handoff': {
      const p = event.payload as unknown as HandoffPayload
      if (!isStall(p)) return
      index(state, event, 'f', [head(p.detail!), p.session_id], p.detail!.slice(0, LEXICON_DOC_CHARS))
      return
    }
  }
}

/**
 * The shard a term's postings live in: FNV-1a over the term's UTF-8 bytes,
 * masked to LEXICON_BUCKETS. Bytes, not UTF-16 units, so rust-core (3.4)
 * computes the same bucket from its own strings.
 */
export function lexiconBucket(term: string): number {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(term)) {
    h ^= byte
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h & (LEXICON_BUCKETS - 1)
}

function bucketFile(bucket: number): string {
  return `lexicon-p${bucket.toString().padStart(2, '0')}.json`
}

interface LexiconDisk {
  version: number
  gen: string
  initiatives: Record<string, SlugLexiconState>
}

/**
 * A postings shard or the heads file: per initiative, one string.
 *
 * Postings: `\n<term>\t<entries>\n` per term, an entry `<doc>:<tf>` in base 36
 * with `!` appended when the term is in the decision's `over`, entries
 * comma-separated — the leading newline makes `\n<term>\t` a unique needle.
 * Heads: one line per doc, in doc order.
 */
interface ShardDisk {
  version: number
  gen: string
  initiatives: Record<string, string>
}

function isSlugState(v: unknown): v is SlugLexiconState {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.decisions === 'number' &&
    Array.isArray(r.ids) &&
    typeof r.ruled === 'string' &&
    Array.isArray(r.superseded) &&
    typeof r.count === 'number' &&
    typeof r.tokens === 'number' &&
    typeof r.docs === 'string'
  )
}

function isLexiconDisk(v: unknown): v is LexiconDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r.version !== INDEX_SCHEMA_VERSION || typeof r.gen !== 'string') return false
  if (typeof r.initiatives !== 'object' || r.initiatives === null) return false
  return Object.values(r.initiatives).every(isSlugState)
}

function isShardDisk(v: unknown): v is ShardDisk {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  if (r.version !== INDEX_SCHEMA_VERSION || typeof r.gen !== 'string') return false
  if (typeof r.initiatives !== 'object' || r.initiatives === null) return false
  return Object.values(r.initiatives).every((s) => typeof s === 'string')
}

/** The tier as a reader holds it: the doc table, plus shards loaded on first use. */
export interface LexiconIndex {
  readonly gen: string
  readonly initiatives: Readonly<Record<string, SlugLexiconState>>
  readonly sofarDir: string
  /** Shards read so far, by file name. */
  readonly loaded: Map<string, ShardDisk>
}

/** Thrown when a shard does not match the doc table; the caller falls back. */
export class LexiconStale extends Error {}

/** Drop the doc table so the next refresh rebuilds every part. Silent on failure. */
function invalidate(sofarDir: string): void {
  for (const name of [LEXICON_FILE, LEXICON_META]) {
    try {
      rmSync(join(indexDir(sofarDir), name), { force: true })
    } catch {
      // A table that cannot be removed stays stale, and every read falls back.
    }
  }
}

function shard(index: LexiconIndex, name: string): ShardDisk {
  const cached = index.loaded.get(name)
  if (cached !== undefined) return cached
  const disk = readIndexFile<ShardDisk>(index.sofarDir, name, isShardDisk)
  if (disk === null || disk.gen !== index.gen) {
    invalidate(index.sofarDir)
    throw new LexiconStale(name)
  }
  index.loaded.set(name, disk)
  return disk
}

function newGen(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function postingsMap(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab > 0) map.set(line.slice(0, tab), line.slice(tab + 1))
  }
  return map
}

function postingsText(map: ReadonlyMap<string, string>): string {
  let out = '\n'
  for (const term of [...map.keys()].sort(byCodeUnit)) out += `${term}\t${map.get(term)}\n`
  return out
}

/**
 * Write what this refresh indexed into the shards and heads, under a new gen.
 * Every shard is rewritten, because each carries the gen; this runs only when
 * a decision, note or stall handoff arrived, which is rare next to prompts.
 * Returns false when the old shards cannot be trusted to extend — the caller
 * rebuilds from the logs instead.
 */
function writeShards(sofarDir: string, states: Record<string, SlugLexiconState>, oldGen: string | null, gen: string): boolean {
  const names = [...Array.from({ length: LEXICON_BUCKETS }, (_, b) => bucketFile(b)), HEADS_FILE]
  const allFresh = Object.values(states).every((s) => fresh.has(s))
  const shards = new Map<string, Record<string, string>>()
  for (const name of names) {
    if (allFresh) {
      shards.set(name, {})
      continue
    }
    const disk = readIndexFile<ShardDisk>(sofarDir, name, isShardDisk)
    if (disk === null || disk.gen !== oldGen) return false
    // An initiative that vanished leaves every shard with it.
    const kept: Record<string, string> = {}
    for (const [slug, text] of Object.entries(disk.initiatives)) if (states[slug] !== undefined) kept[slug] = text
    shards.set(name, kept)
  }
  for (const [slug, state] of Object.entries(states)) {
    if (fresh.has(state)) for (const name of names) delete shards.get(name)![slug]
    const docs = pending.get(state)
    if (docs === undefined) continue
    const heads = shards.get(HEADS_FILE)!
    heads[slug] = (heads[slug] ?? '') + docs.map((d) => `${d.heads}\n`).join('')
    const byBucket = new Map<number, [string, string][]>()
    for (const d of docs) {
      const at = d.at.toString(36)
      for (const [term, tf] of Object.entries(d.counts)) {
        const b = lexiconBucket(term)
        const rows = byBucket.get(b) ?? []
        rows.push([term, `${at}:${tf.toString(36)}${d.over.has(term) ? '!' : ''}`])
        byBucket.set(b, rows)
      }
    }
    for (const [b, rows] of byBucket) {
      const file = shards.get(bucketFile(b))!
      const map = postingsMap(file[slug] ?? '')
      for (const [term, entry] of rows) {
        const list = map.get(term)
        map.set(term, list === undefined ? entry : `${list},${entry}`)
      }
      file[slug] = postingsText(map)
    }
  }
  for (const name of names) writeIndexFile(sofarDir, name, { version: INDEX_SCHEMA_VERSION, gen, initiatives: shards.get(name)! })
  return true
}

/**
 * Bring the tier up to date. Rewrites anything only when a decision, note or
 * stall handoff arrived (the reducer's `relevant`), so the common prompt — one
 * whose preceding events were hooks' command_run and file_touched — rewrites
 * nothing but the cursors.
 */
export function refreshLexicon(sofarDir: string, retry = true): LexiconIndex {
  const prior = readIndexFile<LexiconDisk>(sofarDir, LEXICON_FILE, isLexiconDisk)
  const { states, stateChanged } = passOverRecord<SlugLexiconState>(
    sofarDir,
    LEXICON_META,
    prior === null ? null : prior.initiatives,
    { empty, clone, apply: (s, e) => apply(s, e), relevant },
  )
  let gen = prior?.gen ?? ''
  if (stateChanged) {
    const next = newGen()
    if (!writeShards(sofarDir, states, prior?.gen ?? null, next)) {
      invalidate(sofarDir)
      if (retry) return refreshLexicon(sofarDir, false)
      throw new LexiconStale('shards')
    }
    writeIndexFile(sofarDir, LEXICON_FILE, { version: INDEX_SCHEMA_VERSION, gen: next, initiatives: states })
    gen = next
  }
  return { gen, initiatives: states, sofarDir, loaded: new Map() }
}

/** A slug's docs, decoded — only for an initiative that has a hit. */
function docsOf(state: SlugLexiconState): LexiconDoc[] {
  const out: LexiconDoc[] = []
  for (const line of state.docs.split('\n')) {
    if (line.length === 0) continue
    const [k, id, ts, len, n, until] = line.split('\t')
    out.push({
      k: k as LexiconKind,
      id: id ?? '',
      ts: ts ?? '',
      len: Number(len),
      ...(n !== undefined && n.length > 0 ? { n: Number(n) } : {}),
      ...(until === '1' ? { until: true as const } : {}),
    })
  }
  return out
}

/** What a doc renders — reads the heads file on first use. Empty when the tier has no such doc. */
export function lexiconHeads(index: LexiconIndex, slug: string, doc: LexiconDoc): LexiconHeads {
  const state = index.initiatives[slug]
  if (state === undefined) return {}
  const at = docsOf(state).findIndex((d) => d.id === doc.id)
  const line = at < 0 ? undefined : (shard(index, HEADS_FILE).initiatives[slug] ?? '').split('\n')[at]
  if (line === undefined) return {}
  const [a = '', b = ''] = line.split('\t')
  return doc.k === 'd' ? { chose: a, over: b } : { text: a, ...(b.length > 0 ? { session: b } : {}) }
}

/** Whether a decision was superseded in its own record, as far as the tier knows. */
export function lexiconSuperseded(index: LexiconIndex, slug: string, ordinal: number): boolean {
  return index.initiatives[slug]?.superseded.includes(ordinal) === true
}

export interface LexiconMatch {
  slug: string
  doc: LexiconDoc
  score: number
  /** The asker's words this doc carried, strongest first. */
  terms: string[]
  /** Share of the score carried by words in the decision's `over` (0 for notes). */
  overShare: number
}

interface Posting {
  at: number
  tf: number
  over: boolean
}

/** One term's entries from a postings string; empty when the term is absent. */
function postingsFor(text: string, term: string): Posting[] {
  const needle = `\n${term}\t`
  const start = text.indexOf(needle)
  if (start < 0) return []
  const from = start + needle.length
  const end = text.indexOf('\n', from)
  const rows: Posting[] = []
  // A malformed entry is skipped, never fatal: the tier is derived state.
  for (const entry of text.slice(from, end < 0 ? undefined : end).split(',')) {
    const colon = entry.indexOf(':')
    if (colon <= 0) continue
    const over = entry.endsWith('!')
    const at = parseInt(entry.slice(0, colon), 36)
    const tf = parseInt(entry.slice(colon + 1, over ? -1 : undefined), 36)
    if (Number.isInteger(at) && Number.isInteger(tf) && tf > 0) rows.push({ at, tf, over })
  }
  return rows
}

const K1 = 1.2
const B = 0.75

/**
 * Rank every doc in the tier against a query — core/lexicon.ts rankLexical's
 * BM25, over postings instead of per-doc term maps, with the same order:
 * score, then newest, then slug and id. IDF and the average length are
 * corpus-wide, retired docs included (see the header).
 *
 * `keep` filters BEFORE the limit but AFTER scoring, so what a caller drops
 * never changes another doc's score. Throws LexiconStale when a shard does
 * not match the doc table.
 */
export function rankLexicon(
  index: LexiconIndex,
  query: string,
  limit: number,
  keep: (slug: string, doc: LexiconDoc) => boolean = () => true,
): { matches: LexiconMatch[]; docs: number } {
  const asked = queryTerms(query)
  const wanted = [...asked.keys()].sort(byCodeUnit)
  const slugs = Object.keys(index.initiatives).sort(byCodeUnit)
  let n = 0
  let tokens = 0
  for (const slug of slugs) {
    n += index.initiatives[slug]!.count
    tokens += index.initiatives[slug]!.tokens
  }
  if (wanted.length === 0 || n === 0) return { matches: [], docs: n }

  const df = new Map<string, number>()
  const found = new Map<string, Map<string, Posting[]>>()
  for (const term of wanted) {
    const file = shard(index, bucketFile(lexiconBucket(term)))
    for (const slug of slugs) {
      const text = file.initiatives[slug]
      if (text === undefined) continue
      const rows = postingsFor(text, term)
      if (rows.length === 0) continue
      let bySlug = found.get(slug)
      if (bySlug === undefined) found.set(slug, (bySlug = new Map()))
      bySlug.set(term, rows)
      df.set(term, (df.get(term) ?? 0) + rows.length)
    }
  }
  const average = tokens / n
  const idf = new Map<string, number>()
  for (const [term, count] of df) idf.set(term, fdlibmLog(1 + (n - count + 0.5) / (count + 0.5)))

  const out: LexiconMatch[] = []
  for (const [slug, terms] of found) {
    const docs = docsOf(index.initiatives[slug]!)
    const hits = new Map<number, { term: string; weight: number; over: boolean }[]>()
    for (const [term, rows] of terms) {
      for (const { at, tf, over } of rows) {
        const doc = docs[at]
        if (doc === undefined) continue
        const damp = K1 * (1 - B + (B * doc.len) / average)
        const weight = idf.get(term)! * ((tf * (K1 + 1)) / (tf + damp))
        const row = hits.get(at)
        const hit = { term, weight, over }
        if (row === undefined) hits.set(at, [hit])
        else row.push(hit)
      }
    }
    for (const [at, hit] of hits) {
      const doc = docs[at]!
      if (!keep(slug, doc)) continue
      hit.sort((a, b) => b.weight - a.weight || byCodeUnit(a.term, b.term))
      const score = hit.reduce((sum, h) => sum + h.weight, 0)
      const over = hit.reduce((sum, h) => sum + (h.over ? h.weight : 0), 0)
      out.push({
        slug,
        doc,
        score,
        terms: hit.map((h) => asked.get(h.term) ?? h.term),
        overShare: score > 0 ? over / score : 0,
      })
    }
  }
  out.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.doc.ts !== b.doc.ts) return a.doc.ts < b.doc.ts ? 1 : -1
    return byCodeUnit(a.slug, b.slug) || byCodeUnit(a.doc.id, b.doc.id)
  })
  return { matches: out.slice(0, Math.max(0, limit)), docs: n }
}
