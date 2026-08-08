import type { FindArgs } from '@sofar/schema/tool-inputs'
import { findFrom, type ReachResult } from '../core/index-reach'
import type { ToolContext } from './context'

/**
 * sofar_find — the agent-pulled layer of retrieval (record-index 3.4).
 *
 * Read-only, appends nothing, and never builds the record graph: it reads the
 * reach index, which is maintained incrementally on its own cursor, so asking
 * costs what has been appended since the last question rather than the repo's
 * whole history. That is what makes this callable mid-task instead of once.
 *
 * The seed is resolved LITERALLY FIRST (path, session id, slug, decision handle),
 * and only a query denoting none of those is matched against decision and note
 * prose (3.5) — IDF-ranked, no model. A bare `D<n>` needs an initiative, and —
 * unlike the write tools — it is NOT resolved from the branch by default: a read
 * that silently answers about a different record than the caller meant is worse
 * than one that says it found nothing. The caller passes `initiative` when it
 * means the bound one.
 *
 * Everything returned is DERIVED relevance (D2). The tool description carries
 * that caveat because the result is JSON: the agent sees the shape, not a
 * caveat line rendered beside it, so the authority split has to live in the
 * contract rather than in the presentation.
 */
export function find(ctx: ToolContext, args: FindArgs): ReachResult {
  return findFrom(ctx.sofarDir, args.seed, {
    ...(args.hops !== undefined ? { hops: args.hops } : {}),
    ...(args.initiative !== undefined ? { initiative: args.initiative } : {}),
  })
}
