import type { Command } from 'commander'
import { createToolContext } from '../mcp/context'
import { readAllStdin } from './shared'

/**
 * `sofar statusline` (felt-cost 3.1/3.2, D4) — the rent-meter. Wired as
 * Claude Code's statusLine command, it reads the statusline JSON from stdin
 * and prints ONE plain line:
 *
 *   <slug> <done>/<total> · $<session cost> · cache <warm%>[⚠|✓] · ctx <used%>
 *
 * Every segment is independent and omitted when its inputs are missing —
 * the line degrades, never errors (hooks' best-effort philosophy, BD22).
 * Read-side only: nothing is appended to the record, no model is called
 * (SPEC §Architectural invariants) — the statusline stdin already carries
 * cost.total_cost_usd and per-call cache token counts at zero API cost.
 *
 * The cache segment is the self-diagnostic: healthy stable-prefix workloads
 * run 50–80% cache-read (✓ at ≥50%); below 30% signals prefix
 * non-determinism (⚠). Health is judged only once ≥10k tokens have flowed —
 * a young session's ratio is noise.
 */

export const CACHE_WARN_BELOW = 0.3
export const CACHE_HEALTHY_FROM = 0.5
export const CACHE_JUDGE_MIN_TOKENS = 10_000

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseJson(input: string): Obj {
  try {
    const decoded: unknown = JSON.parse(input)
    return isObj(decoded) ? decoded : {}
  } catch {
    return {}
  }
}

function numField(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function strField(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Bound record → "slug done/total"; null when no candidate root resolves. */
function recordSegment(rootDir: string, hook: Obj): string | null {
  const workspace = isObj(hook.workspace) ? hook.workspace : {}
  const candidates = [rootDir, strField(workspace.current_dir), strField(hook.cwd)]
  for (const root of candidates) {
    if (root === null) continue
    try {
      const ctx = createToolContext(root)
      const slug = ctx.resolveInitiative()
      const state = ctx.foldState(slug)
      let done = 0
      let total = 0
      for (const phase of state.phases) {
        for (const task of phase.tasks) {
          total++
          if (task.status === 'done') done++
        }
      }
      return total > 0 ? `${slug} ${done}/${total}` : slug
    } catch {
      // unbound / no .sofar here — try the next candidate
    }
  }
  return null
}

/** First object in the known statusline shapes that carries usage counters. */
function findUsage(hook: Obj): Obj | null {
  const candidates: unknown[] = [
    hook.current_usage,
    isObj(hook.context_window) ? hook.context_window.current_usage : undefined,
    isObj(hook.cost) ? hook.cost.current_usage : undefined,
  ]
  for (const c of candidates) {
    if (
      isObj(c) &&
      ('cache_read_input_tokens' in c || 'cache_creation_input_tokens' in c || 'input_tokens' in c)
    ) {
      return c
    }
  }
  return null
}

/** Warm share of input: cache_read / (cache_read + cache_creation + input). */
function rentSegment(hook: Obj): string | null {
  const usage = findUsage(hook)
  if (usage === null) return null
  const read = numField(usage.cache_read_input_tokens) ?? 0
  const written = numField(usage.cache_creation_input_tokens) ?? 0
  const fresh = numField(usage.input_tokens) ?? 0
  const denom = read + written + fresh
  if (denom <= 0) return null
  const share = read / denom
  const pct = `cache ${Math.round(share * 100)}%`
  if (denom < CACHE_JUDGE_MIN_TOKENS) return pct
  if (share < CACHE_WARN_BELOW) return `${pct} ⚠`
  if (share >= CACHE_HEALTHY_FROM) return `${pct} ✓`
  return pct
}

export function runStatusline(rootDir: string, input: string): string {
  const hook = parseJson(input)
  const segments: string[] = []

  const record = recordSegment(rootDir, hook)
  if (record !== null) segments.push(record)

  const cost = isObj(hook.cost) ? numField(hook.cost.total_cost_usd) : null
  if (cost !== null) segments.push(`$${cost.toFixed(2)}`)

  const rent = rentSegment(hook)
  if (rent !== null) segments.push(rent)

  const ctxPct = isObj(hook.context_window) ? numField(hook.context_window.used_percentage) : null
  if (ctxPct !== null) segments.push(`ctx ${Math.round(ctxPct)}%`)

  return segments.join(' · ')
}

export function registerStatuslineCommand(
  program: Command,
  rootOf: (opts: { root?: string }) => string,
): void {
  program
    .command('statusline')
    .description(
      'Claude Code statusLine command: statusline JSON on stdin → one plain line (record progress · session cost · cache rent-meter · context %)',
    )
    .option('--root <dir>', 'repo root (default: current directory)')
    .action(async (opts: { root?: string }) => {
      const line = runStatusline(rootOf(opts), await readAllStdin())
      if (line.length > 0) process.stdout.write(`${line}\n`)
    })
}
