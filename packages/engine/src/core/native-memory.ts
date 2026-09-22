import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { NATIVE_ORIGIN_RE } from '@sofar/schema'
import { foldLog } from './fold'
import { commonGitDir } from './git'
import { initiativeSlugs } from './listing'
import { byCodeUnit } from './order'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * Claude Code auto memory as an import SOURCE (memory-lead 2.4, D13/D14).
 *
 * The operator ruled the bridge import-only, off by default, limited to
 * project and reference entries, and approved entry by entry: native memory
 * is private to the operator's machine and a sofar record is committed and
 * shared, so nothing crosses without the operator choosing it. This module
 * only READS the native store and classifies what may be offered; the one
 * write path is `sofar remember --from-native` (cli/native-import.ts), which
 * asks on a terminal. Nothing here writes native memory, ever (D13).
 */

/** The only entry types D13 admits. User and feedback entries never cross. */
export const IMPORTABLE_TYPES: ReadonlySet<string> = new Set(['project', 'reference'])

/** One topic file of the native store, as read. */
export interface NativeEntry {
  /** File name within the memory directory, e.g. `release-steps.md`. */
  file: string
  /** Frontmatter `type`, or `metadata.type`; undefined when neither is set. */
  type?: string
  name?: string
  description?: string
  /** Everything after the frontmatter, trimmed. */
  body: string
  /** First 16 hex of sha256(file bytes) — a changed file is a new digest. */
  digest: string
}

// ---------------------------------------------------------------------------
// Where the store is.
// ---------------------------------------------------------------------------

/**
 * Claude Code's own project-directory name for a path: every non-alphanumeric
 * character becomes `-`, and a result past 200 characters is cut there with a
 * base-36 hash of the path appended — the rule in the 2.1.278 binary.
 */
export function claudeProjectSlug(path: string): string {
  const slug = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= 200) return slug
  return `${slug.slice(0, 200)}-${Math.abs(javaHash(path)).toString(36)}`
}

/** Java's String.hashCode over UTF-16 code units, as Claude Code computes it. */
export function javaHash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return hash
}

/**
 * The main worktree's path: auto memory is keyed by the repository, so every
 * worktree of one clone shares the main checkout's directory.
 */
function mainWorktreeRoot(rootDir: string): string {
  const common = commonGitDir(rootDir)
  const root = common !== null && basename(common) === '.git' ? dirname(common) : rootDir
  try {
    return realpathSync(root)
  } catch {
    return resolve(root)
  }
}

function settingsDir(settingsPath: string): string | undefined {
  try {
    const decoded = JSON.parse(readFileSync(settingsPath, 'utf8')) as { autoMemoryDirectory?: unknown } | null
    const dir = decoded?.autoMemoryDirectory
    return typeof dir === 'string' && dir.trim().length > 0 ? dir.trim() : undefined
  } catch {
    return undefined
  }
}

export interface NativeDirResolution {
  dir: string
  /** Where the answer came from, for the operator's report. */
  source: '--dir' | '.claude/settings.local.json' | '~/.claude/settings.json' | 'default'
}

/**
 * Claude's auto-memory directory for this repo, resolved as Claude resolves
 * it: `autoMemoryDirectory` from the local settings, then the user settings
 * (`~/` expanded), else `<config>/projects/<slug of the main worktree>/memory`.
 * The checked-in .claude/settings.json is never read for it — Claude ignores
 * that key there for security, and so does this. `CLAUDE_CONFIG_DIR` moves
 * the config dir as it does for Claude.
 */
export function claudeMemoryDir(rootDir: string, explicit?: string, env: StateEnv = process.env, home: string = homedir()): NativeDirResolution {
  const expand = (dir: string): string => (dir === '~' ? home : dir.startsWith('~/') ? join(home, dir.slice(2)) : isAbsolute(dir) ? dir : resolve(rootDir, dir))
  if (explicit !== undefined) return { dir: expand(explicit), source: '--dir' }
  const config = env.CLAUDE_CONFIG_DIR !== undefined && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(home, '.claude')
  const local = settingsDir(join(rootDir, '.claude', 'settings.local.json'))
  if (local !== undefined) return { dir: expand(local), source: '.claude/settings.local.json' }
  const user = settingsDir(join(config, 'settings.json'))
  if (user !== undefined) return { dir: expand(user), source: '~/.claude/settings.json' }
  return { dir: join(config, 'projects', claudeProjectSlug(mainWorktreeRoot(rootDir)), 'memory'), source: 'default' }
}

// ---------------------------------------------------------------------------
// Reading it.
// ---------------------------------------------------------------------------

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
  return v
}

/**
 * The frontmatter subset auto-memory files use: top-level `key: value`, one
 * `metadata:` block of indented `key: value`, and `|`/`>` block scalars. A
 * file without frontmatter yields none, which leaves it untyped.
 */
export function parseFrontmatter(text: string): { top: Record<string, string>; metadata: Record<string, string>; body: string } {
  const top: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { top, metadata, body: normalized.trim() }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return { top, metadata, body: normalized.trim() }
  const lines = normalized.slice(4, end).split('\n')
  const after = normalized.slice(end + 4)
  const body = after.startsWith('\n') ? after.slice(1) : after
  let inMetadata = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (m === null) continue
    const [, indent, key, raw] = m as unknown as [string, string, string, string]
    if (indent.length === 0) inMetadata = key === 'metadata' && raw.trim().length === 0
    if (indent.length === 0 && inMetadata) continue
    let value = raw
    if (/^[|>][-+]?\s*$/.test(raw.trim())) {
      const folded = raw.trim().startsWith('>')
      const block: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1]!.trim() === '')) {
        i++
        const next = lines[i]!
        if (next.trim().length === 0 || next.search(/\S/) > indent.length) block.push(next.trim())
        else {
          i--
          break
        }
      }
      value = block.join(folded ? ' ' : '\n')
    }
    if (indent.length > 0 && inMetadata) metadata[key] = unquote(value)
    else if (indent.length === 0) top[key] = unquote(value)
  }
  return { top, metadata, body: body.trim() }
}

/**
 * Every topic file directly in the directory — MEMORY.md (the index) and
 * subdirectories such as `team/` (another sharing regime) are not entries.
 * Unreadable files are skipped. Sorted by file name, code unit order.
 */
export function readNativeEntries(dir: string): NativeEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: NativeEntry[] = []
  for (const file of names.filter((n) => n.endsWith('.md') && n !== 'MEMORY.md').sort(byCodeUnit)) {
    const path = join(dir, file)
    let bytes: Buffer
    try {
      if (!statSync(path).isFile()) continue
      bytes = readFileSync(path)
    } catch {
      continue
    }
    const { top, metadata, body } = parseFrontmatter(bytes.toString('utf8'))
    const type = top.type ?? metadata.type
    out.push({
      file,
      ...(type !== undefined && type.length > 0 ? { type } : {}),
      ...(top.name !== undefined && top.name.length > 0 ? { name: top.name } : {}),
      ...(top.description !== undefined && top.description.length > 0 ? { description: top.description } : {}),
      body,
      digest: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    })
  }
  return out
}

/** The memory text an import records: the description, then the body. */
export function importText(entry: NativeEntry): string {
  const parts = [entry.description, entry.body].filter((p): p is string => p !== undefined && p.trim().length > 0)
  return parts.join('\n\n')
}

export function originOf(entry: NativeEntry): string {
  return `claude-memory:${entry.file}@${entry.digest}`
}

// ---------------------------------------------------------------------------
// What may be offered.
// ---------------------------------------------------------------------------

/** An import already in the repo's records, found by its origin. */
export interface PriorImport {
  file: string
  digest: string
  /** Qualified handle, `<slug> M<n>`. */
  handle: string
  inForce: boolean
}

/** Every memory in the repo that carries a native origin (D14), in force or not. */
export function priorImports(sofarDir: string): PriorImport[] {
  const out: PriorImport[] = []
  for (const slug of initiativeSlugs(sofarDir)) {
    const log = join(sofarDir, 'initiatives', slug, 'events.jsonl')
    if (!existsSync(log)) continue
    let memories
    try {
      memories = foldLog(log).state.memories
    } catch {
      continue
    }
    memories.forEach((memory, index) => {
      const m = memory.origin !== undefined ? NATIVE_ORIGIN_RE.exec(memory.origin) : null
      if (m === null) return
      out.push({ file: m[1]!, digest: m[2]!, handle: `${slug} M${index + 1}`, inForce: memory.superseded_by === undefined })
    })
  }
  return out
}

export interface Candidate {
  entry: NativeEntry
  /** The in-force import of the same file this one replaces, when its file changed since. */
  updates?: string
}

export interface Classification {
  offered: Candidate[]
  /** Entries D13 never offers: user, feedback, or no type at all. */
  notImportable: number
  /** Entries whose exact digest was imported before. */
  alreadyImported: number
  /** Entries whose exact digest this clone declined before. */
  declinedBefore: number
  /** Importable entries with no text to record. */
  empty: number
}

export function classify(entries: readonly NativeEntry[], prior: readonly PriorImport[], declined: ReadonlySet<string>): Classification {
  const result: Classification = { offered: [], notImportable: 0, alreadyImported: 0, declinedBefore: 0, empty: 0 }
  for (const entry of entries) {
    if (entry.type === undefined || !IMPORTABLE_TYPES.has(entry.type)) {
      result.notImportable++
      continue
    }
    if (importText(entry).length === 0) {
      result.empty++
      continue
    }
    if (prior.some((p) => p.file === entry.file && p.digest === entry.digest)) {
      result.alreadyImported++
      continue
    }
    if (declined.has(entry.digest)) {
      result.declinedBefore++
      continue
    }
    const current = prior.find((p) => p.file === entry.file && p.inForce)
    result.offered.push({ entry, ...(current !== undefined ? { updates: current.handle } : {}) })
  }
  return result
}

// ---------------------------------------------------------------------------
// The review's secret flag. sofar has no secret scanner; this only points the
// operator's eye at lines worth a second look before they approve (D13).
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(api[_-]?key|secret|token|passw(or)?d|passwd|credential|auth)\b\s*[:=]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
]

/** 1-based line numbers of `text` that look like they carry a secret. */
export function secretLines(text: string): number[] {
  const out: number[] = []
  text.split('\n').forEach((line, i) => {
    if (SECRET_PATTERNS.some((p) => p.test(line))) out.push(i + 1)
  })
  return out
}

// ---------------------------------------------------------------------------
// Declines: private to this clone, never the record (D14 (f)) — a decline in
// a committed log would publish that the entry exists.
// ---------------------------------------------------------------------------

interface DeclineFile {
  version: 1
  /** digest → the file it was, and when it was declined. */
  declined: Record<string, { file: string; ts: string }>
}

/** `<state>/native-memory/<clone key>.json`, shared by the clone's worktrees; null when it would sit inside the clone. */
export function declinePath(rootDir: string, env: StateEnv = process.env): string | null {
  const base = stateBase(env)
  if (resolvesInside(base, rootDir)) return null
  return join(base, 'native-memory', `${cloneKey(commonGitDir(rootDir) ?? rootDir)}.json`)
}

function readDeclines(path: string | null): DeclineFile {
  const empty: DeclineFile = { version: 1, declined: {} }
  if (path === null || !existsSync(path)) return empty
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeclineFile> | null
    if (decoded === null || typeof decoded.declined !== 'object' || decoded.declined === null) return empty
    return { version: 1, declined: decoded.declined }
  } catch {
    return empty
  }
}

export function declinedDigests(rootDir: string, env: StateEnv = process.env): Set<string> {
  return new Set(Object.keys(readDeclines(declinePath(rootDir, env)).declined))
}

/** Remember a decline on this clone. False when there is no state dir to hold it. */
export function recordDecline(rootDir: string, entry: NativeEntry, now: string, env: StateEnv = process.env): boolean {
  const path = declinePath(rootDir, env)
  if (path === null) return false
  const file = readDeclines(path)
  file.declined[entry.digest] = { file: entry.file, ts: now }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
  return true
}
