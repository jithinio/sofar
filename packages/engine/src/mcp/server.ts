import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { TOOL_DEFS } from '@harness/schema/tool-inputs'
import { resolve } from 'node:path'

/**
 * Harness MCP server (SPEC §MCP tools) — low-level SDK API on purpose (BD12):
 * tools are declared with plain JSON Schema objects and validated by
 * @harness/schema validators, keeping zod out of our runtime dependency set.
 * Launched over stdio by `harness mcp` (BD13).
 */

export const SERVER_NAME = 'harness'
export const SERVER_VERSION = '0.1.0'

export interface CreateHarnessServerOptions {
  /** Repo root containing .harness/ — defaults to process.cwd(). */
  rootDir?: string
}

export interface HarnessServerHandle {
  server: Server
  rootDir: string
  /** Connect the server to stdio (production path — `harness mcp`). */
  connectStdio(): Promise<void>
}

/**
 * Build the server without connecting a transport, so tests can attach an
 * InMemoryTransport and production attaches stdio.
 */
export function createHarnessServer(options: CreateHarnessServerOptions = {}): HarnessServerHandle {
  const rootDir = resolve(options.rootDir ?? process.cwd())

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

  return {
    server,
    rootDir,
    async connectStdio() {
      await server.connect(new StdioServerTransport())
    },
  }
}
