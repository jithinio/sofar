import { existsSync } from 'node:fs'
import type { RememberArgs, ToolOkResult } from '@sofar/schema/tool-inputs'
import type { EventEnvelope } from '../core/envelope'
import { ToolError, type AppendOptions, type ToolContext } from './context'

/**
 * sofar_remember — appends memory_promoted {text, supersedes?}.
 *
 * The capture point the record was missing (repo-memory-capture D1): a fact
 * whose repo-wide scope is known when it is learned, which no citation
 * behaviour could ever surface because nothing derives what was never written
 * down. Resolution pins to the active session's initiative (task 12.1, BD58)
 * like every other write — the promotion is repo-scoped in MEANING, but it is
 * still an event, and events live in the log of the initiative that made them.
 *
 * `supersedes` (r1-fixes 1.5, D8) replaces an outdated fact without editing
 * history: the old memory keeps its handle and is retired by the new one.
 */
export function remember(ctx: ToolContext, args: RememberArgs): ToolOkResult {
  const slug = ctx.resolveWriteInitiative(args.initiative)
  const event = promoteMemory(ctx, slug, args.text, args.supersedes)
  return { ok: true, event_id: event.id }
}

/** `M<n>` (resolved against `slug`) or the qualified `<slug> M<n>`. */
const HANDLE_INPUT_RE = /^(?:([a-z0-9-]+) )?M([1-9][0-9]*)$/

/**
 * Resolve a `--supersedes` argument to the qualified handle the payload
 * stores, refusing anything that does not name an existing, live memory —
 * a typo here would retire nothing and nag forever, so it fails before the
 * append rather than after.
 */
export function resolveSupersedes(ctx: ToolContext, slug: string, raw: string): string {
  const m = HANDLE_INPUT_RE.exec(raw.trim())
  if (m === null) {
    throw new ToolError(
      'invalid_input',
      `supersedes: expected a memory handle — \`M<n>\` or \`<slug> M<n>\` — got "${raw}"`,
    )
  }
  const target = m[1] ?? slug
  const n = Number.parseInt(m[2]!, 10)
  if (!existsSync(ctx.eventsPath(target))) {
    throw new ToolError('invalid_input', `supersedes: no initiative "${target}"`)
  }
  const memories = ctx.foldState(target).memories
  if (n > memories.length) {
    throw new ToolError(
      'invalid_input',
      `supersedes: ${target} has ${memories.length} promoted ${memories.length === 1 ? 'memory' : 'memories'} — there is no M${n}`,
    )
  }
  const existing = memories[n - 1]!
  if (existing.superseded_by !== undefined) {
    throw new ToolError(
      'invalid_input',
      `supersedes: ${target} M${n} is already superseded by ${existing.superseded_by} — name that one instead`,
    )
  }
  return `${target} M${n}`
}

/** The one promote path: CLI and MCP both append through here. */
export function promoteMemory(
  ctx: ToolContext,
  slug: string,
  text: string,
  supersedes: string | undefined,
  options?: AppendOptions,
): EventEnvelope {
  const payload: Record<string, unknown> = { text }
  if (supersedes !== undefined) payload.supersedes = resolveSupersedes(ctx, slug, supersedes)
  return ctx.appendAndProject(slug, 'memory_promoted', payload, options)
}
