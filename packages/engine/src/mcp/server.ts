import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  TOOL_DEFS,
  TOOL_NAMES,
  isToolName,
  validateToolInput,
  type ToolArgs,
  type ToolName,
} from '@sofar/schema/tool-inputs'
import { resolve } from 'node:path'
import { version } from '../../package.json'
import { createToolContext, ToolError, type ActiveSession, type ToolContext } from './context'
import { recordDiagnostic } from '../core/diagnostics'
import { getState } from './get-state'
import { startSession } from './start-session'
import { endSession } from './end-session'
import { updateTask } from './update-task'
import { updatePhase } from './update-phase'
import { logDecision } from './log-decision'
import { updatePlan } from './update-plan'
import { addNote } from './add-note'
import { remember } from './remember'
import { review } from './review'
import { closeInitiative } from './close-initiative'
import { find } from './find'

/**
 * Sofar MCP server (SPEC §MCP tools) — low-level SDK API on purpose (BD12):
 * tools are declared with plain JSON Schema objects and validated by
 * @sofar/schema validators, keeping zod out of our runtime dependency set.
 * Launched over stdio by `sofar mcp` (BD13).
 *
 * Every tool call = validate args → append event (core/log) → regenerate
 * projections → return. Failures come back as isError results whose text is
 * a typed { code, message, errors? } JSON (BD17) — never as protocol faults,
 * so agents always see an actionable, parseable error.
 */

export const SERVER_NAME = 'sofar'
// Single-sourced from package.json (the cli/index.ts BD39 precedent) —
// esbuild inlines the JSON import, so the handshake always reports the
// manifest's version.
export const SERVER_VERSION = version

const handlers: { [K in ToolName]: (ctx: ToolContext, args: ToolArgs[K]) => unknown } = {
  sofar_get_state: getState,
  sofar_start_session: startSession,
  sofar_end_session: endSession,
  sofar_update_task: updateTask,
  sofar_update_phase: updatePhase,
  sofar_log_decision: logDecision,
  sofar_update_plan: updatePlan,
  sofar_add_note: addNote,
  sofar_remember: remember,
  sofar_review: review,
  sofar_close_initiative: closeInitiative,
  sofar_find: find,
}

function okResult(value: unknown): CallToolResult {
  // Text results (e.g. get_state's digest projection) pass through raw — the
  // MCP-native idiom; structured results are JSON-encoded as before.
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text', text }] }
}

/**
 * One diagnostics row per MCP call, success or rejection (self-improve 1.2).
 * This is where the MCP half of the bookkeeping denominator comes from: the
 * PostToolUse matcher never sees mcp__sofar__* calls, so the server counts
 * its own. Best-effort — a row that cannot be written changes nothing.
 */
function recordCall(
  context: ToolContext,
  tool: string,
  data: { ok: boolean; code?: string; ms: number },
): void {
  try {
    const active = context.session.get()
    let initiative: string | undefined = active?.initiative
    if (initiative === undefined) {
      try {
        initiative = context.resolveInitiative()
      } catch {
        initiative = undefined
      }
    }
    recordDiagnostic(context.rootDir, {
      kind: 'mcp_call',
      data: { tool, ok: data.ok, ...(data.code !== undefined ? { code: data.code } : {}), ms: data.ms },
      ...(initiative !== undefined ? { initiative } : {}),
      ...(active !== undefined && active !== null ? { session: active.id, host: { tool: active.tool } } : {}),
    })
  } catch {
    // never let diagnostics touch the tool result
  }
}

function errorResult(error: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error.toShape()) }] }
}

export interface CreateSofarServerOptions {
  /** Repo root containing .sofar/ — defaults to process.cwd(). */
  rootDir?: string
}

export interface SofarServerHandle {
  server: Server
  context: ToolContext
  rootDir: string
  /** The in-memory active session, if any (BD15) — exposed for tests. */
  getActiveSession(): ActiveSession | null
  /** Connect the server to stdio (production path — `sofar mcp`). */
  connectStdio(): Promise<void>
}

/**
 * Build the server without connecting a transport, so tests can attach an
 * InMemoryTransport and production attaches stdio.
 */
export function createSofarServer(options: CreateSofarServerOptions = {}): SofarServerHandle {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const context = createToolContext(rootDir)

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name
    const args: unknown = request.params.arguments ?? {}
    const started = Date.now()
    try {
      if (!isToolName(name)) {
        throw new ToolError(
          'unknown_tool',
          `unknown tool "${name}" — available: ${TOOL_NAMES.join(', ')}`,
        )
      }
      const check = validateToolInput(name, args)
      if (!check.ok) {
        throw new ToolError('invalid_input', `invalid arguments for ${name}`, check.errors)
      }
      // Runtime-validated above; the registry's per-tool arg types are
      // narrower than `unknown`, hence the cast.
      const handler = handlers[name] as (ctx: ToolContext, a: unknown) => unknown
      const result = okResult(handler(context, args))
      recordCall(context, name, { ok: true, ms: Date.now() - started })
      return result
    } catch (err) {
      const toolError =
        err instanceof ToolError
          ? err
          : new ToolError('io_error', err instanceof Error ? err.message : String(err))
      // A typed rejection appends NOTHING to the record (no-write-on-invalid-
      // input) — it lands only as a diagnostics row (self-improve D3 (5)).
      recordCall(context, name, { ok: false, code: toolError.code, ms: Date.now() - started })
      return errorResult(toolError)
    }
  })

  return {
    server,
    context,
    rootDir,
    getActiveSession: () => context.session.get(),
    async connectStdio() {
      await server.connect(new StdioServerTransport())
    },
  }
}
