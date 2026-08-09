import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every § citation resolves to a section that exists (record-citations D1).
 *
 * `§` is the one mark in this repo that points OUT of the text it sits in, so
 * it is the one mark that can rot without touching the line it lives on:
 * rename `## CLI` in SPEC.md and thirty citations elsewhere go stale silently,
 * each still reading perfectly. The convention in CLAUDE.md cannot catch that
 * — it governs how a citation is WRITTEN, and this failure happens later, to
 * text nobody is editing. Only a mechanical check crossing both sides can.
 *
 * Same bargain as architecture-doc.test.ts: the docs are not maintained by
 * discipline, they are maintained by this test. Rename a heading and the suite
 * fails naming every citation that pointed at the old one — the cheapest
 * moment to fix them, while the rename is still the current thought.
 *
 * Two checks, both mechanical, neither a matter of taste:
 *
 *   RESOLVES  — `§Name` prefix-matches a real heading or **Bold label** in
 *               the document its handle names. `§Acceptance` fails; the
 *               heading is `## Acceptance criteria`.
 *   CLOSED    — a citation never ends a line. `§Sync` / `client` reads fine
 *               to a human and is invisible to every search that would find
 *               it, which is what made it worth a rule at all.
 *
 * It does NOT check that the cited section still SAYS what the citing text
 * claims — no mechanical check can. That is the honest limit here, and it is
 * still the difference between a citation that is imprecise and one that
 * points at nothing.
 *
 * Deliberately out of scope: `.sofar/` records (append-only by law, so their
 * older citations are historical fact, not debt) and docs/harness.md (marked
 * SUPERSEDED — do not update).
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..', '..', '..')

/** Documents a § may point into, keyed by the handle that precedes the mark. */
const TARGET_DOCS: Record<string, string> = {
  SPEC: 'docs/SPEC.md',
  FORMAT: 'docs/FORMAT.md',
  CLAUDE: 'CLAUDE.md',
  'opencode-adapter': 'docs/opencode-adapter.md',
}

/** `SPEC §CLI`, `FORMAT.md §5.5`, `docs/opencode-adapter.md §3` — the handle names the document. */
const HANDLE = new RegExp(`\\b(${Object.keys(TARGET_DOCS).join('|')})(?:\\.md)?\\b[^§]{0,4}$`, 'i')

/** Hand-written files scanned for citations. */
const SCAN_DOCS = ['docs/SPEC.md', 'docs/FORMAT.md', 'docs/opencode-adapter.md', 'CLAUDE.md']

/** Source roots scanned for citations (comments). dist/ is generated — never scanned. */
const SCAN_ROOTS = [
  join('packages', 'engine', 'src'),
  join('packages', 'engine', 'test'),
  join('packages', 'schema', 'src'),
  join('packages', 'schema', 'test'),
]

/**
 * § is a general section mark, not ours: `RFC 8628 §3.5` is a correct citation
 * to somebody else's document and there is nothing here to resolve it against.
 * Recognised by the standards-body handle sitting just before the mark.
 */
const EXTERNAL = /\b(RFC|W3C|ISO|IETF|ECMA|POSIX|MDN|IEEE)\b[^.§]{0,16}$/i

/**
 * A citation: the mark and the name after it. An apostrophe ends the name —
 * `§State's derivation` cites §State and then speaks English about it.
 */
const CITATION = /§(\d+(?:\.\d+)*|[A-Za-z][A-Za-z0-9 _-]{0,45})/g

/** A citation sitting at the end of its line, name and all. */
const AT_LINE_END = /§(\d+(?:\.\d+)*|[A-Za-z][A-Za-z0-9 _-]*)$/

/** Fold a matched handle back to its TARGET_DOCS key; a bare § means SPEC. */
function canonicalHandle(raw: string): string {
  const lower = raw.toLowerCase()
  return Object.keys(TARGET_DOCS).find((key) => key.toLowerCase() === lower) ?? 'SPEC'
}

/** Strip a heading's trailing parenthetical and em-dash clause: the name is the stem. */
function stem(raw: string): string {
  return raw
    .replace(/\s*\(.*$/, '')
    .replace(/\s*—.*$/, '')
    .trim()
}

/** Every name a § may legitimately land on in one document. */
function targetsOf(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/^#{1,4} (.+)$/gm)) {
    const raw = (m[1] ?? '').trim()
    out.add(stem(raw))
    // FORMAT.md numbers its sections ("## 5. Fold semantics", "### 5.1 Tolerance"),
    // and citations use the number alone — §5.5, not §5.5 Session attribution.
    const numbered = raw.match(/^(\d+(?:\.\d+)*)[.\s]/)
    if (numbered?.[1]) out.add(numbered[1])
  }
  // SPEC's sub-section device: a bold label opening a paragraph (**Path identity.**).
  for (const m of text.matchAll(/^\*\*([A-Z][^*]{1,50}?)\.?\*\*/gm)) out.add(stem(m[1] ?? ''))
  return out
}

function readDoc(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(repoRoot, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(rel, acc)
      continue
    }
    if (/\.(ts|mjs|js)$/.test(entry.name)) acc.push(rel)
  }
  return acc
}

/**
 * Two places state the rule instead of following it, by quoting the broken
 * forms as counter-examples (`§Acceptance` ✗, `§Sync` / `client`): CLAUDE.md's
 * rule block and this file's own header. Both are the rule's definition, not
 * uses of it, so neither is scanned.
 */
const SELF = join('packages', 'engine', 'test', 'citations.test.ts')

function withoutRuleBlock(rel: string, text: string): string {
  if (rel !== 'CLAUDE.md') return text
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('### Citing things'))
  if (start === -1) return text
  let end = start + 1
  while (end < lines.length && !lines[end]?.startsWith('## ')) end++
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n')
}

interface Ref {
  file: string
  line: number
  name: string
  /** The document handle in force, resolved from what precedes the mark. */
  doc: string
  text: string
}

/** Every citation in the repo, with the document each one points into. */
function citations(): { refs: Ref[]; unclosed: Ref[] } {
  const refs: Ref[] = []
  const unclosed: Ref[] = []
  const files = [...SCAN_DOCS, ...SCAN_ROOTS.flatMap((root) => sourceFiles(root))].filter(
    (f) => f !== SELF,
  )

  for (const file of files) {
    const body = withoutRuleBlock(file, readFileSync(join(repoRoot, file), 'utf8'))
    body.split('\n').forEach((line, i) => {
      // The handle sticks until another one appears: a wrapped comment writes
      // `SPEC §Record graph,` on one line and a bare `§Acceptance criteria` on
      // the next, and both mean SPEC.
      let doc = file.endsWith('FORMAT.md') ? 'FORMAT' : file.endsWith('CLAUDE.md') ? 'CLAUDE' : 'SPEC'
      for (const m of line.matchAll(CITATION)) {
        const before = line.slice(0, m.index)
        if (EXTERNAL.test(before)) continue
        const handle = before.match(HANDLE)
        if (handle?.[1]) doc = canonicalHandle(handle[1])
        refs.push({ file, line: i + 1, name: m[1] ?? '', doc, text: line.trim() })
      }
      const tail = line.match(AT_LINE_END)
      if (tail && !EXTERNAL.test(line)) {
        unclosed.push({ file, line: i + 1, name: tail[1] ?? '', doc, text: line.trim() })
      }
    })
  }
  return { refs, unclosed }
}

describe('§ citations', () => {
  const targets = new Map(
    Object.entries(TARGET_DOCS).map(([handle, rel]) => [handle, targetsOf(readDoc(rel))]),
  )
  const { refs, unclosed } = citations()

  /**
   * The section a citation lands on, or null if none does.
   *
   * An EXACT match is the normal case — the rule closes a citation with
   * punctuation, so `§Acceptance criteria, Phase 4` captures the name alone.
   * A proper-prefix match is allowed only when the leftover starts LOWERCASE,
   * because that is prose continuing the sentence (`§Hooks and …`, `§Git state
   * is readable`). A CAPITALISED leftover is refused: `§CLI UI` must not be
   * allowed to quietly land on `## CLI` just because a `## CLI UI` heading was
   * renamed out from under it — that silent downgrade is the exact drift this
   * file exists to catch, and it is indistinguishable from a heading that once
   * existed. That refusal is what makes a rename fail the suite.
   */
  function resolve(ref: Ref): string | null {
    const names = targets.get(ref.doc)
    if (!names) return null
    const name = ref.name.trim()
    if (names.has(name)) return name
    let best: string | null = null
    for (const candidate of names) {
      if (!name.startsWith(`${candidate} `)) continue
      const rest = name.slice(candidate.length + 1)
      if (!/^[a-z]/.test(rest)) continue
      if (!best || candidate.length > best.length) best = candidate
    }
    return best
  }

  it('has citations and targets to check', () => {
    // Guards the guard: a resolution bug that found nothing would make every
    // assertion below pass vacuously and the whole test worthless.
    expect(refs.length).toBeGreaterThan(150)
    expect(targets.get('SPEC')!.size).toBeGreaterThan(20)
    expect(targets.get('FORMAT')!.size).toBeGreaterThan(10)
  })

  it('every citation resolves to a section that exists', () => {
    const broken = refs
      .filter((ref) => resolve(ref) === null)
      .map((ref) => {
        const head = (ref.name.trim().split(' ')[0] ?? '').toLowerCase()
        const near = [...(targets.get(ref.doc) ?? [])]
          .filter((n) => n.toLowerCase().startsWith(head))
          .sort((a, b) => a.length - b.length)[0]
        return `${ref.file}:${ref.line}  §${ref.name.trim()}${near ? `  → did you mean §${near}?` : ''}`
      })

    expect(broken, `citations naming no section in their document:\n  ${broken.join('\n  ')}`).toEqual([])
  })

  it('no citation is left open by a line break', () => {
    // A citation may END a line — `… full contract in §Sync client` is fine,
    // because the name is whole and no longer section could continue it. What
    // breaks is `§Sync` / `client`: it reads correctly and is invisible to
    // every search for the section it names. So the test is not "does it end
    // the line" but "could the next line still be part of the name".
    const wrapped = unclosed
      .filter((ref) => {
        const names = targets.get(ref.doc)
        if (!names) return false
        if (!names.has(ref.name)) return true // incomplete on its own
        for (const name of names) if (name.startsWith(`${ref.name} `)) return true // a longer one could continue
        return false
      })
      .map((ref) => `${ref.file}:${ref.line}  §${ref.name}  — ${ref.text.slice(-46)}`)

    expect(wrapped, `citations left open by a line break:\n  ${wrapped.join('\n  ')}`).toEqual([])
  })

  it('CLAUDE.md still carries the rule these checks enforce', () => {
    // Without the written rule, a failure here has no remedy to point at.
    const claude = readDoc('CLAUDE.md')
    for (const clause of ['### Citing things', 'HAND-WRITTEN document only', 'never with `§`']) {
      expect(claude, `CLAUDE.md no longer states: ${clause}`).toContain(clause)
    }
  })
})
