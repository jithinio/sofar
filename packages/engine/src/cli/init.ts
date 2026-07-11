import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpRegistration } from '../mcp/register'
import { detectTailwindV4 } from './scanners'
import { fail, ok, REPO_MD_STUB, type CmdResult } from './shared'
import { type Caps, createStyle, stderrCaps, stdoutCaps, symbolsFor } from './ui'
import sessionStartShim from '../hooks/session-start.sh'
import postToolUseShim from '../hooks/post-tool-use.sh'
import stopShim from '../hooks/stop.sh'
import sessionEndShim from '../hooks/session-end.sh'

/**
 * `sofar init` (task 4.1, SPEC §CLI) — make a repo sofar-ready:
 *   .sofar/ (repo.md stub + bindings.json), hook shims in .claude/hooks/,
 *   .claude/settings.json hooks block, .mcp.json registration, and the
 *   total-jurisdiction protocol blocks (BD19) in CLAUDE.md (MCP loop) and
 *   AGENTS.md (CLI convention dialect for MCP-less tools — task 5.1, BD31).
 *
 * Idempotency is BYTE-LEVEL: a file is written only when its target content
 * differs, so a second run changes nothing (SPEC §Acceptance Phase 4).
 * Hand-written files are sacred: repo.md is never overwritten; CLAUDE.md
 * outside (and inside) the markers is never touched once the block exists;
 * settings.json/.mcp.json are merged, never clobbered — unparseable JSON in
 * either aborts with exit 1 rather than risking user config.
 *
 * Shim TEXT ships inside the bundle (esbuild `loader: {'.sh': 'text'}`) —
 * only dist/ is published, so init never reads src/hooks/ at runtime.
 */

export const PROTOCOL_START = '<!-- sofar:protocol -->'
export const PROTOCOL_END = '<!-- /sofar:protocol -->'

/**
 * The BD19 total-jurisdiction protocol block. Clauses (a)–(c) are contract
 * (SPEC §CLI): record-only state, `sofar new` before unmatched work,
 * bindings resolve the record — plus the read-orient/write-back loop.
 */
export const PROTOCOL_BLOCK = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: orient from the record — call \`sofar_get_state\` (MCP) or run
  \`sofar status\`. Do not ask for context the record already answers.
  Then call \`sofar_start_session\` passing the \`session_id\` from the
  injected context line ("Session: <id> — …") so your events attach to
  YOUR session — never omit it when that line is present (omitting mints
  a separate session id and orphans the hook-registered one).
- DURING: log decisions (\`sofar_log_decision\`) and task status changes
  (\`sofar_update_task\`) as they happen.
- BEFORE FINISHING: write back with \`sofar_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * The AGENTS.md convention dialect (task 5.1, BD31) — the same three BD19
 * total-jurisdiction clauses, but a CLI-only loop: AGENTS.md readers
 * (OpenCode, Codex, plain shells) cannot be assumed to have MCP, so every
 * step goes through \`sofar status\` / \`sofar event append\`. No hook
 * enforces write-back for these tools, hence the MANDATORY clause (the
 * compensating control — see docs/opencode-adapter.md).
 */
export const AGENTS_PROTOCOL_BLOCK = `${PROTOCOL_START}
## Sofar protocol (jurisdiction is total)

This repo's work memory lives in sofar records under \`.sofar/\`. Drive
the whole loop with the \`sofar\` CLI — no MCP support is required.
1. ALL work state lives in sofar records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`sofar new <slug>\` before proceeding.
3. Bindings (\`.sofar/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`sofar event append\` call):
- BEFORE any work: run \`sofar status\` and orient from it. Detail lives
  in \`.sofar/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`sofar event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`sofar event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- BEFORE FINISHING (MANDATORY): write back —
  \`sofar event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

// REPO_MD_STUB moved to ./shared (ui-free) so event.ts can import it without
// transitively reaching cli/ui through this module; re-exported here for the
// existing importers (init is where the stub is written to disk).
export { REPO_MD_STUB } from './shared'

const HOOK_COMMAND_PREFIX = '$CLAUDE_PROJECT_DIR/.claude/hooks/'

interface ShimSpec {
  file: string
  event: 'SessionStart' | 'PostToolUse' | 'Stop' | 'SessionEnd'
  matcher?: string
  text: string
}

/** Order here is the order entries land in settings.json. */
export const SHIMS: readonly ShimSpec[] = [
  { file: 'session-start.sh', event: 'SessionStart', text: sessionStartShim },
  {
    file: 'post-tool-use.sh',
    event: 'PostToolUse',
    matcher: 'Edit|Write|MultiEdit|Bash',
    text: postToolUseShim,
  },
  { file: 'stop.sh', event: 'Stop', text: stopShim },
  { file: 'session-end.sh', event: 'SessionEnd', text: sessionEndShim },
]

export function hookCommand(file: string): string {
  return `${HOOK_COMMAND_PREFIX}${file}`
}

// ---------------------------------------------------------------------------
// Small file primitives — every mutation reports created/updated/unchanged.
// ---------------------------------------------------------------------------

type Change = 'created' | 'updated' | 'unchanged'

class InitAbort extends Error {}

function writeIfChanged(path: string, content: string): Change {
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') === content) return 'unchanged'
    writeFileSync(path, content, 'utf8')
    return 'updated'
  }
  writeFileSync(path, content, 'utf8')
  return 'created'
}

function createIfMissing(path: string, content: string): Change {
  if (existsSync(path)) return 'unchanged'
  writeFileSync(path, content, 'utf8')
  return 'created'
}

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse a user-owned JSON object file; refuse to proceed on anything odd. */
function readJSONObject(path: string, label: string): Obj {
  if (!existsSync(path)) return {}
  let decoded: unknown
  try {
    decoded = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new InitAbort(
      `${label} is not valid JSON — refusing to modify it. Fix or remove it, then re-run sofar init. (${err instanceof Error ? err.message : String(err)})`,
    )
  }
  if (!isObj(decoded)) {
    throw new InitAbort(`${label} must contain a JSON object — refusing to modify it.`)
  }
  return decoded
}

function stableJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Steps.
// ---------------------------------------------------------------------------

function initSofarDir(rootDir: string, report: string[]): void {
  const sofarDir = join(rootDir, '.sofar')
  mkdirSync(join(sofarDir, 'initiatives'), { recursive: true })
  // repo.md is HAND-WRITTEN (SPEC §Record layout) — create only, never touch.
  report.push(`${createIfMissing(join(sofarDir, 'repo.md'), REPO_MD_STUB)} .sofar/repo.md`)
  report.push(
    `${createIfMissing(join(sofarDir, 'bindings.json'), '{}\n')} .sofar/bindings.json`,
  )
}

function installShims(rootDir: string, report: string[]): void {
  const hooksDir = join(rootDir, '.claude', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  for (const shim of SHIMS) {
    const path = join(hooksDir, shim.file)
    const change = writeIfChanged(path, shim.text) // shims are sofar-owned: kept current
    if ((statSync(path).mode & 0o777) !== 0o755) chmodSync(path, 0o755)
    report.push(`${change} .claude/hooks/${shim.file}`)
  }
}

/** Does any entry for this event already run our command? (match on command path) */
function hasCommand(entries: unknown[], command: string): boolean {
  return entries.some(
    (entry) =>
      isObj(entry) &&
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => isObj(h) && h.command === command),
  )
}

function mergeSettings(rootDir: string, report: string[]): void {
  const path = join(rootDir, '.claude', 'settings.json')
  const settings = readJSONObject(path, '.claude/settings.json')

  if (settings.hooks !== undefined && !isObj(settings.hooks)) {
    throw new InitAbort('.claude/settings.json has a non-object "hooks" key — refusing to modify it.')
  }
  const hooks: Obj = isObj(settings.hooks) ? settings.hooks : {}

  let added = 0
  for (const shim of SHIMS) {
    const existing = hooks[shim.event]
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new InitAbort(
        `.claude/settings.json hooks.${shim.event} is not an array — refusing to modify it.`,
      )
    }
    const entries: unknown[] = Array.isArray(existing) ? existing : []
    const command = hookCommand(shim.file)
    if (!hasCommand(entries, command)) {
      entries.push({
        ...(shim.matcher !== undefined ? { matcher: shim.matcher } : {}),
        hooks: [{ type: 'command', command }],
      })
      added++
    }
    hooks[shim.event] = entries
  }

  if (added === 0 && existsSync(path)) {
    report.push('unchanged .claude/settings.json')
    return
  }
  settings.hooks = hooks
  report.push(`${writeIfChanged(path, stableJSON(settings))} .claude/settings.json`)
}

function mergeMcpJson(rootDir: string, report: string[]): void {
  const path = join(rootDir, '.mcp.json')
  const config = readJSONObject(path, '.mcp.json')

  if (config.mcpServers !== undefined && !isObj(config.mcpServers)) {
    throw new InitAbort('.mcp.json has a non-object "mcpServers" key — refusing to modify it.')
  }
  const servers: Obj = isObj(config.mcpServers) ? config.mcpServers : {}

  if (servers.sofar !== undefined && existsSync(path)) {
    report.push('unchanged .mcp.json') // user may have customized the entry — theirs wins
    return
  }
  servers.sofar = mcpRegistration().mcpServers.sofar
  config.mcpServers = servers
  report.push(`${writeIfChanged(path, stableJSON(config))} .mcp.json`)
}

/**
 * Install a marker-delimited protocol block into a repo-root file — one
 * discipline for CLAUDE.md and AGENTS.md: create the file if missing, append
 * the block if the markers are absent, and never touch the file again once
 * the markers exist (hand edits inside them survive).
 */
function appendProtocolBlock(rootDir: string, file: string, block: string, report: string[]): void {
  const path = join(rootDir, file)
  if (!existsSync(path)) {
    writeFileSync(path, block, 'utf8')
    report.push(`created ${file} (sofar protocol block)`)
    return
  }
  const current = readFileSync(path, 'utf8')
  if (current.includes(PROTOCOL_START)) {
    report.push(`unchanged ${file} (protocol block present)`) // never touched once installed
    return
  }
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(path, `${current}${separator}${block}`, 'utf8')
  report.push(`updated ${file} (sofar protocol block appended)`)
}

// ---------------------------------------------------------------------------
// Confirmation styling (cli-ui 2.5). Wording is identical styled or plain —
// caps only add the ✓/✗ mark, color, and dim └ rails on the per-file detail
// lines — so piped output stays byte-identical to the unstyled report.
// Failure text lands on stderr, so it styles under the STDERR stream's caps
// (errCaps): a stdout TTY must not push escapes into a redirected stderr.
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

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export function runInit(
  rootDir: string,
  caps: Caps = stdoutCaps(),
  errCaps: Caps = stderrCaps(),
): CmdResult {
  const report: string[] = []
  try {
    initSofarDir(rootDir, report)
    installShims(rootDir, report)
    mergeSettings(rootDir, report)
    mergeMcpJson(rootDir, report)
    appendProtocolBlock(rootDir, 'CLAUDE.md', PROTOCOL_BLOCK, report)
    appendProtocolBlock(rootDir, 'AGENTS.md', AGENTS_PROTOCOL_BLOCK, report)
  } catch (err) {
    if (err instanceof InitAbort) return fail(renderFailure(`sofar init: ${err.message}`, errCaps))
    throw err
  }
  const changed = report.filter((line) => !line.startsWith('unchanged')).length
  const result =
    changed === 0
      ? 'sofar init: already initialized — nothing to do'
      : `sofar init: done (${changed} change${changed === 1 ? '' : 's'})`
  const lines = [renderReport(report, result, caps)]
  // Scanner defense (task 10.1, D-P10): if a tree-wide class scanner will
  // ingest .sofar/, raise the exclusion hint as the FINAL output. init only
  // flags it; `sofar doctor --fix` does the precise, path-aware insert.
  // The hint stays unstyled: its last line is a copy-pasteable directive.
  const hint = scannerHint(rootDir)
  if (hint !== null) lines.push('', hint)
  return ok(`${lines.join('\n')}\n`)
}

/**
 * The Tailwind-v4 scanner hint (task 10.1) — printed as init's final output
 * when a `tailwindcss@>=4` dependency is present. Generic on purpose: init
 * does not scan for the CSS entry (that is `sofar doctor`'s job); it points
 * the user at the automatic fix and shows the hand-edit shape.
 */
function scannerHint(rootDir: string): string | null {
  const tw = detectTailwindV4(rootDir)
  if (!tw.v4) return null
  return [
    `note: Tailwind v4 detected (tailwindcss ${tw.range}). Its content scanner`,
    '  ingests every non-gitignored file — including .sofar/ records — which can',
    '  bloat or break your CSS build. Exclude the record from scanning:',
    '    run `sofar doctor --fix`   (inserts `@source not` into your Tailwind entry)',
    '  or add this by hand after `@import "tailwindcss";`:',
    '    @source not "<relative-path>/.sofar";',
  ].join('\n')
}
