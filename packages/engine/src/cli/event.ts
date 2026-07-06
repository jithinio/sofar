import { resolve } from 'node:path'
import type { Command } from 'commander'
import { createToolContext, type ToolContext } from '../mcp/context'

/**
 * `harness event <subcommand>` — the internal surface hook shims call
 * (SPEC §Hooks, §CLI). Every subcommand reads Claude Code hook JSON from
 * stdin: { session_id, transcript_path, cwd, hook_event_name, ... }.
 *
 * Philosophy (BD22): hooks must never break the user's session. Any
 * resolution failure — unreadable stdin, no .harness/, no branch binding,
 * missing session_id — exits 0 silently. The ONE deliberate non-zero exit is
 * Stop's exit 2 when a registered session has not written back (BD2).
 *
 * Handlers are pure-ish ({exitCode, stdout, stderr} in, no process.exit) so
 * tests drive them directly; commander wiring below stays thin.
 */

export interface HookResult {
  exitCode: number
  stdout: string
  stderr: string
}

const OK: HookResult = { exitCode: 0, stdout: '', stderr: '' }

export const STOP_BLOCK_MESSAGE =
  'Write back to the harness record before finishing: call harness_end_session (or update harness.md per protocol).'

/** Hook payload tool = the agent tool whose hooks feed this surface. */
const HOOK_TOOL = 'claude-code'

// ---------------------------------------------------------------------------
// Defensive stdin parsing — missing/unknown fields must never crash a shim.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse hook JSON; anything unparseable degrades to an empty object. */
function parseHook(input: string): Obj {
  try {
    const decoded: unknown = JSON.parse(input)
    return isObj(decoded) ? decoded : {}
  } catch {
    return {}
  }
}

function strField(hook: Obj, key: string): string | null {
  const v = hook[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Resolve the bound initiative; null on any failure (unbound repo etc.). */
function resolveBound(rootDir: string): { ctx: ToolContext; slug: string } | null {
  try {
    const ctx = createToolContext(rootDir)
    const slug = ctx.resolveInitiative()
    return { ctx, slug }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

/**
 * SessionStart (task 3.2) — registers Claude Code's session_id in the log
 * (the correlation anchor, BD20) and prints the status projection to stdout
 * for context injection (≤10,000 chars — guaranteed by renderStatus).
 * Re-fires on resume/clear/compact reuse the same session_id: the append is
 * skipped if the session is already registered, but the status block is
 * printed every time (re-injection after compact is the point).
 */
export function handleSessionStart(rootDir: string, input: string): HookResult {
  try {
    const bound = resolveBound(rootDir)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const sessionId = strField(parseHook(input), 'session_id')
    const state = ctx.foldState(slug)
    if (sessionId !== null && !state.sessions.some((s) => s.id === sessionId)) {
      ctx.appendAndProject(slug, 'session_started', { tool: HOOK_TOOL }, {
        session: sessionId,
        source: 'hook',
      })
    }
    // Status-projection stdout lands with task 3.2 (needs the 3.6 template).
    return { ...OK }
  } catch {
    return { ...OK }
  }
}

/**
 * PostToolUse (task 3.3) — mechanical file_touched / command_run events.
 * Edit|MultiEdit → {op:'edit'}, Write → {op:'write'}, Bash → command_run;
 * any other tool_name (or missing fields) appends nothing.
 */
export function handlePostTool(rootDir: string, input: string): HookResult {
  try {
    const bound = resolveBound(rootDir)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const hook = parseHook(input)
    const toolName = strField(hook, 'tool_name')
    const toolInput = isObj(hook.tool_input) ? hook.tool_input : {}

    let type: 'file_touched' | 'command_run'
    let payload: Obj
    if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
      const path = strField(toolInput, 'file_path')
      if (path === null) return { ...OK }
      type = 'file_touched'
      payload = { path, op: toolName === 'Write' ? 'write' : 'edit' }
    } else if (toolName === 'Bash') {
      const cmd = strField(toolInput, 'command')
      if (cmd === null) return { ...OK }
      type = 'command_run'
      payload = { cmd }
    } else {
      return { ...OK }
    }

    ctx.appendAndProject(slug, type, payload, {
      session: strField(hook, 'session_id') ?? 'cli',
      source: 'hook',
    })
    return { ...OK }
  } catch {
    return { ...OK }
  }
}

/**
 * Stop (task 3.4, BD2) — the write-back gate. Exit 2 blocks the stop and
 * feeds stderr back to the agent; every other path exits 0:
 *  - stop_hook_active → 0 (loop guard: we already blocked once)
 *  - unreadable stdin / missing session_id / unbound repo → 0 (never block
 *    sessions the harness does not govern)
 *  - session not registered in the log → 0
 *  - session registered AND written back (session_ended folded) → 0
 * Write-back check is fold-based: only session_ended sets session.summary,
 * so a voided (corrected) session_ended does not count (BD23).
 */
export function handleStop(rootDir: string, input: string): HookResult {
  try {
    const hook = parseHook(input)
    if (hook.stop_hook_active === true) return { ...OK }

    const sessionId = strField(hook, 'session_id')
    if (sessionId === null) return { ...OK }

    const bound = resolveBound(rootDir)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const session = ctx.foldState(slug).sessions.find((s) => s.id === sessionId)
    if (session === undefined) return { ...OK } // never registered — not ours to block
    if (session.summary !== undefined) return { ...OK } // write-back done

    return { exitCode: 2, stdout: '', stderr: STOP_BLOCK_MESSAGE }
  } catch {
    return { ...OK }
  }
}

/**
 * SessionEnd (task 3.5) — mechanical close marker, fallback logging only.
 * Appends session_closed {reason}; the fold sets session.ended and nothing
 * else (BD21 — fabricating a session_ended here would clobber the
 * fold-derived current.next_action). Skipped when the session is unknown
 * (nothing to close) or already ended (write-back or a prior close won).
 */
export function handleSessionEnd(rootDir: string, input: string): HookResult {
  try {
    const bound = resolveBound(rootDir)
    if (bound === null) return { ...OK }
    const { ctx, slug } = bound

    const hook = parseHook(input)
    const sessionId = strField(hook, 'session_id')
    if (sessionId === null) return { ...OK }

    const session = ctx.foldState(slug).sessions.find((s) => s.id === sessionId)
    if (session === undefined || session.ended !== undefined) return { ...OK }

    ctx.appendAndProject(slug, 'session_closed', { reason: strField(hook, 'reason') ?? 'unknown' }, {
      session: sessionId,
      source: 'hook',
    })
    return { ...OK }
  } catch {
    return { ...OK }
  }
}

// ---------------------------------------------------------------------------
// Commander wiring — thin: read stdin, run handler, mirror its result.
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '' // run by hand without piped input
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}

const SUBCOMMANDS: ReadonlyArray<{
  name: string
  description: string
  handler: (rootDir: string, input: string) => HookResult
}> = [
  {
    name: 'session-start',
    description:
      'SessionStart hook: register the session in the log, print the status projection (≤10,000 chars) as injected context',
    handler: handleSessionStart,
  },
  {
    name: 'post-tool',
    description:
      'PostToolUse hook: append mechanical file_touched (Edit|Write|MultiEdit) / command_run (Bash) events',
    handler: handlePostTool,
  },
  {
    name: 'stop',
    description:
      'Stop hook: exit 2 (blocking) when the registered session has not written back via session_ended; loop-guarded by stop_hook_active',
    handler: handleStop,
  },
  {
    name: 'session-end',
    description: 'SessionEnd hook: append a mechanical session_closed marker (fallback only)',
    handler: handleSessionEnd,
  },
]

export function registerEventCommand(program: Command): void {
  const event = program
    .command('event')
    .description('internal surface for hook shims — subcommands read hook JSON from stdin (SPEC §Hooks)')

  for (const { name, description, handler } of SUBCOMMANDS) {
    event
      .command(name)
      .description(description)
      .option('--root <dir>', 'repo root containing .harness/ (default: current directory)')
      .action(async (opts: { root?: string }) => {
        const input = await readStdin()
        const result = handler(resolve(opts.root ?? process.cwd()), input)
        if (result.stdout.length > 0) process.stdout.write(result.stdout)
        if (result.stderr.length > 0) {
          process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`)
        }
        process.exitCode = result.exitCode
      })
  }
}
