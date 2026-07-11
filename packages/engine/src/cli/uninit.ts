import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_END, PROTOCOL_START, SHIMS } from './init'
import { fail, ok, type CmdResult } from './shared'
import { type Caps, createStyle, stderrCaps, stdoutCaps, symbolsFor } from './ui'

/**
 * `sofar uninit [--purge]` (task 8.1, SPEC §CLI, BD45) — the exact inverse
 * of `sofar init`, surgical: remove ONLY what init installed and preserve
 * every byte of user content around it.
 *
 *   - the four hook shims in .claude/hooks/ (other files there are sacred;
 *     directories go only when THIS run emptied them)
 *   - settings.json hook entries whose command points at one of our four
 *     shims (matched on the shim path substring); emptied matcher groups,
 *     event arrays, and the hooks key itself are pruned
 *   - .mcp.json's mcpServers.sofar (other servers/keys untouched)
 *   - the marker-delimited protocol blocks in CLAUDE.md / AGENTS.md, plus
 *     exactly one adjacent blank-line seam so pre-init spacing is restored
 *
 * .sofar/ (the record) is KEPT by default — uninstalling the wiring must
 * never destroy the memory; a notice points at --purge. With --purge the
 * record is deleted, and ONLY --purge may also delete a managed file THIS
 * run emptied entirely (CLAUDE.md/AGENTS.md left zero-byte, settings.json/
 * .mcp.json left {}): that is what makes a fresh repo's init → uninit
 * --purge round-trip byte-clean (BD45). Without --purge those files stay,
 * even empty — the user may have created them.
 *
 * Unparseable user JSON aborts with exit 1 (init's caution, mirrored):
 * a file we cannot parse might still carry our entries, and guessing risks
 * user config.
 */

export interface UninitOptions {
  /** Also delete .sofar/ (the record) and files this run emptied. */
  purge?: boolean
}

class UninitAbort extends Error {}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readJSONObject(path: string, label: string): Obj {
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new UninitAbort(
      `${label} is not valid JSON — refusing to modify it. Fix or remove it, then re-run sofar uninit. (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (!isObj(decoded)) {
    throw new UninitAbort(`${label} must contain a JSON object — refusing to modify it.`)
  }
  return decoded
}

/** init's stable JSON form — rewriting with the same form preserves bytes. */
function stableJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** A settings command is ours iff it points at one of the four shim paths. */
const SHIM_PATH_SUBSTRINGS = SHIMS.map((shim) => `.claude/hooks/${shim.file}`)

function isShimCommand(hook: unknown): boolean {
  return (
    isObj(hook) &&
    typeof hook.command === 'string' &&
    SHIM_PATH_SUBSTRINGS.some((path) => (hook.command as string).includes(path))
  )
}

// ---------------------------------------------------------------------------
// Steps — each pushes "removed …"/"updated …" report lines (changes only).
// ---------------------------------------------------------------------------

function removeShims(rootDir: string, report: string[]): number {
  let removed = 0
  for (const shim of SHIMS) {
    const path = join(rootDir, '.claude', 'hooks', shim.file)
    if (!existsSync(path)) continue
    unlinkSync(path)
    report.push(`removed .claude/hooks/${shim.file}`)
    removed++
  }
  return removed
}

function stripSettings(rootDir: string, purge: boolean, report: string[]): boolean {
  const path = join(rootDir, '.claude', 'settings.json')
  if (!existsSync(path)) return false
  const settings = readJSONObject(path, '.claude/settings.json')
  if (!isObj(settings.hooks)) return false // no hooks object → nothing of ours

  const hooks = settings.hooks
  let changed = false
  // Scan EVERY event key, not just our four — a user may have moved an entry.
  for (const eventName of Object.keys(hooks)) {
    const entries = hooks[eventName]
    if (!Array.isArray(entries)) continue
    const kept = entries.filter((entry) => {
      if (!isObj(entry) || !Array.isArray(entry.hooks)) return true // foreign shape — keep
      const remaining = entry.hooks.filter((h) => !isShimCommand(h))
      if (remaining.length === entry.hooks.length) return true // untouched
      changed = true
      if (remaining.length === 0) return false // emptied matcher group → drop
      entry.hooks = remaining
      return true
    })
    if (kept.length === 0) delete hooks[eventName] // emptied event array → drop key
    else hooks[eventName] = kept
  }
  if (!changed) return false

  if (Object.keys(hooks).length === 0) delete settings.hooks
  if (purge && Object.keys(settings).length === 0) {
    unlinkSync(path)
    report.push('removed .claude/settings.json (nothing left after sofar hook entries removed)')
    return true
  }
  writeFileSync(path, stableJSON(settings), 'utf8')
  report.push('updated .claude/settings.json (sofar hook entries removed)')
  return false
}

function stripMcp(rootDir: string, purge: boolean, report: string[]): void {
  const path = join(rootDir, '.mcp.json')
  if (!existsSync(path)) return
  const config = readJSONObject(path, '.mcp.json')
  if (!isObj(config.mcpServers) || !('sofar' in config.mcpServers)) return

  delete config.mcpServers.sofar
  if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers
  if (purge && Object.keys(config).length === 0) {
    unlinkSync(path)
    report.push('removed .mcp.json (nothing left after sofar server entry removed)')
    return
  }
  writeFileSync(path, stableJSON(config), 'utf8')
  report.push('updated .mcp.json (sofar server entry removed)')
}

/**
 * Remove the marker-delimited protocol block INCLUSIVE of markers, plus
 * exactly one adjacent blank-line seam (init separated user content from the
 * block with a blank line — collapsing it restores pre-init spacing). All
 * content outside the markers is byte-preserved.
 */
function stripProtocolBlock(
  rootDir: string,
  file: string,
  purge: boolean,
  report: string[],
  warnings: string[],
): void {
  const path = join(rootDir, file)
  if (!existsSync(path)) return
  const content = readFileSync(path, 'utf8')
  const start = content.indexOf(PROTOCOL_START)
  if (start === -1) return
  const endMarker = content.indexOf(PROTOCOL_END, start)
  if (endMarker === -1) {
    warnings.push(
      `warning: ${file} has a ${PROTOCOL_START} marker but no ${PROTOCOL_END} — left untouched`,
    )
    return
  }
  let end = endMarker + PROTOCOL_END.length
  if (content[end] === '\n') end += 1 // the block's own trailing newline
  let before = content.slice(0, start)
  if (before.endsWith('\n\n')) before = before.slice(0, -1) // the one seam blank line
  const result = before + content.slice(end)

  if (purge && result.length === 0) {
    unlinkSync(path)
    report.push(`removed ${file} (contained only the sofar protocol block)`)
    return
  }
  writeFileSync(path, result, 'utf8')
  report.push(`updated ${file} (sofar protocol block removed)`)
}

/** Remove a directory ONLY when it exists and is empty. */
function removeDirIfEmpty(rootDir: string, rel: string, report: string[]): boolean {
  const path = join(rootDir, rel)
  if (!existsSync(path) || readdirSync(path).length > 0) return false
  rmdirSync(path)
  report.push(`removed ${rel}/ (empty)`)
  return true
}

// ---------------------------------------------------------------------------
// Confirmation styling (cli-ui 2.5). Wording is identical styled or plain —
// caps only add the ✓/✗ mark, color, dim └ rails on the detail/notice lines,
// and warn color on stderr warnings — so piped output stays byte-identical
// to the unstyled report. Failure and warning text lands on stderr, so it
// styles under the STDERR stream's caps (errCaps): a stdout TTY must not
// push escapes into a redirected stderr.
// ---------------------------------------------------------------------------

function renderReport(details: string[], result: string, caps: Caps): string {
  if (!caps.color) return [...details, result].join('\n')
  const style = createStyle(true)
  const symbols = symbolsFor(caps.unicode)
  return [
    ...details.map((line) => style.dim(`  ${symbols.elbow} ${line}`)),
    `${style.success(symbols.ok)} ${result}`,
  ].join('\n')
}

function renderFailure(message: string, caps: Caps): string {
  if (!caps.color) return message
  return `${createStyle(true).error(symbolsFor(caps.unicode).fail)} ${message}`
}

function renderWarnings(warnings: string[], caps: Caps): string {
  if (!caps.color) return warnings.join('\n')
  const style = createStyle(true)
  return warnings.map((line) => style.warn(line)).join('\n')
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export function runUninit(
  rootDir: string,
  options: UninitOptions = {},
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const purge = options.purge === true
  const report: string[] = []
  const warnings: string[] = []
  const notes: string[] = []

  try {
    const shimsRemoved = removeShims(rootDir, report)
    const settingsDeleted = stripSettings(rootDir, purge, report)
    stripMcp(rootDir, purge, report)
    stripProtocolBlock(rootDir, 'CLAUDE.md', purge, report, warnings)
    stripProtocolBlock(rootDir, 'AGENTS.md', purge, report, warnings)

    // Directory cleanup — only dirs THIS run may have emptied, never a dir
    // that was already empty before uninit touched anything.
    const hooksDirRemoved = shimsRemoved > 0 && removeDirIfEmpty(rootDir, '.claude/hooks', report)
    if (hooksDirRemoved || settingsDeleted) removeDirIfEmpty(rootDir, '.claude', report)

    const sofarDir = join(rootDir, '.sofar')
    if (existsSync(sofarDir)) {
      if (purge) {
        rmSync(sofarDir, { recursive: true, force: true })
        report.push('removed .sofar/ (record deleted)')
        warnings.push(
          'warning: --purge deleted the sofar record (.sofar/) — this is irreversible; `sofar export` before purging is the backup path.',
        )
      } else {
        notes.push('record kept at .sofar/ (use --purge to delete it)')
      }
    }
  } catch (err) {
    if (err instanceof UninitAbort) {
      return fail(renderFailure(`sofar uninit: ${err.message}`, errCaps))
    }
    throw err
  }

  const changes = report.length
  const result =
    changes === 0
      ? 'sofar uninit: nothing to remove'
      : `sofar uninit: done (${changes} change${changes === 1 ? '' : 's'})`
  return ok(
    `${renderReport([...report, ...notes], result, caps)}\n`,
    renderWarnings(warnings, errCaps),
  )
}
