import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { TOOL_INPUT_SCHEMAS, TOOL_NAMES, type ToolName } from '@harness/schema/tool-inputs'
import { createHarnessServer, SERVER_NAME } from '../src/mcp/server'

async function connect(rootDir: string) {
  const handle = createHarnessServer({ rootDir })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'harness-test-client', version: '0.0.0' })
  await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)])
  return { handle, client }
}

describe('MCP server skeleton (2.1)', () => {
  it('identifies as "harness" and lists all seven typed tools', async () => {
    const { client } = await connect('/tmp/does-not-need-a-repo-for-listing')
    expect(SERVER_NAME).toBe('harness')

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      // schemas served verbatim from @harness/schema — the only schema home
      expect(tool.inputSchema).toEqual(TOOL_INPUT_SCHEMAS[tool.name as ToolName])
    }
    await client.close()
  })

  it('resolves rootDir to an absolute path with cwd as default', async () => {
    const { handle } = await connect('.')
    expect(handle.rootDir).toBe(process.cwd())
    const defaulted = createHarnessServer()
    expect(defaulted.rootDir).toBe(process.cwd())
  })
})
