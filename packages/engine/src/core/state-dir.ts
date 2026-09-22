import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Per-clone state OUTSIDE the repo — the third home of sync-client D2's
 * storage triad, shared by the sync cursors and the diagnostics store
 * (self-improve D3). `~/.local/state/sofar/…` (XDG_STATE_HOME-aware), keyed by
 * a hash of the clone's real path so two checkouts of one repo never share a
 * file and a worktree is its own clone.
 *
 * Nothing here is committed, packed, exported or synced — not because a
 * .gitignore says so, but because no path under the repo is ever produced.
 */

export type StateEnv = Record<string, string | undefined>

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.length > 0 ? value : undefined

/** `$XDG_STATE_HOME/sofar` or `~/.local/state/sofar`. */
export function stateBase(env: StateEnv = process.env): string {
  const base = nonEmpty(env.XDG_STATE_HOME) ?? join(homedir(), '.local', 'state')
  return join(base, 'sofar')
}

/** The clone's real path — symlinks resolved so one checkout has one key. */
export function cloneRealPath(rootDir: string): string {
  try {
    return realpathSync(rootDir)
  } catch {
    return resolve(rootDir)
  }
}

/** 32 hex chars of sha256(real clone path) — the key every per-clone file is named by. */
export function cloneKey(rootDir: string): string {
  return createHash('sha256').update(cloneRealPath(rootDir)).digest('hex').slice(0, 32)
}

/**
 * Whether `dir` would sit INSIDE the clone at `rootDir` — which only happens
 * when XDG_STATE_HOME points there. Per-clone state never lives under the
 * clone (self-improve D3), nor does a run lock (drive-visibility D3), and the
 * resolver refuses rather than trusting a gitignore.
 */
export function resolvesInside(dir: string, rootDir: string): boolean {
  // Both sides are compared as typed AND with symlinks resolved: on macOS a
  // temp dir is `/var/…` while its real path is `/private/var/…`, and a
  // containment test that resolved only one side would let the other through.
  const roots = [resolve(rootDir), cloneRealPath(rootDir)]
  const dirs = [resolve(dir), realpathOfNearestAncestor(dir)]
  for (const root of roots) for (const candidate of dirs) if (isInside(candidate, root)) return true
  return false
}

/** Real path of `path`, resolving through its deepest EXISTING ancestor when it does not exist yet. */
function realpathOfNearestAncestor(path: string): string {
  let probe = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(probe), ...tail.reverse())
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return resolve(path)
      tail.push(basename(probe))
      probe = parent
    }
  }
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
