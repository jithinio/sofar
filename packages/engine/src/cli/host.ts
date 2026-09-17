import { resolve } from 'node:path'
import type { HookResult } from './event'

/**
 * Hook hosts (r1-fixes 6.3–6.6, D34; agents-parity 2.1, D5): ONE set of
 * handlers serves Claude Code, Cursor and Codex, and this module is the whole
 * difference between them.
 *
 * Cursor runs the same shim files — natively from .cursor/hooks.json, or as
 * "third-party" hooks read out of .claude/settings.json — but it speaks its own
 * dialect on both ends of the pipe, and a handler written for Claude Code's
 * dialect fails there SILENTLY rather than loudly:
 *
 * - IN: Cursor hands its own payload even to a Claude-format hook. Tools are
 *   named `Shell` and `Write` (never `Bash` / `Edit`), a failure carries
 *   `error_message`, and the stop hook's loop guard is `loop_count`. Round 1's
 *   Cursor cells show the cost: 175 file_touched (Write happens to match) and
 *   0 command_run (Shell never matched Bash).
 * - OUT: Cursor ignores plain stdout and does nothing with exit 2 on stop. It
 *   reads `additional_context` and `followup_message` from a JSON object.
 *   Cursor can translate Claude's `hookSpecificOutput` too, but only behind a
 *   compatibility flag sofar cannot see, so the native keys are emitted.
 *
 * Everything here was read from cursor-agent 2026.09.10-fd3934a, and SPEC
 * pins it (§Cursor host). The handlers stay Claude-shaped and byte-identical for Claude Code:
 * `forHost` converts a Cursor payload on the way in and the result on the way
 * out, and a Claude Code invocation passes straight through.
 *
 * Codex (read from codex-cli 0.154.0 and its docs, SPEC §Codex host) already
 * sends Claude Code's field names, so its payload needs no conversion. What
 * it lacks is any field naming the host, so its shims declare it
 * (`--host codex`, D5). Three differences remain (D6): `apply_patch` edits
 * (parsed by `patchedFiles`), a PostToolUse that also fires after a failing
 * command, and context carried as `hookSpecificOutput` JSON so the digest can
 * be exempted from Codex's 2,500-token spill.
 */

type Obj = Record<string, unknown>

/** The hook subcommand names (event.ts SUBCOMMANDS) — the unit a conversion is chosen by. */
export type HookName = 'session-start' | 'post-tool' | 'post-tool-failure' | 'user-prompt' | 'stop' | 'session-end'

/** Which agent fired a hook — recorded on session registration and diagnostics rows. */
export interface HookHost {
  tool: 'claude-code' | 'cursor' | 'codex'
  /** The host's own version string, when its payload names one. */
  version?: string
}

export const CLAUDE_CODE_HOST: HookHost = { tool: 'claude-code' }
export const CODEX_HOST: HookHost = { tool: 'codex' }

/**
 * Hosts whose payload names no host, so their shims must, as
 * `sofar event <hook> --host <id>` (D5). A host that can be told from stdin
 * never needs the flag.
 */
export const DECLARED_HOSTS = ['codex'] as const
export type DeclaredHost = (typeof DECLARED_HOSTS)[number]

export function isDeclaredHost(value: string): value is DeclaredHost {
  return (DECLARED_HOSTS as readonly string[]).includes(value)
}

/**
 * Does this host fire PostToolUse only for a call that succeeded? Claude Code
 * and Cursor do, and send failures to PostToolUseFailure. Codex has no failure
 * event and fires PostToolUse after a Bash command that exits non-zero as well
 * (docs), with no verified exit status on the payload. So a Codex firing says
 * nothing about the outcome, and the event records none: absent `ok` means
 * unknown, never success.
 */
export function postToolProvesSuccess(host: HookHost): boolean {
  return host.tool !== 'codex'
}

/**
 * Cursor's per-carrier cap on injected context, measured after trimming. Above
 * it Cursor drops the WHOLE carrier rather than truncating it, so a notice one
 * character too long delivers nothing at all.
 */
export const CURSOR_CONTEXT_MAX = 10_000

/** Cursor's hook tool names → the Claude Code names the handlers classify. */
const CURSOR_TOOL_NAMES: Readonly<Record<string, string>> = { Shell: 'Bash' }

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Which host fired this hook. Read from STDIN only — `cursor_version` is on
 * every Cursor payload — and never from the environment: a Claude Code session
 * started inside Cursor's integrated terminal inherits Cursor's variables and
 * must still be served as Claude Code.
 */
export function hookHost(hook: Obj): HookHost {
  const version = hook.cursor_version
  if (typeof version !== 'string') return CLAUDE_CODE_HOST
  return version.length > 0 ? { tool: 'cursor', version } : { tool: 'cursor' }
}

/**
 * A Cursor payload in the field names the handlers read. Every original field
 * is kept (hookHost still has to see `cursor_version`); an alias is added only
 * where the Claude name is absent, so nothing Cursor sent is overwritten.
 */
export function fromCursor(hook: Obj): Obj {
  const out: Obj = { ...hook }
  if (typeof hook.session_id !== 'string' && typeof hook.conversation_id === 'string') {
    out.session_id = hook.conversation_id
  }
  if (typeof hook.tool_name === 'string') {
    const mapped = CURSOR_TOOL_NAMES[hook.tool_name]
    if (mapped !== undefined) out.tool_name = mapped
  }
  if (typeof hook.error_message === 'string' && hook.error === undefined) out.error = hook.error_message
  if (typeof hook.tool_output === 'string' && hook.tool_response === undefined) {
    out.tool_response = { stdout: hook.tool_output }
  }
  // Cursor counts the follow-ups a stop hook has already caused; Claude Code
  // flags the same state as a boolean. Either way: we have held once already.
  if (typeof hook.loop_count === 'number' && hook.stop_hook_active === undefined) {
    out.stop_hook_active = hook.loop_count > 0
  }
  return out
}

/** The context a handler's stdout carries, whichever Claude Code form it took. */
function contextOf(name: HookName, stdout: string): string | null {
  const text = stdout.trim()
  if (text.length === 0) return null
  if (name !== 'post-tool') return text
  // PostToolUse speaks hookSpecificOutput JSON for Claude Code.
  try {
    const decoded: unknown = JSON.parse(text)
    const specific = isObj(decoded) ? decoded.hookSpecificOutput : undefined
    const context = isObj(specific) ? specific.additionalContext : undefined
    return typeof context === 'string' && context.trim().length > 0 ? context : null
  } catch {
    return null
  }
}

function json(value: Obj): string {
  return `${JSON.stringify(value)}\n`
}

/**
 * A handler's Claude Code result, as Cursor reads it. The Stop gate's exit 2
 * becomes exit 0 with `followup_message` — the only stop output Cursor acts on,
 * queued as the agent's next prompt. Context becomes `additional_context`.
 * Session-start is the one carrier Cursor does not cap, and the digest is
 * already held to 10,000 characters, so only the per-prompt and per-tool lines
 * are clipped — and clipped, never dropped, because Cursor's own overflow
 * handling is to discard the lot.
 */
export function toCursor(name: HookName, result: HookResult): HookResult {
  if (name === 'stop') {
    if (result.exitCode !== 2) return result
    const message = result.stderr.trim()
    return { exitCode: 0, stdout: message.length > 0 ? json({ followup_message: message }) : '', stderr: '' }
  }
  const context = contextOf(name, result.stdout)
  if (context === null) return { ...result, stdout: '' }
  const clipped =
    name === 'session-start' || context.length <= CURSOR_CONTEXT_MAX
      ? context
      : `${context.slice(0, CURSOR_CONTEXT_MAX - 1)}…`
  return { ...result, stdout: json({ additional_context: clipped }) }
}

/** The Codex event whose context carrier each context-bearing hook fills. */
const CODEX_CONTEXT_EVENTS: Readonly<Partial<Record<HookName, string>>> = {
  'session-start': 'SessionStart',
  'user-prompt': 'UserPromptSubmit',
}

/**
 * A handler's Claude Code result, as Codex reads it. Codex takes plain stdout
 * as context on SessionStart and UserPromptSubmit, but the docs say nothing on
 * whether plain text is exempt from its ~2,500-token spill, and a 10,000-char
 * digest sits right at that line. A spilled digest reaches the model as a
 * head-and-tail preview. So both carry `hookSpecificOutput.additionalContext`,
 * the one form `additionalContextLimit` (0 on sofar's SessionStart entry) is
 * documented to govern. Post-tool JSON, the Stop gate's exit 2 and every
 * empty result already fit Codex's schemas and pass through.
 */
export function toCodex(name: HookName, result: HookResult): HookResult {
  const event = CODEX_CONTEXT_EVENTS[name]
  if (event === undefined) return result
  const context = contextOf(name, result.stdout)
  if (context === null) return { ...result, stdout: '' }
  return { ...result, stdout: json({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) }
}

/**
 * The file headers of an `apply_patch` body, which Codex's edits carry whole
 * in `tool_input.command` with no `file_path`. The markers were read from codex
 * 0.154.0's binary; the grammar around them is unverified (SPEC §Codex host).
 */
const PATCH_HEADERS: ReadonlyArray<readonly [marker: string, op: string]> = [
  ['*** Add File: ', 'write'],
  ['*** Update File: ', 'edit'],
  ['*** Delete File: ', 'delete'],
]
const PATCH_MOVE = '*** Move to: '

/**
 * Every file one `apply_patch` touches, in patch order, resolved against the
 * session cwd the payload names (a patch path is relative to it, and Claude
 * Code's absolute `file_path` is the form the record already holds). A move
 * touches two paths: its source is gone (`delete`) and its destination is
 * written (`write`). Hunk lines never start with `***`, so a header cannot be
 * mistaken inside a hunk.
 */
export function patchedFiles(patch: string, cwd: string | null): Array<{ path: string; op: string }> {
  const at = (path: string): string => (cwd === null ? path : resolve(cwd, path))
  const files: Array<{ path: string; op: string }> = []
  for (const raw of patch.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith(PATCH_MOVE)) {
      const to = line.slice(PATCH_MOVE.length).trim()
      const from = files[files.length - 1]
      if (to.length > 0 && from !== undefined && from.op === 'edit') {
        from.op = 'delete'
        files.push({ path: at(to), op: 'write' })
      }
      continue
    }
    for (const [marker, op] of PATCH_HEADERS) {
      if (!line.startsWith(marker)) continue
      const path = line.slice(marker.length).trim()
      if (path.length > 0) files.push({ path: at(path), op })
    }
  }
  return files
}

/**
 * Serve a hook handler to whichever host fired it. A host its shim declares
 * (Codex) is served as declared. Otherwise a payload that cannot be a Cursor
 * one (the substring check spares every Claude Code call a second parse on the
 * 100ms hook path) reaches the handler untouched.
 */
export function forHost(
  name: HookName,
  handler: (rootDir: string, input: string, host?: HookHost) => HookResult,
): (rootDir: string, input: string, declared?: DeclaredHost) => HookResult {
  return (rootDir, input, declared) => {
    if (declared === 'codex') return toCodex(name, handler(rootDir, input, CODEX_HOST))
    if (!input.includes('"cursor_version"')) return handler(rootDir, input)
    let hook: Obj
    try {
      const decoded: unknown = JSON.parse(input)
      if (!isObj(decoded)) return handler(rootDir, input)
      hook = decoded
    } catch {
      return handler(rootDir, input)
    }
    if (hookHost(hook).tool !== 'cursor') return handler(rootDir, input)
    return toCursor(name, handler(rootDir, JSON.stringify(fromCursor(hook))))
  }
}
