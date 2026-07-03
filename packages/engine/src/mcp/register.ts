/**
 * .mcp.json registration snippet (BD13) — the entry `harness init` (Phase 4,
 * task 4.1) merges into a repo's .mcp.json so agent tools launch the stdio
 * server via `harness mcp`.
 */

export interface McpRegistration {
  mcpServers: {
    harness: {
      command: string
      args: string[]
    }
  }
}

export function mcpRegistration(): McpRegistration {
  return {
    mcpServers: {
      harness: {
        command: 'harness',
        args: ['mcp'],
      },
    },
  }
}

/** Pretty-printed JSON form, trailing newline included — ready to write to disk. */
export function mcpRegistrationJSON(): string {
  return `${JSON.stringify(mcpRegistration(), null, 2)}\n`
}
