import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lowerBound } from './scanners'

/**
 * Host-repo formatter defence (r1-fixes 1.4, r1-fixes D7) — pure detection,
 * shape and fix helpers shared by `sofar init` (the JSON it writes, the final
 * hint) and `sofar doctor` (the audit + --fix).
 *
 * Two failure classes, both observed in round 1 (bench-refresh preview row):
 *
 *   1. The host's formatter rewrites the JSON init writes. Biome's default
 *      indent is a TAB, and both Biome and Prettier collapse a short array
 *      onto one line, so `JSON.stringify(v, null, 2)` is a guaranteed diff
 *      under either — .mcp.json churns in the agent's next commit. init
 *      therefore writes JSON in the shape the host's own formatter would
 *      print: indent and line width resolved from biome.json(c) > the
 *      Prettier config > .editorconfig, with primitive-only arrays collapsed
 *      when they fit (verified against biome 2.5 and prettier 3:
 *      `"args": ["mcp"]`, objects kept expanded). With no formatter
 *      configured the plain 2-space `JSON.stringify` form stays, so user
 *      content still round-trips init → uninit byte-identically (Phase 8).
 *
 *   2. The formatter or linter processes `.sofar/` — a committed record of
 *      generated markdown and JSON nobody hand-edits — so `biome check`,
 *      `prettier --check` and markdownlint go red on it and the agent detours
 *      to patch the tool's config. sofar defends its host the way it does
 *      against Tailwind's scanner (D-P10): configure the tool away from
 *      `.sofar`, never mangle the record. The fix is the one exclusion each
 *      tool documents, written idempotently; a config that is not plain JSON
 *      (comments, trailing commas) is read for the audit but never rewritten —
 *      the finding names the exact line to add instead, the same refusal init
 *      applies to user JSON it cannot round-trip.
 */

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function obj(v: unknown): Obj {
  return isObj(v) ? v : {}
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
function readPackageJson(rootDir: string): Obj {
  const text = readText(join(rootDir, 'package.json'))
  if (text === undefined) return {}
  try {
    const pkg: unknown = JSON.parse(text)
    return obj(pkg)
  } catch {
    return {} // an unparseable package.json is not our error to raise here
  }
}
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const
function depRange(pkg: Obj, name: string): string | undefined {
  for (const field of DEP_FIELDS) {
    const deps = pkg[field]
    if (isObj(deps) && typeof deps[name] === 'string') return deps[name]
  }
  return undefined
}
function installedVersion(rootDir: string, name: string): string | undefined {
  const text = readText(join(rootDir, 'node_modules', name, 'package.json'))
  if (text === undefined) return undefined
  try {
    const pkg: unknown = JSON.parse(text)
    return isObj(pkg) ? str(pkg.version) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Globs — the one matcher behind editorconfig sections, Biome `files`
// patterns, Prettier/markdownlint ignore lines and markdownlint-cli2 `ignores`.
// ---------------------------------------------------------------------------

/** `a{b,c}d` → `abd`, `acd` (nested and multiple groups expand in full). */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{')
  if (open === -1) return [glob]
  let depth = 0
  let close = -1
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++
    else if (glob[i] === '}' && --depth === 0) {
      close = i
      break
    }
  }
  if (close === -1) return [glob]
  const alts: string[] = []
  let level = 0
  let start = open + 1
  for (let i = open + 1; i < close; i++) {
    const c = glob[i]
    if (c === '{') level++
    else if (c === '}') level--
    else if (c === ',' && level === 0) {
      alts.push(glob.slice(start, i))
      start = i + 1
    }
  }
  alts.push(glob.slice(start, close))
  const head = glob.slice(0, open)
  const tail = glob.slice(close + 1)
  return alts.flatMap((alt) => expandBraces(`${head}${alt}${tail}`))
}

/**
 * Minimal glob → anchored RegExp: `**` spans segments (`** /` zero or more of
 * them), `*` stays within one, `?` is one character, `[…]` classes pass
 * through, braces are expanded first. Enough for every pattern the tools
 * above accept in the shapes people actually write.
 */
export function globToRegExp(glob: string): RegExp {
  const alternatives = expandBraces(glob).map((g) => {
    let re = ''
    for (let i = 0; i < g.length; i++) {
      const c = g[i]!
      if (c === '*') {
        if (g[i + 1] === '*') {
          if (g[i + 2] === '/') {
            re += '(?:.*/)?'
            i += 2
          } else {
            re += '.*'
            i += 1
          }
        } else {
          re += '[^/]*'
        }
      } else if (c === '?') {
        re += '[^/]'
      } else if (c === '[') {
        const end = g.indexOf(']', i + 1)
        if (end === -1) {
          re += '\\['
        } else {
          re += g.slice(i, end + 1)
          i = end
        }
      } else {
        re += c.replace(/[.+^$(){}|\\]/g, '\\$&')
      }
    }
    return re
  })
  return new RegExp(`^(?:${alternatives.join('|')})$`)
}

/**
 * Normalize an ignore-style pattern to a root-relative glob: negation
 * prefixes (`!`, Biome's `!!`) dropped — callers decide what a negation
 * means — a leading `./` or `/` stripped, a trailing `/` stripped, and a
 * pattern with no slash inside made to match at any depth (`**\/`), the
 * gitignore rule editorconfig, Prettier and markdownlint all share.
 */
export function normalizePattern(pattern: string): string {
  let p = pattern.trim().replace(/^!+/, '')
  if (p.startsWith('./')) p = p.slice(2)
  else if (p.startsWith('/')) p = p.slice(1)
  p = p.replace(/\/+$/, '')
  if (!p.includes('/')) p = `**/${p}`
  return p
}

/** Does this pattern match a root-relative file path? */
export function patternMatches(pattern: string, relPath: string): boolean {
  const p = normalizePattern(pattern)
  if (p === '') return false
  return globToRegExp(p).test(relPath)
}

/**
 * Does this pattern reach into `.sofar`? Either the directory itself
 * (`.sofar`, `** /.sofar`, `/.sofar/`) or anything inside it (`.sofar/**`,
 * `** /.sofar/**`) counts — each genuinely keeps the record out of a tool
 * that honours it. A repo-wide `**` reaches it too, which is what makes it
 * useful for the positive half of a Biome `includes` list.
 */
export function patternCoversSofar(pattern: string): boolean {
  return patternMatches(pattern, '.sofar') || patternMatches(pattern, '.sofar/x')
}

// ---------------------------------------------------------------------------
// JSONC — read-only tolerance. A config with comments is parsed for the audit
// and never rewritten (serializing would drop the comments).
// ---------------------------------------------------------------------------

/** Strip `//` and `/* *\/` comments (outside strings) and trailing commas. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') j++
        j++
      }
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

interface JsonFile {
  parsed: Obj
  /** True when JSON.parse accepted the raw text — the file can be rewritten losslessly. */
  plain: boolean
}

function readJsonFile(path: string): JsonFile | null {
  const text = readText(path)
  if (text === undefined) return null
  try {
    const v: unknown = JSON.parse(text)
    return isObj(v) ? { parsed: v, plain: true } : null
  } catch {
    // fall through to the tolerant read
  }
  try {
    const v: unknown = JSON.parse(stripJsonc(text))
    return isObj(v) ? { parsed: v, plain: false } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// JSON shape.
// ---------------------------------------------------------------------------

export interface JsonStyle {
  /** One indent level as written: a tab, or `indentWidth` spaces. */
  indent: string
  /** Columns one level occupies when measuring against `lineWidth`. */
  indentWidth: number
  lineWidth: number
  /** Which configuration decided the shape. */
  source: 'biome' | 'prettier' | 'editorconfig' | 'default'
}

export const DEFAULT_JSON_STYLE: JsonStyle = {
  indent: '  ',
  indentWidth: 2,
  lineWidth: 80,
  source: 'default',
}

function makeStyle(
  source: JsonStyle['source'],
  indentStyle: string,
  indentWidth: number,
  lineWidth: number,
): JsonStyle {
  const width = Math.max(1, Math.floor(indentWidth))
  return {
    indent: indentStyle === 'tab' ? '\t' : ' '.repeat(width),
    indentWidth: width,
    lineWidth: Math.max(20, Math.floor(lineWidth)),
    source,
  }
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object'
}

function renderValue(v: unknown, depth: number, used: number, style: JsonStyle): string {
  if (isPrimitive(v)) return JSON.stringify(v === undefined ? null : v)
  const inner = style.indent.repeat(depth + 1)
  const outer = style.indent.repeat(depth)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (v.every(isPrimitive)) {
      // Both formatters print a short array of scalars on one line and break
      // it one-per-line only when it overflows.
      const inline = `[${v.map((x) => JSON.stringify(x === undefined ? null : x)).join(', ')}]`
      if (used + inline.length <= style.lineWidth) return inline
    }
    const innerCols = (depth + 1) * style.indentWidth
    const items = v.map(
      (x, i) => `${inner}${renderValue(x, depth + 1, innerCols + (i < v.length - 1 ? 1 : 0), style)}`,
    )
    return `[\n${items.join(',\n')}\n${outer}]`
  }
  const entries = Object.entries(v as Obj).filter(([, x]) => x !== undefined)
  if (entries.length === 0) return '{}'
  // Objects always expand: both formatters keep an object expanded once a
  // newline follows its `{`, so this shape is a fixed point under either.
  const innerCols = (depth + 1) * style.indentWidth
  const lines = entries.map(([k, x], i) => {
    const key = `${JSON.stringify(k)}: `
    const trailing = i < entries.length - 1 ? 1 : 0
    return `${inner}${key}${renderValue(x, depth + 1, innerCols + key.length + trailing, style)}`
  })
  return `{\n${lines.join(',\n')}\n${outer}}`
}

/**
 * Pretty JSON in the host formatter's shape, trailing newline included.
 * With the default style it differs from `JSON.stringify(v, null, 2)` in
 * exactly one way — a short array of scalars stays on one line — which is
 * what makes the output a fixed point under Prettier's defaults as well.
 */
export function formatJSON(value: unknown, style: JsonStyle = DEFAULT_JSON_STYLE): string {
  return `${renderValue(value, 0, 0, style)}\n`
}

// ---------------------------------------------------------------------------
// .editorconfig — the root file only; sections are matched against the
// target path in file order, later sections overriding earlier ones.
// ---------------------------------------------------------------------------

type EcProps = Record<string, string>

function editorconfigFor(rootDir: string, relFile: string): EcProps {
  const text = readText(join(rootDir, '.editorconfig'))
  if (text === undefined) return {}
  const props: EcProps = {}
  let applies = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      const glob = line.slice(1, -1).trim()
      applies = glob !== '' && patternMatches(glob, relFile)
      continue
    }
    if (!applies) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    props[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim().toLowerCase()
  }
  return props
}

interface EcIndent {
  style?: 'tab' | 'space'
  width?: number
  lineWidth?: number
}

function ecIndent(ec: EcProps): EcIndent {
  const out: EcIndent = {}
  if (ec.indent_style === 'tab' || ec.indent_style === 'space') out.style = ec.indent_style
  const size = ec.indent_size === 'tab' ? ec.tab_width : (ec.indent_size ?? ec.tab_width)
  if (size !== undefined && /^\d+$/.test(size)) out.width = Number.parseInt(size, 10)
  if (ec.max_line_length !== undefined && /^\d+$/.test(ec.max_line_length)) {
    out.lineWidth = Number.parseInt(ec.max_line_length, 10)
  }
  return out
}

// ---------------------------------------------------------------------------
// Biome.
// ---------------------------------------------------------------------------

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'] as const

interface Biome {
  rel: string
  file: JsonFile
  /** Config dialect: 1 (`files.ignore`) or 2 (`files.includes` with `!`); undefined when unknowable. */
  major: number | undefined
}

function readBiome(rootDir: string): Biome | null {
  for (const rel of BIOME_CONFIGS) {
    const path = join(rootDir, rel)
    if (!existsSync(path)) continue
    const file = readJsonFile(path)
    if (file === null) return null // unreadable/unparseable: treat as absent rather than guess
    return { rel, file, major: biomeMajor(rootDir, file.parsed) }
  }
  return null
}

function biomeMajor(rootDir: string, config: Obj): number | undefined {
  // The installed binary decides which dialect is accepted, so it wins over
  // the schema URL the config was written against (a stale `$schema` after an
  // upgrade is common); the declared range's floor is the last resort before
  // reading the dialect off the config's own shape.
  const installed = installedVersion(rootDir, '@biomejs/biome')
  const fromInstalled = installed === undefined ? null : lowerBound(installed)
  if (fromInstalled !== null) return fromInstalled[0]
  const schema = str(config.$schema)
  const m = schema === undefined ? null : /\/schemas\/(\d+)\./.exec(schema)
  if (m !== null) return Number.parseInt(m[1]!, 10)
  const range = depRange(readPackageJson(rootDir), '@biomejs/biome')
  const fromRange = range === undefined ? null : lowerBound(range)
  if (fromRange !== null) return fromRange[0]
  const files = obj(config.files)
  if (Array.isArray(files.includes)) return 2
  if (Array.isArray(files.ignore)) return 1
  return undefined
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}

/** Does Biome's `files` block leave this path alone? */
function biomeSkips(config: Obj, relPath: string): boolean {
  const files = obj(config.files)
  const includes = stringArray(files.includes)
  if (includes !== undefined) {
    // v2: a path is processed iff some positive pattern matches it and no
    // negated one does. An `includes` list with no positive match is a
    // narrowing, which keeps the path out just as well.
    const positive = includes.filter((p) => !p.startsWith('!'))
    const negative = includes.filter((p) => p.startsWith('!'))
    if (!positive.some((p) => patternMatches(p, relPath))) return true
    if (negative.some((p) => patternMatches(p, relPath))) return true
  }
  const ignore = stringArray(files.ignore)
  if (ignore !== undefined && ignore.some((p) => patternMatches(p, relPath))) return true
  return false
}

function biomeExcludesSofar(config: Obj): boolean {
  return biomeSkips(config, '.sofar') || biomeSkips(config, '.sofar/x')
}

export const BIOME_V2_EXCLUSION = '!**/.sofar'
export const BIOME_V1_EXCLUSION = '.sofar'

function biomeStyle(biome: Biome, relFile: string, ec: EcProps): JsonStyle | null {
  const config = biome.file.parsed
  if (biomeSkips(config, relFile)) return null
  const fmt = obj(config.formatter)
  const jsonFmt = obj(obj(config.json).formatter)
  if (fmt.enabled === false || jsonFmt.enabled === false) return null
  // v2 reads .editorconfig by default; v1 only when asked.
  const useEc = fmt.useEditorconfig ?? (biome.major ?? 2) >= 2
  const fromEc = useEc === true ? ecIndent(ec) : {}
  return makeStyle(
    'biome',
    str(jsonFmt.indentStyle) ?? str(fmt.indentStyle) ?? fromEc.style ?? 'tab',
    num(jsonFmt.indentWidth) ?? num(fmt.indentWidth) ?? fromEc.width ?? 2,
    num(jsonFmt.lineWidth) ?? num(fmt.lineWidth) ?? fromEc.lineWidth ?? 80,
  )
}

// ---------------------------------------------------------------------------
// Prettier.
// ---------------------------------------------------------------------------

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
] as const

interface Prettier {
  /** What identified it — a config file, the package.json key, or the dependency. */
  via: string
  options: Obj
}

/** The three options that shape JSON, read from a JSON config or a flat YAML one. */
function prettierOptionsFrom(text: string): Obj {
  try {
    const v: unknown = JSON.parse(text)
    return obj(v)
  } catch {
    // .prettierrc is YAML as often as JSON; a flat `key: value` file is all
    // the shape we need, and anything richer just falls back to defaults.
  }
  const out: Obj = {}
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(useTabs|tabWidth|printWidth)\s*:\s*("?)([^"#\s]+)\2\s*(?:#.*)?$/.exec(raw)
    if (m === null) continue
    const value = m[3]!
    out[m[1]!] = value === 'true' ? true : value === 'false' ? false : /^\d+$/.test(value) ? Number.parseInt(value, 10) : value
  }
  return out
}

function readPrettier(rootDir: string): Prettier | null {
  for (const rel of PRETTIER_CONFIGS) {
    const text = readText(join(rootDir, rel))
    if (text === undefined) continue
    const readable = rel === '.prettierrc' || rel.endsWith('.json') || rel.endsWith('.yaml') || rel.endsWith('.yml')
    return { via: rel, options: readable ? prettierOptionsFrom(text) : {} }
  }
  const pkg = readPackageJson(rootDir)
  if (isObj(pkg.prettier)) return { via: 'package.json "prettier"', options: pkg.prettier }
  if (depRange(pkg, 'prettier') !== undefined) return { via: 'package.json dependency', options: {} }
  return null
}

const PRETTIER_IGNORE = '.prettierignore'

function ignoreLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
}

function ignoreFileCovers(rootDir: string, rel: string, relPath: string): boolean {
  const text = readText(join(rootDir, rel))
  if (text === undefined) return false
  return ignoreLines(text).some((l) => patternMatches(l, relPath))
}

function ignoreFileCoversSofar(rootDir: string, rel: string): boolean {
  return ignoreFileCovers(rootDir, rel, '.sofar') || ignoreFileCovers(rootDir, rel, '.sofar/x')
}

/** The line every ignore file gets: the directory form, unambiguous to each tool. */
export const SOFAR_IGNORE_LINE = '.sofar/'

function appendIgnoreLine(path: string, line: string): void {
  const existing = readText(path)
  if (existing === undefined || existing === '') {
    writeFileSync(path, `${line}\n`, 'utf8')
    return
  }
  const nl = existing.includes('\r\n') ? '\r\n' : '\n'
  const seam = existing.endsWith('\n') ? '' : nl
  writeFileSync(path, `${existing}${seam}${line}${nl}`, 'utf8')
}

function prettierStyle(prettier: Prettier, ec: EcProps): JsonStyle {
  // Prettier reads .editorconfig underneath its own options by default.
  const fromEc = ecIndent(ec)
  const useTabs = bool(prettier.options.useTabs) ?? (fromEc.style === undefined ? false : fromEc.style === 'tab')
  return makeStyle(
    'prettier',
    useTabs ? 'tab' : 'space',
    num(prettier.options.tabWidth) ?? fromEc.width ?? 2,
    num(prettier.options.printWidth) ?? fromEc.lineWidth ?? 80,
  )
}

// ---------------------------------------------------------------------------
// markdownlint (cli and cli2).
// ---------------------------------------------------------------------------

const MARKDOWNLINT_CLI2_CONFIGS = [
  '.markdownlint-cli2.jsonc',
  '.markdownlint-cli2.yaml',
  '.markdownlint-cli2.yml',
  '.markdownlint-cli2.cjs',
  '.markdownlint-cli2.mjs',
] as const
const MARKDOWNLINT_CONFIGS = [
  '.markdownlint.json',
  '.markdownlint.jsonc',
  '.markdownlint.yaml',
  '.markdownlint.yml',
  '.markdownlintrc',
] as const
const MARKDOWNLINT_IGNORE = '.markdownlintignore'
const MARKDOWNLINT_CLI2_DEFAULT_CONFIG = '.markdownlint-cli2.jsonc'
export const MARKDOWNLINT_CLI2_EXCLUSION = '**/.sofar/**'

// ---------------------------------------------------------------------------
// Style resolution — the one entry point init and uninit use.
// ---------------------------------------------------------------------------

/**
 * The shape the host's formatter would print `relFile` in. Biome wins when it
 * would format the file (present, formatter on, file not excluded), then
 * Prettier (present, file not ignored), then .editorconfig alone, then the
 * 2-space default. A file that no formatter will touch keeps the default —
 * matching a tool that never runs on it would only make the output odd.
 */
export function resolveJsonStyle(rootDir: string, relFile: string): JsonStyle {
  const ec = editorconfigFor(rootDir, relFile)
  const biome = readBiome(rootDir)
  if (biome !== null) {
    const style = biomeStyle(biome, relFile, ec)
    if (style !== null) return style
  }
  const prettier = readPrettier(rootDir)
  if (prettier !== null && !ignoreFileCovers(rootDir, PRETTIER_IGNORE, relFile)) {
    return prettierStyle(prettier, ec)
  }
  const fromEc = ecIndent(ec)
  if (fromEc.style !== undefined || fromEc.width !== undefined) {
    return makeStyle('editorconfig', fromEc.style ?? 'space', fromEc.width ?? 2, fromEc.lineWidth ?? 80)
  }
  return DEFAULT_JSON_STYLE
}

/**
 * JSON for a file init, uninit or --fix writes under rootDir: the host
 * formatter's shape when one is configured, else the plain
 * `JSON.stringify(v, null, 2)` form sofar has always written. The plain form
 * is kept on purpose — with no formatter to satisfy, matching one would only
 * break the Phase 8 promise that user content round-trips init → uninit
 * byte-identically; with one configured, that promise is the formatter's to
 * keep, and its own shape is the only stable one.
 */
export function hostShapedJSON(rootDir: string, relFile: string, value: unknown): string {
  const style = resolveJsonStyle(rootDir, relFile)
  if (style.source === 'default') return `${JSON.stringify(value, null, 2)}\n`
  return formatJSON(value, style)
}

// ---------------------------------------------------------------------------
// Hazards — what doctor audits and --fix repairs, what init hints at.
// ---------------------------------------------------------------------------

export type FormatterTool = 'biome' | 'prettier' | 'markdownlint'

export interface FormatterHazard {
  tool: FormatterTool
  /** Display name with what identified the tool, e.g. `Biome 2 (biome.json)`. */
  label: string
  /** Repo-relative file the exclusion lives in (or would be written to). */
  file: string
  /** True when `.sofar` is already kept out of the tool's reach. */
  excluded: boolean
  /** The exclusion, quoted for a hand edit — what --fix writes. */
  directive: string
  /** Applies the exclusion (idempotent). Absent when --fix must be withheld. */
  apply?: () => void
  /** Why --fix cannot write, and what to do instead. Set iff `apply` is absent and not excluded. */
  withheld?: string
}

function withheld(reason: string): string {
  return `${reason} — add it by hand and rerun`
}

function biomeHazard(rootDir: string): FormatterHazard | null {
  const biome = readBiome(rootDir)
  if (biome === null) {
    // A dependency without a config file still runs with defaults — and
    // still reads .sofar — but there is nothing safe to write into.
    const pkg = readPackageJson(rootDir)
    const range = depRange(pkg, '@biomejs/biome')
    if (range === undefined) return null
    const major = lowerBound(installedVersion(rootDir, '@biomejs/biome') ?? range)?.[0]
    const directive = major === 1 ? `"${BIOME_V1_EXCLUSION}" in files.ignore` : `"${BIOME_V2_EXCLUSION}" in files.includes`
    return {
      tool: 'biome',
      label: `Biome${major === undefined ? '' : ` ${major}`} (package.json dependency)`,
      file: 'biome.json',
      excluded: false,
      directive,
      withheld: withheld('no biome.json to write into'),
    }
  }
  const config = biome.file.parsed
  const label = `Biome${biome.major === undefined ? '' : ` ${biome.major}`} (${biome.rel})`
  const base = { tool: 'biome' as const, label, file: biome.rel }
  if (biomeExcludesSofar(config)) {
    return { ...base, excluded: true, directive: '' }
  }
  if (biome.major === undefined) {
    return {
      ...base,
      excluded: false,
      directive: `"${BIOME_V2_EXCLUSION}" in files.includes (Biome 2) or "${BIOME_V1_EXCLUSION}" in files.ignore (Biome 1)`,
      withheld: withheld('Biome major version unknown (no $schema, not installed, not in package.json)'),
    }
  }
  const v2 = biome.major >= 2
  const directive = v2 ? `"${BIOME_V2_EXCLUSION}" in files.includes` : `"${BIOME_V1_EXCLUSION}" in files.ignore`
  if (!biome.file.plain) {
    return {
      ...base,
      excluded: false,
      directive,
      withheld: withheld(`${biome.rel} carries comments, which a rewrite would drop`),
    }
  }
  const files = obj(config.files)
  if (v2 && files.includes !== undefined && stringArray(files.includes) === undefined) {
    return { ...base, excluded: false, directive, withheld: withheld('files.includes is not a list of strings') }
  }
  if (!v2 && files.ignore !== undefined && stringArray(files.ignore) === undefined) {
    return { ...base, excluded: false, directive, withheld: withheld('files.ignore is not a list of strings') }
  }
  return {
    ...base,
    excluded: false,
    directive,
    apply: () => {
      const next: Obj = { ...config }
      const nextFiles: Obj = { ...obj(config.files) }
      if (v2) {
        nextFiles.includes = [...(stringArray(nextFiles.includes) ?? ['**']), BIOME_V2_EXCLUSION]
      } else {
        nextFiles.ignore = [...(stringArray(nextFiles.ignore) ?? []), BIOME_V1_EXCLUSION]
      }
      next.files = nextFiles
      writeFileSync(join(rootDir, biome.rel), hostShapedJSON(rootDir, biome.rel, next), 'utf8')
    },
  }
}

function prettierHazard(rootDir: string): FormatterHazard | null {
  const prettier = readPrettier(rootDir)
  if (prettier === null) return null
  const base = { tool: 'prettier' as const, label: `Prettier (${prettier.via})`, file: PRETTIER_IGNORE }
  if (ignoreFileCoversSofar(rootDir, PRETTIER_IGNORE)) return { ...base, excluded: true, directive: '' }
  return {
    ...base,
    excluded: false,
    directive: `\`${SOFAR_IGNORE_LINE}\``,
    apply: () => appendIgnoreLine(join(rootDir, PRETTIER_IGNORE), SOFAR_IGNORE_LINE),
  }
}

function markdownlintHazard(rootDir: string): FormatterHazard | null {
  const pkg = readPackageJson(rootDir)
  const cli2Config = MARKDOWNLINT_CLI2_CONFIGS.find((rel) => existsSync(join(rootDir, rel)))
  const cliConfig = MARKDOWNLINT_CONFIGS.find((rel) => existsSync(join(rootDir, rel)))
  const cli2Dep = depRange(pkg, 'markdownlint-cli2') !== undefined
  const cliDep = depRange(pkg, 'markdownlint-cli') !== undefined
  if (cli2Config === undefined && cliConfig === undefined && !cli2Dep && !cliDep) return null

  // cli2 reads `ignores` from its own config and not .markdownlintignore;
  // markdownlint-cli is the other way round.
  const cli2 = cli2Config !== undefined || (cli2Dep && !cliDep)
  if (!cli2) {
    const via = cliConfig ?? 'package.json dependency'
    const base = { tool: 'markdownlint' as const, label: `markdownlint (${via})`, file: MARKDOWNLINT_IGNORE }
    if (ignoreFileCoversSofar(rootDir, MARKDOWNLINT_IGNORE)) return { ...base, excluded: true, directive: '' }
    return {
      ...base,
      excluded: false,
      directive: `\`${SOFAR_IGNORE_LINE}\``,
      apply: () => appendIgnoreLine(join(rootDir, MARKDOWNLINT_IGNORE), SOFAR_IGNORE_LINE),
    }
  }

  const rel = cli2Config ?? MARKDOWNLINT_CLI2_DEFAULT_CONFIG
  const via = cli2Config ?? 'package.json dependency'
  const base = { tool: 'markdownlint' as const, label: `markdownlint-cli2 (${via})`, file: rel }
  const directive = `"${MARKDOWNLINT_CLI2_EXCLUSION}" in ignores`
  const file = cli2Config === undefined ? { parsed: {}, plain: true } : readJsonFile(join(rootDir, rel))
  if (file === null) {
    return { ...base, excluded: false, directive, withheld: withheld(`${rel} is not JSON (YAML or a script)`) }
  }
  const ignores = stringArray(file.parsed.ignores)
  if (ignores !== undefined && ignores.some(patternCoversSofar)) return { ...base, excluded: true, directive: '' }
  if (!file.plain) {
    return { ...base, excluded: false, directive, withheld: withheld(`${rel} carries comments, which a rewrite would drop`) }
  }
  if (file.parsed.ignores !== undefined && ignores === undefined) {
    return { ...base, excluded: false, directive, withheld: withheld('ignores is not a list of strings') }
  }
  return {
    ...base,
    excluded: false,
    directive,
    apply: () => {
      const next: Obj = { ...file.parsed, ignores: [...(ignores ?? []), MARKDOWNLINT_CLI2_EXCLUSION] }
      writeFileSync(join(rootDir, rel), hostShapedJSON(rootDir, rel, next), 'utf8')
    },
  }
}

/**
 * Every formatter or linter the host runs that would reach into `.sofar`,
 * in a fixed order (Biome, Prettier, markdownlint) for a deterministic
 * report. Each carries either an idempotent `apply` or the reason the write
 * is withheld; an excluded tool carries neither.
 */
export function detectFormatterHazards(rootDir: string): FormatterHazard[] {
  const hazards: FormatterHazard[] = []
  for (const detect of [biomeHazard, prettierHazard, markdownlintHazard]) {
    const hazard = detect(rootDir)
    if (hazard !== null) hazards.push(hazard)
  }
  return hazards
}
