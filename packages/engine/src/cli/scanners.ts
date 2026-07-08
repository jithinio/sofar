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
 */

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Tailwind v4 detection (package.json).
// ---------------------------------------------------------------------------

export interface TailwindV4Detection {
  /** True iff a `tailwindcss` dependency resolves to major >= 4. */
  v4: boolean
  /** The raw version range from package.json, when a tailwindcss dep was found. */
  range?: string
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

function tailwindRange(pkg: Obj): string | undefined {
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (isObj(deps) && typeof deps.tailwindcss === 'string') return deps.tailwindcss
  }
  return undefined
}

/**
 * Best-effort: does this npm version range's lower bound sit at major >= 4?
 * Conservative by design (acceptance 10.4: "fires only on Tailwind v4") —
 * strips a leading run of range operators (^ ~ >= > < = v) and reads the first
 * integer as the major. `^4`, `~4.1`, `>=4.0.0`, `4.x`, `4.1.7` → v4; `^3.4`,
 * `3 || 4`, `latest`, `*`, `next` → not v4 (either clearly v3 or ambiguous, and
 * we would rather miss than raise a false hint).
 */
export function tailwindRangeIsV4Plus(range: string): boolean {
  const m = /^[\s^~>=<v]*(\d+)/.exec(range.trim())
  return m !== null && Number.parseInt(m[1]!, 10) >= 4
}

export function detectTailwindV4(rootDir: string): TailwindV4Detection {
  const pkgPath = join(rootDir, 'package.json')
  if (!existsSync(pkgPath)) return { v4: false }
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return { v4: false } // an unparseable package.json is not our error to raise here
  }
  if (!isObj(pkg)) return { v4: false }
  const range = tailwindRange(pkg)
  if (range === undefined) return { v4: false }
  return tailwindRangeIsV4Plus(range) ? { v4: true, range } : { v4: false, range }
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
 * Does this stylesheet already exclude `.sofar` from scanning? Parses every
 * `@source not "<path>"`, strips any glob tail, resolves it relative to the
 * stylesheet, and returns true when one resolves to `.sofar` itself or an
 * ancestor that contains it (e.g. a repo-root exclusion also covers .sofar).
 */
export function cssExcludesSofar(content: string, cssFile: string, rootDir: string): boolean {
  const sofarAbs = join(rootDir, '.sofar')
  const cssDir = dirname(cssFile)
  const re = /@source\s+not\s+["']([^"']+)["']/g
  for (const match of content.matchAll(re)) {
    const raw = match[1]!
    const base = raw.split(/[*?{[]/)[0]!.replace(/\/+$/, '') || '.'
    const resolved = resolve(cssDir, base)
    if (sofarAbs === resolved || sofarAbs.startsWith(resolved + sep)) return true
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
