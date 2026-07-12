import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Command } from 'commander'
import { createToolContext } from '../mcp/context'
import { readAllStdin } from './shared'
import { createStyle, pieFor, symbolsFor, type Caps } from './ui'

/**
 * `sofar statusline` (felt-cost 3.1/3.2 D4; identity segments D6; styling
 * D7/D8) — the rent-meter. Wired as Claude Code's statusLine command, it
 * reads the statusline JSON from stdin and prints ONE line:
 *
 *   <model> · ▸ <dir> ⎇ <branch> · <slug> <done>/<total>
 *     · $<session cost> · ↺ <warm%>[⚠|✓] · <pie> <used%>
 *
 * Icons are text glyphs in the house vocabulary (cli-ui 1.3), never emoji
 * (D8): ▸ dir, ⎇ branch, ↺ cache rewarm, and the kernel's progress pie
 * (○◔◑◕●) as the context-fill gauge.
 *
 * The model and dir/branch segments restore what Claude Code's own default
 * status line shows — a custom statusLine command REPLACES the default
 * entirely, and the rent-meter must not cost the user the line they had
 * (D6).
 *
 * Styling (D7): the consumer is Claude Code's status bar, which renders
 * ANSI + emoji even though stdout is piped — so the command wiring forces
 * styled caps instead of TTY detection (the one case where detection gives
 * the wrong answer). `--no-color` or NO_COLOR falls back to the plain
 * line, byte-identical to the 0.8.0 format (`dir:branch`, `cache`/`ctx`
 * labels, no ANSI). runStatusline's own default is the plain line — the
 * forced caps are the command's choice, not the library's.
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

/** Context-window thresholds (D7): approaching compaction gets loud. */
export const CTX_WARN_FROM = 70
export const CTX_ERROR_FROM = 90

/** The command's caps: the status bar renders ANSI + emoji, piped or not. */
export const STATUSLINE_FORCED_CAPS: Caps = { color: true, unicode: true, animate: false }

const PLAIN_CAPS: Caps = { color: false, unicode: false, animate: false }

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

/**
 * Current branch from .git/HEAD — no subprocess, one file read. Bounded
 * upward walk from the harness-reported dir; handles the worktree/submodule
 * form (.git as a `gitdir: <path>` file). Detached HEAD or any failure →
 * null (segment renders without the branch).
 */
function gitBranch(startDir: string): string | null {
  try {
    let dir = startDir
    for (let depth = 0; depth < 32; depth++) {
      const dotGit = join(dir, '.git')
      if (existsSync(dotGit)) {
        let headPath: string | null = null
        if (statSync(dotGit).isDirectory()) {
          headPath = join(dotGit, 'HEAD')
        } else {
          const gitdir = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1]
          if (gitdir !== undefined) {
            headPath = join(gitdir.startsWith('/') ? gitdir : join(dir, gitdir), 'HEAD')
          }
        }
        if (headPath === null || !existsSync(headPath)) return null
        return readFileSync(headPath, 'utf8').match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim() ?? null
      }
      const parent = dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  } catch {
    return null
  }
}

/** Model display name — the segment the default status line led with. */
function modelSegment(hook: Obj): string | null {
  return isObj(hook.model) ? strField(hook.model.display_name) : null
}

/** Working directory + branch, from the harness-reported paths. */
function dirSegment(hook: Obj): { name: string; branch: string | null } | null {
  const workspace = isObj(hook.workspace) ? hook.workspace : {}
  const dir = strField(workspace.current_dir) ?? strField(hook.cwd)
  if (dir === null) return null
  return { name: basename(dir), branch: gitBranch(dir) }
}

/** Bound record → slug + task progress; null when no candidate root resolves. */
function recordSegment(
  rootDir: string,
  hook: Obj,
): { slug: string; done: number; total: number } | null {
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
      return { slug, done, total }
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

type RentTone = 'success' | 'error' | 'dim' | null

/** Warm share of input: cache_read / (cache_read + cache_creation + input). */
function rentSegment(hook: Obj): { pct: number; marker: '✓' | '⚠' | null; tone: RentTone } | null {
  const usage = findUsage(hook)
  if (usage === null) return null
  const read = numField(usage.cache_read_input_tokens) ?? 0
  const written = numField(usage.cache_creation_input_tokens) ?? 0
  const fresh = numField(usage.input_tokens) ?? 0
  const denom = read + written + fresh
  if (denom <= 0) return null
  const share = read / denom
  const pct = Math.round(share * 100)
  if (denom < CACHE_JUDGE_MIN_TOKENS) return { pct, marker: null, tone: 'dim' }
  if (share < CACHE_WARN_BELOW) return { pct, marker: '⚠', tone: 'error' }
  if (share >= CACHE_HEALTHY_FROM) return { pct, marker: '✓', tone: 'success' }
  return { pct, marker: null, tone: null }
}

export function runStatusline(rootDir: string, input: string, caps: Caps = PLAIN_CAPS): string {
  const hook = parseJson(input)
  const style = createStyle(caps.color)
  const icons = caps.unicode
  const sym = symbolsFor(caps.unicode)
  const segments: string[] = []

  const model = modelSegment(hook)
  if (model !== null) segments.push(style.bold(model))

  const dir = dirSegment(hook)
  if (dir !== null) {
    if (icons) {
      segments.push(
        dir.branch === null
          ? `${sym.pointer} ${dir.name}`
          : `${sym.pointer} ${dir.name} ⎇ ${style.success(dir.branch)}`,
      )
    } else {
      segments.push(dir.branch === null ? dir.name : `${dir.name}:${dir.branch}`)
    }
  }

  const record = recordSegment(rootDir, hook)
  if (record !== null) {
    const slug = style.accent(record.slug)
    segments.push(record.total > 0 ? `${slug} ${record.done}/${record.total}` : slug)
  }

  const cost = isObj(hook.cost) ? numField(hook.cost.total_cost_usd) : null
  if (cost !== null) segments.push(`$${cost.toFixed(2)}`)

  const rent = rentSegment(hook)
  if (rent !== null) {
    const text = `${icons ? '↺' : 'cache'} ${rent.pct}%${rent.marker === null ? '' : ` ${rent.marker}`}`
    segments.push(rent.tone === null ? text : style[rent.tone](text))
  }

  const ctxPct = isObj(hook.context_window) ? numField(hook.context_window.used_percentage) : null
  if (ctxPct !== null) {
    const pct = Math.round(ctxPct)
    const text = icons ? `${pieFor(pct, 100, sym)} ${pct}%` : `ctx ${pct}%`
    segments.push(
      ctxPct >= CTX_ERROR_FROM
        ? style.error(text)
        : ctxPct >= CTX_WARN_FROM
          ? style.warn(text)
          : style.dim(text),
    )
  }

  return segments.join(caps.color ? ` ${style.dim('·')} ` : ' · ')
}

export function registerStatuslineCommand(
  program: Command,
  rootOf: (opts: { root?: string }) => string,
): void {
  program
    .command('statusline')
    .description(
      'Claude Code statusLine command: statusline JSON on stdin → one line (model · dir/branch · record progress · session cost · cache rent-meter · context %); styled for the status bar, --no-color for plain',
    )
    .option('--root <dir>', 'repo root (default: current directory)')
    .action(async (opts: { root?: string }) => {
      // The status bar renders ANSI + emoji even though stdout is piped —
      // force styled caps; --no-color / NO_COLOR opt back into plain (D7).
      const plain = process.argv.includes('--no-color') || process.env.NO_COLOR !== undefined
      const caps = plain ? PLAIN_CAPS : STATUSLINE_FORCED_CAPS
      const line = runStatusline(rootOf(opts), await readAllStdin(), caps)
      if (line.length > 0) process.stdout.write(`${line}\n`)
    })
}
