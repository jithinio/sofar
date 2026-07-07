import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mcpRegistration } from '../mcp/register'
import { fail, ok, type CmdResult } from './shared'
import sessionStartShim from '../hooks/session-start.sh'
import postToolUseShim from '../hooks/post-tool-use.sh'
import stopShim from '../hooks/stop.sh'
import sessionEndShim from '../hooks/session-end.sh'

/**
 * `harness init` (task 4.1, SPEC §CLI) — make a repo harness-ready:
 *   .harness/ (repo.md stub + bindings.json), hook shims in .claude/hooks/,
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

export const PROTOCOL_START = '<!-- harness:protocol -->'
export const PROTOCOL_END = '<!-- /harness:protocol -->'

/**
 * The BD19 total-jurisdiction protocol block. Clauses (a)–(c) are contract
 * (SPEC §CLI): record-only state, `harness new` before unmatched work,
 * bindings resolve the record — plus the read-orient/write-back loop.
 */
export const PROTOCOL_BLOCK = `${PROTOCOL_START}
## Harness protocol (jurisdiction is total)

This repo's work memory lives in harness records under \`.harness/\`.
1. ALL work state lives in harness records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`harness new <slug>\` before proceeding.
3. Bindings (\`.harness/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop:
- START: orient from the record — call \`harness_get_state\` (MCP) or run
  \`harness status\`. Do not ask for context the record already answers.
  Then call \`harness_start_session\` passing the \`session_id\` from the
  injected context line ("Session: <id> — …") so your events attach to
  YOUR session — never omit it when that line is present (omitting mints
  a separate session id and orphans the hook-registered one).
- DURING: log decisions (\`harness_log_decision\`) and task status changes
  (\`harness_update_task\`) as they happen.
- BEFORE FINISHING: write back with \`harness_end_session\` (summary +
  next action). The Stop hook blocks sessions that skip this.
${PROTOCOL_END}
`

/**
 * The AGENTS.md convention dialect (task 5.1, BD31) — the same three BD19
 * total-jurisdiction clauses, but a CLI-only loop: AGENTS.md readers
 * (OpenCode, Codex, plain shells) cannot be assumed to have MCP, so every
 * step goes through \`harness status\` / \`harness event append\`. No hook
 * enforces write-back for these tools, hence the MANDATORY clause (the
 * compensating control — see docs/opencode-adapter.md).
 */
export const AGENTS_PROTOCOL_BLOCK = `${PROTOCOL_START}
## Harness protocol (jurisdiction is total)

This repo's work memory lives in harness records under \`.harness/\`. Drive
the whole loop with the \`harness\` CLI — no MCP support is required.
1. ALL work state lives in harness records — never in tool memory, scratch
   files, or ad-hoc notes. If it is worth keeping, it goes in the record.
2. Work that matches no existing initiative requires creating one first:
   run \`harness new <slug>\` before proceeding.
3. Bindings (\`.harness/bindings.json\`) resolve which record a session
   serves — the current git branch selects the initiative.

Session loop (every write is one \`harness event append\` call):
- BEFORE any work: run \`harness status\` and orient from it. Detail lives
  in \`.harness/initiatives/<slug>/plan.md\` and \`decisions.md\`. Do not
  ask for context the record already answers.
- START: pick one unique session id, reuse it for every append this
  session, and register it:
  \`harness event append --type session_started --session <session-id> --source opencode --payload '{"tool":"opencode"}'\`
  (put your tool's name in --source and the payload).
- DURING: log work as it happens with \`harness event append --session <session-id> --source <tool>\` plus:
  task status:  \`--type task_status_changed --payload '{"id":"<task-id>","status":"pending|active|done|blocked"}'\`
  decisions:    \`--type decision_logged --payload '{"chose":"...","over":"...","because":"..."}'\`
  notes:        \`--type note_added --payload '{"text":"..."}'\`
- BEFORE FINISHING (MANDATORY): write back —
  \`harness event append --type session_ended --session <session-id> --source <tool> --payload '{"summary":"<what happened>","next_action":"<single next step>"}'\`
  A session that skips this abandons its state and the next session starts blind.

Prohibitions:
- Never hand-edit generated projections (plan.md, decisions.md,
  sessions/*) — they are rebuilt from events.jsonl on every append.
- Never edit events.jsonl directly — truth is append-only, via the CLI.
- Corrections are new \`correction\` events referencing the bad event's id
  (then append the corrected event fresh); history is never rewritten.
${PROTOCOL_END}
`

export const REPO_MD_STUB = `# Repo memory

Hand-written, repo-scoped notes for agents working here: conventions,
commands, gotchas — anything true of the repo across all initiatives.
Harness never generates or overwrites this file; initiative state lives in
.harness/initiatives/<slug>/ instead.
`

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
      `${label} is not valid JSON — refusing to modify it. Fix or remove it, then re-run harness init. (${err instanceof Error ? err.message : String(err)})`,
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

function initHarnessDir(rootDir: string, report: string[]): void {
  const harnessDir = join(rootDir, '.harness')
  mkdirSync(join(harnessDir, 'initiatives'), { recursive: true })
  // repo.md is HAND-WRITTEN (SPEC §Record layout) — create only, never touch.
  report.push(`${createIfMissing(join(harnessDir, 'repo.md'), REPO_MD_STUB)} .harness/repo.md`)
  report.push(
    `${createIfMissing(join(harnessDir, 'bindings.json'), '{}\n')} .harness/bindings.json`,
  )
}

function installShims(rootDir: string, report: string[]): void {
  const hooksDir = join(rootDir, '.claude', 'hooks')
  mkdirSync(hooksDir, { recursive: true })
  for (const shim of SHIMS) {
    const path = join(hooksDir, shim.file)
    const change = writeIfChanged(path, shim.text) // shims are harness-owned: kept current
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

  if (servers.harness !== undefined && existsSync(path)) {
    report.push('unchanged .mcp.json') // user may have customized the entry — theirs wins
    return
  }
  servers.harness = mcpRegistration().mcpServers.harness
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
    report.push(`created ${file} (harness protocol block)`)
    return
  }
  const current = readFileSync(path, 'utf8')
  if (current.includes(PROTOCOL_START)) {
    report.push(`unchanged ${file} (protocol block present)`) // never touched once installed
    return
  }
  const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n'
  writeFileSync(path, `${current}${separator}${block}`, 'utf8')
  report.push(`updated ${file} (harness protocol block appended)`)
}

// ---------------------------------------------------------------------------
// Command.
// ---------------------------------------------------------------------------

export function runInit(rootDir: string): CmdResult {
  const report: string[] = []
  try {
    initHarnessDir(rootDir, report)
    installShims(rootDir, report)
    mergeSettings(rootDir, report)
    mergeMcpJson(rootDir, report)
    appendProtocolBlock(rootDir, 'CLAUDE.md', PROTOCOL_BLOCK, report)
    appendProtocolBlock(rootDir, 'AGENTS.md', AGENTS_PROTOCOL_BLOCK, report)
  } catch (err) {
    if (err instanceof InitAbort) return fail(`harness init: ${err.message}`)
    throw err
  }
  const changed = report.filter((line) => !line.startsWith('unchanged')).length
  report.push(
    changed === 0
      ? 'harness init: already initialized — nothing to do'
      : `harness init: done (${changed} change${changed === 1 ? '' : 's'})`,
  )
  return ok(`${report.join('\n')}\n`)
}
