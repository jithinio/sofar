import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { watch } from 'chokidar'
import { isClosedInitiativeStatus } from '@sofar/schema'
import { readBindingsFile } from '../core/bindings'
import { currentBranch } from '../core/git'
import { listAcrossCopies } from '../core/listing'
import { createToolContext, ToolError, type ToolContext } from '../mcp/context'
import { emptyState, foldLog, type InitiativeState } from '../core/fold'
import {
  copyWatch,
  scanRecordCopies,
  unionFold,
  type CopyScan,
  type RecordProvenance,
} from '../core/record-copies'
import { renderFullStatus } from '../projections/templates/status'
import { listResult, type CopyOptions } from './list'
import { errMessage, fail, ok, type CmdResult } from './shared'
import {
  columnsOf,
  createStyle,
  renderInitiative,
  stdoutCaps,
  symbolsFor,
  terminalRows,
  type Caps,
} from './ui'

/**
 * `sofar status [slug]` (task 4.3, SPEC §CLI) — fold and print goal,
 * progress %, phase tree with per-task statuses, next action, blocked_on,
 * and the last written-back session. Initiative resolution matches the MCP
 * tools (explicit slug wins, else branch → bindings.json, BD16). Output is
 * UNCAPPED — the 10k limit belongs to the SessionStart projection (BD3) —
 * and fold warnings go to stderr without failing the command.
 *
 * Rendering (cli-ui 2.2) is capability-gated: `caps.color` picks the
 * full-zoom layout grammar (2.1) — the styled layout is inherently
 * color-coded (D1), so piped/NO_COLOR output keeps the pre-styling
 * renderFullStatus bytes, which the agent-facing surfaces also share.
 */

export function runStatus(
  rootDir: string,
  slug?: string,
  caps: Caps = stdoutCaps(),
  columns: number = columnsOf(process.stdout),
  options: CopyOptions = {},
): CmdResult {
  const ctx = createToolContext(rootDir)

  let resolved: string
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    // An initiative that exists only on another branch still has a status
    // (branch-visibility D1): look for it there before giving up.
    const scan = err instanceof ToolError ? heldElsewhere(rootDir, slug, options) : null
    if (scan !== null) return statusOf(ctx, slug!, caps, columns, options, scan)
    if (err instanceof ToolError) {
      if (slug === undefined && err.code === 'unknown_initiative') {
        const oriented = unboundStatus(ctx, rootDir, caps, columns, options)
        if (oriented !== null) return oriented
      }
      return fail(`sofar status: ${err.message} (usage: sofar status [slug])`)
    }
    return fail(`sofar status: ${errMessage(err)}`)
  }
  return statusOf(ctx, resolved, caps, columns, options)
}

/** Slug shape, checked before an explicit slug is looked up on another copy. */
const SLUG = /^[a-z0-9-]+$/

/**
 * The scan that finds an explicit slug this checkout lacks on another copy,
 * or null when no copy holds it (or `--here` rules the other copies out).
 */
function heldElsewhere(rootDir: string, slug: string | undefined, options: CopyOptions): CopyScan | null {
  if (slug === undefined || !SLUG.test(slug) || options.here === true) return null
  const scan = scanRecordCopies(rootDir, { slugs: [slug], remotes: options.remotes === true })
  return (scan.logs.get(slug)?.length ?? 0) > 0 ? scan : null
}

/** One initiative folded for display, with where its events live. */
export interface StatusView {
  state: InitiativeState
  warnings: string[]
  /** Null unless another copy adds an event (branch-visibility D1). */
  provenance: RecordProvenance | null
}

/**
 * Fold one initiative from this checkout's log and, when given, the other
 * copies' logs. Throws only when this checkout's log exists but cannot be read.
 */
function foldView(ctx: ToolContext, resolved: string, copies: CopyScan | undefined): StatusView {
  const logPath = ctx.eventsPath(resolved)
  const foreign = copies?.logs.get(resolved) ?? []
  let view: StatusView
  if (foreign.length > 0) {
    const localText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : null
    const union = unionFold(resolved, localText, foreign, currentBranch(ctx.rootDir))
    view = { state: union.state, warnings: union.warnings, provenance: union.provenance }
  } else if (existsSync(logPath)) {
    const { state, warnings } = foldLog(logPath)
    view = { state, warnings, provenance: null }
  } else {
    view = { state: emptyState(), warnings: [], provenance: null } // created-but-unwritten still has a status
  }
  if (view.state.slug === '') view.state.slug = resolved
  return view
}

/**
 * `sofar status` with no slug on an unbound branch (r1-fixes 4.1.4, L10, D28)
 * orients instead of failing: a line naming why and the slug to pass, the
 * most recently active open initiative's status, then the listing — exit 0.
 * Round 1: that exit 1 was the first call of 9 in 10 Codex sessions, and the
 * cells it happened in went on to open one initiative per roadmap item.
 *
 * Null — keep failing — when the repo carries no record, or the branch IS
 * bound (to a directory that is gone: a broken binding, not an unbound
 * branch), or bindings.json cannot be read. Read-only: binding is `sofar
 * switch`'s job, never a status side effect.
 */
function unboundStatus(
  ctx: ToolContext,
  rootDir: string,
  caps: Caps,
  columns: number,
  options: CopyOptions,
): CmdResult | null {
  if (!existsSync(join(rootDir, '.sofar'))) return null
  const branch = currentBranch(rootDir)
  if (branch !== null) {
    try {
      if (typeof readBindingsFile(join(rootDir, '.sofar', 'bindings.json'))[branch] === 'string') return null
    } catch {
      return null
    }
  }
  const why = branch !== null ? `No initiative is bound to branch "${branch}"` : 'No current git branch'
  // One listing, read across copies, for both the pick and the list under it:
  // the record named first must be the one the list puts first.
  const listing = listAcrossCopies(rootDir, options)
  const recent = listing.entries.find((e) => !isClosedInitiativeStatus(e.status))
  const list = listResult(rootDir, listing, caps, columns)
  if (recent === undefined) {
    const head = `${why}, and no open initiative exists — create one: sofar new <slug> --goal "<one line>"\n\n`
    return ok(`${head}${list.stdout}`, list.stderr)
  }
  const head =
    `${why} — showing the most recently active initiative, ${recent.slug}. ` +
    `Pass it explicitly: sofar status ${recent.slug}, sofar event append ${recent.slug} …\n\n`
  const shown = statusOf(ctx, recent.slug, caps, columns, options)
  if (shown.exitCode !== 0) return shown
  const stderr = [shown.stderr, list.stderr].filter((s) => s !== '').join('\n')
  return ok(`${head}${shown.stdout}\n${list.stdout}`, stderr)
}

/**
 * One initiative's status, already resolved to a slug this checkout or
 * another copy holds. Folded across the other copies of the record unless
 * `--here` (branch-visibility D1); `scan` is passed when resolution already
 * had to look for the slug elsewhere.
 */
function statusOf(
  ctx: ToolContext,
  resolved: string,
  caps: Caps,
  columns: number,
  options: CopyOptions = {},
  scan?: CopyScan,
): CmdResult {
  const copies =
    scan ??
    (options.here === true
      ? undefined
      : scanRecordCopies(ctx.rootDir, { slugs: [resolved], remotes: options.remotes === true }))
  let view: StatusView
  try {
    view = foldView(ctx, resolved, copies)
  } catch (err) {
    return fail(`sofar status: failed to read ${ctx.eventsPath(resolved)}: ${errMessage(err)}`)
  }
  const { state, warnings, provenance } = view

  const home = homedir()
  const stdout = caps.color
    ? `${renderInitiative(state, {
        zoom: 'full',
        style: createStyle(true),
        symbols: symbolsFor(caps.unicode),
        columns,
        provenance,
        home,
      }).join('\n')}\n`
    : renderFullStatus(state, provenance, home)

  return ok(stdout, warnings.map((w) => `warning: ${w}`).join('\n'))
}

/** Pulse beat interval — Codex's non-truecolor blink cadence (research D1). */
const PULSE_MS = 600

/**
 * Git writes a ref as a lock file renamed into place, and a checkout touches
 * HEAD and several refs in one burst: one rescan per burst, not per path.
 */
const RESCAN_DEBOUNCE_MS = 150

/**
 * The live view's state, apart from the terminal (branch-visibility 3.2).
 * Reading is cheap and scanning is not: a scan of the other copies spawns
 * git, so it runs only when something that decides them changed. A pulse
 * re-renders the cached view and never reads anything.
 */
export interface StatusWatchModel {
  /** The folded view a render shows. */
  readonly view: StatusView
  /** Scans of the other copies so far — the start's included. */
  readonly scans: number
  /** This checkout's log changed: re-fold against the copies already scanned. */
  localChanged(): void
  /** Something that decides the other copies changed: rescan, then re-fold. */
  copiesChanged(): void
  /**
   * A pulse's backstop for a missed watcher event on this checkout's log: one
   * stat, and a re-fold only when its size or mtime moved. True when it did.
   */
  pollLocal(): boolean
}

export function createStatusWatchModel(
  ctx: ToolContext,
  resolved: string,
  options: CopyOptions = {},
  initial?: CopyScan,
): StatusWatchModel {
  const logPath = ctx.eventsPath(resolved)
  let scans = 0
  const scan = (): CopyScan | undefined => {
    if (options.here === true) return undefined
    scans += 1
    return scanRecordCopies(ctx.rootDir, { slugs: [resolved], remotes: options.remotes === true })
  }
  const stamp = (): string => {
    try {
      const st = statSync(logPath)
      return `${st.size}:${st.mtimeMs}`
    } catch {
      return 'absent'
    }
  }
  let copies = initial ?? scan()
  let seen = stamp()
  let view: StatusView = { state: emptyState(), warnings: [], provenance: null }
  view.state.slug = resolved
  const refold = (): void => {
    seen = stamp()
    try {
      view = foldView(ctx, resolved, copies)
    } catch {
      // a read error never kills the watch: keep the last view, the next event may heal
    }
  }
  refold()
  return {
    get view() {
      return view
    },
    get scans() {
      return scans
    },
    localChanged: refold,
    copiesChanged() {
      copies = scan()
      refold()
    },
    pollLocal() {
      if (stamp() === seen) return false
      refold()
      return true
    },
  }
}

/**
 * `sofar status --watch` (cli-ui 4.3) — a live status: re-renders on
 * every record change and pulses the active-task marker warn↔dim on a
 * 600 ms beat. The ONLY live surface a one-shot CLI ships: animation cannot
 * outlive a print-and-exit process, so the static `sofar status` stays
 * static and --watch holds the process open instead.
 *
 * It folds every copy of the record like the one-shot status (branch-
 * visibility 3.2) and rescans them only when something that decides them
 * changes: another checkout's log for this initiative, a HEAD, a ref, or a
 * worktree coming or going (core/record-copies.ts copyWatch). The watched
 * set is re-derived after each rescan, so a worktree added mid-watch is
 * picked up.
 *
 * TTY-gated by caps.animate: piped/CI/dumb terminals fall back to the
 * one-shot runStatus result (returned for the caller to emit). On the
 * live path this function starts the loop and returns undefined — the
 * watcher and timer keep the process alive until ^C, which restores the
 * cursor before the default SIGINT disposition applies.
 */
export function runStatusWatch(
  rootDir: string,
  slug?: string,
  caps: Caps = stdoutCaps(),
  options: CopyOptions = {},
): CmdResult | undefined {
  if (!caps.animate) return runStatus(rootDir, slug, caps, undefined, options)

  const ctx = createToolContext(rootDir)
  let resolved: string
  let initial: CopyScan | undefined
  try {
    resolved = ctx.resolveInitiative(slug)
  } catch (err) {
    const scan = err instanceof ToolError ? heldElsewhere(rootDir, slug, options) : null
    if (scan === null) {
      if (err instanceof ToolError) {
        return fail(`sofar status: ${err.message} (usage: sofar status --watch [slug])`)
      }
      return fail(`sofar status: ${errMessage(err)}`)
    }
    resolved = slug!
    initial = scan
  }

  const model = createStatusWatchModel(ctx, resolved, options, initial)
  const style = createStyle(caps.color)
  const symbols = symbolsFor(caps.unicode)
  const home = homedir()
  let pulse = false
  let prevRows = 0

  const render = (): void => {
    const columns = columnsOf(process.stdout)
    const lines = renderInitiative(model.view.state, {
      zoom: 'full',
      style,
      symbols,
      columns,
      pulse,
      provenance: model.view.provenance,
      home,
    })
    lines.push('', style.dim('watching — ^C to exit'))
    const rewind = prevRows > 0 ? `\x1b[${prevRows}A\x1b[0J` : ''
    process.stdout.write(`${rewind}${lines.join('\n')}\n`)
    prevRows = terminalRows(lines, columns)
  }

  process.stdout.write('\x1b[?25l')
  render()
  const timer = setInterval(() => {
    pulse = !pulse
    model.pollLocal()
    render()
  }, PULSE_MS)

  // This checkout's record: the initiatives dir, filtered to this slug, so a
  // slug held only on another copy is picked up the moment it lands here.
  // Its filter covers this tree too. With --here the other copies go unwatched.
  const local = join(rootDir, '.sofar', 'initiatives')
  const remotes = options.remotes === true
  const targets = copyWatch(rootDir, resolved, { remotes })
  let watched = new Set(options.here === true ? [] : targets.paths)
  const watcher = watch([local, ...watched], { ignoreInitial: true, ignored: targets.ignored })

  let pending: NodeJS.Timeout | undefined
  const rescan = (): void => {
    pending = undefined
    model.copiesChanged()
    const next = new Set(copyWatch(rootDir, resolved, { remotes }).paths)
    const added = [...next].filter((p) => !watched.has(p))
    const gone = [...watched].filter((p) => !next.has(p))
    if (added.length > 0) watcher.add(added)
    if (gone.length > 0) watcher.unwatch(gone)
    watched = next
    render()
  }
  watcher.on('all', (_event, path) => {
    if (path === local || path.startsWith(`${local}/`)) {
      model.localChanged()
      render()
      return
    }
    if (pending !== undefined) clearTimeout(pending)
    pending = setTimeout(rescan, RESCAN_DEBOUNCE_MS)
  })
  process.once('SIGINT', () => {
    clearInterval(timer)
    if (pending !== undefined) clearTimeout(pending)
    void watcher.close()
    process.stdout.write('\x1b[?25h')
    process.kill(process.pid, 'SIGINT') // re-raise: default disposition exits
  })
  return undefined
}
