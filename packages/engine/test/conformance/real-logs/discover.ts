import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every real events.jsonl a repository holds (rust-core 5.1): each worktree's
 * working copy, uncommitted appends included, and every branch tip, local and
 * remote-tracking, read from git's object store. Deduplicated by content, so
 * a log that several branches share is folded once; `sources` names every
 * place it was found.
 */

export interface RealLog {
  /** sha256 of the bytes: the identity a failure is reported under. */
  sha: string
  slug: string
  text: string
  /** `<repo>:<worktree path>` or `<repo>@<ref>` — every place these bytes live. */
  sources: string[]
}

const SLUG = /^[a-z0-9-]+$/
const LOG = /^\.sofar\/initiatives\/([a-z0-9-]+)\/events\.jsonl$/

function git(root: string, args: string[], input?: string): Buffer | null {
  const r = spawnSync('git', args, { cwd: root, input, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'] })
  return r.status === 0 && r.error === undefined ? r.stdout : null
}

/** `git worktree list --porcelain` → every checkout's path (the main one first). */
function worktrees(root: string): string[] {
  const out = git(root, ['worktree', 'list', '--porcelain'])
  if (out === null) return [root]
  return out
    .toString('utf8')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
}

/** Every ref tip: `[name, commit sha]`, symrefs (`origin/HEAD`) skipped. */
function refTips(root: string): Array<[string, string]> {
  const out = git(root, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', 'refs/remotes'])
  if (out === null) return []
  return out
    .toString('utf8')
    .split('\n')
    .map((l) => l.trim().split(' '))
    .filter((p): p is [string, string] => p.length === 2 && !p[1]!.endsWith('/HEAD') && p[1] !== 'origin')
    .map(([sha, name]) => [name, sha])
}

/** `git cat-file --batch` over blob ids, in one process. */
function catBlobs(root: string, ids: string[]): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>()
  if (ids.length === 0) return blobs
  const out = git(root, ['cat-file', '--batch'], `${ids.join('\n')}\n`)
  if (out === null) return blobs
  let at = 0
  for (const id of ids) {
    const eol = out.indexOf(0x0a, at)
    if (eol === -1) break
    const header = out.toString('utf8', at, eol).split(' ')
    at = eol + 1
    if (header.length !== 3) continue
    const size = Number(header[2])
    blobs.set(id, out.subarray(at, at + size))
    at += size + 1
  }
  return blobs
}

export function discoverRealLogs(roots: readonly string[]): RealLog[] {
  const bySha = new Map<string, RealLog>()
  const add = (slug: string, bytes: Buffer, source: string): void => {
    const sha = createHash('sha256').update(bytes).digest('hex')
    const found = bySha.get(sha)
    if (found !== undefined) {
      if (!found.sources.includes(source)) found.sources.push(source)
      return
    }
    bySha.set(sha, { sha, slug, text: bytes.toString('utf8'), sources: [source] })
  }
  for (const root of roots) {
    const repo = root.split('/').filter((s) => s.length > 0).pop() ?? root
    for (const checkout of worktrees(root)) {
      const dir = join(checkout, '.sofar', 'initiatives')
      if (!existsSync(dir)) continue
      for (const slug of readdirSync(dir).sort()) {
        const log = join(dir, slug, 'events.jsonl')
        if (!SLUG.test(slug) || !existsSync(log)) continue
        add(slug, readFileSync(log), `${repo}:${checkout}`)
      }
    }
    // Branch tips: one ls-tree per tip for the log blobs, one cat-file for all.
    const wanted: Array<{ blob: string; slug: string; source: string }> = []
    for (const [name, sha] of refTips(root)) {
      const out = git(root, ['ls-tree', '-r', '--full-tree', sha, '--', '.sofar/initiatives'])
      if (out === null) continue
      for (const line of out.toString('utf8').split('\n')) {
        const tab = line.indexOf('\t')
        if (tab === -1) continue
        const m = LOG.exec(line.slice(tab + 1))
        const meta = line.slice(0, tab).split(' ')
        if (m === null || meta[1] !== 'blob') continue
        wanted.push({ blob: meta[2]!, slug: m[1]!, source: `${repo}@${name}` })
      }
    }
    const blobs = catBlobs(root, [...new Set(wanted.map((w) => w.blob))])
    for (const w of wanted) {
      const bytes = blobs.get(w.blob)
      if (bytes !== undefined) add(w.slug, bytes, w.source)
    }
  }
  return [...bySha.values()].sort((a, b) => (a.slug === b.slug ? (a.sha < b.sha ? -1 : 1) : a.slug < b.slug ? -1 : 1))
}
