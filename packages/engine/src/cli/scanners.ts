import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

/**
 * Host-repo scanner defense (Phase 10, D-P10) — pure detection helpers shared
 * by `sofar init` (the hint) and `sofar doctor` (the audit + --fix).
 *
 * The failure class: Tailwind CSS v4's automatic content detection scans every
 * non-gitignored file in the project tree for class names, reading raw bytes
 * and ignoring markdown fences. Committed `.sofar/` records — a coding record
 * full of code-like strings — get ingested, which bloats or breaks the CSS
 * build. sofar defends its host by configuring the scanner away from `.sofar`,
 * never by mangling its own memory (D-P10): the fix is a single `@source not`
 * exclusion in the Tailwind entry stylesheet, whose path is resolved RELATIVE
 * TO THE STYLESHEET (Tailwind's contract), not the repo root.
 *
 * `@source not` is itself version-gated: it landed in Tailwind 4.1. On 4.0.x
 * the directive parses as an unquoted path (`not`) and BREAKS the build we set
 * out to protect, so detection carries `sourceNot` and the fix is withheld
 * unless the version that will actually build is known to support it.
 */

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Tailwind v4 detection (package.json + node_modules).
// ---------------------------------------------------------------------------

export interface TailwindV4Detection {
  /** True iff a `tailwindcss` dependency resolves to major >= 4. */
  v4: boolean
  /** The raw version range from package.json, when a tailwindcss dep was found. */
  range?: string
  /** The exact version read from node_modules/tailwindcss, when the dep is installed. */
  installed?: string
  /**
   * True iff the version that will actually build is KNOWN to support
   * `@source not` (Tailwind >= 4.1). False both when it is known to predate it
   * and when it cannot be established — writing the directive is unsafe under
   * either, so the fix is withheld rather than guessed.
   */
  sourceNot: boolean
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** The Tailwind version that introduced `@source not`. Before it, the line breaks the build. */
export const SOURCE_NOT_SINCE = '4.1'

function tailwindRange(pkg: Obj): string | undefined {
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (isObj(deps) && typeof deps.tailwindcss === 'string') return deps.tailwindcss
  }
  return undefined
}

/**
 * `[major, minor]` of an exact version, or of a range's LOWER BOUND — strips a
 * leading run of range operators (^ ~ >= > < = v) and reads the leading
 * integers. A missing or wildcard minor reads as 0 (`^4`, `4.x` → [4, 0]), so
 * an open range never argues for a feature its floor cannot deliver.
 */
function lowerBound(spec: string): [number, number] | null {
  const m = /^[\s^~>=<v]*(\d+)(?:\.(\d+))?/.exec(spec.trim())
  if (m === null) return null
  return [Number.parseInt(m[1]!, 10), m[2] === undefined ? 0 : Number.parseInt(m[2], 10)]
}

/**
 * Best-effort: does this npm version range's lower bound sit at major >= 4?
 * Conservative by design (acceptance 10.4: "fires only on Tailwind v4") —
 * `^4`, `~4.1`, `>=4.0.0`, `4.x`, `4.1.7` → v4; `^3.4`, `3 || 4`, `latest`,
 * `*`, `next` → not v4 (either clearly v3 or ambiguous, and we would rather
 * miss than raise a false hint).
 */
export function tailwindRangeIsV4Plus(range: string): boolean {
  const lb = lowerBound(range)
  return lb !== null && lb[0] >= 4
}

/** Does this exact version (or range floor) carry `@source not`? >= 4.1. */
export function supportsSourceNot(spec: string): boolean {
  const lb = lowerBound(spec)
  if (lb === null) return false
  const [major, minor] = lb
  return major > 4 || (major === 4 && minor >= 1)
}

/**
 * The tailwindcss version actually installed under rootDir — the one that will
 * build, and therefore the one that decides which directives are legal. Read
 * from node_modules/tailwindcss/package.json (npm, pnpm and yarn all leave a
 * resolvable entry there); undefined when deps are not installed.
 */
function installedTailwindVersion(rootDir: string): string | undefined {
  const path = join(rootDir, 'node_modules', 'tailwindcss', 'package.json')
  if (!existsSync(path)) return undefined
  try {
    const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (isObj(pkg) && typeof pkg.version === 'string') return pkg.version
  } catch {
    // an unreadable installed package.json just leaves the version unknown
  }
  return undefined
}

export function detectTailwindV4(rootDir: string): TailwindV4Detection {
  const pkgPath = join(rootDir, 'package.json')
  if (!existsSync(pkgPath)) return { v4: false, sourceNot: false }
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return { v4: false, sourceNot: false } // an unparseable package.json is not our error to raise here
  }
  if (!isObj(pkg)) return { v4: false, sourceNot: false }
  const range = tailwindRange(pkg)
  if (range === undefined) return { v4: false, sourceNot: false }
  if (!tailwindRangeIsV4Plus(range)) return { v4: false, range, sourceNot: false }
  // The installed version wins over the declared range: `^4.0.17` may resolve
  // to 4.1.x and `^4.1.0` cannot be trusted against what is on disk.
  const installed = installedTailwindVersion(rootDir)
  return {
    v4: true,
    range,
    ...(installed !== undefined ? { installed } : {}),
    sourceNot: supportsSourceNot(installed ?? range),
  }
}

// ---------------------------------------------------------------------------
// Tailwind entry stylesheet discovery.
// ---------------------------------------------------------------------------

/** The v4 entry import: `@import "tailwindcss"` (optionally with `source(...)`). Not global — used with .test(). */
const TAILWIND_IMPORT_RE = /@import\s+["']tailwindcss["']/

/** Directories a class scanner never usefully lives in — skipped during the walk. */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'tmp',
])

const MAX_DEPTH = 10

/**
 * Find Tailwind v4 entry stylesheets under rootDir: `.css` files carrying the
 * `@import "tailwindcss"` line. Bounded walk — skips heavy/generated dirs and
 * every dot-directory (`.git`, `.sofar`, `.next`, …) — so it stays cheap on a
 * real repo. Returns absolute paths, sorted for determinism.
 */
export function findTailwindCssEntries(rootDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        walk(path, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.css')) {
        let content: string
        try {
          content = readFileSync(path, 'utf8')
        } catch {
          continue
        }
        if (TAILWIND_IMPORT_RE.test(content)) out.push(path)
      }
    }
  }
  walk(rootDir, 0)
  return out.sort()
}

// ---------------------------------------------------------------------------
// The .sofar exclusion directive.
// ---------------------------------------------------------------------------

/** The `.sofar` path as Tailwind wants it: relative to the STYLESHEET, forward-slashed, dot-anchored. */
export function sofarRelativePath(cssFile: string, rootDir: string): string {
  const sofarDir = join(rootDir, '.sofar')
  let rel = relative(dirname(cssFile), sofarDir).split(sep).join('/')
  // Dot-anchor so Tailwind reads it as a path, not a bare name: `.sofar` → `./.sofar`.
  if (!rel.startsWith('./') && !rel.startsWith('../')) rel = `./${rel}`
  return rel
}

/** The exact line `sofar doctor --fix` inserts (and the hand-edit hint shows). */
export function sofarExclusionDirective(cssFile: string, rootDir: string): string {
  return `@source not "${sofarRelativePath(cssFile, rootDir)}";`
}

/**
 * The pre-4.1 remedy, path-aware: narrow the import's scan base so `.sofar`
 * falls outside it. Tailwind resolves this path against the STYLESHEET too, so
 * `./` means the stylesheet's own directory — right whenever the entry sits
 * below the repo root (the usual `src/app.css`). An entry AT the root has no
 * safe narrower base we can name, so that case yields a placeholder to fill in.
 */
export function sofarScanBaseDirective(cssFile: string, rootDir: string): string {
  const cssDir = dirname(cssFile)
  const sofarAbs = join(rootDir, '.sofar')
  const swallowsSofar = sofarAbs === cssDir || sofarAbs.startsWith(cssDir + sep)
  return `@import "tailwindcss" source("${swallowsSofar ? '<your-template-dir>' : './'}");`
}

/**
 * The scan-base narrowing form, available since v4.0 and therefore the remedy
 * we point pre-4.1 repos at: `@import "tailwindcss" source("./src")` detects
 * classes under that base only, `source(none)` disables detection entirely.
 */
const TAILWIND_IMPORT_SOURCE_RE =
  /@import\s+["']tailwindcss["']\s+source\(\s*(none|["'][^"']*["'])\s*\)/g

/**
 * Does this stylesheet already exclude `.sofar` from scanning? Two mechanisms
 * count, because either genuinely keeps the record out of the scan:
 *   - `@source not "<path>"` (>= 4.1) resolving to `.sofar` or an ancestor that
 *     contains it (a repo-root exclusion also covers .sofar);
 *   - `@import "tailwindcss" source(…)` narrowing the base to a directory that
 *     does NOT contain `.sofar` (or `source(none)`, which scans nothing).
 * Every path is resolved relative to the stylesheet, per Tailwind's contract.
 */
export function cssExcludesSofar(content: string, cssFile: string, rootDir: string): boolean {
  const sofarAbs = join(rootDir, '.sofar')
  const cssDir = dirname(cssFile)
  const contains = (base: string): boolean =>
    sofarAbs === base || sofarAbs.startsWith(base + sep)

  for (const match of content.matchAll(TAILWIND_IMPORT_SOURCE_RE)) {
    const arg = match[1]!
    if (arg === 'none') return true
    if (!contains(resolve(cssDir, arg.slice(1, -1)))) return true
  }
  const re = /@source\s+not\s+["']([^"']+)["']/g
  for (const match of content.matchAll(re)) {
    const raw = match[1]!
    const base = raw.split(/[*?{[]/)[0]!.replace(/\/+$/, '') || '.'
    if (contains(resolve(cssDir, base))) return true
  }
  return false
}

export interface ExclusionInsertion {
  content: string
  changed: boolean
}

/**
 * Insert the `.sofar` exclusion immediately after the `@import "tailwindcss"`
 * line, matching that line's indentation and the file's newline style.
 * Idempotent: a stylesheet already excluding `.sofar` (or one with no tailwind
 * import to anchor on) is returned unchanged.
 *
 * Version-blind on purpose — callers must gate on `TailwindV4Detection.sourceNot`
 * before writing the result, since the directive is a build error before 4.1.
 */
export function insertSofarExclusion(
  content: string,
  cssFile: string,
  rootDir: string,
): ExclusionInsertion {
  if (cssExcludesSofar(content, cssFile, rootDir)) return { content, changed: false }
  const lines = content.split(/\r?\n/)
  const idx = lines.findIndex((line) => TAILWIND_IMPORT_RE.test(line))
  if (idx === -1) return { content, changed: false }
  const indent = /^(\s*)/.exec(lines[idx]!)![1]!
  lines.splice(idx + 1, 0, `${indent}${sofarExclusionDirective(cssFile, rootDir)}`)
  const nl = content.includes('\r\n') ? '\r\n' : '\n'
  return { content: lines.join(nl), changed: true }
}
