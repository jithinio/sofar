import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'
import { ensureIndexDir, indexDir, logStat } from './index-store'

/**
 * Each session's FIRST registration in one log, kept current by reading only
 * what the log grew by (rust-core 4.4, D35). Session resolution asks every
 * log "where did this session register?", and at team scale scanning the
 * whole log per call was the entire cost of a cached statusline.
 *
 * The answer is exactly `registrationIn`'s: the first line in file order that
 * parses as an object with type `session_started` and string `session`, `id`
 * and `ts`, and whose raw text contains that session id (registrationIn's
 * pre-filter, kept so the two can never disagree).
 *
 * Derived and disposable (record-integrity D1 stands: the log is the only
 * truth). The cache covers complete lines only, and the unterminated last line
 * is always scanned live. It is trusted when the log is unchanged (size and
 * mtimeMs), or when it has GROWN past the consumed offset with its first
 * HEAD_BYTES and its last consumed line hashing the same. A log with the same
 * size but a new mtime cannot be an append, so it rescans, as does anything
 * else. The bargain is the one index-tail and D22's chain snapshots make: an
 * in-place edit that preserves the head, the last consumed line and then
 * grows is trusted. The record is append-only; git is what can break that.
 * A lost, corrupt or raced cache file is a rescan, never a wrong answer.
 * TypeScript and sofar-core share the file byte for byte.
 */

const REG_DIR = 'registrations'
export const REGISTRATIONS_VERSION = 1

export interface Registration {
  id: string
  ts: string
}

interface RegFile {
  v: number
  size: number
  mtimeMs: number
  /** Bytes consumed: through the last complete line's newline. */
  offset: number
  /** The last consumed line (start offset, sha256 without its newline); null when none. */
  last: { start: number; sha256: string } | null
  /** sha256 of the first min(HEAD_BYTES, offset) bytes. */
  head: string
  first: Record<string, Registration>
}

/** How much of the log's head a grown log must still match. */
const HEAD_BYTES = 4096

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/**
 * Whether `line` can be a session_started at all. The type value decodes to
 * `session_started` either literally or through a `\u` escape (no short escape
 * spells any of its characters), so a line with neither is skipped unparsed.
 */
const mayRegister = (line: string): boolean => line.includes('session_started') || line.includes('\\u')

/** One line's registration, exactly as registrationIn would accept it. */
function registrationOf(line: string): { session: string; reg: Registration } | null {
  if (line.length === 0 || !mayRegister(line)) return null
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof event !== 'object' || event === null) return null
  const e = event as Record<string, unknown>
  if (e.type !== 'session_started' || typeof e.session !== 'string') return null
  if (typeof e.id !== 'string' || typeof e.ts !== 'string') return null
  if (!line.includes(e.session)) return null
  return { session: e.session, reg: { id: e.id, ts: e.ts } }
}

/** Fold complete lines into `first`, keeping each session's earliest. */
function scanInto(first: Map<string, Registration>, text: string): void {
  for (const line of text.split('\n')) {
    const found = registrationOf(line)
    if (found !== null && !first.has(found.session)) first.set(found.session, found.reg)
  }
}

function readRange(path: string, start: number, end: number): Buffer | null {
  if (end <= start) return Buffer.alloc(0)
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(end - start)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got)
      if (n === 0) break
      got += n
    }
    return got === buf.length ? buf : null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isOffset = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function parseRegFile(text: string): RegFile | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw) || raw.v !== REGISTRATIONS_VERSION) return null
  if (!isOffset(raw.size) || typeof raw.mtimeMs !== 'number' || !isOffset(raw.offset) || raw.offset > raw.size) return null
  const last = raw.last
  if (last !== null && !(isRecord(last) && isOffset(last.start) && last.start < (raw.offset as number) && typeof last.sha256 === 'string')) return null
  if (typeof raw.head !== 'string' || !isRecord(raw.first)) return null
  for (const r of Object.values(raw.first)) {
    if (!isRecord(r) || typeof r.id !== 'string' || typeof r.ts !== 'string') return null
  }
  return raw as unknown as RegFile
}

function regFile(sofarDir: string, slug: string): string {
  return join(indexDir(sofarDir), REG_DIR, `${slug}.json`)
}

/**
 * Consume every complete line of `buf` (which begins at a line start at
 * `base`), returning the new offset and last-line anchor; the unterminated
 * remainder is left for the caller.
 */
function consume(
  first: Map<string, Registration>,
  buf: Buffer,
  base: number,
  prev: RegFile['last'],
): { offset: number; last: RegFile['last']; rest: Buffer } {
  const end = buf.lastIndexOf(0x0a)
  if (end < 0) return { offset: base, last: prev, rest: buf }
  scanInto(first, buf.subarray(0, end).toString('utf8'))
  // A negative byteOffset would count from the END in Node, so a buffer whose
  // only newline is its first byte is anchored at its start explicitly.
  const lineStart = end === 0 ? 0 : buf.lastIndexOf(0x0a, end - 1) + 1
  return {
    offset: base + end + 1,
    last: { start: base + lineStart, sha256: sha256(buf.subarray(lineStart, end)) },
    rest: buf.subarray(end + 1),
  }
}

/**
 * `registrationIn(logPath, sessionId)` through the cache for `slug`. Falls
 * back to the plain scan whenever the log cannot be stat'd.
 */
export function cachedRegistrationIn(
  sofarDir: string,
  slug: string,
  logPath: string,
  sessionId: string,
  scan: (logPath: string, sessionId: string) => Registration | null,
): Registration | null {
  const stat = logStat(logPath)
  if (stat === null) return scan(logPath, sessionId)
  const path = regFile(sofarDir, slug)
  let cached: RegFile | null = null
  try {
    cached = parseRegFile(readFileSync(path, 'utf8'))
  } catch {
    cached = null
  }

  let file: RegFile
  let rest: Buffer | null
  let changed = true
  if (cached !== null && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    file = cached
    rest = readRange(logPath, cached.offset, stat.size)
    changed = false
  } else {
    let base: RegFile | null = null
    // Only growth can be an append; the same size under a new mtime is a rewrite.
    if (cached !== null && stat.size > cached.size && stat.size >= cached.offset) {
      const head = readRange(logPath, 0, Math.min(HEAD_BYTES, cached.offset))
      const headOk = head !== null && sha256(head) === cached.head
      if (headOk && cached.last === null) {
        base = cached.offset === 0 ? cached : null
      } else if (headOk && cached.last !== null) {
        const line = readRange(logPath, cached.last.start, cached.offset - 1)
        base = line !== null && sha256(line) === cached.last.sha256 ? cached : null
      }
    }
    const from = base?.offset ?? 0
    const buf = readRange(logPath, from, stat.size)
    if (buf === null) return scan(logPath, sessionId)
    const first = new Map<string, Registration>(base === null ? [] : Object.entries(base.first))
    const step = consume(first, buf, from, base?.last ?? null)
    const headLen = Math.min(HEAD_BYTES, step.offset)
    const head =
      base !== null && Math.min(HEAD_BYTES, base.offset) === headLen
        ? base.head
        : sha256(from === 0 ? buf.subarray(0, headLen) : (readRange(logPath, 0, headLen) ?? Buffer.alloc(0)))
    file = {
      v: REGISTRATIONS_VERSION,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      offset: step.offset,
      last: step.last,
      head,
      first: Object.fromEntries(first),
    }
    rest = step.rest
  }
  if (rest === null) return scan(logPath, sessionId)

  if (changed) {
    // Written only when the log still measures what was read: bytes that
    // landed mid-read belong to the next call's tail, never to this key.
    const after = logStat(logPath)
    if (after !== null && after.size === stat.size && after.mtimeMs === stat.mtimeMs) {
      try {
        ensureIndexDir(sofarDir)
        mkdirSync(join(indexDir(sofarDir), REG_DIR), { recursive: true })
        writeFileAtomic(path, `${JSON.stringify(file)}\n`)
      } catch {
        // a cache that cannot be written rescans next time, never an error
      }
    }
  }

  if (Object.hasOwn(file.first, sessionId)) return file.first[sessionId] ?? null
  // The unterminated last line, scanned live exactly as registrationIn would.
  const found = registrationOf(rest.toString('utf8'))
  return found !== null && found.session === sessionId ? found.reg : null
}
