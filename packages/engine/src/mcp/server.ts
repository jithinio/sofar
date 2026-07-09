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
import { createToolContext, ToolError, type ActiveSession, type ToolContext } from './context'
import { getState } from './get-state'
import { startSession } from './start-session'
import { endSession } from './end-session'
import { updateTask } from './update-task'
import { logDecision } from './log-decision'
import { updatePlan } from './update-plan'
import { addNote } from './add-note'

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
export const SERVER_VERSION = '0.1.0'

const handlers: { [K in ToolName]: (ctx: ToolContext, args: ToolArgs[K]) => unknown } = {
  sofar_get_state: getState,
  sofar_start_session: startSession,
  sofar_end_session: endSession,
  sofar_update_task: updateTask,
  sofar_log_decision: logDecision,
  sofar_update_plan: updatePlan,
  sofar_add_note: addNote,
}

function okResult(value: unknown): CallToolResult {
  // Text results (e.g. get_state's digest projection) pass through raw — the
  // MCP-native idiom; structured results are JSON-encoded as before.
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { content: [{ type: 'text', text }] }
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
      return okResult(handler(context, args))
    } catch (err) {
      const toolError =
        err instanceof ToolError
          ? err
          : new ToolError('io_error', err instanceof Error ? err.message : String(err))
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
