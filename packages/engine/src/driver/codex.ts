import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { PermissionSurface } from './permissions'
import type {
  Adapter,
  AdapterCapabilities,
  AgentSession,
  LaunchRequest,
  SessionExit,
  Usage,
} from './adapter'

/**
 * The codex adapter (session-driver 3.1, D9): `codex exec --json`, one JSON
 * object per stdout line.
 *
 * It exists to PROVE the contract, and it proves it by fitting badly. An
 * adapter written from the same agent the contract was designed around shows
 * only that the contract describes that agent. Codex disagrees with Claude
 * Code on every axis the contract abstracts, and `sofar drive` runs against it
 * unchanged anyway — that is the proof.
 *
 * Shapes verified against codex-cli 0.136.0, captured from a real
 * `codex exec --json` pointed at an unreachable provider so the run cost
 * nothing:
 *
 * - `{"type":"thread.started","thread_id":"01a050e6-…"}` — codex's OWN id, not
 *   the record's. Nothing marries them: codex runs no sofar hook, so unlike
 *   Claude Code this transport does not show a record session id.
 * - `{"type":"turn.started"}` / `{"type":"turn.completed","usage":{…}}` /
 *   `{"type":"turn.failed","error":{"message":…}}`
 * - `{"type":"error","message":"…"}` — a turn-level failure, kept for the exit
 *   diagnostics.
 * - `item.started` / `item.updated` / `item.completed` carry the work
 *   (agent_message, command_execution, file_change, mcp_tool_call, …) and are
 *   skipped: the driver reads what a session DID from the record, never from a
 *   transport.
 *
 * The usage field names are codex's `TokenUsage` — input_tokens,
 * cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens —
 * taken from the binary and from a real rollout file. The `turn.completed`
 * envelope around them is the one shape a zero-cost capture could not produce,
 * so the parse is tolerant: an unrecognised shape yields no usage rather than
 * a wrong number.
 *
 * Four things it cannot do, declared rather than worked around:
 *
 * 1. NO LIVE GAUGE. Usage arrives with `turn.completed`, which is to say after
 *    the session has ended. A gauge that only reads after the fact is not a
 *    gauge, so `capabilities.usage` is false and `policyUnavailable` refuses
 *    the threshold policy here. The final numbers still ride `SessionExit`.
 * 2. NO NUDGE. There is no channel into a running `codex exec` — stdin is
 *    closed at spawn and no sofar hook is wired into codex.
 * 3. NO PERMISSION RULES. Codex speaks a sandbox enum and an approval policy,
 *    not per-tool allow/deny. The surface's MODE maps; its rules do not, and
 *    `capabilities.permission_rules` is false so the driver says so.
 * 4. NO COST. Nothing in the transport reports money, so `--cost-cap` is inert
 *    and the driver says that too.
 *
 * And one thing it does differently: the session id is ASSIGNED, not observed.
 * The adapter mints it, writes it into the pin line, and reports it on exit —
 * but it is still only an id, and `resolveLaunchedSession` believes it solely
 * because the record registered it (D3). A session that ignored the
 * instruction falls through to the tool-and-time diff, which is the path
 * Claude Code's hook-supplied id never exercises.
 */

export interface CodexOptions {
  /** Binary to spawn; default `codex`, resolved on the child's PATH. */
  bin?: string
  /** The sofar CLI the driven session is told to use; default `sofar`. */
  sofarBin?: string
  /** Extra argv inserted before the prompt — the operator's escape hatch. */
  args?: string[]
}

export const CODEX_CAPABILITIES: AdapterCapabilities = {
  usage: false,
  nudge: false,
  model: true,
  effort: true,
  permission_rules: false,
  cost: false,
}

/**
 * Generic permission mode → codex sandbox. Approval is `never` in every case,
 * not because every mode means it but because an unattended session cannot
 * answer an approval prompt: the same fact that makes `default` unusable for
 * Claude Code print mode collapses codex's approval axis entirely. `default`
 * and `acceptEdits` therefore land in the same place, which is honest — codex
 * has no "ask about commands but not edits" state under automation.
 */
export const SANDBOX_BY_MODE: Readonly<Record<string, string>> = {
  default: 'workspace-write',
  acceptEdits: 'workspace-write',
  dontAsk: 'workspace-write',
  bypassPermissions: 'danger-full-access',
  plan: 'read-only',
}

export class CodexSurfaceError extends Error {}

/** The `-s`/`-c` pair a surface becomes, or a throw when the mode has no codex meaning. */
export function codexPermissionArgs(surface: PermissionSurface): string[] {
  const sandbox = SANDBOX_BY_MODE[surface.permission_mode]
  if (sandbox === undefined) {
    // D8's rule, applied here: a launch whose surface cannot be honoured does
    // not happen. Falling back to a "safe" sandbox would run the session under
    // a permission surface nobody chose and the record would still name the
    // other one.
    throw new CodexSurfaceError(
      `codex has no sandbox for permission mode "${surface.permission_mode}" — known modes are ${Object.keys(SANDBOX_BY_MODE).join(', ')}`,
    )
  }
  return ['-s', sandbox, '-c', 'approval_policy="never"']
}

/**
 * The preamble a driven codex session opens with. It does two jobs Claude
 * Code's `pinLine` does not have to: it hands over the session id (codex has
 * no hook to inject one, so the driver assigns it), and it translates the
 * protocol into the CLI dialect, because codex carries no sofar MCP server.
 *
 * `tool` is stated exactly, and it is load-bearing: `resolveLaunchedSession`
 * matches candidate sessions on the adapter's name, so a session registered
 * under any other tool is invisible to the driver that launched it.
 */
export function codexPinLine(initiative: string, sessionId: string, sofarBin = 'sofar'): string {
  const append = `${sofarBin} event append ${initiative} --session ${sessionId} --source codex --type`
  return [
    `This session is driven by sofar and serves the initiative \`${initiative}\`.`,
    `Your session id is ${sessionId} — use it on every sofar call, unchanged.`,
    '',
    'You have no sofar MCP tools. Use the `sofar` CLI instead, from the repo root.',
    'Before anything else, register this session:',
    `  ${append} session_started --payload '{"tool":"codex"}'`,
    'Read the record you are serving with:',
    `  ${sofarBin} status ${initiative}`,
    'Log a decision, and set the task status, as they happen — note the task',
    'key is `id`, not `task_id`:',
    `  ${append} decision_logged --payload '{"chose":"…","over":"…","because":"…"}'`,
    `  ${append} task_status_changed --payload '{"id":"…","status":"done"}'`,
    'If the task needs a decision only the operator can take, set it `blocked`',
    'with the question as the note instead — that is what stops the run:',
    `  ${append} task_status_changed --payload '{"id":"…","status":"blocked","note":"…"}'`,
    'And write back LAST, before you commit:',
    `  ${append} session_ended --payload '{"summary":"…","next_action":"…"}'`,
    '',
    'The write-back is what hands off to the next session; a session that skips',
    'it is recorded as a stall however much work it did.',
  ].join('\n')
}

export function codexPrompt(request: LaunchRequest, sessionId: string, sofarBin?: string): string {
  return `${codexPinLine(request.initiative, sessionId, sofarBin)}\n\n${request.prompt}`
}

/**
 * The argv, exported so a test can pin it without spawning. The prompt is
 * POSITIONAL and therefore last; `--skip-git-repo-check` because the driver
 * requires a `.sofar` log, never a git repo, and codex otherwise refuses to
 * start outside one.
 */
export function codexArgs(
  request: LaunchRequest,
  sessionId: string,
  options: CodexOptions = {},
): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...(request.model !== undefined ? ['-m', request.model] : []),
    ...(request.effort !== undefined ? ['-c', `model_reasoning_effort="${request.effort}"`] : []),
    ...(request.surface !== undefined ? codexPermissionArgs(request.surface) : []),
    ...(options.args ?? []),
    codexPrompt(request, sessionId, options.sofarBin),
  ]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const STDERR_TAIL = 4096
/** How long after exit to wait for stdout to drain before reporting the exit anyway. */
const STDOUT_DRAIN_GRACE_MS = 2_000

export class CodexSession implements AgentSession {
  /** The session id the driver ASSIGNED and the prompt asked for — never one codex reported. */
  readonly sessionId: string
  /** Codex's own thread id, from `thread.started`. Diagnostics only: the record never sees it. */
  threadId: string | undefined
  /** Last STDERR_TAIL chars of stderr — codex writes its tracing there, and it is what to show on a bad exit. */
  stderrTail = ''
  /** The `error` / `turn.failed` message, when the stream carried one. */
  failure: string | undefined
  /** Set when the binary could not be spawned at all. */
  spawnError: string | undefined

  /**
   * Usage from `turn.completed`. NOT returned by `usage()`: it exists only
   * after the turn is over, so reporting it as a live reading would let a
   * caller mistake a post-mortem for a gauge.
   */
  private finalUsage: Usage | undefined
  private readonly exit: Promise<SessionExit>
  private readonly child: ChildProcess

  constructor(request: LaunchRequest, options: CodexOptions) {
    this.sessionId = randomUUID()
    const env: NodeJS.ProcessEnv = { ...process.env, ...request.env }

    // stdin is closed at once, verified: with it piped, codex prints "Reading
    // additional input from stdin" and waits, even when a prompt was given on
    // the command line. Detached for the same reason as the Claude adapter —
    // codex spawns MCP servers and hook shims that would outlive it holding
    // the stdout pipe open.
    this.child = spawn(options.bin ?? 'codex', codexArgs(request, this.sessionId, options), {
      cwd: request.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })

    const lines = createInterface({ input: this.child.stdout!, crlfDelay: Infinity })
    lines.on('line', (line) => this.consume(line))
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL)
    })

    this.exit = new Promise<SessionExit>((resolve) => {
      let settled = false
      const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (settled) return
        settled = true
        resolve({
          code,
          ...(signal !== null ? { signal } : {}),
          // Assigned, not observed — and the driver still refuses to believe it
          // unless the record registered it (D3).
          session_id: this.sessionId,
          ...(this.finalUsage !== undefined ? { usage: this.finalUsage } : {}),
        })
      }
      let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
      let drained = false
      lines.on('close', () => {
        drained = true
        if (exited !== undefined) settle(exited.code, exited.signal)
      })
      this.child.on('exit', (code, signal) => {
        exited = { code, signal }
        if (drained) settle(code, signal)
        else setTimeout(() => settle(code, signal), STDOUT_DRAIN_GRACE_MS).unref()
      })
      this.child.on('error', (err) => {
        this.spawnError = err.message
        settle(127, null)
      })
    })
  }

  private consume(line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      return
    }
    if (!isObj(decoded)) return
    switch (decoded.type) {
      case 'thread.started': {
        if (typeof decoded.thread_id === 'string' && decoded.thread_id.length > 0) {
          this.threadId = decoded.thread_id
        }
        return
      }
      case 'turn.completed': {
        const u = decoded.usage
        if (!isObj(u)) return
        this.finalUsage = {
          context_tokens: num(u.input_tokens) + num(u.cached_input_tokens),
          output_tokens: num(u.output_tokens) + num(u.reasoning_output_tokens),
        }
        return
      }
      case 'turn.failed': {
        const err = decoded.error
        if (isObj(err) && typeof err.message === 'string') this.failure = err.message
        return
      }
      case 'error': {
        if (typeof decoded.message === 'string') this.failure = decoded.message
        return
      }
      default:
        return
    }
  }

  /**
   * Always undefined (`capabilities.usage` is false). Codex reports a number
   * only once the turn is over, and the threshold policy is refused here
   * precisely so nothing reads a post-mortem as a gauge.
   */
  usage(): Usage | undefined {
    return undefined
  }

  /** Signal the whole process group; fall back to the child alone where groups are unavailable. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    const pid = this.child.pid
    if (pid !== undefined && process.platform !== 'win32') {
      try {
        process.kill(-pid, signal)
        return
      } catch {
        // Group already gone or never formed — fall through to the child.
      }
    }
    this.child.kill(signal)
  }

  wait(): Promise<SessionExit> {
    return this.exit
  }
}

export class CodexAdapter implements Adapter {
  readonly name = 'codex'
  readonly capabilities = CODEX_CAPABILITIES

  constructor(private readonly options: CodexOptions = {}) {}

  launch(request: LaunchRequest): CodexSession {
    return new CodexSession(request, this.options)
  }
}
