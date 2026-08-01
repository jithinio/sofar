import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * Git facts read straight from the repo, never copied into the record.
 *
 * Lives in core/ rather than mcp/ because both the resolution path (branch →
 * bindings.json) and the render path (the status block's Git line) need it,
 * and a projection template must not depend on the MCP layer.
 *
 * Everything here reads FILES — no subprocess. Hook shims run inside a 100ms
 * end-to-end budget (speed T2) that already covers process spawn and CLI
 * boot, so spawning git to answer a question the refs already hold would be
 * the most expensive line in the block.
 */

/** The .git directory, following a worktree-style .git FILE. Null if absent. */
export function gitDir(rootDir: string): string | null {
  try {
    const dotGit = join(rootDir, '.git')
    if (statSync(dotGit).isDirectory()) return dotGit
    const gitdirMatch = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!gitdirMatch) return null
    const dir = gitdirMatch[1]!.trim()
    return isAbsolute(dir) ? dir : join(rootDir, dir)
  } catch {
    return null
  }
}

/**
 * Current branch from .git/HEAD without spawning git. Supports a
 * worktree-style .git FILE ("gitdir: <path>") by following it to that HEAD.
 * Returns null for detached HEAD or when no .git is readable.
 */
export function currentBranch(rootDir: string): string | null {
  try {
    const dir = gitDir(rootDir)
    if (dir === null) return null
    const head = readFileSync(join(dir, 'HEAD'), 'utf8').trim()
    const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return refMatch ? refMatch[1]! : null
  } catch {
    return null
  }
}

export interface GitState {
  branch: string
  /** Local branch tip (short). */
  head: string
  /** origin/<branch> tip (short), or null when the remote ref is absent. */
  upstream: string | null
  /** head === upstream — i.e. everything local has been pushed. */
  synced: boolean
}

/** Resolve a ref to its sha via loose refs, then packed-refs. Null if absent. */
function readRef(dir: string, ref: string): string | null {
  try {
    const loose = readFileSync(join(dir, ref), 'utf8').trim()
    if (/^[0-9a-f]{40}$/i.test(loose)) return loose
  } catch {
    // not a loose ref — fall through to packed-refs
  }
  try {
    for (const line of readFileSync(join(dir, 'packed-refs'), 'utf8').split('\n')) {
      const m = /^([0-9a-f]{40})\s+(.+)$/i.exec(line.trim())
      if (m && m[2] === ref) return m[1]!
    }
  } catch {
    // no packed-refs
  }
  return null
}

/**
 * Git state derived at render time (record-integrity 4.1).
 *
 * Committing and pushing leave NO trace in the record by design —
 * record-hygiene D1 exempts git commands from PostToolUse, because logging
 * them makes the record un-settleable (the commit of the record appends an
 * event about committing the record). The unintended consequence was that no
 * session could tell whether work had been pushed, which is exactly what
 * forced a human to announce it to every other session by hand.
 *
 * The fix is not to start logging git — it is to READ git, which is already
 * an authoritative self-describing ledger. Derived state cannot go stale and
 * cannot dirty the tree.
 *
 * Refs only, so the answer is "same or different" rather than an ahead/behind
 * count. That is the question that matters here, and it is the one refs can
 * answer without walking the commit graph. In the shared checkout this
 * targets, every session sees one .git, so a push by any of them updates
 * refs/remotes/origin/<branch> for all of them at once.
 *
 * Best-effort: any failure returns null and the caller renders nothing.
 */
export function readGitState(rootDir: string): GitState | null {
  const dir = gitDir(rootDir)
  if (dir === null) return null
  const branch = currentBranch(rootDir)
  if (branch === null) return null // detached HEAD has no upstream to compare

  const head = readRef(dir, `refs/heads/${branch}`)
  if (head === null) return null
  const upstream = readRef(dir, `refs/remotes/origin/${branch}`)
  return {
    branch,
    head: head.slice(0, 7),
    upstream: upstream === null ? null : upstream.slice(0, 7),
    synced: upstream !== null && upstream === head,
  }
}
