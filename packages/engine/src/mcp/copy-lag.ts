import { homedir } from 'node:os'
import { worktreeLeads } from '../core/record-copies'
import { copyLagWarning } from '../projections/templates/copies'
import type { ToolContext } from './context'

/**
 * The write guard (branch-visibility 3.4): after a write, whether the copy it
 * landed in lacks events another worktree's copy holds. It only warns. The
 * write has already happened here, and D1 forbids moving it to another copy.
 *
 * Files only (core/record-copies.ts worktreeLeads), so a write pays a stat per
 * other checkout, plus one read of a copy that really diverged.
 *
 * Warned once per server process for each lagging worktree: a session writing
 * a dozen times into the same lag would otherwise read the same line a dozen
 * times. It re-arms when the lag clears, so a later lag is named again.
 */
const warned = new WeakMap<ToolContext, Map<string, Set<string>>>()

export function copyLagGuard(ctx: ToolContext, slug: string): string | null {
  let bySlug = warned.get(ctx)
  if (bySlug === undefined) {
    bySlug = new Map()
    warned.set(ctx, bySlug)
  }
  const leads = worktreeLeads(ctx.rootDir, slug, ctx.eventsPath(slug))
  if (leads.length === 0) {
    bySlug.delete(slug)
    return null
  }
  const seen = bySlug.get(slug) ?? new Set<string>()
  bySlug.set(slug, seen)
  const fresh = leads.filter((lead) => !seen.has(lead.copy.path ?? ''))
  if (fresh.length === 0) return null
  for (const lead of leads) seen.add(lead.copy.path ?? '')
  return copyLagWarning(slug, leads, homedir())
}

/** `value` with the guard's line appended to its `warnings`, when there is one. */
export function withCopyLag(ctx: ToolContext, slug: string | null, value: unknown): unknown {
  if (slug === null || typeof value !== 'object' || value === null) return value
  let line: string | null
  try {
    line = copyLagGuard(ctx, slug)
  } catch {
    return value // the guard is advisory: it never fails a write that happened
  }
  if (line === null) return value
  const prior = (value as { warnings?: unknown }).warnings
  return { ...value, warnings: [...(Array.isArray(prior) ? prior : []), line] }
}
