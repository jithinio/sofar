import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  validateDiagnosticRow,
  type DiagnosticDataByKind,
  type DiagnosticHost,
  type DiagnosticKind,
  type DiagnosticRow,
} from '@sofar/schema/diagnostics'
import { version as ENGINE_VERSION } from '../../package.json'
import { writeFileAtomic } from './atomic'
import { cloneKey, resolvesInside, stateBase, type StateEnv } from './state-dir'

/**
 * The private diagnostics store (self-improve D3, SPEC §Diagnostics store).
 *
 * A THIRD class of data next to events.jsonl (truth) and .sofar/.index
 * (derived, disposable): raw observations that exist nowhere else and are
 * NOT rebuildable, kept OUTSIDE the repo under the XDG state dir, keyed by
 * clone hash exactly like the sync cursors. Nothing the fold, the projections
 * or the digest's byte-stable block depends on may read it; its loss costs
 * evidence, never record correctness.
 *
 * Layout: `<stateBase>/diagnostics/<cloneKey>/<initiative>.jsonl` plus one
 * `meta.json` per clone that remembers the last retention sweep.
 *
 * Every write is best-effort (BD22) and never recursive: a failed write
 * returns false, appends no event, and is not itself recorded as a
 * diagnostic. Rows are validated against the schema before the append so the
 * store can never widen the shape from the engine side (D2 (1)).
 */

/** Rows older than this are dropped by the next sweep (D3 (2)). */
export const DIAGNOSTIC_RETENTION_DAYS = 90
/** A sweep runs at most this often — one stat per write, one read per day. */
export const DIAGNOSTIC_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Per-file byte cap; over it, the oldest rows go until the file fits in half the cap. */
export const DIAGNOSTIC_FILE_BYTE_CAP = 8 * 1024 * 1024
/** File name for observations no initiative could be resolved for. Not a slug on purpose. */
export const UNBOUND_INITIATIVE = '_unbound'

const META_FILE = 'meta.json'

export interface DiagnosticsMeta {
  version: 1
  /** ISO time of the last retention sweep over this clone's files. */
  last_sweep?: string
}

/**
 * Directory for this clone's rows. Returns null — and so every writer stays
 * silent — when the resolved directory would sit INSIDE the repo, which can
 * only happen when XDG_STATE_HOME points there. D3 (1): never under the clone
 * root, and the resolver refuses rather than trusting a gitignore.
 */
export function diagnosticsDir(rootDir: string, env: StateEnv = process.env): string | null {
  const dir = join(stateBase(env), 'diagnostics', cloneKey(rootDir))
  return resolvesInside(dir, rootDir) ? null : dir
}

/** Path of one initiative's row file, or null when the store is refused. */
export function diagnosticsFile(
  rootDir: string,
  initiative: string,
  env: StateEnv = process.env,
): string | null {
  const dir = diagnosticsDir(rootDir, env)
  if (dir === null) return null
  return join(dir, `${safeName(initiative)}.jsonl`)
}

/** Initiatives are slugs already; `_unbound` and anything else are sanitized the way session ids are. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_')
}

export interface RowInput<K extends DiagnosticKind> {
  kind: K
  data: DiagnosticDataByKind[K]
  initiative?: string
  session?: string
  host?: DiagnosticHost
  /** Injected for tests; defaults to now. */
  now?: Date
}

/** Build a complete, validated row for this clone. */
export function makeDiagnosticRow<K extends DiagnosticKind>(
  rootDir: string,
  input: RowInput<K>,
): DiagnosticRow<K> {
  return {
    d: 1,
    ts: (input.now ?? new Date()).toISOString(),
    engine: ENGINE_VERSION,
    ...(input.host !== undefined ? { host: input.host } : {}),
    clone: cloneKey(rootDir),
    initiative: input.initiative ?? UNBOUND_INITIATIVE,
    session: input.session ?? 'cli',
    kind: input.kind,
    data: input.data,
  }
}

/**
 * Append one row. Returns true when the line landed. Every failure — refused
 * store, invalid row, unwritable directory — returns false and throws
 * nothing, because the caller is a hook or a tool handler in the middle of
 * the user's own operation.
 */
export function appendDiagnostic(
  rootDir: string,
  row: DiagnosticRow,
  env: StateEnv = process.env,
): boolean {
  try {
    const check = validateDiagnosticRow(row)
    if (!check.ok) return false
    const file = diagnosticsFile(rootDir, row.initiative, env)
    if (file === null) return false
    const dir = diagnosticsDir(rootDir, env)!
    mkdirSync(dir, { recursive: true })
    appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8')
    maintain(dir, file)
    return true
  } catch {
    return false
  }
}

/** Convenience: build and append in one call. */
export function recordDiagnostic<K extends DiagnosticKind>(
  rootDir: string,
  input: RowInput<K>,
  env: StateEnv = process.env,
): boolean {
  try {
    return appendDiagnostic(rootDir, makeDiagnosticRow(rootDir, input), env)
  } catch {
    return false
  }
}

/**
 * Retention and cap, both bounded so the hot path pays one stat per write:
 * the cap check is a stat of the file just appended; the sweep runs once per
 * DIAGNOSTIC_SWEEP_INTERVAL_MS per clone, remembered in meta.json.
 */
function maintain(dir: string, file: string): void {
  const now = Date.now()
  const size = statSync(file).size
  if (size > DIAGNOSTIC_FILE_BYTE_CAP) compactFile(file, now)

  const metaPath = join(dir, META_FILE)
  const meta = readMeta(metaPath)
  const last = meta.last_sweep !== undefined ? Date.parse(meta.last_sweep) : NaN
  if (!Number.isNaN(last) && now - last < DIAGNOSTIC_SWEEP_INTERVAL_MS) return
  sweepDir(dir, now)
  writeFileSync(metaPath, `${JSON.stringify({ version: 1, last_sweep: new Date(now).toISOString() })}\n`)
}

function readMeta(path: string): DiagnosticsMeta {
  try {
    const decoded = JSON.parse(readFileSync(path, 'utf8')) as Partial<DiagnosticsMeta> | null
    if (typeof decoded === 'object' && decoded !== null && decoded.version === 1) {
      return { version: 1, ...(typeof decoded.last_sweep === 'string' ? { last_sweep: decoded.last_sweep } : {}) }
    }
  } catch {
    // absent or corrupt → sweep now
  }
  return { version: 1 }
}

/** Drop rows past retention in every row file of the clone. */
export function sweepDir(dir: string, nowMs = Date.now()): void {
  const cutoff = nowMs - DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const entry of listRowFiles(dir)) {
    const path = join(dir, entry)
    const lines = readLines(path)
    const kept = lines.filter((line) => {
      const ts = rowTs(line)
      return ts === null || ts >= cutoff
    })
    if (kept.length !== lines.length) writeLines(path, kept)
  }
}

/** Over the cap: drop expired rows first, then the oldest until the file fits in half the cap. */
function compactFile(path: string, nowMs: number): void {
  const cutoff = nowMs - DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let lines = readLines(path).filter((line) => {
    const ts = rowTs(line)
    return ts === null || ts >= cutoff
  })
  const target = Math.floor(DIAGNOSTIC_FILE_BYTE_CAP / 2)
  let bytes = lines.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0)
  let drop = 0
  while (bytes > target && drop < lines.length) {
    bytes -= Buffer.byteLength(lines[drop]!, 'utf8') + 1
    drop++
  }
  if (drop > 0) lines = lines.slice(drop)
  writeLines(path, lines)
}

function rowTs(line: string): number | null {
  try {
    const decoded = JSON.parse(line) as { ts?: unknown }
    if (typeof decoded.ts !== 'string') return null
    const ms = Date.parse(decoded.ts)
    return Number.isNaN(ms) ? null : ms
  } catch {
    return null
  }
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

function writeLines(path: string, lines: readonly string[]): void {
  writeFileAtomic(path, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
}

function listRowFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
}

export interface ReadDiagnosticsResult {
  rows: DiagnosticRow[]
  /** Lines that failed to parse or validate — skipped, never fatal, never rewritten here. */
  skipped: number
}

/** Read one initiative's rows (or every initiative's when omitted), in file order. */
export function readDiagnostics(
  rootDir: string,
  initiative?: string,
  env: StateEnv = process.env,
): ReadDiagnosticsResult {
  const dir = diagnosticsDir(rootDir, env)
  if (dir === null) return { rows: [], skipped: 0 }
  const files =
    initiative !== undefined ? [`${safeName(initiative)}.jsonl`] : listRowFiles(dir)
  const rows: DiagnosticRow[] = []
  let skipped = 0
  for (const name of files) {
    for (const line of readLines(join(dir, name))) {
      let decoded: unknown
      try {
        decoded = JSON.parse(line)
      } catch {
        skipped++
        continue
      }
      if (!validateDiagnosticRow(decoded).ok) {
        skipped++
        continue
      }
      rows.push(decoded as DiagnosticRow)
    }
  }
  return { rows, skipped }
}

export interface DiagnosticsFileStat {
  initiative: string
  rows: number
  bytes: number
  kinds: Record<string, number>
}

export interface DiagnosticsStats {
  /** Null when the store is refused (XDG_STATE_HOME inside the repo). */
  dir: string | null
  files: DiagnosticsFileStat[]
  bytes: number
}

/** What `sofar diagnostics` prints: where the store is and how much sits in it. */
export function diagnosticsStats(rootDir: string, env: StateEnv = process.env): DiagnosticsStats {
  const dir = diagnosticsDir(rootDir, env)
  if (dir === null) return { dir: null, files: [], bytes: 0 }
  const files: DiagnosticsFileStat[] = []
  let total = 0
  for (const name of listRowFiles(dir).sort()) {
    const path = join(dir, name)
    const bytes = statSync(path).size
    total += bytes
    const kinds: Record<string, number> = {}
    let rows = 0
    for (const line of readLines(path)) {
      rows++
      try {
        const kind = (JSON.parse(line) as { kind?: unknown }).kind
        if (typeof kind === 'string') kinds[kind] = (kinds[kind] ?? 0) + 1
      } catch {
        kinds.corrupt = (kinds.corrupt ?? 0) + 1
      }
    }
    files.push({ initiative: name.slice(0, -'.jsonl'.length), rows, bytes, kinds })
  }
  return { dir, files, bytes: total }
}

/** Delete this clone's entire store. Returns the directory removed, or null when there was none. */
export function purgeDiagnostics(rootDir: string, env: StateEnv = process.env): string | null {
  const dir = diagnosticsDir(rootDir, env)
  if (dir === null || !existsSync(dir)) return null
  rmSync(dir, { recursive: true, force: true })
  return dir
}
