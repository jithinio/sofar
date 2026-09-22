/**
 * File mentions (memory-lead 2.1, D6): which files a decision's own text
 * names. A mention is the derived half of a decision's scope, where a `path:`
 * guard is the declared half.
 *
 * A mention states only that a decision NAMES a file, never that it governs
 * it (record-index D2). So the extractor may over-collect: a token that is
 * not a file (`Node.js`, `api.sofar.sh`) matches only a path that ends in it,
 * and no real read does. What it must not do is match broadly. Directory
 * tokens are therefore not mentions: on this repo they alone spread 92
 * decisions over 375 files, where file tokens name 74, with a median of one
 * decision per file. Directory scope is what a `path:` guard declares.
 *
 * Pure and deterministic, like rule-fidelity's classifier, whose file-name
 * class this reuses for the last segment.
 */

/** Delimiters a path never contains: whitespace, backticks, quotes, brackets, commas, semicolons. */
const SPLIT_RE = /[\s`"“”‘’'(),;<>[\]{}|]+/
const TRAILING_PUNCT_RE = /[.:!?]+$/
/** `src/a.ts:42`, `src/a.ts:42:7` and `src/a.ts#L10-L12` name the file. */
const LOCATION_RE = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/
/**
 * rule-fidelity's file-name class (`categories.ts`), or a dotfile (`.mcp.json`,
 * `.gitignore`). A bare name needs two characters before its extension, which
 * keeps `e.g` out; behind a `/` one will do (`src/a.ts`).
 */
const FILE_SEGMENT_RE = /^(?:[\w-]{2,}(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}|\.[\w-][\w.-]*)$/
const PATHED_FILE_SEGMENT_RE = /^(?:[\w-]+(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,4}|\.[\w-][\w.-]*)$/
const PATH_SEGMENT_RE = /^[\w.@+-]+$/

/** The file tokens of `text`, in order, deduplicated. */
export function fileMentions(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split(SPLIT_RE)) {
    const token = fileToken(raw)
    if (token === null || seen.has(token)) continue
    seen.add(token)
    found.push(token)
  }
  return found
}

function fileToken(raw: string): string | null {
  let token = raw.replace(TRAILING_PUNCT_RE, '').replace(LOCATION_RE, '').replace(TRAILING_PUNCT_RE, '')
  const pathed = token.includes('/')
  if (token.startsWith('./')) token = token.slice(2)
  if (token.length === 0 || token.includes('://') || /[*?$]/.test(token) || token.startsWith('~')) return null
  const segments = (token.startsWith('/') ? token.slice(1) : token).split('/')
  const last = segments[segments.length - 1] ?? ''
  if (!(pathed ? PATHED_FILE_SEGMENT_RE : FILE_SEGMENT_RE).test(last)) return null
  for (const segment of segments) {
    if (segment.length === 0 || !PATH_SEGMENT_RE.test(segment)) return null
  }
  return token
}

/**
 * How many path segments of `path` the token names, or 0 when it names none
 * of it. A token names a path when it IS the path or its tail at a `/`
 * boundary, so `core/fold.ts` names `/repo/src/core/fold.ts` (2) and
 * `fold.ts` names it too (1), but `old.ts` does not. The count ranks a
 * specific mention over a bare file name.
 */
export function mentionDepth(token: string, path: string): number {
  if (path !== token && !path.endsWith(token.startsWith('/') ? token : `/${token}`)) return 0
  return token.split('/').filter((s) => s.length > 0).length
}
