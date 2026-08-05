import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic'

/**
 * bindings.json read-modify-write (branch → slug). Merging, never replacing:
 * other branches' bindings always survive, because the file is committed and
 * shared and one checkout must not stomp another's routing.
 *
 * Lives in core/ so both `sofar new`/`switch` (cli) and closing (mcp) reach
 * the same writer — there is exactly one way this file changes shape.
 */

/** A refusal to touch bindings.json, so a malformed file is never overwritten. */
export class BindingsAbort extends Error {}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function readBindingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new BindingsAbort(
      `.sofar/bindings.json is not valid JSON — refusing to modify it (${errMessage(err)})`,
    )
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new BindingsAbort('.sofar/bindings.json must be a JSON object of branch → slug')
  }
  return decoded as Record<string, unknown>
}

function writeBindings(path: string, bindings: Record<string, unknown>): void {
  writeFileAtomic(path, `${JSON.stringify(bindings, null, 2)}\n`)
}

/** Bind branch → slug; returns false when the binding was already in place. */
export function writeBinding(path: string, branch: string, slug: string): boolean {
  const bindings = readBindingsFile(path)
  if (bindings[branch] === slug) return false
  bindings[branch] = slug
  writeBindings(path, bindings)
  return true
}

/**
 * Remove EVERY binding pointing at `slug`; returns the branches unbound,
 * sorted. Closing unbinds all of them, not just the current branch (D1) — a
 * closed record should have no branch aimed at it, and the branch that closed
 * it is rarely the only one bound.
 *
 * Idempotent: nothing to remove writes nothing, so re-running close on an
 * already-unbound initiative leaves the file byte-identical.
 */
export function unbindAll(path: string, slug: string): string[] {
  const bindings = readBindingsFile(path)
  const removed = Object.keys(bindings)
    .filter((branch) => bindings[branch] === slug)
    .sort()
  if (removed.length === 0) return []
  for (const branch of removed) delete bindings[branch]
  writeBindings(path, bindings)
  return removed
}
